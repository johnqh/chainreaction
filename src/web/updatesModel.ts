import type { ChangesetEntry } from "../graph/types";
import { classifyPr, type PrState } from "../pr/lifecycle";

/**
 * Names of in-chain dependencies `entry` is still waiting on before its PR
 * can merge.
 *
 * Mirrors the exact intersection `src/pr/train.ts`'s stall message uses:
 * `entry.depBumps` keys, filtered down to packages that are also members of
 * this changeset (`entries`), minus whatever has already published. A
 * `blocked` classification from `classifyPr` and a non-empty result here
 * describe the same fact two ways — this function exists so the UI can name
 * names instead of just repeating the word "blocked".
 */
export function waitingFor(
  entry: ChangesetEntry,
  entries: ChangesetEntry[],
  published: Set<string>,
): string[] {
  const inChain = new Set(entries.map((e) => e.pkg));
  return Object.keys(entry.depBumps).filter((dep) => inChain.has(dep) && !published.has(dep));
}

/**
 * Human-readable rendering of `waitingFor`'s result for a blocked PR.
 *
 * A blocked PR must always name what it is waiting for. If `waitingFor`
 * somehow comes back empty for an entry `classifyPr` called blocked — which
 * should never happen given consistent inputs, but would otherwise render as
 * a silent, contentless "Waiting for:" — this says so distinctly instead of
 * printing an empty list.
 */
export function describeWaiting(names: string[]): string {
  if (names.length === 0) {
    return "blocked, but no specific pending dependency could be identified";
  }
  return `waiting for: ${names.join(", ")}`;
}

/**
 * The single place the UI resolves a PR's displayed state.
 *
 * `classifyPr` is the only source of `ready`/`blocked` — this function never
 * recomputes that logic, it only lets an *observed* terminal state (`merged`
 * or `failed`, reported by GitHub) override it once one is known. Nothing
 * here can produce `merged`/`failed` on its own.
 */
export function resolvePrState(
  entry: ChangesetEntry,
  entries: ChangesetEntry[],
  published: Set<string>,
  observed: "merged" | "failed" | undefined,
): PrState {
  return observed ?? classifyPr(entry, entries, published);
}
