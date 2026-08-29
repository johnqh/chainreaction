import type { RepoNode, ChangesetEntry } from "../graph/types";
import { bumpPatch } from "../graph/changeset";
import { dependencyClosure, dependencyLevels } from "../graph/closure";

function requireNode(graph: Map<string, RepoNode>, pkg: string): RepoNode {
  const node = graph.get(pkg);
  if (!node) throw new Error(`not in graph: ${pkg}`);
  return node;
}

/**
 * "Update" button: refresh exactly `pkg` against what is already published.
 *
 * Rewrites `pkg`'s own in-graph `deps`/`devDeps` to `^<current graph version>`
 * of each dependency and patch-bumps `pkg` itself. Nothing else moves —
 * dependencies keep their own published versions, since this is a leaf
 * refresh, not a chain republish.
 */
export function planUpdateOne(
  graph: Map<string, RepoNode>,
  pkg: string,
): ChangesetEntry[] {
  const node = requireNode(graph, pkg);

  const depBumps: Record<string, string> = {};
  for (const dep of [...node.deps, ...(node.devDeps ?? [])]) {
    const depNode = graph.get(dep);
    if (depNode) depBumps[dep] = `^${depNode.version}`;
  }

  return [
    {
      pkg,
      dir: node.dir,
      repo: node.repo,
      fromVersion: node.version,
      toVersion: bumpPatch(node.version),
      depBumps,
      level: 0,
    },
  ];
}

/**
 * "Update chain" button: republish `pkg`'s full `dependencyClosure`, ordered
 * bottom-up by `dependencyLevels`, bumping every member.
 *
 * Mirrors `computeChangeset`'s walk: bumped versions are recorded as each
 * level is processed, and every later level's in-chain ranges are rewritten
 * against those bumped versions rather than the versions currently in the
 * graph. A range built from the current (not-yet-bumped) version would be
 * satisfiable immediately — the dependent's PR would go green and could
 * merge before its dependency actually publishes the bump, breaking the
 * chain silently at the point it looks healthiest.
 */
export function planUpdateChain(
  graph: Map<string, RepoNode>,
  pkg: string,
): ChangesetEntry[] {
  requireNode(graph, pkg);

  const closure = dependencyClosure(graph, pkg);
  const levels = dependencyLevels(graph, closure);

  const newVersions = new Map<string, string>();
  const entries: ChangesetEntry[] = [];

  levels.forEach((level, index) => {
    for (const member of level) {
      const node = graph.get(member);
      // Unreachable today, and deliberately so: requireNode guarantees the seed
      // is in-graph, and dependencyClosure only ever admits a member when
      // graph.has(dep) holds, so every closure member is provably in-graph.
      // Kept as a type guard, not as error handling. If dependencyClosure ever
      // relaxes that gate, this silently DROPS a repo from the chain — the
      // manifest edit is never made, its PR never opens, and everything
      // downstream of it merges against a version that never publishes. Should
      // that gate move, this must become a throw.
      if (!node) continue;
      const toVersion = bumpPatch(node.version);
      newVersions.set(member, toVersion);

      const depBumps: Record<string, string> = {};
      for (const dep of [...node.deps, ...(node.devDeps ?? [])]) {
        const bumped = newVersions.get(dep);
        if (bumped) depBumps[dep] = `^${bumped}`;
      }

      entries.push({
        pkg: member,
        dir: node.dir,
        repo: node.repo,
        fromVersion: node.version,
        toVersion,
        depBumps,
        level: index,
      });
    }
  });

  return entries;
}
