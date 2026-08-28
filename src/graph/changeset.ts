import type { RepoNode, ChangesetEntry } from "./types";

export function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a plain semver version: ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

export function computeChangeset(
  graph: Map<string, RepoNode>,
  levels: string[][],
): ChangesetEntry[] {
  const newVersions = new Map<string, string>();
  const entries: ChangesetEntry[] = [];

  levels.forEach((level, index) => {
    for (const pkg of level) {
      const node = graph.get(pkg);
      if (!node) continue;
      const toVersion = bumpPatch(node.version);
      newVersions.set(pkg, toVersion);

      const depBumps: Record<string, string> = {};
      for (const dep of node.deps) {
        const bumped = newVersions.get(dep);
        if (bumped) depBumps[dep] = `^${bumped}`;
      }

      entries.push({
        pkg, dir: node.dir, repo: node.repo,
        fromVersion: node.version, toVersion, depBumps, level: index,
      });
    }
  });
  return entries;
}

export function assertScoped(
  affected: Set<string>,
  targets: string[] | "all",
): void {
  if (targets === "all") return;
  if (targets.length === 0) {
    throw new Error(
      `refusing to run unscoped: ${affected.size} packages are affected. ` +
        `Pass an explicit target set or "all".`,
    );
  }
  const unknown = targets.filter((t) => !affected.has(t));
  if (unknown.length > 0) {
    throw new Error(`not in the affected set: ${unknown.join(", ")}`);
  }
  const targetSet = new Set(targets);
  const missing = [...affected].filter((a) => !targetSet.has(a));
  if (missing.length > 0) {
    throw new Error(
      `targets do not cover the full affected set, missing: ${missing.join(", ")}. ` +
        `A partial cascade would leave downstream repos referencing versions that never publish. ` +
        `Pass "all" to accept the whole set.`,
    );
  }
}
