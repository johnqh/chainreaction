import { test, expect } from "bun:test";
import { SessionStore } from "../../src/auth/session";

const SECRET = "test-session-secret-do-not-use-in-prod";
const TOKEN = "gho_the-users-real-github-token";

test("createSession then readSession round-trips userId, installationId, and userToken", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const cookie = await store.createSession("user-1", 42, TOKEN);
  const session = await store.readSession(cookie);
  expect(session).toEqual({ userId: "user-1", installationId: 42, userToken: TOKEN, exp: 1000 + 60 * 60 * 8 });
});

test("the cookie value never contains the session secret", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const cookie = await store.createSession("user-1", 42, TOKEN);
  expect(cookie).not.toContain(SECRET);
});

// The whole point of encrypting the embedded token: even though the cookie
// carries enough to reconstruct it, the plaintext token itself must never
// appear in the cookie's bytes.
test("the cookie value never contains the plaintext user token", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const cookie = await store.createSession("user-1", 42, TOKEN);
  expect(cookie).not.toContain(TOKEN);
});

// Same property, checked against the decoded (but still-encrypted) payload
// rather than just the base64url cookie string — proves this isn't merely
// "base64 doesn't happen to contain the substring" but that the token
// genuinely never appears in what gets signed either.
test("the decoded payload JSON never contains the plaintext user token", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const cookie = await store.createSession("user-1", 42, TOKEN);
  const payloadB64 = cookie.split(".")[0]!;
  const decoded = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  expect(decoded).not.toContain(TOKEN);
});

// A fresh random IV per session means encrypting the exact same token twice
// must never produce the same ciphertext — otherwise two sessions for the
// same user would leak that their tokens match via identical cookie bytes.
test("encrypting the same token twice (two sessions) produces different cookies", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const cookieA = await store.createSession("user-1", 42, TOKEN);
  const cookieB = await store.createSession("user-1", 42, TOKEN);
  expect(cookieA).not.toBe(cookieB);
});

test("readSession rejects undefined/null/empty cookies", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  expect(await store.readSession(undefined)).toBeNull();
  expect(await store.readSession(null)).toBeNull();
  expect(await store.readSession("")).toBeNull();
});

test("readSession rejects a cookie with no signature separator", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  expect(await store.readSession("not-a-valid-cookie-at-all")).toBeNull();
});

// This is the test that discriminates "signature actually checked" from "signature
// ignored": flipping one character in the signature segment must invalidate the
// cookie even though the payload segment (and its shape) is untouched.
test("readSession rejects a cookie whose signature has been tampered with", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const cookie = await store.createSession("user-1", 42, TOKEN);
  const [payload, sig] = cookie.split(".");
  const tamperedSig = (sig![0] === "A" ? "B" : "A") + sig!.slice(1);
  const tampered = `${payload}.${tamperedSig}`;
  expect(await store.readSession(tampered)).toBeNull();
});

// This is the test that discriminates a real cross-tenant escalation: an attacker
// who can guess/observe their own valid cookie's shape edits the installationId
// field directly. Unless the signature is verified against the *exact* payload
// bytes, this forged cookie would be accepted with a different installationId
// than was ever signed.
test("readSession rejects a cookie whose payload has been tampered to change installationId", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const cookie = await store.createSession("user-1", 42, TOKEN);
  const [payload, sig] = cookie.split(".");
  const decoded = JSON.parse(
    Buffer.from(payload!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );
  decoded.installationId = 999; // attacker's target installation
  const forgedPayload = Buffer.from(JSON.stringify(decoded))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const forged = `${forgedPayload}.${sig}`;
  expect(await store.readSession(forged)).toBeNull();
});

