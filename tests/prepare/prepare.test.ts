import { test, expect } from "bun:test";
import { assessRepo, mergeMechanismFor, prepareRepo } from "../../src/prepare/prepare";
import type { ProtectionProbe, RepoAdminApi, RepoMeta } from "../../src/prepare/adminApi";
import type { RepoCapabilities } from "../../src/prepare/types";

const caps = (over: Partial<RepoCapabilities> = {}): RepoCapabilities => ({
  repo: "acme/lib", defaultBranch: "main", isPrivate: false,
  protection: "unprotected", requiresReviews: false, autoMergeEnabled: false,
  hasValidationWorkflow: true, observedChecks: [], ...over,
});

function api(
  over: Partial<{ meta: RepoMeta; protection: ProtectionProbe; file: boolean; checkRuns: string[] }> = {},
) {
  const calls: string[] = [];
  // Defaults to observing "ci" — the check name every test below that expects
  // readiness passes as its requiredChecks — so tests unrelated to check
  // verification don't have to know it exists. Tests for the new blocker
  // override `checkRuns` explicitly.
  const a: RepoAdminApi = {
    getRepo: async () => over.meta ?? { defaultBranch: "main", isPrivate: false, allowAutoMerge: false },
    getProtection: async () => over.protection ?? { status: 404 },
    hasFile: async () => over.file ?? true,
    listCheckRuns: async () => over.checkRuns ?? ["ci"],
    setProtection: async (_f, _b, contexts) => { calls.push(`setProtection:${contexts.join("+")}`); },
    enableAutoMerge: async () => { calls.push("enableAutoMerge"); },
  };
  return { a, calls };
}

test("a protectable repo uses GitHub auto-merge", () => {
  expect(mergeMechanismFor(caps({ protection: "unprotected" }))).toBe("auto-merge");
  expect(mergeMechanismFor(caps({ protection: "protected" }))).toBe("auto-merge");
});

test("a repo that cannot be protected falls back to control-plane merge", () => {
  expect(mergeMechanismFor(caps({ protection: "unavailable" }))).toBe("control-plane");
});

test("prepare applies protection and enables auto-merge on a protectable repo", async () => {
  const { a, calls } = api({ protection: { status: 404 } });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(calls).toEqual(["enableAutoMerge", "setProtection:ci"]);
  expect(res).toMatchObject({ repo: "acme/lib", ready: true, mechanism: "auto-merge", blockers: [] });
});

test("prepare does not attempt protection when it is unavailable, and still succeeds", async () => {
  const { a, calls } = api({
    protection: { status: 403, message: "Upgrade to GitHub Pro or make this repository public to enable this feature." },
    meta: { defaultBranch: "main", isPrivate: true, allowAutoMerge: false },
  });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(calls.some((c) => c.startsWith("setProtection"))).toBe(false);
  expect(res.ready).toBe(true);
  expect(res.mechanism).toBe("control-plane");
});

test("prepareRepo performs no mutation at all for a control-plane repo — it is about to be declared unusable", async () => {
  const { a, calls } = api({
    protection: { status: 403, message: "Upgrade to GitHub Pro or make this repository public to enable this feature." },
    meta: { defaultBranch: "main", isPrivate: true, allowAutoMerge: false },
  });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(res.mechanism).toBe("control-plane");
  expect(calls).toEqual([]);
});

test("an already-protected repo is blocked and setProtection is never called", async () => {
  const { a, calls } = api({
    protection: { status: 200, body: { required_pull_request_reviews: { required_approving_review_count: 2 } } },
  });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(res.ready).toBe(false);
  expect(res.blockers.join(" ")).toMatch(/already has branch protection/);
  expect(res.blockers.join(" ")).toMatch(/will not modify existing branch protection/);
  expect(calls.some((c) => c.startsWith("setProtection"))).toBe(false);
});

test("an already-protected repo without a review requirement is still blocked", async () => {
  const { a, calls } = api({ protection: { status: 200, body: { required_status_checks: {} } } });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(res.ready).toBe(false);
  expect(calls.some((c) => c.startsWith("setProtection"))).toBe(false);
});

test("an unprotected repo still gets protection applied", async () => {
  const { a, calls } = api({ protection: { status: 404 } });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(res.ready).toBe(true);
  expect(calls).toContain("setProtection:ci");
});

test("a missing validation workflow blocks readiness and names the file", async () => {
  const { a, calls } = api({ file: false });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(res.ready).toBe(false);
  expect(res.blockers.join(" ")).toMatch(/chainreaction-validate\.yml/);
  expect(calls).toEqual([]);
});

