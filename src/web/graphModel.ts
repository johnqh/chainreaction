// Pure, DOM-free logic backing RepoList and Graph: search filtering, edge-kind
// classification, and a layered (by dependency level) layout. Kept dependency-free
// so it can be tested with no rendering at all.
import type { RepoNode } from "../graph/types";

/** One rendered edge. `dependency` forces the target to republish; `devDependency` never does. */
export interface GraphEdge {
  from: string;
  to: string;
  kind: "dependency" | "devDependency";
}

export interface LayoutNode {
  pkg: string;
  level: number;
  /** position within its level, left to right, alphabetical for determinism */
  index: number;
  x: number;
  y: number;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export const NODE_WIDTH = 160;
export const NODE_HEIGHT = 44;
export const NODE_GAP_X = 32;
export const NODE_GAP_Y = 80;

/**
 * Case-insensitive substring filter over pkg name and repo name.
 * Empty/whitespace-only query returns every node.
 */
export function filterRepos(nodes: RepoNode[], query: string): RepoNode[] {
  const q = query.trim().toLowerCase();
  if (q === "") return nodes;
  return nodes.filter(
    (n) => n.pkg.toLowerCase().includes(q) || n.repo.toLowerCase().includes(q),
  );
}

/**
 * Bottom-up topological levels using ONLY `deps` (dependency edges) — devDeps
 * never force a republish, so they never constrain level order. A dep pointing
 * outside the visible node set (e.g. an external package) does not block leveling.
 * Cycles (which shouldn't occur in valid data) are broken by dumping all
 * remaining nodes into the next level rather than looping forever.
 */
export function computeLevels(nodes: RepoNode[]): Map<string, number> {
  const byPkg = new Map(nodes.map((n) => [n.pkg, n]));
  const levels = new Map<string, number>();
  const remaining = new Set(byPkg.keys());
  let level = 0;

  while (remaining.size > 0) {
    const ready = [...remaining].filter((pkg) => {
      const node = byPkg.get(pkg);
      if (!node) return true;
      return node.deps.every((d) => !byPkg.has(d) || !remaining.has(d));
    });

    if (ready.length === 0) {
      // Cycle guard: nothing is ready, so stop looping and place the rest here.
      for (const pkg of remaining) levels.set(pkg, level);
      break;
    }

    for (const pkg of ready) {
      levels.set(pkg, level);
      remaining.delete(pkg);
    }
    level++;
  }

  return levels;
}

/**
 * Classifies every dependency/devDependency edge in the node set. Only edges
 * whose target is also present in the node set are emitted — there is nothing
 * to draw an edge to otherwise. `devDeps` is optional; its absence yields no
 * devDependency edges for that node (never treated as an error).
 */
export function classifyEdges(nodes: RepoNode[]): GraphEdge[] {
  const present = new Set(nodes.map((n) => n.pkg));
  const edges: GraphEdge[] = [];

  for (const node of nodes) {
    for (const dep of node.deps) {
      if (present.has(dep)) edges.push({ from: node.pkg, to: dep, kind: "dependency" });
    }
    for (const dep of node.devDeps ?? []) {
      if (present.has(dep)) edges.push({ from: node.pkg, to: dep, kind: "devDependency" });
    }
  }

  return edges;
}

/**
 * A simple layered layout: one row per dependency level, nodes within a level
 * ordered alphabetically (deterministic, no external layout library).
 */
export function computeLayout(nodes: RepoNode[]): GraphLayout {
  const levels = computeLevels(nodes);
  const byLevel = new Map<number, string[]>();

  for (const node of nodes) {
    const level = levels.get(node.pkg) ?? 0;
    const bucket = byLevel.get(level) ?? [];
    bucket.push(node.pkg);
    byLevel.set(level, bucket);
  }

  const layoutNodes: LayoutNode[] = [];
  let maxIndex = 0;
  for (const [level, pkgs] of byLevel) {
    pkgs.sort((a, b) => a.localeCompare(b));
    pkgs.forEach((pkg, index) => {
      layoutNodes.push({
        pkg,
        level,
        index,
        x: index * (NODE_WIDTH + NODE_GAP_X),
        y: level * (NODE_HEIGHT + NODE_GAP_Y),
      });
      if (index > maxIndex) maxIndex = index;
    });
  }

  const maxLevel = byLevel.size === 0 ? 0 : Math.max(...byLevel.keys());
  const width = (maxIndex + 1) * (NODE_WIDTH + NODE_GAP_X);
  const height = (maxLevel + 1) * (NODE_HEIGHT + NODE_GAP_Y);

  return { nodes: layoutNodes, edges: classifyEdges(nodes), width, height };
}
