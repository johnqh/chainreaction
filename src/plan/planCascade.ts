import type { GraphSource } from "../graph/source";
import type { ChangesetEntry } from "../graph/types";
import type { SkippedRepo } from "../graph/githubSource";
import { affectedSubgraph, topoLevels } from "../graph/resolver";
import { assertScoped, computeChangeset } from "../graph/changeset";

export interface CascadePlan {
  changed: string;
  affected: string[];
  levels: string[][];
  changeset: ChangesetEntry[];
  skipped: SkippedRepo[];
}

export async function planCascade(
  source: GraphSource,
  changed: string,
  targets: string[] | "all",
): Promise<CascadePlan> {
  const graph = await source.load();
  if (!graph.has(changed)) {
    throw new Error(`${changed} is not in the graph for this installation`);
  }

  const affected = affectedSubgraph(graph, changed);
  // Before anything else: refuse to plan a publish nobody scoped.
  assertScoped(affected, targets);

  const levels = topoLevels(graph, affected);
  // Feature-detect: only a source that tracks skipped repos (e.g.
  // GitHubGraphSource) exposes this. FilesystemGraphSource and test doubles
  // that satisfy plain GraphSource still work, and just report none skipped.
  const skipped: SkippedRepo[] =
    "skipped" in source && Array.isArray((source as { skipped: unknown }).skipped)
      ? (source as { skipped: SkippedRepo[] }).skipped
      : [];
  return {
    changed,
    affected: [...affected].sort(),
    levels,
    changeset: computeChangeset(graph, levels),
    skipped,
  };
}
