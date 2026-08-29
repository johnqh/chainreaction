import { test, expect } from "bun:test";
import { bumpPatch, computeChangeset, assertScoped } from "../../src/graph/changeset";
import type { RepoNode } from "../../src/graph/types";

const graph = new Map<string, RepoNode>([
  ["@acme/design", { pkg: "@acme/design", dir: "/design_system", repo: "acme/design_system", version: "1.1.49", deps: [] }],
  ["@acme/components", { pkg: "@acme/components", dir: "/mail_box_components", repo: "acme/mail_box_components", version: "5.3.13", deps: ["@acme/design"] }],
]);

test("bumpPatch increments the patch segment", () => {
  expect(bumpPatch("1.1.49")).toBe("1.1.50");
  expect(bumpPatch("0.0.293")).toBe("0.0.294");
  expect(bumpPatch("5.3.9")).toBe("5.3.10");
});

test("bumpPatch rejects a non-semver version", () => {
  expect(() => bumpPatch("1.2")).toThrow(/semver/i);
});

test("computeChangeset bumps each package and rewrites in-subgraph dep ranges", () => {
  const levels = [["@acme/design"], ["@acme/components"]];
  const cs = computeChangeset(graph, levels);

  expect(cs[0]).toMatchObject({
    pkg: "@acme/design", fromVersion: "1.1.49", toVersion: "1.1.50",
    depBumps: {}, level: 0,
  });
  expect(cs[1]).toMatchObject({
    pkg: "@acme/components", fromVersion: "5.3.13", toVersion: "5.3.14",
    depBumps: { "@acme/design": "^1.1.50" }, level: 1,
  });
});

test("assertScoped rejects an unscoped run over a large affected set", () => {
  const affected = new Set(Array.from({ length: 60 }, (_, i) => `pkg-${i}`));
  expect(() => assertScoped(affected, [])).toThrow(/explicit target set/i);
});

test("assertScoped allows an explicit target list that exactly covers the affected set, or an explicit all", () => {
  const affected = new Set(["a", "b"]);
  expect(() => assertScoped(affected, ["a", "b"])).not.toThrow();
  expect(() => assertScoped(affected, "all")).not.toThrow();
});

test("assertScoped rejects a target that is not in the affected set", () => {
  expect(() => assertScoped(new Set(["a"]), ["zzz"])).toThrow(/not in the affected set/i);
});

test("assertScoped rejects a strict subset of the affected set, naming what is missing", () => {
  const affected = new Set(["a", "b", "c"]);
  expect(() => assertScoped(affected, ["a"])).toThrow(/missing.*b.*c|missing.*c.*b/is);
  expect(() => assertScoped(affected, ["a"])).toThrow(/"all"/);
});
