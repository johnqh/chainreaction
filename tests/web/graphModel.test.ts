import { test, expect } from "bun:test";
import type { RepoNode } from "../../src/graph/types";
import {
  filterRepos,
  computeLevels,
  classifyEdges,
  computeLayout,
  NODE_WIDTH,
  NODE_GAP_X,
  NODE_HEIGHT,
  NODE_GAP_Y,
} from "../../src/web/graphModel";

function node(partial: Partial<RepoNode> & Pick<RepoNode, "pkg">): RepoNode {
  return {
    dir: undefined,
    repo: `org/${partial.pkg.replace(/[^a-z0-9-]/gi, "-")}`,
    version: "1.0.0",
    deps: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// filterRepos
// ---------------------------------------------------------------------------

test("filterRepos matches case-insensitively on pkg name", () => {
  const nodes = [node({ pkg: "widget-Core", repo: "acme/widget-core" })];
  // Mixed-case query against a mixed-case pkg name: only survives if compared
  // case-insensitively. A case-sensitive implementation fails this.
  expect(filterRepos(nodes, "WIDGET-core").map((n) => n.pkg)).toEqual(["widget-Core"]);
  expect(filterRepos(nodes, "core").map((n) => n.pkg)).toEqual(["widget-Core"]);
  expect(filterRepos(nodes, "CORE").map((n) => n.pkg)).toEqual(["widget-Core"]);
});

test("filterRepos matches by substring across a couple hundred repos", () => {
  const nodes = Array.from({ length: 250 }, (_, i) => node({ pkg: `pkg-${i}`, repo: `org/repo-${i}` }));
  const nodes2 = [...nodes, node({ pkg: "@scope/needle", repo: "org/needle-repo" })];
  expect(filterRepos(nodes2, "needle").length).toBe(1);
  expect(filterRepos(nodes2, "NEEDLE").length).toBe(1);
});

test("filterRepos also matches on repo name, not only pkg", () => {
  const nodes = [node({ pkg: "@scope/a", repo: "org/totally-different-name" })];
  expect(filterRepos(nodes, "different").map((n) => n.pkg)).toEqual(["@scope/a"]);
});

test("filterRepos returns everything for an empty or whitespace query", () => {
  const nodes = [node({ pkg: "a" }), node({ pkg: "b" })];
  expect(filterRepos(nodes, "")).toEqual(nodes);
  expect(filterRepos(nodes, "   ")).toEqual(nodes);
});

test("filterRepos returns nothing when no repo matches", () => {
  const nodes = [node({ pkg: "a" }), node({ pkg: "b" })];
  expect(filterRepos(nodes, "zzz-nope")).toEqual([]);
});

// ---------------------------------------------------------------------------
// computeLevels
// ---------------------------------------------------------------------------

test("computeLevels puts leaves at 0 and orders dependents above their deps", () => {
  const a = node({ pkg: "a", deps: [] });
  const b = node({ pkg: "b", deps: ["a"] });
  const c = node({ pkg: "c", deps: ["b"] });
  const levels = computeLevels([a, b, c]);
  expect(levels.get("a")).toBe(0);
  expect(levels.get("b")).toBe(1);
  expect(levels.get("c")).toBe(2);
});

test("computeLevels ignores devDeps entirely when assigning levels", () => {
  const a = node({ pkg: "a", deps: [] });
  // z has no *dependency* on anything, only a devDependency on a higher-would-be node.
  // Since devDeps never force a republish, they must not push z to a higher level.
  const z = node({ pkg: "z", deps: [], devDeps: ["a"] });
  const levels = computeLevels([a, z]);
  expect(levels.get("a")).toBe(0);
  expect(levels.get("z")).toBe(0);
});

test("computeLevels is unaffected by a dep pointing outside the visible set", () => {
  const a = node({ pkg: "a", deps: ["react"] }); // "react" isn't one of our nodes
  const levels = computeLevels([a]);
  expect(levels.get("a")).toBe(0);
});

test("computeLevels handles a node with no devDeps key at all", () => {
  const a: RepoNode = { pkg: "a", repo: "org/a", version: "1.0.0", deps: [] };
  expect(() => computeLevels([a])).not.toThrow();
  expect(computeLevels([a]).get("a")).toBe(0);
});

test("computeLevels breaks cycles instead of looping forever", () => {
  const a = node({ pkg: "a", deps: ["b"] });
  const b = node({ pkg: "b", deps: ["a"] });
  const levels = computeLevels([a, b]);
  expect(levels.size).toBe(2);
  expect(levels.get("a")).toBeDefined();
  expect(levels.get("b")).toBeDefined();
});

// ---------------------------------------------------------------------------
// classifyEdges
// ---------------------------------------------------------------------------

test("classifyEdges labels deps as dependency edges", () => {
  const a = node({ pkg: "a", deps: [] });
  const b = node({ pkg: "b", deps: ["a"] });
  const edges = classifyEdges([a, b]);
  expect(edges).toEqual([{ from: "b", to: "a", kind: "dependency" }]);
});

test("classifyEdges labels devDeps as devDependency edges", () => {
  const a = node({ pkg: "a", deps: [] });
  const b = node({ pkg: "b", deps: [], devDeps: ["a"] });
  const edges = classifyEdges([a, b]);
  expect(edges).toEqual([{ from: "b", to: "a", kind: "devDependency" }]);
});

test("classifyEdges distinguishes both kinds on the same node", () => {
  const a = node({ pkg: "a", deps: [] });
  const c = node({ pkg: "c", deps: [] });
  const b = node({ pkg: "b", deps: ["a"], devDeps: ["c"] });
  const edges = classifyEdges([a, b, c]);
  const kinds = edges.map((e) => e.kind).sort();
  expect(kinds).toEqual(["dependency", "devDependency"]);
  expect(edges.find((e) => e.to === "a")?.kind).toBe("dependency");
  expect(edges.find((e) => e.to === "c")?.kind).toBe("devDependency");
});

test("classifyEdges does not crash and yields no devDependency edges when devDeps is absent", () => {
  const a: RepoNode = { pkg: "a", repo: "org/a", version: "1.0.0", deps: [] };
  const b: RepoNode = { pkg: "b", repo: "org/b", version: "1.0.0", deps: ["a"] };
  const edges = classifyEdges([a, b]);
  expect(edges).toEqual([{ from: "b", to: "a", kind: "dependency" }]);
  expect(edges.some((e) => e.kind === "devDependency")).toBe(false);
});

test("classifyEdges drops edges whose target is outside the visible node set", () => {
  const a = node({ pkg: "a", deps: ["not-in-set"], devDeps: ["also-not-in-set"] });
  expect(classifyEdges([a])).toEqual([]);
});

// ---------------------------------------------------------------------------
// computeLayout
// ---------------------------------------------------------------------------

test("computeLayout places level-0 nodes at y=0 and higher levels further down", () => {
  const a = node({ pkg: "a", deps: [] });
  const b = node({ pkg: "b", deps: ["a"] });
  const layout = computeLayout([a, b]);
  const la = layout.nodes.find((n) => n.pkg === "a")!;
  const lb = layout.nodes.find((n) => n.pkg === "b")!;
  expect(la.y).toBe(0);
  expect(lb.y).toBe(NODE_HEIGHT + NODE_GAP_Y);
  expect(lb.y).toBeGreaterThan(la.y);
});

test("computeLayout orders nodes within a level alphabetically along x", () => {
  const c = node({ pkg: "c", deps: [] });
  const a = node({ pkg: "a", deps: [] });
  const b = node({ pkg: "b", deps: [] });
  const layout = computeLayout([c, a, b]);
  const xs = layout.nodes
    .slice()
    .sort((n1, n2) => n1.x - n2.x)
    .map((n) => n.pkg);
  expect(xs).toEqual(["a", "b", "c"]);
  const first = layout.nodes.find((n) => n.pkg === "a")!;
  expect(first.x).toBe(0);
  const second = layout.nodes.find((n) => n.pkg === "b")!;
  expect(second.x).toBe(NODE_WIDTH + NODE_GAP_X);
});

test("computeLayout carries classified edges through", () => {
  const a = node({ pkg: "a", deps: [] });
  const b = node({ pkg: "b", deps: ["a"], devDeps: [] });
  const layout = computeLayout([a, b]);
  expect(layout.edges).toEqual([{ from: "b", to: "a", kind: "dependency" }]);
});

test("computeLayout sizes width/height to fit the widest level and deepest chain", () => {
  const a = node({ pkg: "a", deps: [] });
  const b = node({ pkg: "b", deps: [] });
  const c = node({ pkg: "c", deps: ["a", "b"] });
  const layout = computeLayout([a, b, c]);
  expect(layout.width).toBe(2 * (NODE_WIDTH + NODE_GAP_X));
  expect(layout.height).toBe(2 * (NODE_HEIGHT + NODE_GAP_Y));
});
