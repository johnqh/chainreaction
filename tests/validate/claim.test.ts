import { test, expect } from "bun:test";
import { JwksCache, type Jwk } from "../../src/oidc/jwks";
import { TokenStore, type AppCredentials } from "../../src/auth/appAuth";
import { handleClaim } from "../../src/validate/claim";
import type { ClaimDeps, PendingClaim, ValidationRequest } from "../../src/validate/types";
import type { ChangesetEntry } from "../../src/graph/types";

const AUDIENCE = "https://example-consumer.test";
const OWNER_ID = "9999";
const JWKS_URI = "https://example.test/.well-known/jwks";
const INSTALLATION_ID = 42;

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

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // handleClaim delegates to verifyOidcToken with no injected clock, so
  // these must be valid against the real wall clock (verifyOidcToken's
  // clock injection is exercised directly in tests/oidc/verify.test.ts).
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: AUDIENCE,
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300,
    repository_id: "123456",
    repository_owner_id: OWNER_ID,
    repository: "acme/widgets",
    repository_owner: "acme",
    ref: "refs/heads/main",
    sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ...overrides,
  };
}

/** Serves one JWKS document forever — none of these tests rotate keys. */
function stubJwksFetch(keys: Jwk[]): typeof fetch {
  return (async () => new Response(JSON.stringify({ keys }), { status: 200 })) as unknown as typeof fetch;
}

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

/**
 * Serves a scripted installation-token exchange; each call mints a distinct
 * token. `delayMs`, when given, resolves on a later tick so two concurrent
 * callers genuinely overlap in-flight instead of serialising — a
 * synchronously-resolving stub would let the first call finish end to end
 * before the second even starts, hiding a race regardless of whether it's
 * actually closed.
 */
