import { test, expect } from "bun:test";
import { validationClosure } from "../../src/graph/closure";
import type { RepoNode } from "../../src/graph/types";

const node = (pkg: string, deps: string[], devDeps: string[] = []): RepoNode => ({
  pkg, repo: `acme/${pkg.replace("@acme/", "")}`, version: "1.0.0", deps, devDeps,
});

const graph = new Map<string, RepoNode>([
  ["@acme/design", node("@acme/design", [])],
  ["@acme/components", node("@acme/components", ["@acme/design"])],
  // depends on components for publishing, but builds against di_web
  ["@acme/blocks", node("@acme/blocks", ["@acme/components"], ["@acme/di_web"])],
  ["@acme/di_web", node("@acme/di_web", ["@acme/components"])],
  ["@acme/unrelated", node("@acme/unrelated", [])],
]);

test("the closure contains the publish set", () => {
  const publish = new Set(["@acme/design", "@acme/components"]);
  const closure = validationClosure(graph, publish);
  expect(closure.has("@acme/design")).toBe(true);
  expect(closure.has("@acme/components")).toBe(true);
});

test("a repo that only devDepends on a publishing package is added", () => {
  // di_web publishes; blocks devDepends on it, so blocks must be validated
  // even though it is not republished.
  const closure = validationClosure(graph, new Set(["@acme/di_web"]));
  expect(closure.has("@acme/blocks")).toBe(true);
});

test("an unrelated repo is not added", () => {
  const closure = validationClosure(graph, new Set(["@acme/di_web"]));
  expect(closure.has("@acme/unrelated")).toBe(false);
});

test("the closure is transitive through devDependency edges", () => {
  const g = new Map(graph);
  g.set("@acme/top", node("@acme/top", [], ["@acme/blocks"]));
  const closure = validationClosure(g, new Set(["@acme/di_web"]));
  expect(closure.has("@acme/top")).toBe(true);
});

test("a node with no devDeps recorded is handled", () => {
  const g = new Map<string, RepoNode>([
    ["@acme/a", { pkg: "@acme/a", repo: "acme/a", version: "1.0.0", deps: [] }],
  ]);
  expect(() => validationClosure(g, new Set(["@acme/a"]))).not.toThrow();
});
