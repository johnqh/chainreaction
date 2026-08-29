import type { PrepareResult } from "../prepare/types";
import type { CascadePlan } from "../plan/planCascade";
import { participationBlocker } from "../plan/readiness";

const EXIT_OK = 0;
const EXIT_ERROR = 1;

export interface CliDeps {
  log: (line: string) => void;
  prepare: (repo: string) => Promise<PrepareResult>;
  plan: (changed: string, targets: string[] | "all") => Promise<CascadePlan>;
}

const USAGE = [
  "usage: chainreaction <command> [options]",
  "",
  "commands:",
  "  prepare <owner/repo>                 check (and ready) one repo for the cascade",
  "  plan <package> (--all|--targets a,b)  plan a cascade from a changed package",
].join("\n");

async function runPrepare(argv: string[], deps: CliDeps): Promise<number> {
  const repo = argv[0];
  if (!repo) {
    deps.log(`prepare requires a repository argument.\n\n${USAGE}`);
    return EXIT_ERROR;
  }

  let result: PrepareResult;
  try {
    result = await deps.prepare(repo);
  } catch (err) {
    deps.log(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  }

  if (result.ready) {
    // ready:true from the probe is not the same question as "can this repo
    // take part in a cascade today" — a control-plane repo passes the probe
    // but has no merge mechanism implemented yet. participationBlocker is the
    // one place that distinction is made; without it, prepare would print
    // "ready" for exactly the repo plan is about to refuse.
    const blocker = participationBlocker(result);
    if (!blocker) {
      deps.log(`${result.repo}: ready (${result.mechanism})`);
      return EXIT_OK;
    }
    deps.log(`${result.repo}: prepared, but cannot take part yet (${blocker})`);
    return EXIT_ERROR;
  }

  deps.log(`${result.repo}: not ready (${result.mechanism})`);
  for (const blocker of result.blockers) {
    deps.log(`  - ${blocker}`);
  }
  return EXIT_ERROR;
}

function parseTargets(argv: string[]): { targets: string[] | "all" } | { error: string } {
  const hasAll = argv.includes("--all");
  const targetsIndex = argv.indexOf("--targets");
  const hasTargets = targetsIndex !== -1;

  if (hasAll && hasTargets) {
    return {
      error:
        "pass exactly one of --all or --targets, not both — an unscoped combination of the " +
        "two would be ambiguous about which repos are actually authorized.",
    };
  }
  if (!hasAll && !hasTargets) {
    return {
      error:
        "refusing to plan without an explicit scope. Pass --all to publish every affected " +
        "package, or --targets a,b,c to name exactly which ones.",
    };
  }
  if (hasAll) return { targets: "all" };

  const TARGETS_ERROR = "--targets requires a comma-separated list of package names.";
  const raw = argv[targetsIndex + 1];
  if (!raw || raw.startsWith("--")) {
    return { error: TARGETS_ERROR };
  }
  const targets = raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (targets.length === 0) {
    // "--targets ,,," and "--targets ' , '" are truthy and not flag-shaped, so
    // they pass the check above; without this, they filter down to an empty
    // array that is indistinguishable from "no targets given" one layer down,
    // where a typo would be rejected by an unhandled throw instead of a
    // clean CLI error.
    return { error: TARGETS_ERROR };
  }
  return { targets };
}

function printPlan(plan: CascadePlan, deps: CliDeps): void {
  deps.log(`plan for ${plan.changed}: ${plan.affected.length} package(s) affected`);
  plan.levels.forEach((level, index) => {
    deps.log(`level ${index}: ${level.join(", ")}`);
  });

  if (plan.skipped.length > 0) {
    deps.log("");
    deps.log(
      "skipped repositories (dropped from the graph — any dependents reachable only " +
        "through them are also missing from this plan, not just these repos themselves):",
    );
    for (const skip of plan.skipped) {
      deps.log(`  - ${skip.repo}: ${skip.reason}`);
    }
  }
}

async function runPlan(argv: string[], deps: CliDeps): Promise<number> {
  const changed = argv[0];
  if (!changed) {
    deps.log(`plan requires a changed package argument.\n\n${USAGE}`);
    return EXIT_ERROR;
  }

  const scoped = parseTargets(argv.slice(1));
  if ("error" in scoped) {
    deps.log(scoped.error);
    return EXIT_ERROR;
  }

  let plan: CascadePlan;
  try {
    plan = await deps.plan(changed, scoped.targets);
  } catch (err) {
    // assertScoped and assertPrepared both throw — a legitimate guard
    // failure must read the same as every other validation failure in this
    // file: a clean message and an error exit, never an unhandled rejection.
    deps.log(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  }
  printPlan(plan, deps);
  return EXIT_OK;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "prepare":
      return runPrepare(rest, deps);
    case "plan":
      return runPlan(rest, deps);
    default:
      deps.log(USAGE);
      return EXIT_ERROR;
  }
}
