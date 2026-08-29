import { test, expect } from "bun:test";
import { SessionStore } from "../../src/auth/session";

const SECRET = "test-session-secret-do-not-use-in-prod";

test("createSession then readSession round-trips userId and installationId", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const cookie = await store.createSession("user-1", 42);
  const session = await store.readSession(cookie);
  expect(session).toEqual({ userId: "user-1", installationId: 42, exp: 1000 + 60 * 60 * 24 * 7 });
});

test("the cookie value never contains the session secret", async () => {
  const store = new SessionStore(SECRET, () => 1000);
  const cookie = await store.createSession("user-1", 42);
  expect(cookie).not.toContain(SECRET);
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
  const cookie = await store.createSession("user-1", 42);
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
  const cookie = await store.createSession("user-1", 42);
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

test("readSession rejects a cookie signed with a different secret", async () => {
  const storeA = new SessionStore("secret-a", () => 1000);
  const storeB = new SessionStore("secret-b", () => 1000);
  const cookie = await storeA.createSession("user-1", 42);
  expect(await storeB.readSession(cookie)).toBeNull();
});

test("readSession rejects an expired session", async () => {
  let clock = 1000;
  const store = new SessionStore(SECRET, () => clock, 100);
  const cookie = await store.createSession("user-1", 42);
  clock += 101; // past the 100s TTL
  expect(await store.readSession(cookie)).toBeNull();
});

test("readSession accepts a session right up to (but not past) expiry", async () => {
  let clock = 1000;
  const store = new SessionStore(SECRET, () => clock, 100);
  const cookie = await store.createSession("user-1", 42);
  clock += 99;
  expect(await store.readSession(cookie)).not.toBeNull();
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
