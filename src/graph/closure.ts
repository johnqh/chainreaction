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