function stubInstallationFetch(delayMs = 0): { fetchFn: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchFn = (async () => {
    n++;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(
      JSON.stringify({
        token: `installation-token-${n}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => n };
}

const CHANGESET: ChangesetEntry[] = [
  { pkg: "widgets", repo: "acme/widgets", fromVersion: "1.0.0", toVersion: "1.1.0", depBumps: {}, level: 0 },
];

async function makeDeps(overrides: {
  keys?: Jwk[];
  jwksFetch?: typeof fetch;
  installationFetch?: typeof fetch;
  installationDelayMs?: number;
  cascades?: Map<string, PendingClaim>;
} = {}): Promise<{ deps: ClaimDeps; installationCalls?: () => number }> {
  const keys = overrides.keys ?? [];
  const jwks = new JwksCache(overrides.jwksFetch ?? stubJwksFetch(keys), JWKS_URI);
  const creds: AppCredentials = { appId: "1", privateKeyPem: await generatePem() };
  const { fetchFn: installFetch, calls } = stubInstallationFetch(overrides.installationDelayMs);
  const tokens = new TokenStore(creds, overrides.installationFetch ?? installFetch);

  const request: ValidationRequest = {
    cascadeId: "cascade-1",
    changeset: CHANGESET,
    repos: ["acme/widgets"],
  };
  const cascades =
    overrides.cascades ??
    new Map<string, PendingClaim>([["cascade-1", { request, consumed: false }]]);

  return {
    deps: {
      jwks, tokens, cascades,
      audience: AUDIENCE, ownerId: OWNER_ID, installationId: INSTALLATION_ID,
    },
    installationCalls: calls,
  };
}

test("returns a token and the changeset for a legitimate claim", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  const { deps } = await makeDeps({ keys: [jwk] });
  const token = await signToken(pair.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims());

  const result = await handleClaim(token, "cascade-1", deps);

  expect(result.token).toBe("installation-token-1");
  expect(result.request).toEqual({
    cascadeId: "cascade-1",
    changeset: CHANGESET,
    repos: ["acme/widgets"],
  });
});

test("refuses when the OIDC token fails verification", async () => {
  const legit = await generateKeyPair();
  const attacker = await generateKeyPair();
  const jwk = await jwkFor("key-1", legit.publicKey);
  const { deps } = await makeDeps({ keys: [jwk] });
  // Signed by an attacker's key over a real, published kid.
  const token = await signToken(attacker.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims());

  await expect(handleClaim(token, "cascade-1", deps)).rejects.toThrow(/signature/i);
});

test("refuses when the cascade id is unknown", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  const { deps } = await makeDeps({ keys: [jwk] });
  const token = await signToken(pair.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims());

  await expect(handleClaim(token, "no-such-cascade", deps)).rejects.toThrow(/unknown cascade/i);
});

test("refuses when the claiming repository is not part of that cascade", async () => {
  // The authorisation rule: verifying the OIDC token only proves which repo
  // the run belongs to. Here that repo (acme/other) is real and its token
  // verifies cleanly — but it is not one of the repos cascade-1 covers. An
  // implementation that stops at OIDC verification (and never checks
  // request.repos) would let this claim through and mint a token scoped to
  // every repo in the cascade, including ones this repo has no business
  // touching. This must be refused.
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  const { deps } = await makeDeps({ keys: [jwk] });
  const token = await signToken(
    pair.privateKey, { alg: "RS256", kid: "key-1" },
    baseClaims({ repository: "acme/other", repository_id: "999999" }),
  );

  await expect(handleClaim(token, "cascade-1", deps)).rejects.toThrow(/not part of|not a member|authoris|authoriz/i);
});

test("refuses a second claim for the same cascade from the same run", async () => {
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  const { deps, installationCalls } = await makeDeps({ keys: [jwk] });
  const token = await signToken(pair.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims());

  const first = await handleClaim(token, "cascade-1", deps);
  expect(first.token).toBe("installation-token-1");

  // Same (still-valid) OIDC token, replayed against the same cascade.
  await expect(handleClaim(token, "cascade-1", deps)).rejects.toThrow(/already claimed|consumed|single.use/i);
  // No second installation token was minted for the replay.
  expect(installationCalls!()).toBe(1);
});

test("two concurrent claims for the same cascade: exactly one succeeds, one is refused", async () => {
  // TOCTOU guard: a replayed still-valid OIDC token fired twice, or an
  // overlapping client retry, must not both observe `consumed === false`
  // and both mint. Unlike the sequential replay test above, this starts
  // both calls before awaiting either — genuine overlap, not two calls in
  // sequence — and the installation-token mint resolves on a later tick so
  // the window between "authorised" and "marked consumed" would actually be
  // exercised if it existed.
  const pair = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);
  const { deps, installationCalls } = await makeDeps({ keys: [jwk], installationDelayMs: 5 });
  const token = await signToken(pair.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims());

  const [a, b] = await Promise.allSettled([
    handleClaim(token, "cascade-1", deps),
    handleClaim(token, "cascade-1", deps),
  ]);

  const outcomes = [a, b];
  const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
  const rejected = outcomes.filter((o) => o.status === "rejected");
  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);
  expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
    /already claimed|consumed|single.use/i,
  );
  // Exactly one installation token was ever minted, not two.
  expect(installationCalls!()).toBe(1);
});

test("no token, OIDC or installation, appears in any thrown error", async () => {
  const pair = await generateKeyPair();
  const attacker = await generateKeyPair();
  const jwk = await jwkFor("key-1", pair.publicKey);

  const oidcToken = await signToken(pair.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims());
  const badSigToken = await signToken(attacker.privateKey, { alg: "RS256", kid: "key-1" }, baseClaims());
  const wrongRepoToken = await signToken(
    pair.privateKey, { alg: "RS256", kid: "key-1" },
    baseClaims({ repository: "acme/other", repository_id: "999999" }),
  );

  const scenarios: { token: string; cascadeId: string; makeDepsFn: () => Promise<ClaimDeps> }[] = [
    { token: badSigToken, cascadeId: "cascade-1", makeDepsFn: async () => (await makeDeps({ keys: [jwk] })).deps },
    { token: oidcToken, cascadeId: "no-such-cascade", makeDepsFn: async () => (await makeDeps({ keys: [jwk] })).deps },
    { token: wrongRepoToken, cascadeId: "cascade-1", makeDepsFn: async () => (await makeDeps({ keys: [jwk] })).deps },
  ];

  for (const scenario of scenarios) {
    const deps = await scenario.makeDepsFn();
    let message = "";
    try {
      await handleClaim(scenario.token, scenario.cascadeId, deps);
      throw new Error("expected handleClaim to reject");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(scenario.token);
    expect(message).not.toContain(oidcToken);
    expect(message).not.toMatch(/installation-token-\d/);
  }

  // Replay case also mints (and must not leak) a real installation token.
  {
    const { deps } = await makeDeps({ keys: [jwk] });
    await handleClaim(oidcToken, "cascade-1", deps);
    let message = "";
    try {
      await handleClaim(oidcToken, "cascade-1", deps);
      throw new Error("expected handleClaim to reject");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(oidcToken);
    expect(message).not.toMatch(/installation-token-\d/);
  }
});