test("no required checks blocks readiness — auto-merge has nothing to wait on", async () => {
  const { a, calls } = api();
  const res = await prepareRepo(a, "acme/lib", []);
  expect(res.ready).toBe(false);
  expect(res.blockers.join(" ")).toMatch(/required status check/i);
  expect(calls).toEqual([]);
});

test("a blocked repo reports every blocker, not just the first", async () => {
  const { a } = api({ file: false });
  const res = await prepareRepo(a, "acme/lib", []);
  expect(res.blockers.length).toBe(2);
});

test("a blocked repo is left completely untouched", async () => {
  const { a, calls } = api({ file: false });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(res.ready).toBe(false);
  expect(calls).toEqual([]);
});

test("enableAutoMerge is skipped when it is already on", async () => {
  const { a, calls } = api({ meta: { defaultBranch: "main", isPrivate: false, allowAutoMerge: true } });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(calls).toEqual(["setProtection:ci"]);
  expect(res.ready).toBe(true);
});

// --- FIX 3: assessRepo is the read-only half prepareRepo is built on ---

test("assessRepo performs no mutation, even for a repo that would otherwise be prepared", async () => {
  const { a, calls } = api({ protection: { status: 404 } });
  const res = await assessRepo(a, "acme/lib", ["ci"]);
  expect(res).toMatchObject({ repo: "acme/lib", ready: true, mechanism: "auto-merge", blockers: [] });
  expect(calls).toEqual([]);
});

test("assessRepo reports the same blockers as prepareRepo for a blocked repo", async () => {
  const { a: assessApi } = api({ file: false });
  const { a: prepareApi } = api({ file: false });
  const assessed = await assessRepo(assessApi, "acme/lib", ["ci"]);
  const prepared = await prepareRepo(prepareApi, "acme/lib", ["ci"]);
  expect(assessed).toEqual(prepared);
});

test("assessRepo reports control-plane readiness without ever touching the repo", async () => {
  const { a, calls } = api({
    protection: { status: 403, message: "Upgrade to GitHub Pro or make this repository public to enable this feature." },
    meta: { defaultBranch: "main", isPrivate: true, allowAutoMerge: false },
  });
  const res = await assessRepo(a, "acme/lib", ["ci"]);
  expect(res.ready).toBe(true);
  expect(res.mechanism).toBe("control-plane");
  expect(calls).toEqual([]);
});

// --- FIX: a required check that has never been observed on the default
// branch blocks readiness. This is the guard against the exact failure mode
// this fix exists for: a typo (or a stale name) in CR_REQUIRED_CHECKS makes
// Prepare succeed, branch protection then requires a check that never runs,
// and every PR to the repo — the customer's own included — silently becomes
// unmergeable, with nothing telling anyone why. ---

test("a required check GitHub has never reported on the default branch blocks readiness and names it", async () => {
  const { a, calls } = api({ checkRuns: ["build", "test"] });
  const res = await prepareRepo(a, "acme/lib", ["cy"]); // typo for "ci"
  expect(res.ready).toBe(false);
  expect(res.blockers.join(" ")).toMatch(/never reported a check named "cy"/);
  expect(calls).toEqual([]);
});

test("the blocker lists the checks that were actually observed, so the fix is obvious", async () => {
  const { a } = api({ checkRuns: ["build", "test"] });
  const res = await prepareRepo(a, "acme/lib", ["cy"]);
  expect(res.blockers.join(" ")).toMatch(/build/);
  expect(res.blockers.join(" ")).toMatch(/test/);
});

test("the blocker says so explicitly when nothing at all has been observed", async () => {
  const { a } = api({ checkRuns: [] });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(res.ready).toBe(false);
  expect(res.blockers.join(" ")).toMatch(/No checks have been observed/);
});

test("a required check that has been observed does not block, even alongside others that have not", async () => {
  const { a } = api({ checkRuns: ["ci"] });
  const res = await prepareRepo(a, "acme/lib", ["ci", "also-missing"]);
  expect(res.ready).toBe(false);
  expect(res.blockers.join(" ")).toMatch(/"also-missing"/);
  expect(res.blockers.join(" ")).not.toMatch(/"ci"/);
});

test("all required checks observed on the default branch is not itself a blocker", async () => {
  const { a } = api({ checkRuns: ["ci", "build"] });
  const res = await prepareRepo(a, "acme/lib", ["ci", "build"]);
  expect(res.ready).toBe(true);
  expect(res.blockers).toEqual([]);
});

test("prepareRepo never mutates a repo whose required check has never been observed", async () => {
  const { a, calls } = api({ checkRuns: [] });
  await prepareRepo(a, "acme/lib", ["ci"]);
  expect(calls).toEqual([]);
});
