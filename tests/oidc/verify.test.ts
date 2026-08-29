import { test, expect } from "bun:test";
import { JwksCache, type Jwk } from "../../src/oidc/jwks";
import { verifyOidcToken } from "../../src/oidc/verify";

const AUDIENCE = "https://example-consumer.test";
const OWNER_ID = "9999";
const JWKS_URI = "https://example.test/.well-known/jwks";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlJson = (value: unknown): string =>
  b64url(new TextEncoder().encode(JSON.stringify(value)));

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

async function signToken(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const signedInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signedInput),
    ),
  );
  return `${signedInput}.${b64url(sig)}`;
}

/** Serves a scripted sequence of JWKS documents; the last entry repeats for any extra calls. */
function stubFetch(sequence: Jwk[][]): { fetchFn: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchFn = (async () => {
    const idx = Math.min(n, sequence.length - 1);
    const keys = sequence[idx]!;
    n++;
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => n };
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: AUDIENCE,
    iat: 1_000_000 - 10,
    nbf: 1_000_000 - 10,
    exp: 1_000_000 + 300,
    repository_id: "123456",
    repository_owner_id: OWNER_ID,
    repository: "acme/widgets",
    repository_owner: "acme",
    ref: "refs/heads/main",
    sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ...overrides,
  };
}

test("accepts a well-formed token and returns its claims", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  const { fetchFn } = stubFetch([[jwk]]);
  const jwks = new JwksCache(fetchFn, JWKS_URI);
  const token = await signToken(pair.privateKey, { alg: "RS256", kid: "key-1", typ: "JWT" }, baseClaims());

  const claims = await verifyOidcToken(token, jwks, { audience: AUDIENCE, ownerId: OWNER_ID }, 1_000_000);

  expect(claims).toEqual({
    repositoryId: "123456",
    repositoryOwnerId: OWNER_ID,
    repository: "acme/widgets",
    ref: "refs/heads/main",
    sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  });
});

test("rejects a token signed by a key absent from the JWKS", async () => {
  const legit = await generateKeyPair();
  const attacker = await generateKeyPair();
  const jwk = await jwkFor("key-1", legit.publicKey);
  const { fetchFn } = stubFetch([[jwk]]);
  const jwks = new JwksCache(fetchFn, JWKS_URI);
  // Attacker reuses a real, published kid but signs with their own private key.
  const token = await signToken(attacker.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims());

  await expect(
    verifyOidcToken(token, jwks, { audience: AUDIENCE, ownerId: OWNER_ID }, 1_000_000),
  ).rejects.toThrow(/signature/i);
});

test("rejects a token whose kid is unknown even after a refetch", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  // Every fetch returns the same set — key-2 never appears, even on refetch.
  const { fetchFn, calls } = stubFetch([[jwk]]);
  const jwks = new JwksCache(fetchFn, JWKS_URI);
  const attacker = await generateKeyPair();
  const token = await signToken(attacker.privateKey, { alg: "RS256", kid: "key-2" }, baseClaims());

  await expect(
    verifyOidcToken(token, jwks, { audience: AUDIENCE, ownerId: OWNER_ID }, 1_000_000),
  ).rejects.toThrow(/kid/i);
  // Initial load + exactly one refetch — not a retry loop.
  expect(calls()).toBe(2);
});

test("refetches the JWKS once when it sees an unknown kid, then succeeds", async () => {
  const pair1 = await generateKeyPair();
  const pair2 = await generateKeyPair();
  const jwk1 = await jwkFor("key-1", pair1.publicKey);
  const jwk2 = await jwkFor("key-2", pair2.publicKey);
  // key-2 only shows up after rotation — i.e. on the second fetch.
  const { fetchFn, calls } = stubFetch([[jwk1], [jwk1, jwk2]]);
  const jwks = new JwksCache(fetchFn, JWKS_URI);
  const token = await signToken(pair2.privateKey, { alg: "RS256", kid: "key-2" }, baseClaims());

  const claims = await verifyOidcToken(token, jwks, { audience: AUDIENCE, ownerId: OWNER_ID }, 1_000_000);

  expect(claims.repositoryId).toBe("123456");
  expect(calls()).toBe(2);
});

