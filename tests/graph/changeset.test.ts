import { test, expect } from "bun:test";
import { bumpPatch, computeChangeset, assertScoped } from "../../src/graph/changeset";
import type { RepoNode } from "../../src/graph/types";

const graph = new Map<string, RepoNode>([
  ["@sudobility/design", { pkg: "@sudobility/design", dir: "/design_system", repo: "johnqh/design_system", version: "1.1.49", deps: [] }],
  ["@sudobility/components", { pkg: "@sudobility/components", dir: "/mail_box_components", repo: "johnqh/mail_box_components", version: "5.3.13", deps: ["@sudobility/design"] }],
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
  const levels = [["@sudobility/design"], ["@sudobility/components"]];
  const cs = computeChangeset(graph, levels);

  expect(cs[0]).toMatchObject({
    pkg: "@sudobility/design", fromVersion: "1.1.49", toVersion: "1.1.50",
    depBumps: {}, level: 0,
  });
  expect(cs[1]).toMatchObject({
    pkg: "@sudobility/components", fromVersion: "5.3.13", toVersion: "5.3.14",
    depBumps: { "@sudobility/design": "^1.1.50" }, level: 1,
  });
});

test("assertScoped rejects an unscoped run over a large affected set", () => {
  const affected = new Set(Array.from({ length: 60 }, (_, i) => `pkg-${i}`));
  expect(() => assertScoped(affected, [])).toThrow(/explicit target set/i);
});

test("assertScoped allows an explicit target list or an explicit all", () => {
  const affected = new Set(["a", "b"]);
  expect(() => assertScoped(affected, ["a"])).not.toThrow();
  expect(() => assertScoped(affected, "all")).not.toThrow();
});

test("assertScoped rejects a target that is not in the affected set", () => {
  expect(() => assertScoped(new Set(["a"]), ["zzz"])).toThrow(/not in the affected set/i);
});
