import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { RepoNode } from "./types";

const SCOPE = "@sudobility/";
const ORG = "johnqh";

export function scanRepos(root: string): Map<string, RepoNode> {
  const graph = new Map<string, RepoNode>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;

    let pkg: any;
    try {
      pkg = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      continue; // an unparseable manifest is not a graph node
    }
    if (!pkg?.name) continue;

    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })
      .filter((d) => d.startsWith(SCOPE))
      .sort();

    graph.set(pkg.name, {
      pkg: pkg.name,
      dir,
      repo: `${ORG}/${basename(dir)}`,
      version: pkg.version ?? "0.0.0",
      deps,
    });
  }
  return graph;
}

export function affectedSubgraph(
  graph: Map<string, RepoNode>,
  changed: string,
): Set<string> {
  const affected = new Set<string>([changed]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of graph.values()) {
      if (affected.has(node.pkg)) continue;
      if (node.deps.some((d) => affected.has(d))) {
        affected.add(node.pkg);
        grew = true;
      }
    }
  }
  return affected;
}

export function topoLevels(
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
        return node.deps.every((d) => !remaining.has(d));
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
