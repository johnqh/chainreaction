import type { RepoAdminApi } from "./adminApi";
import type { RepoCapabilities, ProtectionState } from "./types";

export const DEFAULT_WORKFLOW_PATH = ".github/workflows/chainreaction-validate.yml";

function classify(status: number): ProtectionState {
  if (status === 200) return "protected";
  if (status === 404) return "unprotected";
  // 403 is GitHub's "Upgrade to GitHub Pro or make this repository public" —
  // branch protection and rulesets alike are unavailable on free-tier private repos.
  if (status === 403) return "unavailable";
  // Anything else is a real failure. Guessing here would silently misclassify a
  // repo and later stall a cascade with no explanation.
  throw new Error(`unexpected status probing branch protection: ${status}`);
}

export async function probeRepo(
  api: RepoAdminApi,
  full: string,
  workflowPath: string = DEFAULT_WORKFLOW_PATH,
): Promise<RepoCapabilities> {
  const meta = await api.getRepo(full);
  const [status, hasWorkflow] = await Promise.all([
    api.getProtection(full, meta.defaultBranch),
    api.hasFile(full, workflowPath),
  ]);
  return {
    repo: full,
    defaultBranch: meta.defaultBranch,
    isPrivate: meta.isPrivate,
    protection: classify(status),
    autoMergeEnabled: meta.allowAutoMerge,
    hasValidationWorkflow: hasWorkflow,
  };
}