// The encrypted-token analogue of the test above: tampering with the
// ciphertext bytes directly (rather than installationId) must also be
// rejected — via the same outer HMAC signature, since the ciphertext is
// part of the signed payload.
test("readSession rejects a cookie whose embedded token ciphertext has been tampered with", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const cookie = await store.createSession("user-1", 42, TOKEN);
  const [payload, sig] = cookie.split(".");
  const decoded = JSON.parse(
    Buffer.from(payload!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  ) as { tokenCiphertext: string };
  const flipped = decoded.tokenCiphertext[0] === "A" ? "B" : "A";
  decoded.tokenCiphertext = flipped + decoded.tokenCiphertext.slice(1);
  const forgedPayload = Buffer.from(JSON.stringify(decoded))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const forged = `${forgedPayload}.${sig}`;
  expect(await store.readSession(forged)).toBeNull();
});

test("readSession rejects a cookie signed with a different secret", async () => {
  const storeA = new SessionStore("secret-a", () => 1000);
  const storeB = new SessionStore("secret-b", () => 1000);
  const cookie = await storeA.createSession("user-1", 42, TOKEN);
  expect(await storeB.readSession(cookie)).toBeNull();
});

test("readSession rejects an expired session", async () => {
  let clock = 1000;
  const store = new SessionStore(SECRET, () => clock, 100);
  const cookie = await store.createSession("user-1", 42, TOKEN);
  clock += 101; // past the 100s TTL
  expect(await store.readSession(cookie)).toBeNull();
});

test("readSession accepts a session right up to (but not past) expiry", async () => {
  let clock = 1000;
  const store = new SessionStore(SECRET, () => clock, 100);
  const cookie = await store.createSession("user-1", 42, TOKEN);
  clock += 99;
  expect(await store.readSession(cookie)).not.toBeNull();
});

// The exact boundary: `exp === now()` must be treated as expired (the code
// uses `exp <= now()`), not as "one more second of validity". Without this
// case, a mutation that changed `<=` to `<` would leave the suite green —
// the two tests on either side of the boundary don't touch this instant.
test("readSession rejects a session at the exact instant it expires (exp === now)", async () => {
  let clock = 1000;
  const store = new SessionStore(SECRET, () => clock, 100);
  const cookie = await store.createSession("user-1", 42, TOKEN);
  clock += 100; // now() === exp exactly
  expect(await store.readSession(cookie)).toBeNull();
});

test("constructing a SessionStore with an empty secret throws", () => {
  expect(() => new SessionStore("")).toThrow(/secret/);
});

test("readSession rejects a payload segment that is not valid base64url", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  expect(await store.readSession("not!!valid!!base64.abcd")).toBeNull();
});

test("readSession rejects a well-signed payload that decodes to the wrong shape", async () => {
  // Sign an arbitrary object ourselves (using the same key) to prove that a
  // valid signature over a malformed payload still isn't accepted as a session.
  const store = new SessionStore(SECRET, () => 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify({ foo: "bar" })));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64)),
  );
  const cookie = `${payloadB64}.${b64url(sig)}`;
  expect(await store.readSession(cookie)).toBeNull();
});

// Proves the AES-GCM decrypt-failure path is actually reached and actually
// rejects — independent of the HMAC layer above. This payload has the right
// shape and a *genuine* signature (minted with the real HMAC key, just like
// the test above), but `tokenCiphertext` is not authentic AES-GCM output
// under this store's derived key at all, so decryption itself must fail.
test("readSession rejects a well-signed, well-shaped payload whose token ciphertext does not decrypt", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const bogusPayload = {
    userId: "user-1",
    installationId: 42,
    exp: 1_000_000,
    tokenIv: b64url(new Uint8Array(12)), // well-formed, but not the IV any real ciphertext below was encrypted under
    tokenCiphertext: b64url(new TextEncoder().encode("not-a-real-aes-gcm-ciphertext-at-all")),
  };
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(bogusPayload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64)),
  );
  const cookie = `${payloadB64}.${b64url(sig)}`;
  expect(await store.readSession(cookie)).toBeNull();
});

test("readSession rejects a payload missing the token fields entirely", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const payloadB64 = b64url(
    new TextEncoder().encode(JSON.stringify({ userId: "user-1", installationId: 42, exp: 1_000_000 })),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64)),
  );
  const cookie = `${payloadB64}.${b64url(sig)}`;
  expect(await store.readSession(cookie)).toBeNull();
});
