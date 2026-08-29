import type { ChangesetEntry } from "../graph/types";
import { classifyPr } from "./lifecycle";

/**
 * Everything the train needs from the outside world, injected so tests never
 * touch GitHub, a registry, or a real timer.
 */
export interface TrainDeps {
  /** Merge the PR for `entry`. Resolve `false` (do not throw) for an ordinary merge failure. */
  mergePr(entry: ChangesetEntry, pr: number): Promise<boolean>;
  /**
   * Whether `entry.toVersion` is currently resolvable from wherever the next
   * repo's install will look. This is a propagation check, not the
   * idempotency guard `unified-cicd.yml`'s `check-npm-version` step performs
   * — merging a PR only starts publishing; it does not finish it.
   */
  isResolvable(entry: ChangesetEntry): Promise<boolean>;
  /** Injected clock. Must never be a real timer in a test. */
  sleep(ms: number): Promise<void>;
  /** Delay between resolvability polls. Default 5000. */
  pollIntervalMs?: number;
  /** Max resolvability polls before giving up on a single entry. Default 12. */
  maxPollAttempts?: number;
}

export interface MergedStep {
  pkg: string;
  repo: string;
}

export type TrainOutcome =
  | { status: "success"; merged: MergedStep[] }
  | {
      status: "stalled";
      /** Entries successfully merged and published before the stall. */
      merged: MergedStep[];
      /** The package whose PR stalled the train. */
      pkg: string;
      /** The repo whose PR stalled the train. */
      repo: string;
      /** Human-actionable reason: what to look at, in GitHub or the registry. */
      reason: string;
    };

/**
 * Run the Auto Merge train: merge every `ready` PR, wait for its publish to
 * become resolvable, re-classify with `classifyPr`, and repeat until every
 * entry has merged or the train stalls.
 *
 * Readiness is recomputed from `classifyPr` on every pass — never assumed
 * from `entries`' input order — so a PR only merges once its in-chain
 * dependencies have actually published, regardless of how `entries` (or
 * `prs`) happen to be ordered.
 */
export async function runTrain(
  entries: ChangesetEntry[],
  prs: Map<string, number>,
  deps: TrainDeps,
): Promise<TrainOutcome> {
  const merged: MergedStep[] = [];
  const published = new Set<string>();
  const pending = new Set(entries.map((e) => e.pkg));
  const maxAttempts = deps.maxPollAttempts ?? 12;
  const intervalMs = deps.pollIntervalMs ?? 5000;

  while (pending.size > 0) {
    const next = entries.find(
      (e) => pending.has(e.pkg) && classifyPr(e, entries, published) === "ready",
    );

    if (!next) {
      const stuck = entries.find((e) => pending.has(e.pkg));
      if (!stuck) {
        // Unreachable: pending.size > 0 guarantees some entry is pending.
        return {
          status: "stalled",
          merged,
          pkg: "<unknown>",
          repo: "<unknown>",
          reason: "internal error: no pending entry found despite a non-empty pending set",
        };
      }
      // Same intersection classifyPr uses internally — in-chain deps of
      // `stuck` that have not yet published — so the reason names exactly
      // what `stuck` is waiting on, not just that it is stuck.
      const inChain = new Set(entries.map((e) => e.pkg));
      const waitingFor = Object.keys(stuck.depBumps).filter(
        (dep) => inChain.has(dep) && !published.has(dep),
      );
      const reason =
        waitingFor.length > 0
          ? `${stuck.pkg} is blocked — waiting for upstream package(s) to publish: ${waitingFor.join(", ")}`
          : `${stuck.pkg} never became ready to merge, but no unpublished in-chain dependency could ` +
            `be identified — this indicates a readiness-tracking bug, not a normal stall`;
      return {
        status: "stalled",
        merged,
        pkg: stuck.pkg,
        repo: stuck.repo,
        reason,
      };
    }

    const pr = prs.get(next.repo);
    if (pr === undefined) {
      return {
        status: "stalled",
        merged,
        pkg: next.pkg,
        repo: next.repo,
        reason: `no open PR is recorded for ${next.repo}, cannot merge ${next.pkg}`,
      };
    }

    const mergeOk = await deps.mergePr(next, pr);
    if (!mergeOk) {
      return {
        status: "stalled",
        merged,
        pkg: next.pkg,
        repo: next.repo,
        reason: `merging PR #${pr} for ${next.repo} (${next.pkg}) failed`,
      };
    }

    let resolvable = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (await deps.isResolvable(next)) {
        resolvable = true;
        break;
      }
      if (attempt < maxAttempts - 1) {
        await deps.sleep(intervalMs);
      }
    }
    if (!resolvable) {
      return {
        status: "stalled",
        merged,
        pkg: next.pkg,
        repo: next.repo,
        reason:
          `${next.pkg}@${next.toVersion} merged in ${next.repo} but never became resolvable ` +
          `after ${maxAttempts} checks — the publish may have failed or the registry is lagging`,
      };
    }

    published.add(next.pkg);
    pending.delete(next.pkg);
    merged.push({ pkg: next.pkg, repo: next.repo });
  }

  return { status: "success", merged };
}
