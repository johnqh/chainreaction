import { test, expect } from "bun:test";
import { probeRepo } from "../../src/prepare/probe";
import type { ProtectionProbe, RepoAdminApi, RepoMeta } from "../../src/prepare/adminApi";

function api(
  over: Partial<{
    meta: RepoMeta;
    protection: ProtectionProbe;
    file: boolean;
    checkRuns: string[];
    /** Ref -> observed checks. Takes precedence over `checkRuns` for a ref present here. */
    checksByRef: Record<string, string[]>;
    /** What `recentPrHeadSha` reports. `undefined` (the default) means "no PR ever" (null). */
    prHeadSha: string | null;
  }> = {},
): RepoAdminApi {
  return {
    getRepo: async () => over.meta ?? { defaultBranch: "main", isPrivate: false, allowAutoMerge: false },
    getProtection: async () => over.protection ?? { status: 404 },
    hasFile: async () => over.file ?? false,
    recentPrHeadSha: async () => over.prHeadSha ?? null,
    listCheckRuns: async (_f, ref) => over.checksByRef?.[ref] ?? over.checkRuns ?? [],
    setProtection: async () => { throw new Error("not called in probe"); },
    enableAutoMerge: async () => { throw new Error("not called in probe"); },
  };
}

test("404 on protection means protection is available but unset", async () => {
  const caps = await probeRepo(api({ protection: { status: 404 } }), "acme/lib");
  expect(caps.protection).toBe("unprotected");
});

test("200 on protection means already protected", async () => {
  const caps = await probeRepo(api({ protection: { status: 200, body: {} } }), "acme/lib");
  expect(caps.protection).toBe("protected");
});

test("a 200 protection body with required_pull_request_reviews sets requiresReviews", async () => {
  const caps = await probeRepo(
    api({ protection: { status: 200, body: { required_pull_request_reviews: { required_approving_review_count: 2 } } } }),
    "acme/lib",
  );
  expect(caps.protection).toBe("protected");
  expect(caps.requiresReviews).toBe(true);
});

test("a 200 protection body without reviews leaves requiresReviews false", async () => {
  const caps = await probeRepo(api({ protection: { status: 200, body: { required_status_checks: {} } } }), "acme/lib");
  expect(caps.requiresReviews).toBe(false);
});

test("403 with the free-tier message means unavailable — a free-tier private repo", async () => {
  const caps = await probeRepo(
    api({
      protection: { status: 403, message: "Upgrade to GitHub Pro or make this repository public to enable this feature." },
      meta: { defaultBranch: "main", isPrivate: true, allowAutoMerge: false },
    }),
    "acme/lib",
  );
  expect(caps.protection).toBe("unavailable");
  expect(caps.isPrivate).toBe(true);
  expect(caps.requiresReviews).toBe(false);
});

test("403 with 'Resource not accessible by integration' must reject, not classify as unavailable", async () => {
  await expect(
    probeRepo(
      api({ protection: { status: 403, message: "Resource not accessible by integration" } }),
      "acme/lib",
    ),
  ).rejects.toThrow(/Resource not accessible by integration/);
});

test("403 with no message at all must reject, not classify as unavailable", async () => {
  await expect(probeRepo(api({ protection: { status: 403 } }), "acme/lib")).rejects.toThrow(/403/);
});

test("403 from a secondary rate limit must reject, not classify as unavailable", async () => {
  await expect(
    probeRepo(
      api({ protection: { status: 403, message: "You have exceeded a secondary rate limit." } }),
      "acme/lib",
    ),
  ).rejects.toThrow(/secondary rate limit/);
});

test("an unexpected status is not silently treated as unavailable", async () => {
  await expect(probeRepo(api({ protection: { status: 500 } }), "acme/lib")).rejects.toThrow(/500/);
});

test("carries the default branch, auto-merge flag, workflow presence and observed checks through", async () => {
  const caps = await probeRepo(
    api({
      meta: { defaultBranch: "trunk", isPrivate: false, allowAutoMerge: true },
      file: true,
      checkRuns: ["build", "test"],
    }),
    "acme/lib",
  );
  expect(caps).toEqual({
    repo: "acme/lib",
    defaultBranch: "trunk",
    isPrivate: false,
    protection: "unprotected",
    requiresReviews: false,
    autoMergeEnabled: true,
    hasValidationWorkflow: true,
    observedChecks: ["build", "test"],
    observedChecksRef: "trunk",
  });
});

