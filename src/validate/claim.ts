import { verifyOidcToken } from "../oidc/verify";
import type { ClaimDeps, ClaimResult } from "./types";

/**
 * A CI run presents its OIDC token and the cascade id it believes it should
 * validate; this hands back a scoped installation token and the changeset,
 * or refuses.
 *
 * `verifyOidcToken` is authentication: it proves *which repository* the
 * calling run belongs to, cryptographically, against GitHub's own JWKS. It
 * does not, and cannot, know anything about cascades — so on its own it
 * answers "who are you", never "are you allowed to have this".
 *
 * The line below — `pending.request.repos.includes(claims.repository)` — is
 * the authorisation check that answers the second question, and it is the
 * entire point of this function. Skip it and any repository in the
 * installation with a workflow that can mint an OIDC token (that is: any
 * repository at all) could claim any cascade in flight and walk away with
 * an installation token scoped to every repo in it — a token that can push
 * branches and open PRs across all of them. Do not remove or weaken this
 * check without re-reading this comment.
 *
 * Every rejection throws a message naming the failed check and nothing
 * else — never the OIDC token presented, never the installation token
 * minted below.
 */
export async function handleClaim(
  oidcToken: string,
  cascadeId: string,
  deps: ClaimDeps,
): Promise<ClaimResult> {
  const claims = await verifyOidcToken(oidcToken, deps.jwks, {
    audience: deps.audience,
    ownerId: deps.ownerId,
  });

  const pending = deps.cascades.get(cascadeId);
  if (!pending) {
    // Deliberately identical whether the id was never issued or was already
    // claimed and cleaned up elsewhere: neither case should tell a caller
    // anything more than "this claim does not proceed".
    throw new Error("claim refused: unknown cascade id");
  }

  if (pending.consumed) {
    throw new Error("claim refused: cascade already claimed — single use");
  }

  // --- Authorisation rule (see function doc comment) ---
  // `claims.repository` is authenticated — GitHub's own signature vouches
  // for it. Whether it belongs in *this* cascade is a fact only the pending
  // claim knows, and checking it is what stands between "a valid CI run"
  // and "a valid CI run for the right repository".
  //
  // This is a name comparison, not an id comparison, and that is a
  // deliberate gap from Task 1's standard: `verifyOidcToken` authorises the
  // owner on `repository_owner_id` specifically because names are mutable —
  // renamed, transferred, or freed by deletion and later reclaimed by
  // someone else. `ValidationRequest.repos` and `ChangesetEntry` both carry
  // only `repo: string`, with no repository id anywhere in this data model,
  // so there is nothing better to compare against today. The residual risk
  // this leaves is bounded: an attacker would already have to be inside the
  // same GitHub org — `ownerId` above pins that — and would additionally
  // have to create a repository that reuses a name freed from this cascade
  // between the cascade being planned and this claim being made. If
  // `ValidationRequest` ever gains repository ids, this check should move
  // to comparing those instead.
  if (!pending.request.repos.includes(claims.repository)) {
    throw new Error(
      "claim refused: claiming repository is not part of this cascade — authorisation failed",
    );
  }

  // Single-use: flip *before* awaiting the mint, not after, so two calls
  // racing on the same cascade (a replayed still-valid OIDC token fired
  // twice, or an overlapping client retry) cannot both read `consumed ===
  // false` before either has a chance to set it. Whichever call reaches
  // this line first closes the window for every other racer immediately —
  // no `await` separates the read of `consumed` above from this write.
  pending.consumed = true;

  let token: string;
  try {
    token = await deps.tokens.get(deps.installationId);
  } catch (err) {
    // A transient mint failure (e.g. GitHub outage) must not permanently
    // burn a claim that was never actually fulfilled — roll back so the
    // same legitimate run can retry.
    pending.consumed = false;
    throw err;
  }

  return { token, request: pending.request };
}
