import type { ProtectionProbe, RepoAdminApi } from "./adminApi";
import type { RepoCapabilities, ProtectionState } from "./types";

export const DEFAULT_WORKFLOW_PATH = ".github/workflows/chainreaction-validate.yml";

/**
 * The status check ChainReaction requires on a participating repo's default branch.
 * MUST match the job name in the validation workflow customers add at
 * DEFAULT_WORKFLOW_PATH. Plan D ships that template; until then this is the single
 * place the name is written, so it cannot be invented twice.
 */
export const DEFAULT_REQUIRED_CHECK = "chainreaction-validate";

// GitHub's actual "protection is unavailable on this plan" message. Every other
// 403 on this endpoint means something else entirely — Resource not accessible
// by integration (the App lacks the Administration permission), a secondary
// rate limit, or SAML/SSO enforcement — and none of those mean the repo is
// unprotectable. Misclassifying them as "unavailable" skips setProtection,
// reports the repo ready, and stalls the cascade at that level with nothing
// logged, so only this exact message may collapse to "unavailable".
const FREE_TIER_403 = /Upgrade to GitHub Pro|make this repository public/i;

function classify(full: string, probe: ProtectionProbe): ProtectionState {
  if (probe.status === 200) return "protected";
  if (probe.status === 404) return "unprotected";
  if (probe.status === 403) {
    if (probe.message && FREE_TIER_403.test(probe.message)) return "unavailable";
    // A 403 that isn't the free-tier plan limit is a real failure (missing
    // permission, rate limit, SSO enforcement, ...). Guessing here would
    // silently misclassify a protectable repo as control-plane.
    throw new Error(
      `${full}: 403 probing branch protection was not the free-tier plan limit` +
        (probe.message ? ` (${probe.message})` : "") +
        ` — refusing to classify as unavailable`,
    );
  }
  // Anything else is a real failure. Guessing here would silently misclassify a
  // repo and later stall a cascade with no explanation.
  throw new Error(`${full}: unexpected status probing branch protection: ${probe.status}`);
}

function classifyRequiresReviews(protection: ProtectionState, probe: ProtectionProbe): boolean {
  if (protection !== "protected") return false;
  return Boolean(probe.body?.["required_pull_request_reviews"]);
}

export async function probeRepo(
  api: RepoAdminApi,
  full: string,
  workflowPath: string = DEFAULT_WORKFLOW_PATH,
): Promise<RepoCapabilities> {
  const meta = await api.getRepo(full);
  if (typeof meta.defaultBranch !== "string" || meta.defaultBranch.length === 0) {
    // A partial or error-shaped response would otherwise carry `undefined`
    // typed as `string` into getProtection, which would 404 against
    // /branches/undefined/protection and be misreported as "unprotected" —
    // a branch that does not exist reported healthy.
    throw new Error(`${full}: repo metadata has no default branch`);
  }
  const [probe, hasWorkflow] = await Promise.all([
    api.getProtection(full, meta.defaultBranch),
    api.hasFile(full, workflowPath),
  ]);
  const protection = classify(full, probe);
  return {
    repo: full,
    defaultBranch: meta.defaultBranch,
    isPrivate: meta.isPrivate,
    protection,
    requiresReviews: classifyRequiresReviews(protection, probe),
    autoMergeEnabled: meta.allowAutoMerge,
    hasValidationWorkflow: hasWorkflow,
  };
}
