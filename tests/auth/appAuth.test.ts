import { test, expect } from "bun:test";
import { pemToPkcs8Der, pkcs1ToPkcs8 } from "../../src/auth/pem";
import { mintAppJwt, TokenStore, type AppCredentials } from "../../src/auth/appAuth";

async function generatePem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** Strip the fixed PKCS#8 envelope to recover the inner PKCS#1 RSAPrivateKey. */
function extractPkcs1(pkcs8: Uint8Array): Uint8Array {
  // SEQUENCE hdr, INTEGER 0 (3 bytes), AlgorithmIdentifier (15 bytes), then OCTET STRING.
  let i = 1;
  i += pkcs8[i]! & 0x80 ? (pkcs8[i]! & 0x7f) + 1 : 1; // skip outer length
  i += 3 + 15;
  if (pkcs8[i] !== 0x04) throw new Error("expected OCTET STRING");
  i += 1;
  const lenByte = pkcs8[i]!;
  i += lenByte & 0x80 ? (lenByte & 0x7f) + 1 : 1;
  return pkcs8.slice(i);
}

test("pemToPkcs8Der strips armour and whitespace on a PKCS#8 key", async () => {
  const der = pemToPkcs8Der(await generatePem());
  expect(der.byteLength).toBeGreaterThan(1000);
  expect(der[0]).toBe(0x30); // DER SEQUENCE
});

test("pemToPkcs8Der rejects a non-PEM string", () => {
  expect(() => pemToPkcs8Der("not a key")).toThrow(/pem/i);
});

test("a PKCS#1 key round-trips to importable PKCS#8", async () => {
  // GitHub hands out PKCS#1; crypto.subtle only accepts PKCS#8. This is the
  // conversion, and the assertion that matters is that importKey accepts the result.
  const pkcs8 = pemToPkcs8Der(await generatePem());
  const rewrapped = pkcs1ToPkcs8(extractPkcs1(pkcs8));
  expect(Array.from(rewrapped)).toEqual(Array.from(pkcs8));
  await expect(
    crypto.subtle.importKey("pkcs8", rewrapped,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]),
  ).resolves.toBeDefined();
});

test("a PKCS#1 PEM is detected by its armour and converted", async () => {
  const pkcs8 = pemToPkcs8Der(await generatePem());
  const pkcs1 = extractPkcs1(pkcs8);
  const armoured =
    "-----BEGIN RSA PRIVATE KEY-----\n" +
    btoa(String.fromCharCode(...pkcs1)).replace(/(.{64})/g, "$1\n") +
    "\n-----END RSA PRIVATE KEY-----\n";
  const der = pemToPkcs8Der(armoured);
  await expect(
    crypto.subtle.importKey("pkcs8", der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]),
  ).resolves.toBeDefined();
});

test("mintAppJwt produces three base64url segments with the right claims", async () => {
  const jwt = await mintAppJwt({ appId: "12345", privateKeyPem: await generatePem() }, 1_000_000);
  const parts = jwt.split(".");
  expect(parts.length).toBe(3);
  const decode = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
  expect(decode(parts[0]!)).toEqual({ alg: "RS256", typ: "JWT" });
  const payload = decode(parts[1]!);
  expect(payload.iss).toBe("12345");
  expect(payload.iat).toBe(1_000_000 - 60);
  expect(payload.exp).toBeLessThanOrEqual(1_000_000 + 600);
  expect(parts[2]!.length).toBeGreaterThan(0);
  expect(jwt).not.toContain("=");
});

test("TokenStore mints a token and caches it until near expiry", async () => {
  const creds: AppCredentials = { appId: "1", privateKeyPem: await generatePem() };
  let calls = 0;
  let clock = 1_000_000;
  const fetchFn = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ token: `tok-${calls}`, expires_at: new Date((clock + 3600) * 1000).toISOString() }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const store = new TokenStore(creds, fetchFn, () => clock);
  expect(await store.get(42)).toBe("tok-1");
  expect(await store.get(42)).toBe("tok-1");
  expect(calls).toBe(1);

  clock += 3540; // inside the 120s safety margin
  expect(await store.get(42)).toBe("tok-2");
  expect(calls).toBe(2);
});

test("TokenStore keys the cache per installation", async () => {
  const creds: AppCredentials = { appId: "1", privateKeyPem: await generatePem() };
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ token: `tok-${calls}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;
  const store = new TokenStore(creds, fetchFn);
  expect(await store.get(1)).toBe("tok-1");
  expect(await store.get(2)).toBe("tok-2");
});

test("TokenStore surfaces a failed exchange without leaking the JWT", async () => {
  const creds: AppCredentials = { appId: "1", privateKeyPem: await generatePem() };
  const fetchFn = (async () =>
    new Response('{"message":"Bad credentials"}', { status: 401 })) as unknown as typeof fetch;
  const store = new TokenStore(creds, fetchFn);
  let message = "";
  try { await store.get(7); } catch (e) { message = (e as Error).message; }
  expect(message).toMatch(/401/);
  expect(message).not.toMatch(/BEGIN PRIVATE KEY|eyJ/);
});

test("TokenStore de-duplicates concurrent requests for the same installation", async () => {
  const creds: AppCredentials = { appId: "1", privateKeyPem: await generatePem() };
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    // Resolve on a later tick so both concurrent get() calls genuinely
    // overlap; a synchronously-resolving stub wouldn't exercise the race.
    await new Promise((r) => setTimeout(r, 0));
    return new Response(
      JSON.stringify({ token: `tok-${calls}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const store = new TokenStore(creds, fetchFn);
  const [a, b] = await Promise.all([store.get(42), store.get(42)]);
  expect(a).toBe("tok-1");
  expect(b).toBe("tok-1");
  expect(calls).toBe(1);
});

test("TokenStore retries after a failed exchange instead of caching the rejection", async () => {
  const creds: AppCredentials = { appId: "1", privateKeyPem: await generatePem() };
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) return new Response('{"message":"Bad credentials"}', { status: 401 });
    return new Response(
      JSON.stringify({ token: `tok-${calls}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const store = new TokenStore(creds, fetchFn);
  await expect(store.get(7)).rejects.toThrow(/401/);
  expect(await store.get(7)).toBe("tok-2");
  expect(calls).toBe(2);
});
