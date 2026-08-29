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
   * Distinct check names (check-runs and legacy statuses) GitHub has
   * reported on `observedChecksRef`. `assess` compares each configured
   * required check against this list — a required status check GitHub has
   * never reported will never be satisfied, and branch protection would
   * then wait on it forever for every pull request, not only ChainReaction's.
   */
  observedChecks: string[];
  /**
   * The commit `observedChecks` was actually sampled from: the most recent
   * pull request's head commit, or the default branch tip when the repo has
   * never had a PR. Required status checks are evaluated against a PR head,
   * not the default branch tip, so this is deliberately not always
   * `defaultBranch` — carried alongside `observedChecks` so a blocker can
   * name the commit it actually inspected instead of guessing "main".
   */
  observedChecksRef: string;
}

export interface PrepareResult {
  repo: string;
  ready: boolean;
  mechanism: MergeMechanism;
  /** Human-readable reasons this repo cannot participate. Empty when ready. */
  blockers: string[];
}
