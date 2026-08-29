import type { RepoNode } from "./types";

/**
 * Translate package names into repository full names.
 *
 * Refuses on an unknown package rather than dropping it. A silent drop shrinks the
 * set handed to `assertPrepared`, which then certifies a smaller set than the
 * cascade will actually touch — a gate that passes because it was asked about
 * nothing.
 */
export function reposForPackages(
  graph: Map<string, RepoNode>,
  packages: Iterable<string>,
): string[] {
  const repos = new Set<string>();
  const unknown: string[] = [];

  for (const pkg of packages) {
    const node = graph.get(pkg);
    if (!node) {
      unknown.push(pkg);
      continue;
    }
    repos.add(node.repo);
  }

  if (unknown.length > 0) {
    throw new Error(
      `no repository known for ${unknown.length} package(s): ${unknown.sort().join(", ")}`,
    );
  }
  return [...repos].sort();
}
