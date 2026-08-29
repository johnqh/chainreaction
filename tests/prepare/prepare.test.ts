import { test, expect } from "bun:test";
import { mergeMechanismFor, prepareRepo } from "../../src/prepare/prepare";
import type { ProtectionProbe, RepoAdminApi, RepoMeta } from "../../src/prepare/adminApi";
import type { RepoCapabilities } from "../../src/prepare/types";

const caps = (over: Partial<RepoCapabilities> = {}): RepoCapabilities => ({
  repo: "acme/lib", defaultBranch: "main", isPrivate: false,
  protection: "unprotected", requiresReviews: false, autoMergeEnabled: false,
  hasValidationWorkflow: true, ...over,
});

function api(over: Partial<{ meta: RepoMeta; protection: ProtectionProbe; file: boolean }> = {}) {
  const calls: string[] = [];
  const a: RepoAdminApi = {
    getRepo: async () => over.meta ?? { defaultBranch: "main", isPrivate: false, allowAutoMerge: false },
    getProtection: async () => over.protection ?? { status: 404 },
    hasFile: async () => over.file ?? true,
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
