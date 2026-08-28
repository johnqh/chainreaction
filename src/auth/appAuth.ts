import { pemToPkcs8Der } from "./pem";

export interface AppCredentials {
  appId: string;
  privateKeyPem: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: number;
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlJson = (value: unknown): string =>
  b64url(new TextEncoder().encode(JSON.stringify(value)));

export async function mintAppJwt(
  creds: AppCredentials,
  nowSeconds: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8Der(creds.privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  // GitHub rejects a JWT older than 60s or living beyond 10 minutes.
  const body =
    `${b64urlJson({ alg: "RS256", typ: "JWT" })}.` +
    `${b64urlJson({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: creds.appId })}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body)),
  );
  return `${body}.${b64url(sig)}`;
}

const REFRESH_MARGIN_SECONDS = 120;

export class TokenStore {
  private cache = new Map<number, InstallationToken>();

  constructor(
    private creds: AppCredentials,
    private fetchFn: typeof fetch = fetch,
    private now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async get(installationId: number): Promise<string> {
    const now = this.now();
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt - now > REFRESH_MARGIN_SECONDS) return cached.token;

    const jwt = await mintAppJwt(this.creds, now);
    const res = await this.fetchFn(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      { method: "POST",
        headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" } },
    );
    if (!res.ok) {
      // Never include the JWT or the key in the message.
      throw new Error(`installation token exchange failed: ${res.status}`);
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    const minted: InstallationToken = {
      token: body.token,
      expiresAt: Math.floor(new Date(body.expires_at).getTime() / 1000),
    };
    this.cache.set(installationId, minted);
    return minted.token;
  }
}
