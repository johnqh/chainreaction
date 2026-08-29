export interface SessionPayload {
  userId: string;
  installationId: number;
  /**
   * The signed-in user's GitHub user-to-server OAuth access token, decrypted
   * for the lifetime of this in-process request only. Never re-serialize
   * this into a log line, an error message, or a JSON response body — see
   * `SessionStore`'s class doc for how it is protected at rest in the
   * cookie itself.
   */
  userToken: string;
  exp: number;
}

// A token-bearing cookie must not live as long as the old userId/
// installationId-only session did. Eight hours (one working session) bounds
// how long a stolen or leaked cookie stays useful, while combined with the
// per-mutation `assertInstallationMembership` recheck on /api/prs,
// /api/merge and /api/train (see src/server/api.ts), a revoked installation
// or a removed collaborator loses write access on their very next mutating
// call regardless of how much of the TTL remains. Not shorter than that:
// this is an interactive developer tool used within a single sitting, and a
// TTL measured in minutes would force re-authentication mid-task for no
// added protection once the per-mutation recheck exists.
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

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

// Domain-separation labels for HKDF, distinct from the raw-secret bytes the
// HMAC key above is imported from directly: the AES-GCM key is *derived*
// material (HKDF-Expand output under a different label), not the secret
// itself reused across two algorithms.
const TOKEN_KEY_SALT = new TextEncoder().encode("chainreaction-session-token-salt-v1");
const TOKEN_KEY_INFO = new TextEncoder().encode("chainreaction-session-token-encryption-v1");

/**
 * Derives an AES-256-GCM key for encrypting the session's embedded user
 * token from `CR_SESSION_SECRET`, via HKDF (Web Crypto only — no new
 * dependency). Using HKDF rather than the raw secret bytes means this key
 * is cryptographically independent of the HMAC signing key `importHmacKey`
 * derives from the same secret: a fixed salt/info pair distinct from
 * anything else derived from this secret is enough for that separation,
 * since the secret itself is assumed to carry sufficient entropy (the same
 * assumption `CR_SESSION_SECRET`'s own docs already make — see
 * `loadOAuthConfig`).
 */
async function deriveTokenKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: TOKEN_KEY_SALT, info: TOKEN_KEY_INFO },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts `token` under a fresh random 96-bit IV. Never reuses an IV across sessions. */
async function encryptToken(secret: string, token: string): Promise<{ iv: string; ciphertext: string }> {
  const key = await deriveTokenKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token)),
  );
  return { iv: b64url(iv), ciphertext: b64url(ciphertext) };
}

/**
 * Decrypts a token encrypted by `encryptToken`, or returns `null` on any
 * failure — wrong secret, tampered ciphertext, corrupt IV/base64. AES-GCM's
 * authentication tag makes a tampered ciphertext fail to decrypt at all
 * (not merely decrypt to garbage), so `null` here is a reliable signal to
 * the caller (`readSession`) that the whole cookie must be rejected.
 */
async function decryptToken(secret: string, iv: string, ciphertext: string): Promise<string | null> {
  try {
    const key = await deriveTokenKey(secret);
    const ivBytes = b64urlToBytes(iv);
    const ctBytes = b64urlToBytes(ciphertext);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, ctBytes);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

interface SerializedPayload {
  userId: string;
  installationId: number;
  exp: number;
  tokenIv: string;
  tokenCiphertext: string;
}

/**
 * Signs and verifies the session cookie value: `<base64url payload>.<base64url HMAC-SHA256>`.
 *
 * The cookie carries `userId`, `installationId`, and the signed-in user's
 * GitHub access token — the token is required so `ownedRepos` (see
 * `src/server/api.ts`) can authorize a client-named repo against *this
 * user's* actual access rather than the App installation's full reach (the
 * confused-deputy gap that made every login-scoped installation member able
 * to act on every repo the App could reach). The token is never stored in
 * the cookie in plaintext: it is AES-GCM-encrypted under a key derived from
 * this store's own secret (see `deriveTokenKey`) with a fresh random IV per
 * session, and the whole payload — ciphertext included — is still covered
 * by the outer HMAC signature below, so tampering with the ciphertext is
 * caught by the same signature check that already protects `installationId`.
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

  async createSession(userId: string, installationId: number, userToken: string): Promise<string> {
    const { iv, ciphertext } = await encryptToken(this.secret, userToken);
    const payload: SerializedPayload = {
      userId,
      installationId,
      exp: this.now() + this.ttlSeconds,
      tokenIv: iv,
      tokenCiphertext: ciphertext,
    };
    const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    const key = await importHmacKey(this.secret);
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64)),
    );
    return `${payloadB64}.${b64url(sig)}`;
  }

  /**
   * Returns the session iff `cookieValue` is well-formed, correctly signed
   * with this store's secret, unexpired, and its embedded token decrypts
   * cleanly. Any other case — missing, malformed, wrong signature, tampered
   * payload, expired, undecryptable token — returns `null`.
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
      typeof (parsed as Record<string, unknown>).exp !== "number" ||
      typeof (parsed as Record<string, unknown>).tokenIv !== "string" ||
      typeof (parsed as Record<string, unknown>).tokenCiphertext !== "string"
    ) {
      return null;
    }
    const serialized = parsed as SerializedPayload;
    if (serialized.exp <= this.now()) return null;

    const userToken = await decryptToken(this.secret, serialized.tokenIv, serialized.tokenCiphertext);
    if (userToken === null) return null; // tampered/undecryptable token ciphertext: fail closed

    return {
      userId: serialized.userId,
      installationId: serialized.installationId,
      exp: serialized.exp,
      userToken,
    };
  }
}
