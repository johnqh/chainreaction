import { test, expect } from "bun:test";
import { planCascade, type PreparedProvider } from "../../src/plan/planCascade";
import type { GraphSource } from "../../src/graph/source";
import type { RepoNode } from "../../src/graph/types";
import type { PrepareResult } from "../../src/prepare/types";

const source: GraphSource = {
  load: async () =>
    new Map<string, RepoNode>([
      ["@acme/design", { pkg: "@acme/design", repo: "acme/design_system", version: "1.1.49", deps: [] }],
      ["@acme/components", { pkg: "@acme/components", repo: "acme/components", version: "5.3.13", deps: ["@acme/design"] }],
      ["acme-app", { pkg: "acme-app", repo: "acme/app", version: "1.0.96", deps: ["@acme/components"] }],
      ["@acme/unrelated", { pkg: "@acme/unrelated", repo: "acme/unrelated", version: "2.0.0", deps: [] }],
    ]),
};

const ready = (repo: string): PrepareResult =>
  ({ repo, ready: true, mechanism: "auto-merge", blockers: [] });

const allReady = (...repos: string[]) =>
  new Map(repos.map((r) => [r, ready(r)]));

const allThreeReady = () => allReady("acme/design_system", "acme/components", "acme/app");

/**
 * planCascade needs a provider, not a map — see PreparedProvider's doc comment
 * on why (a caller can't know the repo set in advance, and the tempting
 * alternative mutates customer repos). This wraps a fixed map into the
 * simplest possible provider, so most tests keep asserting exactly what they
 * asserted before that seam existed.
 */
const provide = (m: Map<string, PrepareResult>): PreparedProvider => async () => m;

test("plans the full chain from a source, in dependency order", async () => {
  const plan = await planCascade(source, "@acme/design", "all", provide(allThreeReady()));
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
  const plan = await planCascade(source, "@acme/design", "all", provide(allThreeReady()));
  expect(plan.affected).not.toContain("@acme/unrelated");
});

test("refuses an unscoped run", async () => {
  await expect(planCascade(source, "@acme/design", [], provide(allThreeReady()))).rejects.toThrow(
    /explicit target set/i,
  );
});

test("rejects a target outside the affected set", async () => {
  await expect(
    planCascade(source, "@acme/design", ["@acme/unrelated"], provide(allThreeReady())),
  ).rejects.toThrow(/not in the affected set/i);
});

test("an explicit target set that exactly covers the affected set passes", async () => {
  const plan = await planCascade(
    source,
    "@acme/design",
    ["@acme/design", "@acme/components", "acme-app"],
    provide(allThreeReady()),
  );
  expect(plan.affected.sort()).toEqual(["@acme/components", "@acme/design", "acme-app"]);
});

test("a strict subset of the affected set is rejected, naming what is missing", async () => {
  await expect(
    planCascade(source, "@acme/design", ["@acme/design"], provide(allThreeReady())),
  ).rejects.toThrow(/missing.*@acme\/components.*acme-app|missing.*acme-app.*@acme\/components/is);
});

test("throws when the changed package is not in the graph", async () => {
  await expect(planCascade(source, "@acme/ghost", "all", provide(allThreeReady()))).rejects.toThrow(
    /not in the graph/i,
  );
});

test("a plain GraphSource with no skipped property defaults to an empty skipped list", async () => {
  const plan = await planCascade(source, "@acme/design", "all", provide(allThreeReady()));
  expect(plan.skipped).toEqual([]);
});

test("a source exposing skipped repos has them surfaced on the plan", async () => {
  const skippedSource: GraphSource & { skipped: { repo: string; reason: string }[] } = {
    load: source.load,
    skipped: [{ repo: "acme/broken", reason: "manifest has no name field" }],
  };
  const plan = await planCascade(skippedSource, "@acme/design", "all", provide(allThreeReady()));
  expect(plan.skipped).toEqual([{ repo: "acme/broken", reason: "manifest has no name field" }]);
});

test("refuses to plan when a repo in the cascade is not prepared", async () => {
  // acme/components is affected but absent from the prepared map.
  const prepared = allReady("acme/design_system");
  await expect(planCascade(source, "@acme/design", "all", provide(prepared))).rejects.toThrow(
    /acme\/components.*never prepared/s,
  );
});

test("refuses when a prepared repo is not ready, naming the blocker", async () => {
  const prepared = allReady("acme/design_system", "acme/components", "acme/app");
  prepared.set("acme/components", {
    repo: "acme/components",
    ready: false,
    mechanism: "auto-merge",
    blockers: ["missing chainreaction-validate.yml"],
  });
  await expect(planCascade(source, "@acme/design", "all", provide(prepared))).rejects.toThrow(
    /missing chainreaction-validate\.yml/,
  );
});

