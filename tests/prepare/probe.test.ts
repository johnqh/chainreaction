import { test, expect } from "bun:test";
import { probeRepo } from "../../src/prepare/probe";
import type { RepoAdminApi, RepoMeta } from "../../src/prepare/adminApi";

function api(over: Partial<{ meta: RepoMeta; protection: number; file: boolean }> = {}): RepoAdminApi {
  return {
    getRepo: async () => over.meta ?? { defaultBranch: "main", isPrivate: false, allowAutoMerge: false },
    getProtection: async () => over.protection ?? 404,
    hasFile: async () => over.file ?? false,
    setProtection: async () => { throw new Error("not called in probe"); },
    enableAutoMerge: async () => { throw new Error("not called in probe"); },
  };
}

test("404 on protection means protection is available but unset", async () => {
  const caps = await probeRepo(api({ protection: 404 }), "acme/lib");
  expect(caps.protection).toBe("unprotected");
});

test("200 on protection means already protected", async () => {
  const caps = await probeRepo(api({ protection: 200 }), "acme/lib");
  expect(caps.protection).toBe("protected");
});

test("403 on protection means unavailable — a free-tier private repo", async () => {
  const caps = await probeRepo(
    api({ protection: 403, meta: { defaultBranch: "main", isPrivate: true, allowAutoMerge: false } }),
    "acme/lib",
  );
  expect(caps.protection).toBe("unavailable");
  expect(caps.isPrivate).toBe(true);
});

test("an unexpected status is not silently treated as unavailable", async () => {
  await expect(probeRepo(api({ protection: 500 }), "acme/lib")).rejects.toThrow(/500/);
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