test("falls back to querying the default branch only when the repo has never had a PR", async () => {
  const seen: string[] = [];
  const a = api({ meta: { defaultBranch: "trunk", isPrivate: false, allowAutoMerge: false }, prHeadSha: null });
  a.listCheckRuns = async (_f, ref) => { seen.push(ref); return []; };
  const caps = await probeRepo(a, "acme/lib");
  expect(seen).toEqual(["trunk"]);
  expect(caps.observedChecksRef).toBe("trunk");
});

// --- FIX: required status checks are evaluated against a PR's head commit,
// never the default branch tip. Sampling the default branch instead is the
// exact catastrophe this guard exists to prevent: a workflow_dispatch run
// (chainreaction-validate) attaches its check-run to the default branch, so
// a version that samples the default branch would certify
// "chainreaction-validate" as a safe required check — precisely the check
// that can never appear on a real PR. It would also reject a repo's
// genuine, always-passing-on-PRs "ci" check, because that check may never
// have run standalone against the default branch tip. Both failure modes
// are covered below; both fail against a default-branch-sampling version. ---

test("queries check-runs against the most recent PR's head commit, not the default branch", async () => {
  const seen: string[] = [];
  const a = api({
    meta: { defaultBranch: "main", isPrivate: false, allowAutoMerge: false },
    prHeadSha: "pr-head-sha",
  });
  a.listCheckRuns = async (_f, ref) => { seen.push(ref); return []; };
  const caps = await probeRepo(a, "acme/lib");
  expect(seen).toEqual(["pr-head-sha"]);
  expect(caps.observedChecksRef).toBe("pr-head-sha");
});

test("a check that only ever ran on the default branch tip (chainreaction-validate, dispatched there) " +
  "is NOT reported as observed when the PR head never saw it", async () => {
  const caps = await probeRepo(
    api({
      meta: { defaultBranch: "main", isPrivate: false, allowAutoMerge: false },
      prHeadSha: "pr-head-sha",
      checksByRef: { main: ["chainreaction-validate"], "pr-head-sha": ["ci"] },
    }),
    "acme/lib",
  );
  expect(caps.observedChecks).toEqual(["ci"]);
  expect(caps.observedChecks).not.toContain("chainreaction-validate");
});

test("a check that runs on every PR head is reported as observed even though it never ran on the " +
  "default branch tip standalone", async () => {
  const caps = await probeRepo(
    api({
      meta: { defaultBranch: "main", isPrivate: false, allowAutoMerge: false },
      prHeadSha: "pr-head-sha",
      checksByRef: { main: [], "pr-head-sha": ["ci"] },
    }),
    "acme/lib",
  );
  expect(caps.observedChecks).toEqual(["ci"]);
});

test("the workflow path is a parameter, not hardcoded", async () => {
  const seen: string[] = [];
  const a = api();
  a.hasFile = async (_f, path) => { seen.push(path); return false; };
  await probeRepo(a, "acme/lib", ".github/workflows/custom.yml");
  expect(seen).toEqual([".github/workflows/custom.yml"]);
});

test("a repo whose metadata has no default branch is rejected, not probed", async () => {
  const a = api({ meta: { defaultBranch: "", isPrivate: false, allowAutoMerge: false } });
  let calledGetProtection = false;
  a.getProtection = async () => { calledGetProtection = true; return { status: 404 }; };
  await expect(probeRepo(a, "acme/lib")).rejects.toThrow(/no default branch/);
  expect(calledGetProtection).toBe(false);
});

test("a repo whose metadata has a non-string default branch is rejected", async () => {
  const a = api({ meta: { defaultBranch: undefined as unknown as string, isPrivate: false, allowAutoMerge: false } });
  await expect(probeRepo(a, "acme/lib")).rejects.toThrow(/no default branch/);
});
