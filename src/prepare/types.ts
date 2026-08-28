export type MergeMechanism = "auto-merge" | "control-plane";

export type ProtectionState = "protected" | "unprotected" | "unavailable";

export interface RepoCapabilities {
  repo: string;
  defaultBranch: string;
  isPrivate: boolean;
  protection: ProtectionState;
  autoMergeEnabled: boolean;
  hasValidationWorkflow: boolean;
}

export interface PrepareResult {
  repo: string;
  ready: boolean;
  mechanism: MergeMechanism;
  /** Human-readable reasons this repo cannot participate. Empty when ready. */
  blockers: string[];
}