test("the gate runs before the changeset is computed", async () => {
  // A test that merely asserts "it throws" does not distinguish whether the
  // readiness gate ran before or after computeChangeset, because either
  // ordering throws and either leaves the result undefined. To actually test
  // ordering we need a fixture where BOTH steps would fail, but with
  // different, distinguishable error messages, and then assert on which
  // message comes back.
  //
  // Here @acme/design has a non-plain-semver version ("1.0.0-beta.1"), which
  // makes bumpPatch (and therefore computeChangeset) throw a message about
  // semver. Separately, acme/components and acme/app are missing from the
  // prepared map, which makes assertPrepared throw a message about readiness.
  // If the gate runs first we see the readiness error; if computeChangeset
  // runs first (i.e. the gate was moved after it, or removed) we would see
  // the semver error instead. Asserting the readiness error message is what
  // proves the gate runs first.
  const badVersionSource: GraphSource = {
    load: async () =>
      new Map<string, RepoNode>([
        ["@acme/design", { pkg: "@acme/design", repo: "acme/design_system", version: "1.0.0-beta.1", deps: [] }],
        ["@acme/components", { pkg: "@acme/components", repo: "acme/components", version: "5.3.13", deps: ["@acme/design"] }],
        ["acme-app", { pkg: "acme-app", repo: "acme/app", version: "1.0.96", deps: ["@acme/components"] }],
      ]),
  };
  const prepared = allReady("acme/design_system"); // acme/components and acme/app were never prepared
  await expect(planCascade(badVersionSource, "@acme/design", "all", provide(prepared))).rejects.toThrow(
    /never prepared/,
  );
});

test("plans normally when every affected repo is ready", async () => {
  const plan = await planCascade(source, "@acme/design", "all", provide(allThreeReady()));
  expect(plan.levels.length).toBe(3);
});

// --- FIX 1: an unparseable manifest must not silently shrink the affected set ---

test("refuses to plan when a skipped repo's manifest was unparseable, naming that repo", async () => {
  // acme/components sits in the middle of the chain: @acme/design <- @acme/components <- acme-app.
  // A trailing comma or similar in its package.json means its deps (and therefore
  // everything reachable through it) are unknown, so the affected set computed by
  // affectedSubgraph cannot be trusted. This must throw before the readiness gate,
  // not merely get logged as a footnote in `skipped`.
  const skippedSource: GraphSource & { skipped: { repo: string; reason: string }[] } = {
    load: source.load,
    skipped: [{ repo: "acme/components", reason: "unparseable manifest: Unexpected token } in JSON" }],
  };
  await expect(
    planCascade(skippedSource, "@acme/design", "all", provide(allThreeReady())),
  ).rejects.toThrow(/acme\/components/);
});

test("a nameless manifest stays a warning, not a refusal — it cannot be a dependency target", async () => {
  const skippedSource: GraphSource & { skipped: { repo: string; reason: string }[] } = {
    load: source.load,
    skipped: [{ repo: "acme/nameless", reason: "manifest has no name field" }],
  };
  const plan = await planCascade(skippedSource, "@acme/design", "all", provide(allThreeReady()));
  expect(plan.skipped).toEqual([{ repo: "acme/nameless", reason: "manifest has no name field" }]);
});

// --- FIX 3: the prepared provider, not a map ---

test("the provider receives exactly the repos planCascade computed, nothing more or less", async () => {
  let received: string[] = [];
  const provider: PreparedProvider = async (repos) => {
    received = repos;
    return allThreeReady();
  };
  await planCascade(source, "@acme/design", "all", provider);
  expect(received.sort()).toEqual(["acme/app", "acme/components", "acme/design_system"]);
});

test("a provider returning a map missing one of the computed repos still fails closed", async () => {
  const provider: PreparedProvider = async () => allReady("acme/design_system", "acme/components");
  // acme/app is in the computed set but absent from what the provider returned.
  await expect(planCascade(source, "@acme/design", "all", provider)).rejects.toThrow(
    /acme\/app.*never prepared/s,
  );
});

test("repo keys from the provider are matched case-insensitively against the computed set", async () => {
  const provider: PreparedProvider = async () =>
    new Map([
      ["Acme/Design_System", ready("Acme/Design_System")],
      ["ACME/COMPONENTS", ready("ACME/COMPONENTS")],
      ["acme/app", ready("acme/app")],
    ]);
  const plan = await planCascade(source, "@acme/design", "all", provider);
  expect(plan.levels.length).toBe(3);
});
