export interface SessionPayload {
  userId: string;
  installationId: number;
  exp: number;
}

export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlToBytes(segment: string): Uint8Array<ArrayBuffer> {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  const binary = atob(padded + "=".repeat(padLength));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Signs and verifies the session cookie value: `<base64url payload>.<base64url HMAC-SHA256>`.
 *
 * The cookie carries only `userId` and `installationId` — never the GitHub
 * user access token, which stays server-side only for the brief window it is
 * needed (see `PendingLoginStore`) and never touches the browser at all.
 *
 * Verification uses `crypto.subtle.verify`, which compares the signature in
 * constant time — a hand-rolled `===` or byte-loop comparison here would
 * leak timing information about how many leading bytes of a forged
 * signature happen to match.
 */
export class SessionStore {
  constructor(
    private secret: string,
    private now: () => number = () => Math.floor(Date.now() / 1000),
    private ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
  ) {
    if (secret.length === 0) {
      throw new Error("session secret must not be empty");
    }
  }

  async createSession(userId: string, installationId: number): Promise<string> {
    const payload: SessionPayload = { userId, installationId, exp: this.now() + this.ttlSeconds };
    const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    const key = await importHmacKey(this.secret);
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64)),
    );
    return `${payloadB64}.${b64url(sig)}`;
  }

  /**
   * Returns the session iff `cookieValue` is well-formed, correctly signed
   * with this store's secret, and unexpired. Any other case — missing,
   * malformed, wrong signature, tampered payload, expired — returns `null`.
   *
   * Callers must treat `null` as "reject this request" (401 / redirect to
   * login), never as "proceed unauthenticated with some default scope": a
   * tampered cookie must fail closed, not fall through to whatever behavior
   * an anonymous request gets.
   */
  async readSession(cookieValue: string | undefined | null): Promise<SessionPayload | null> {
    if (!cookieValue) return null;
    const dot = cookieValue.indexOf(".");
    if (dot < 0) return null;
    const payloadB64 = cookieValue.slice(0, dot);
    const sigB64 = cookieValue.slice(dot + 1);
    if (payloadB64.length === 0 || sigB64.length === 0) return null;

    let sigBytes: Uint8Array<ArrayBuffer>;
    try {
      sigBytes = b64urlToBytes(sigB64);
    } catch {
      return null;
    }

    const key = await importHmacKey(this.secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(payloadB64),
    );
    if (!valid) return null; // wrong or tampered signature: rejected outright, payload is never even parsed as trusted

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).userId !== "string" ||
      typeof (parsed as Record<string, unknown>).installationId !== "number" ||
      typeof (parsed as Record<string, unknown>).exp !== "number"
    ) {
      return null;
    }
    const session = parsed as SessionPayload;
    if (session.exp <= this.now()) return null;
    return session;
  }
}
