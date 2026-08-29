import { test, expect } from "bun:test";
import { reposForPackages } from "../../src/graph/mapping";
import type { RepoNode } from "../../src/graph/types";

const graph = new Map<string, RepoNode>([
  ["@acme/design", { pkg: "@acme/design", repo: "acme/design_system", version: "1.0.0", deps: [] }],
  ["@acme/components", { pkg: "@acme/components", repo: "acme/components", version: "1.0.0", deps: [] }],
]);

test("maps package names to repo full names", () => {
  expect(reposForPackages(graph, ["@acme/design", "@acme/components"]))
    .toEqual(["acme/components", "acme/design_system"]);
});

test("refuses an unknown package rather than dropping it", () => {
  // Dropping would shrink the required set and let the readiness gate pass vacuously.
  expect(() => reposForPackages(graph, ["@acme/design", "@acme/ghost"]))
    .toThrow(/@acme\/ghost/);
});

test("names every unknown package, not just the first", () => {
  let msg = "";
  try { reposForPackages(graph, ["@acme/ghost", "@acme/phantom"]); } catch (e) { msg = (e as Error).message; }
  expect(msg).toContain("@acme/ghost");
  expect(msg).toContain("@acme/phantom");
});

test("deduplicates when two packages share a repo", () => {
  const g = new Map(graph);
  g.set("@acme/extra", { pkg: "@acme/extra", repo: "acme/components", version: "1.0.0", deps: [] });
  expect(reposForPackages(g, ["@acme/components", "@acme/extra"])).toEqual(["acme/components"]);
});

test("an empty input yields an empty result without throwing", () => {
  expect(reposForPackages(graph, [])).toEqual([]);
});
