import type { RepoAdminApi } from "./adminApi";
import type { MergeMechanism, PrepareResult, RepoCapabilities } from "./types";
import { probeRepo, DEFAULT_WORKFLOW_PATH } from "./probe";

export function mergeMechanismFor(caps: RepoCapabilities): MergeMechanism {
  // Protection is unavailable on free-tier private repos, so GitHub cannot merge
  // on our behalf. The control plane watches check_suite and merges itself.
  return caps.protection === "unavailable" ? "control-plane" : "auto-merge";
}

export async function prepareRepo(
  api: RepoAdminApi,
  full: string,
  requiredChecks: string[],
  workflowPath: string = DEFAULT_WORKFLOW_PATH,
): Promise<PrepareResult> {
  const caps = await probeRepo(api, full, workflowPath);
  const mechanism = mergeMechanismFor(caps);
  const blockers: string[] = [];

  if (!caps.hasValidationWorkflow) {
    blockers.push(
      `${full} is missing ${workflowPath}. ChainReaction cannot add it — the App does not ` +
        `request Workflows:write — so add the file and merge it, then prepare again.`,
    );
  }
  if (requiredChecks.length === 0) {
    blockers.push(
      `${full} has no required status check. Auto-merge needs an unsatisfied requirement to ` +
        `wait on, so a repo with no CI cannot take part in a cascade.`,
    );
  }

  if (blockers.length === 0) {
    if (!caps.autoMergeEnabled) await api.enableAutoMerge(full);
    if (caps.protection !== "unavailable") {
      // Status checks only, never reviews: an identity cannot approve its own PR,
      // and the human decision is ChainReaction's own approval gate.
      await api.setProtection(full, caps.defaultBranch, requiredChecks);
    }
  }

  return { repo: full, ready: blockers.length === 0, mechanism, blockers };
}
