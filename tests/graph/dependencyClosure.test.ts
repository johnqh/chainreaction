import { test, expect } from "bun:test";
import { dependencyClosure, dependencyLevels } from "../../src/graph/closure";
import { topoLevels } from "../../src/graph/resolver";
import type { RepoNode } from "../../src/graph/types";

const node = (pkg: string, deps: string[], devDeps: string[] = []): RepoNode => ({
  pkg, repo: `acme/${pkg.replace("@acme/", "")}`, version: "1.0.0", deps, devDeps,
});

// proj1 --devDependency of--> proj2 --devDependency of--> proj3 --dependency of--> proj5
//                                └──── dependency of ────> proj4
//
// i.e. proj2.devDeps = [proj1], proj3.devDeps = [proj2], proj4.deps = [proj2],
// proj5.deps = [proj3].
function worked(): Map<string, RepoNode> {
  return new Map<string, RepoNode>([
    ["proj1", node("proj1", [])],
    ["proj2", node("proj2", [], ["proj1"])],
    ["proj3", node("proj3", [], ["proj2"])],
    ["proj4", node("proj4", ["proj2"])],
    ["proj5", node("proj5", ["proj3"])],
  ]);
}

test("includes the package itself", () => {
  const graph = worked();
  expect(dependencyClosure(graph, "proj5").has("proj5")).toBe(true);
});

test("follows dependency edges upstream", () => {
  const graph = worked();
  const closure = dependencyClosure(graph, "proj5");
  expect(closure.has("proj3")).toBe(true);
});

test("follows devDependency edges upstream too — the user is electing to propagate", () => {
  const graph = worked();
  const closure = dependencyClosure(graph, "proj5");
  expect(closure.has("proj2")).toBe(true);
  expect(closure.has("proj1")).toBe(true);
});

test("excludes packages outside the graph", () => {
  const graph = new Map<string, RepoNode>([
    ["@acme/app", node("@acme/app", ["@acme/design", "react"])],
    ["@acme/design", node("@acme/design", [])],
  ]);
  const closure = dependencyClosure(graph, "@acme/app");
  expect(closure.has("react")).toBe(false);
  expect([...closure].sort()).toEqual(["@acme/app", "@acme/design"]);
});

test("excludes dependents — this walk goes the other way", () => {
  const graph = worked();
  const closure = dependencyClosure(graph, "proj5");
  expect([...closure].sort()).toEqual(["proj1", "proj2", "proj3", "proj5"]);
  expect(closure.has("proj4")).toBe(false);
});

test("levels are bottom-up: a package never precedes something it depends on", () => {
  const graph = worked();
  const closure = dependencyClosure(graph, "proj5");
  const levels = dependencyLevels(graph, closure);

  const levelOf = (pkg: string) => levels.findIndex((l) => l.includes(pkg));
  expect(levelOf("proj1")).toBeLessThan(levelOf("proj2"));
  expect(levelOf("proj2")).toBeLessThan(levelOf("proj3"));
  expect(levelOf("proj3")).toBeLessThan(levelOf("proj5"));
  expect(levels.flat().sort()).toEqual(["proj1", "proj2", "proj3", "proj5"]);
  expect(levels[0]).toEqual(["proj1"]);
});

test("throws on a dependency cycle rather than looping", () => {
  const graph = new Map<string, RepoNode>([
    ["a", node("a", ["b"])],
    ["b", node("b", ["a"])],
  ]);
  const closure = new Set(["a", "b"]);
  let message = "";
  expect(() => {
    try {
      dependencyLevels(graph, closure);
    } catch (e) {
      message = (e as Error).message;
      throw e;
    }
  }).toThrow(/cycle/i);
  expect(message).toContain("a");
  expect(message).toContain("b");
});

// devDeps is optional on RepoNode, and a real graph built from a package.json
// with no devDependencies block omits the key entirely rather than recording an
// empty array. Every other fixture here goes through node(), whose default
// `devDeps: string[] = []` always writes the key — so without this test the
// `?? []` fallback in both functions is never actually exercised. Mirrors
// closure.test.ts's "a node with no devDeps recorded is handled".
test("a node with no devDeps recorded is handled", () => {
  const g = new Map<string, RepoNode>([
    ["a", { pkg: "a", repo: "acme/a", version: "1.0.0", deps: [] }],
  ]);
  expect(() => dependencyClosure(g, "a")).not.toThrow();
  expect(() => dependencyLevels(g, new Set(["a"]))).not.toThrow();
});

// dependencyLevels deliberately duplicates topoLevels' loop, differing only in
// which edges it follows: topoLevels must ignore devDeps so publish order is
// never gated on one, while dependencyLevels must include them. Strip the only
// intended difference — give every node an empty devDeps — and the two must
// agree exactly. Nothing else would catch the sibling silently drifting from
// its twin.
test("with no devDeps edges, dependencyLevels agrees with topoLevels", () => {
  // Inserted in deliberately non-alphabetical order: both functions sort each
  // level, so a drift that dropped that sort would surface here as insertion
  // order rather than being masked by an already-sorted fixture.
  const graph = new Map<string, RepoNode>([
    ["d", node("d", ["b", "c"])],
    ["c", node("c", ["a"])],
    ["b", node("b", ["a"])],
    ["a", node("a", [])],
  ]);
  // Subset iteration order, not graph order, drives each level's ordering.
  const subset = new Set(["d", "c", "b", "a"]);
  expect(dependencyLevels(graph, subset)).toEqual(topoLevels(graph, subset));
});
