import { test, expect } from "bun:test";
import { probeRepo } from "../../src/prepare/probe";
import type { ProtectionProbe, RepoAdminApi, RepoMeta } from "../../src/prepare/adminApi";

function api(
  over: Partial<{ meta: RepoMeta; protection: ProtectionProbe; file: boolean }> = {},
): RepoAdminApi {
  return {
    getRepo: async () => over.meta ?? { defaultBranch: "main", isPrivate: false, allowAutoMerge: false },
    getProtection: async () => over.protection ?? { status: 404 },
    hasFile: async () => over.file ?? false,
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

test("carries the default branch, auto-merge flag and workflow presence through", async () => {
  const caps = await probeRepo(
    api({ meta: { defaultBranch: "trunk", isPrivate: false, allowAutoMerge: true }, file: true }),
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
  });
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
