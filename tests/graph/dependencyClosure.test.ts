import { test, expect } from "bun:test";
import { dependencyClosure, dependencyLevels } from "../../src/graph/closure";
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
