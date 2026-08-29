import type { ChangesetEntry } from "../graph/types";
import type { JwksCache } from "../oidc/jwks";
import type { TokenStore } from "../auth/appAuth";
import type { ValidationResult } from "../sandbox/workspace";

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
 * What the runner (`src/validate/runner.ts`) hands back after assembling the
 * changeset as one workspace, asserting it actually linked, and building and
 * testing every affected package. `ok` is true only when every result in
 * `results` is; a run that stops early on a build failure (see
 * `runValidation`) still reports the packages it got to, in dependency
 * order, so the failing one is always named.
 */
export interface ValidationOutcome {
  cascadeId: string;
  ok: boolean;
  results: ValidationResult[];
}

/**
 * One cascade awaiting a claim.
 *
 * `consumed` starts `false` and is flipped to `true` by `handleClaim`
 * synchronously, before it awaits the installation-token mint — not after —
 * so two `handleClaim` calls racing on the same cascade (a replayed OIDC
 * token fired twice, or an overlapping client retry; GitHub's tokens stay
 * valid for several minutes) cannot both observe `consumed === false` and
 * both mint. If the mint then fails, `handleClaim` rolls `consumed` back to
 * `false` so a transient failure still leaves the claim retryable.
 */
export interface PendingClaim {
  request: ValidationRequest;
  consumed: boolean;
}

/**
 * Everything `handleClaim` needs, injected so tests never touch the network
 * or the clock: the OIDC verifier's key cache, the installation-token
 * minter, the table of cascades currently awaiting a claim, and the
 * audience/owner/installation this control plane expects.
 *
 * `installationId` lives here — one per control plane, not one per pending
 * claim — because the model is one control plane watching one GitHub App
 * installation on one owner (see `ownerId`). Carrying it per-claim would add
 * a degree of freedom nothing here needs, and `handleClaim`'s authorisation
 * check only ever compares repo names against `request.repos` — it has no
 * way to notice a claim whose `installationId` doesn't actually cover those
 * repos. Keeping a single installation id at the top level makes that
 * mismatch structurally impossible instead of a convention someone has to
 * maintain when populating `cascades`.
 */
export interface ClaimDeps {
  jwks: JwksCache;
  tokens: TokenStore;
  cascades: Map<string, PendingClaim>;
  audience: string;
  ownerId: string;
  installationId: number;
}
