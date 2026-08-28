import type { GraphSource } from "../graph/source";
import type { ChangesetEntry } from "../graph/types";
import { affectedSubgraph, topoLevels } from "../graph/resolver";
import { assertScoped, computeChangeset } from "../graph/changeset";

export interface CascadePlan {
  changed: string;
  affected: string[];
  levels: string[][];
  changeset: ChangesetEntry[];
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
  return {
    changed,
    affected: [...affected].sort(),
    levels,
    changeset: computeChangeset(graph, levels),
  };
}
