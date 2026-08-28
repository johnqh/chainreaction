import { test, expect } from "bun:test";
import { planCascade } from "../../src/plan/planCascade";
import type { GraphSource } from "../../src/graph/source";
import type { RepoNode } from "../../src/graph/types";

const source: GraphSource = {
  load: async () =>
    new Map<string, RepoNode>([
      ["@acme/design", { pkg: "@acme/design", repo: "acme/design_system", version: "1.1.49", deps: [] }],
      ["@acme/components", { pkg: "@acme/components", repo: "acme/components", version: "5.3.13", deps: ["@acme/design"] }],
      ["acme-app", { pkg: "acme-app", repo: "acme/app", version: "1.0.96", deps: ["@acme/components"] }],
      ["@acme/unrelated", { pkg: "@acme/unrelated", repo: "acme/unrelated", version: "2.0.0", deps: [] }],
    ]),
};

test("plans the full chain from a source, in dependency order", async () => {
  const plan = await planCascade(source, "@acme/design", "all");
  expect(plan.affected.sort()).toEqual(["@acme/components", "@acme/design", "acme-app"]);
  expect(plan.levels).toEqual([["@acme/design"], ["@acme/components"], ["acme-app"]]);
  expect(plan.changeset.map((e) => [e.pkg, e.toVersion])).toEqual([
    ["@acme/design", "1.1.50"],
    ["@acme/components", "5.3.14"],
    ["acme-app", "1.0.97"],
  ]);
  expect(plan.changeset[1]!.depBumps).toEqual({ "@acme/design": "^1.1.50" });
});

test("an unrelated package is not in the affected set", async () => {
  const plan = await planCascade(source, "@acme/design", "all");
  expect(plan.affected).not.toContain("@acme/unrelated");
});

test("refuses an unscoped run", async () => {
  await expect(planCascade(source, "@acme/design", [])).rejects.toThrow(/explicit target set/i);
});

test("rejects a target outside the affected set", async () => {
  await expect(planCascade(source, "@acme/design", ["@acme/unrelated"])).rejects.toThrow(/not in the affected set/i);
});

test("throws when the changed package is not in the graph", async () => {
  await expect(planCascade(source, "@acme/ghost", "all")).rejects.toThrow(/not in the graph/i);
});
