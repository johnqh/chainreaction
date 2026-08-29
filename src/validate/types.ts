import type { ChangesetEntry } from "../graph/types";
import type { JwksCache } from "../oidc/jwks";
import type { TokenStore } from "../auth/appAuth";

/**
 * What a legitimate claimant receives: the cascade it is validating and the
 * repositories that make it up. `repos` is the authorisation boundary —
 * `handleClaim` checks the claiming repository against this list before
 * minting anything, and the installation token returned alongside it must
 * never reach further than these repos.
 */
export interface ValidationRequest {
  cascadeId: string;
  changeset: ChangesetEntry[];
  repos: string[];
}

export interface ClaimResult {
  token: string;
  request: ValidationRequest;
}

/**
 * One cascade awaiting a claim.
 *
 * `installationId` is the GitHub App installation whose token covers
 * `request.repos` — a single control-plane instance watches one owner (see
 * `ClaimDeps.ownerId`), so one installation id is all any cascade needs.
 *
 * `consumed` starts `false` and is flipped to `true` exactly once, by
 * `handleClaim`, immediately after a legitimate claim mints its token and
 * before the result is returned. A second claim — e.g. a replayed OIDC
 * token, which stays valid for several minutes — must find `consumed` true
 * and refuse rather than minting a second token.
 */
export interface PendingClaim {
  request: ValidationRequest;
  installationId: number;
  consumed: boolean;
}

/**
 * Everything `handleClaim` needs, injected so tests never touch the network
 * or the clock: the OIDC verifier's key cache, the installation-token
 * minter, the table of cascades currently awaiting a claim, and the
 * audience/owner this control plane expects an OIDC token to carry.
 */
export interface ClaimDeps {
  jwks: JwksCache;
  tokens: TokenStore;
  cascades: Map<string, PendingClaim>;
  audience: string;
  ownerId: string;
}
