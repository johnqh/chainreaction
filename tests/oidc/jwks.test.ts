import { test, expect } from "bun:test";
import { JwksCache, type Jwk } from "../../src/oidc/jwks";

const JWKS_URI = "https://example.test/.well-known/jwks";

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function jwkFor(kid: string, publicKey: CryptoKey): Promise<Jwk> {
  const exported = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey;
  return { kid, kty: exported.kty!, alg: "RS256", n: exported.n!, e: exported.e! };
}

test("JwksCache de-duplicates concurrent lookups on a cold cache into one fetch", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    // Resolve on a later tick so both concurrent keyFor() calls genuinely
    // overlap; a synchronously-resolving stub would pass either way.
    await new Promise((r) => setTimeout(r, 0));
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }) as unknown as typeof fetch;

  const jwks = new JwksCache(fetchFn, JWKS_URI);
  const [a, b] = await Promise.all([jwks.keyFor("key-1"), jwks.keyFor("key-1")]);

  expect(a).toBe(b);
  expect(calls).toBe(1);
});

test("JwksCache retries after a failed load instead of caching the rejection", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) return new Response("server error", { status: 500 });
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }) as unknown as typeof fetch;

  const jwks = new JwksCache(fetchFn, JWKS_URI);
  await expect(jwks.keyFor("key-1")).rejects.toThrow(/JWKS fetch returned status 500/);
  await expect(jwks.keyFor("key-1")).resolves.toBeDefined();
  expect(calls).toBe(2);
});
