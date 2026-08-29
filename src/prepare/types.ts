export type MergeMechanism = "auto-merge" | "control-plane";

export type ProtectionState = "protected" | "unprotected" | "unavailable";

export interface RepoCapabilities {
  repo: string;
  defaultBranch: string;
  isPrivate: boolean;
  protection: ProtectionState;
  /** False when protection is "unprotected" or "unavailable" — there is nothing to require reviews. */
  requiresReviews: boolean;
  autoMergeEnabled: boolean;
  hasValidationWorkflow: boolean;
  /**
   * Distinct check-run names GitHub has ever reported on the default
   * branch's tip commit. `assess` compares each configured required check
   * against this list — a required status check GitHub has never reported
   * will never be satisfied, and branch protection would then wait on it
   * forever for every pull request, not only ChainReaction's.
   */
  observedChecks: string[];
}

export interface PrepareResult {
  repo: string;
  ready: boolean;
  mechanism: MergeMechanism;
  /** Human-readable reasons this repo cannot participate. Empty when ready. */
  blockers: string[];
}
