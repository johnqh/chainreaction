import type { ChangesetEntry } from "../graph/types";
import type { GhClient } from "../github/client";
import { openChangesetPrs } from "../github/orchestrator";

/**
 * The lifecycle of a single update PR.
 *
 * `ready` / `blocked` are computed by `classifyPr` from the changeset shape
 * alone. `merged` / `failed` are observed states — reported by GitHub via
 * `GhClient.prState` (or a supervisor watching it) — and are never produced
 * by `classifyPr`; nothing in this module invents them.
 */
export type PrState = "ready" | "blocked" | "merged" | "failed";

/**
 * Open one PR per changeset entry.
 *
 * Delegates entirely to `openChangesetPrs` — the update flow and the
 * cascade flow open PRs identically; only how the changeset was planned
 * differs.
 */
export async function openUpdatePrs(
  entries: ChangesetEntry[],
  gh: GhClient,
  branch: string,
): Promise<Map<string, number>> {
  return openChangesetPrs(entries, gh, branch);
}

/**
 * Decide whether `entry`'s PR is ready to merge or blocked on an upstream PR.
 *
 * "In-chain dependency" means a key of `entry.depBumps` that is also the
 * `pkg` of some entry in `entries` — i.e. a dependency this same cascade is
 * also updating. `entry` is ready once every in-chain dependency has
 * published; a dependency bump that names a package outside this cascade
 * (a third-party package, or a repo the user chose not to update) is
 * ignored, since it will never appear in `published` and would otherwise
 * block the PR forever.
 *
 * Pure and synchronous — takes `published` explicitly so the rule is
 * testable without GitHub, and so no caller (in particular the UI) can
 * invent its own readiness colouring.
 */
export function classifyPr(
  entry: ChangesetEntry,
  entries: ChangesetEntry[],
  published: Set<string>,
): PrState {
  const inChain = new Set(entries.map((e) => e.pkg));
  const inChainDeps = Object.keys(entry.depBumps).filter((dep) => inChain.has(dep));
  const allPublished = inChainDeps.every((dep) => published.has(dep));
  return allPublished ? "ready" : "blocked";
}
