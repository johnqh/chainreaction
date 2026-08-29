import { GITHUB_OIDC_ISSUER, type JwksCache } from "./jwks";

/**
 * The claims this control plane relies on out of a verified GitHub Actions
 * OIDC token. `repository` is returned for logging only — it is a mutable
 * name (renamed, transferred, or reclaimed after deletion) and is never
 * itself the basis of an authorisation decision. `repositoryOwnerId` is the
 * numeric id actually checked against the expected owner.
 */
export interface OidcClaims {
  repositoryId: string;
  repositoryOwnerId: string;
  repository: string;
  ref: string;
  sha: string;
}

function b64urlToBytes(segment: string): Uint8Array<ArrayBuffer> {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  const binary = atob(padded + "=".repeat(padLength));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64urlToJson(segment: string): Record<string, unknown> {
  const decoded = JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("oidc: malformed token — segment is not a JSON object");
  }
  return decoded as Record<string, unknown>;
}

function requireStringClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`oidc: malformed token — missing ${name} claim`);
  }
  return value;
}

/**
 * Verifies a GitHub Actions OIDC token end to end: signature, issuer,
 * audience, expiry, and the numeric repository-owner id. Returns the claims
 * this control plane needs on success. Every failure throws an error naming
 * the specific check that failed — never the token, and never any substring
 * long enough to reconstruct it.
 */
export async function verifyOidcToken(
  token: string,
  jwks: JwksCache,
  expect: { audience: string; ownerId: string },
  now: number = Math.floor(Date.now() / 1000),
): Promise<OidcClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("oidc: malformed token — expected three dot-separated segments");
  }
  // Safe: length is checked above, so all three indices exist.
  const headerSeg = parts[0]!;
  const payloadSeg = parts[1]!;
  const sigSeg = parts[2]!;

  let header: Record<string, unknown>;
  try {
    header = b64urlToJson(headerSeg);
  } catch {
    throw new Error("oidc: malformed token — header is not valid base64url JSON");
  }

  // This check MUST come before any key resolution or signature check. A
  // token with alg:"none" carries no signature to verify at all; resolving
  // the key first and verifying second would let such a token sail through
  // untouched. Reject on alg alone, before jwks is asked for anything.
  if (header["alg"] !== "RS256") {
    throw new Error("oidc: algorithm check failed — only RS256 is accepted");
  }

  const kid = header["kid"];
  if (typeof kid !== "string" || kid.length === 0) {
    throw new Error("oidc: malformed token — header has no kid");
  }

  const key = await jwks.keyFor(kid);

  const signature = b64urlToBytes(sigSeg);
  const signedInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    signedInput,
  );
  if (!validSignature) {
    throw new Error("oidc: signature verification failed");
  }

  let payload: Record<string, unknown>;
  try {
    payload = b64urlToJson(payloadSeg);
  } catch {
    throw new Error("oidc: malformed token — payload is not valid base64url JSON");
  }

  if (payload["iss"] !== GITHUB_OIDC_ISSUER) {
    throw new Error("oidc: issuer check failed");
  }

  const aud = payload["aud"];
  const audienceMatches =
    aud === expect.audience || (Array.isArray(aud) && aud.includes(expect.audience));
  if (!audienceMatches) {
    throw new Error("oidc: audience check failed");
  }

  const exp = payload["exp"];
  if (typeof exp !== "number") {
    throw new Error("oidc: malformed token — missing exp claim");
  }
  if (exp <= now) {
    throw new Error("oidc: expiry check failed — token has expired");
  }

  const nbf = payload["nbf"];
  if (typeof nbf === "number" && nbf > now) {
    throw new Error("oidc: not-before check failed — token is not yet valid");
  }

  // Checked against the numeric id, deliberately never the name:
  // repository_owner is mutable (renamed, transferred, or reclaimed after
  // deletion) while repository_owner_id is not. Authorising on the name
  // would be one rename away from handing a scoped token to the wrong party.
  const repositoryOwnerId = requireStringClaim(payload, "repository_owner_id");
  if (repositoryOwnerId !== expect.ownerId) {
    throw new Error("oidc: repository_owner_id check failed");
  }

  const repositoryId = requireStringClaim(payload, "repository_id");
  const repository = requireStringClaim(payload, "repository");
  const ref = requireStringClaim(payload, "ref");
  const sha = requireStringClaim(payload, "sha");

  return { repositoryId, repositoryOwnerId, repository, ref, sha };
}