test("rejects an expired token", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  const { fetchFn } = stubFetch([[jwk]]);
  const jwks = new JwksCache(fetchFn, JWKS_URI);
  const token = await signToken(pair.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims({ exp: 999_000 }));

  await expect(
    verifyOidcToken(token, jwks, { audience: AUDIENCE, ownerId: OWNER_ID }, 1_000_000),
  ).rejects.toThrow(/expir/i);
});

test("rejects a token whose audience does not match", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  const { fetchFn } = stubFetch([[jwk]]);
  const jwks = new JwksCache(fetchFn, JWKS_URI);
  const token = await signToken(
    pair.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims({ aud: "https://wrong.example" }),
  );

  await expect(
    verifyOidcToken(token, jwks, { audience: AUDIENCE, ownerId: OWNER_ID }, 1_000_000),
  ).rejects.toThrow(/audience/i);
});

test("rejects a token whose repository_owner_id does not match", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  const { fetchFn } = stubFetch([[jwk]]);
  const jwks = new JwksCache(fetchFn, JWKS_URI);
  // Same repository_owner name, different numeric id — the shape a rename/transfer
  // or a reclaimed deleted name actually produces.
  const token = await signToken(
    pair.privateKey, { alg: "RS256", kid: "key-1" },
    baseClaims({ repository_owner_id: "1", repository_owner: "acme" }),
  );

  await expect(
    verifyOidcToken(token, jwks, { audience: AUDIENCE, ownerId: OWNER_ID }, 1_000_000),
  ).rejects.toThrow(/repository_owner_id/i);
});

test("rejects alg=none and alg=HS256 — only RS256 is accepted", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  let fetchCalls = 0;
  const fetchFn = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }) as unknown as typeof fetch;
  const jwks = new JwksCache(fetchFn, JWKS_URI);

  const noneToken = `${b64urlJson({ alg: "none", kid: "key-1" })}.${b64urlJson(baseClaims())}.`;
  await expect(
    verifyOidcToken(noneToken, jwks, { audience: AUDIENCE, ownerId: OWNER_ID }, 1_000_000),
  ).rejects.toThrow(/RS256|alg/i);

  const hsToken = `${b64urlJson({ alg: "HS256", kid: "key-1" })}.${b64urlJson(baseClaims())}.deadbeef`;
  await expect(
    verifyOidcToken(hsToken, jwks, { audience: AUDIENCE, ownerId: OWNER_ID }, 1_000_000),
  ).rejects.toThrow(/RS256|alg/i);

  // The alg check must run before any key resolution: neither rejection above
  // may have touched the JWKS endpoint.
  expect(fetchCalls).toBe(0);
});

test("rejects a token with a valid signature but a missing repository_id claim", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  const { fetchFn } = stubFetch([[jwk]]);
  const jwks = new JwksCache(fetchFn, JWKS_URI);
  const claims = baseClaims();
  delete claims["repository_id"];
  const token = await signToken(pair.privateKey, { alg: "RS256", kid: "key-1" }, claims);

  await expect(
    verifyOidcToken(token, jwks, { audience: AUDIENCE, ownerId: OWNER_ID }, 1_000_000),
  ).rejects.toThrow(/repository_id/i);
});

test("never includes the token in a thrown error, regardless of which check fails", async () => {
  const pair = await generateKeyPair();
  const attacker = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);

  const tokens: string[] = [
    `${b64urlJson({ alg: "none", kid: "key-1" })}.${b64urlJson(baseClaims())}.`,
    await signToken(attacker.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims()),
    await signToken(pair.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims({ exp: 1 })),
    await signToken(pair.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims({ aud: "nope" })),
  ];

  for (const token of tokens) {
    const { fetchFn } = stubFetch([[jwk]]);
    const jwks = new JwksCache(fetchFn, JWKS_URI);
    let message = "";
    try {
      await verifyOidcToken(token, jwks, { audience: AUDIENCE, ownerId: OWNER_ID }, 1_000_000);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(token);
    for (const segment of token.split(".")) {
      if (segment.length > 12) expect(message).not.toContain(segment);
    }
  }
});
