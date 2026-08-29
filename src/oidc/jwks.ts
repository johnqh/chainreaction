/** A single RSA public key as published in a JWKS document. */
export interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

interface JwksDocument {
  keys: Jwk[];
}

/** GitHub Actions' OIDC issuer and its published key set. Both are public,
 *  well-known GitHub endpoints — not anything specific to this installation. */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_JWKS_URI = "https://token.actions.githubusercontent.com/.well-known/jwks";

/**
 * Resolves a `kid` to an importable RSA public key, fetched from a JWKS
 * endpoint and cached by key id.
 *
 * GitHub rotates its signing keys. A time-based cache fails closed exactly
 * when a new key appears — the worst possible moment — so this cache instead
 * refetches, once, whenever it is asked for a `kid` it has never seen. A kid
 * that is still missing after that refetch really doesn't exist.
 */
export class JwksCache {
  private keys: Map<string, CryptoKey> | null = null;
  private inFlight: Promise<Map<string, CryptoKey>> | null = null;

  constructor(
    private fetchFn: typeof fetch = fetch,
    private jwksUri: string = GITHUB_OIDC_JWKS_URI,
  ) {}

  async keyFor(kid: string): Promise<CryptoKey> {
    if (!this.keys) await this.load();
    if (!this.keys!.has(kid)) {
      // Unknown kid: refetch exactly once before giving up. This must not
      // become a loop — a cache that refetches on every lookup would hammer
      // GitHub instead of rotating in the new key once and moving on.
      await this.load();
    }
    const key = this.keys!.get(kid);
    if (!key) {
      throw new Error("oidc: key lookup failed — kid not found in JWKS after refetch");
    }
    return key;
  }

  private async load(): Promise<void> {
    // Concurrent callers hitting a cold (or rotating) cache share one fetch
    // in flight instead of each firing their own request at GitHub — the
    // exact load shape N CI runs claiming simultaneously produces. Cleared
    // in .finally() on both success and failure so a transient error cannot
    // poison the cache with a permanently cached rejection.
    const existing = this.inFlight;
    if (existing) {
      this.keys = await existing;
      return;
    }
    const fetching = this.fetchAndParse().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = fetching;
    this.keys = await fetching;
  }

  private async fetchAndParse(): Promise<Map<string, CryptoKey>> {
    const res = await this.fetchFn(this.jwksUri);
    if (!res.ok) {
      throw new Error(`oidc: key lookup failed — JWKS fetch returned status ${res.status}`);
    }
    const body = (await res.json()) as JwksDocument;
    if (!Array.isArray(body.keys)) {
      throw new Error("oidc: key lookup failed — JWKS response has no keys array");
    }
    const next = new Map<string, CryptoKey>();
    for (const jwk of body.keys) {
      if (jwk.kty !== "RSA") continue; // only RSA keys are usable for RS256
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      next.set(jwk.kid, key);
    }
    return next;
  }
}
