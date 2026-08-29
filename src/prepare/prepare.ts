import type { RepoAdminApi } from "./adminApi";
import type { MergeMechanism, PrepareResult, RepoCapabilities } from "./types";
import { probeRepo, DEFAULT_WORKFLOW_PATH } from "./probe";

export function mergeMechanismFor(caps: RepoCapabilities): MergeMechanism {
  // Protection is unavailable on free-tier private repos, so GitHub cannot merge
  // on our behalf. The control plane watches check_suite and merges itself.
  return caps.protection === "unavailable" ? "control-plane" : "auto-merge";
}

interface Assessment {
  caps: RepoCapabilities;
  mechanism: MergeMechanism;
  result: PrepareResult;
}

async function assess(
  api: RepoAdminApi,
  full: string,
  requiredChecks: string[],
  workflowPath: string,
): Promise<Assessment> {
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
  if (caps.protection === "protected") {
    // setProtection is a whole-object PUT replace: sending only requiredChecks
    // would silently strip whatever the customer already configured (required
    // reviews, signed commits, linear history, admin enforcement, ...).
    // Merging observed settings is also wrong — a review requirement our own
    // identity cannot satisfy (GitHub refuses self-approval) would make
    // auto-merge never fire. So: refuse, do not touch it.
    blockers.push(
      `${full} already has branch protection on ${caps.defaultBranch}` +
        (caps.requiresReviews ? " that requires pull request reviews" : "") +
        `. ChainReaction will not modify existing branch protection — remove it manually, ` +
        `or adjust it to allow this App's auto-merge, then prepare again.`,
    );
  }

  return { caps, mechanism, result: { repo: full, ready: blockers.length === 0, mechanism, blockers } };
}

/** Probe a repo and compute its blockers. Performs no writes. */
export async function assessRepo(
  api: RepoAdminApi,
  full: string,
  requiredChecks: string[],
  workflowPath: string = DEFAULT_WORKFLOW_PATH,
): Promise<PrepareResult> {
  const { result } = await assess(api, full, requiredChecks, workflowPath);
  return result;
}

/** `assessRepo`, then apply the mutations it implies. */
export async function prepareRepo(
  api: RepoAdminApi,
  full: string,
  requiredChecks: string[],
  workflowPath: string = DEFAULT_WORKFLOW_PATH,
): Promise<PrepareResult> {
  const { caps, mechanism, result } = await assess(api, full, requiredChecks, workflowPath);

  // A control-plane repo is about to be reported as unable to take part in a
  // cascade (see participationBlocker) — never mutate a repo you are about to
  // declare unusable. Its `ready: true` here only means "the probe found no
  // blocker", which mergeMechanismFor and participationBlocker both already
  // know is not the same thing as "can take part today".
  if (result.ready && mechanism !== "control-plane") {
    if (!caps.autoMergeEnabled) await api.enableAutoMerge(full);
    if (caps.protection === "unprotected") {
      // Status checks only, never reviews: an identity cannot approve its own PR,
      // and the human decision is ChainReaction's own approval gate.
      await api.setProtection(full, caps.defaultBranch, requiredChecks);
    }
  }

  return result;
}
