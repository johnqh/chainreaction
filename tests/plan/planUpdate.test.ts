import { test, expect } from "bun:test";
import { planUpdateOne, planUpdateChain } from "../../src/plan/planUpdate";
import type { RepoNode } from "../../src/graph/types";

const node = (
  pkg: string,
  version: string,
  deps: string[] = [],
  devDeps?: string[],
): RepoNode => ({
  pkg,
  repo: `acme/${pkg.replace("@acme/", "")}`,
  version,
  deps,
  devDeps,
});

// proj2 --devDependency of--> proj3 --dependency of--> proj5
// i.e. proj3.devDeps = [proj2], proj5.deps = [proj3].
//
// proj3 also carries an out-of-graph dependency and devDependency. They are
// deliberate: without them the chain path never exercises the `if (bumped)`
// guard, and removing that guard leaves the whole suite green while producing
// `"^undefined"` ranges.
function chainGraph(): Map<string, RepoNode> {
  return new Map<string, RepoNode>([
    ["proj2", node("proj2", "1.0.0")],
    ["proj3", node("proj3", "2.0.0", ["some-3p-tool"], ["proj2", "another-3p-lib"])],
    ["proj5", node("proj5", "3.0.0", ["proj3"])],
  ]);
}

test("planUpdateOne produces exactly one entry", () => {
  const graph = chainGraph();
  const entries = planUpdateOne(graph, "proj5");
  expect(entries).toHaveLength(1);
  expect(entries[0]?.pkg).toBe("proj5");
});

test("planUpdateOne rewrites both deps and devDeps to current graph versions", () => {
  const graph = new Map<string, RepoNode>([
    ["dep-a", node("dep-a", "1.2.3")],
    ["dep-b", node("dep-b", "4.5.6")],
    ["main", node("main", "0.1.0", ["dep-a"], ["dep-b"])],
  ]);

  const entries = planUpdateOne(graph, "main");
  expect(entries).toHaveLength(1);
  const entry = entries[0]!;
  expect(entry.fromVersion).toBe("0.1.0");
  expect(entry.toVersion).toBe("0.1.1");
  expect(entry.depBumps).toEqual({
    "dep-a": "^1.2.3",
    "dep-b": "^4.5.6",
  });
});

test("planUpdateOne leaves out-of-graph dependencies untouched", () => {
  const graph = new Map<string, RepoNode>([
    ["dep-a", node("dep-a", "1.2.3")],
    ["main", node("main", "0.1.0", ["dep-a", "react"], ["some-3p-tool"])],
  ]);

  const entries = planUpdateOne(graph, "main");
  const entry = entries[0]!;
  expect(entry.depBumps).toEqual({ "dep-a": "^1.2.3" });
  expect(entry.depBumps["react"]).toBeUndefined();
  expect(entry.depBumps["some-3p-tool"]).toBeUndefined();
});

test("planUpdateChain orders entries bottom-up", () => {
  const graph = chainGraph();
  const entries = planUpdateChain(graph, "proj5");
  const pkgs = entries.map((e) => e.pkg);
  expect(pkgs.indexOf("proj2")).toBeLessThan(pkgs.indexOf("proj3"));
  expect(pkgs.indexOf("proj3")).toBeLessThan(pkgs.indexOf("proj5"));
  expect(pkgs.sort()).toEqual(["proj2", "proj3", "proj5"]);
});

test("a chain entry references the BUMPED version of its dependency, not the current one", () => {
  const graph = chainGraph();
  const entries = planUpdateChain(graph, "proj5");

  const proj2 = entries.find((e) => e.pkg === "proj2")!;
  expect(proj2.fromVersion).toBe("1.0.0");
  expect(proj2.toVersion).toBe("1.0.1");

  const proj3 = entries.find((e) => e.pkg === "proj3")!;
  // proj3 devDeps on proj2. Must reference proj2's BUMPED version (1.0.1),
  // not its current published version (1.0.0) — a range of ^1.0.0 would be
  // satisfiable immediately and let proj3's PR merge before proj2 publishes.
  expect(proj3.depBumps["proj2"]).toBe("^1.0.1");
  expect(proj3.depBumps["proj2"]).not.toBe("^1.0.0");

  const proj5 = entries.find((e) => e.pkg === "proj5")!;
  expect(proj5.depBumps["proj3"]).toBe(`^${proj3.toVersion}`);
});

test("planUpdateChain on a package with no in-graph dependencies is a single entry", () => {
  const graph = chainGraph();
  const entries = planUpdateChain(graph, "proj2");
  expect(entries).toHaveLength(1);
  expect(entries[0]?.pkg).toBe("proj2");
  expect(entries[0]?.depBumps).toEqual({});
});

test("refuses a package absent from the graph", () => {
  const graph = chainGraph();
  expect(() => planUpdateOne(graph, "ghost")).toThrow(/ghost/);
  expect(() => planUpdateChain(graph, "ghost")).toThrow(/ghost/);
});

test("planUpdateChain leaves out-of-graph dependencies of a chain member untouched", () => {
  const graph = chainGraph();
  const entries = planUpdateChain(graph, "proj5");
  const proj3 = entries.find((e) => e.pkg === "proj3")!;

  // proj3 depends on some-3p-tool and another-3p-lib, neither of which is in
  // the graph and neither of which this cascade publishes. They must not appear
  // in depBumps at all. Writing them unconditionally yields "^undefined" — a
  // range that is wrong but plausible enough to open a PR and merge.
  expect(proj3.depBumps["some-3p-tool"]).toBeUndefined();
  expect(proj3.depBumps["another-3p-lib"]).toBeUndefined();
  expect(Object.keys(proj3.depBumps)).toEqual(["proj2"]);
  for (const entry of entries) {
    for (const range of Object.values(entry.depBumps)) {
      expect(range).not.toContain("undefined");
    }
  }
});
