import type { ChangesetEntry } from "../graph/types";
import type { GhClient } from "../github/client";
import { Cascade, detectStall, type NodeState } from "./state";

const STALL_TIMEOUT_MS = 15 * 60_000;

export async function pollOnce(
  cascade: Cascade,
  entries: ChangesetEntry[],
  prs: Map<string, number>,
  gh: GhClient,
  now: number = Date.now(),
): Promise<void> {
  for (const entry of entries) {
    const pr = prs.get(entry.repo);
    if (pr === undefined) continue;

    const ghState = await gh.prState(entry.repo, pr);
    const next: NodeState = ghState === "MERGED" ? "merged" : "ci-running";
    cascade.set(entry.pkg, next, now);
  }
  for (const pkg of detectStall(cascade, now, STALL_TIMEOUT_MS)) {
    cascade.set(pkg, "stalled", now);
  }
}
