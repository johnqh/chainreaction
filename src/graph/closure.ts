import type { RepoNode } from "./types";

/**
 * Every package that must be VALIDATED when `publishSet` is republished.
 *
 * A superset of the publish set: a repo that only devDepends on a publishing
 * package is never republished, but it builds and tests against it, so a
 * breaking change reddens its CI. Omitting it lets a cascade report success
 * while leaving that repo's default branch broken.
 */
export function validationClosure(
  graph: Map<string, RepoNode>,
  publishSet: Set<string>,
): Set<string> {
  const closure = new Set(publishSet);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of graph.values()) {
      if (closure.has(node.pkg)) continue;
      const edges = [...node.deps, ...(node.devDeps ?? [])];
      if (edges.some((d) => closure.has(d))) {
        closure.add(node.pkg);
        grew = true;
      }
    }
  }
  return closure;
}

/**
 * Everything `pkg` transitively depends on, walking upstream through both
 * `deps` and `devDeps`, restricted to packages present in `graph`.
 *
 * This is the opposite direction from `affectedSubgraph`: that walk answers
 * "who must republish because this package changed" and stops at
 * dependencies/peerDependencies, since a devDependency bump never forces a
 * dependent to republish. This walk answers "what have I chosen to refresh
 * so this project gets the newest of everything" — a user selecting a
 * project and asking for its chain is electing to propagate through
 * devDependencies too, so those edges are included here.
 */
export function dependencyClosure(
  graph: Map<string, RepoNode>,
  pkg: string,
): Set<string> {
  const closure = new Set<string>();
  const queue: string[] = [pkg];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (closure.has(current)) continue;
    closure.add(current);
    const node = graph.get(current);
    if (!node) continue;
    for (const dep of [...node.deps, ...(node.devDeps ?? [])]) {
      if (graph.has(dep) && !closure.has(dep)) queue.push(dep);
    }
  }
  return closure;
}

/**
 * Bottom-up topological levels over a `dependencyClosure` subset: level 0
 * holds packages with no in-subset dependency, and nothing ever precedes
 * something it depends on.
 *
 * This is the inverse ordering of `topoLevels` (which schedules a
 * dependency's *dependents* only once the dependency itself has been
 * scheduled, for publishing). It is a sibling rather than a generalisation
 * of `topoLevels` because the edge sets differ: `topoLevels` deliberately
 * looks only at `deps` (publish order must not depend on devDependency
 * edges), while this walk must also account for `devDeps`, since
 * `dependencyClosure` may have pulled a package in through one.
 */
export function dependencyLevels(
  graph: Map<string, RepoNode>,
  subset: Set<string>,
): string[][] {
  const remaining = new Set(subset);
  const levels: string[][] = [];

  while (remaining.size > 0) {
    const level = [...remaining]
      .filter((pkg) => {
        const node = graph.get(pkg);
        if (!node) return true; // not in graph => nothing to wait for
        const edges = [...node.deps, ...(node.devDeps ?? [])];
        return edges.every((d) => !remaining.has(d));
      })
      .sort();

    if (level.length === 0) {
      throw new Error(
        `dependency cycle among: ${[...remaining].sort().join(", ")}`,
      );
    }
    for (const pkg of level) remaining.delete(pkg);
    levels.push(level);
  }
  return levels;
}
