import type { ChangesetEntry } from "../graph/types";
import type { PrApi } from "../github/prApi";
import { Cascade, detectStall, type NodeState } from "./state";

const STALL_TIMEOUT_MS = 15 * 60_000;

export async function pollOnce(
  cascade: Cascade,
  entries: ChangesetEntry[],
  prs: Map<string, number>,
  gh: PrApi,
  now: number = Date.now(),
): Promise<void> {
  for (const entry of entries) {
    const pr = prs.get(entry.repo);
    if (pr === undefined) continue;

    const ghState = await gh.prState(entry.repo, pr);
    if (cascade.get(entry.pkg) === "stalled" && ghState !== "MERGED") continue;

    const next: NodeState =
      ghState === "MERGED" ? "merged" :
      ghState === "CLOSED" ? "stalled" :
      "ci-running";
    cascade.set(entry.pkg, next, now);
  }
  for (const pkg of detectStall(cascade, now, STALL_TIMEOUT_MS)) {
    cascade.set(pkg, "stalled", now);
  }
}
