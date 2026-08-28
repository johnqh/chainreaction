import { test, expect } from "bun:test";
import { GitHubGraphSource, type GitHubApi, type RepoRef } from "../../src/graph/githubSource";

const REPOS: RepoRef[] = [
  { fullName: "acme/design_system", private: false, defaultBranch: "main" },
  { fullName: "acme/components", private: true, defaultBranch: "main" },
  { fullName: "acme/app", private: false, defaultBranch: "main" },
  { fullName: "acme/no-manifest", private: false, defaultBranch: "main" },
  { fullName: "acme/broken", private: false, defaultBranch: "main" },
];

const MANIFESTS: Record<string, string | null> = {
  "acme/design_system": JSON.stringify({ name: "@acme/design", version: "1.1.49" }),
  "acme/components": JSON.stringify({
    name: "@acme/components", version: "5.3.13",
    dependencies: { "@acme/design": "^1.1.49", react: "^18.0.0" },
  }),
  "acme/app": JSON.stringify({
    name: "acme-app", version: "1.0.96",
    dependencies: { "@acme/components": "^5.3.13" },
  }),
  "acme/no-manifest": null,
  "acme/broken": "{ this is not json",
};

function api(): GitHubApi & { manifestCalls: string[] } {
  const manifestCalls: string[] = [];
  return {
    manifestCalls,
    listRepos: async () => REPOS,
    getManifest: async (fullName) => { manifestCalls.push(fullName); return MANIFESTS[fullName] ?? null; },
  };
}

test("builds a graph from API manifests, following only in-scope edges", async () => {
  const g = await new GitHubGraphSource(api(), "@acme/").load();
  expect(g.size).toBe(3);
  const components = g.get("@acme/components")!;
  expect(components.repo).toBe("acme/components");
  expect(components.version).toBe("5.3.13");
  expect(components.deps).toEqual(["@acme/design"]);
});

test("a repo with no package.json is skipped, not fatal", async () => {
  const g = await new GitHubGraphSource(api(), "@acme/").load();
  expect([...g.keys()].some((k) => k.includes("no-manifest"))).toBe(false);
});

test("an unparseable manifest is skipped but warned about", async () => {
  const warnings: string[] = [];
  const original = console.error;
  console.error = (msg: string) => warnings.push(String(msg));
  try { await new GitHubGraphSource(api(), "@acme/").load(); } finally { console.error = original; }
  expect(warnings.some((w) => w.includes("acme/broken"))).toBe(true);
});

test("private repos are included", async () => {
  const g = await new GitHubGraphSource(api(), "@acme/").load();
  expect(g.has("@acme/components")).toBe(true);
});

test("the scope is a parameter — a different scope yields no edges", async () => {
  const g = await new GitHubGraphSource(api(), "@other/").load();
  expect(g.get("@acme/components")!.deps).toEqual([]);
});

test("one manifest request per repo, no duplicates", async () => {
  const a = api();
  await new GitHubGraphSource(a, "@acme/").load();
  expect(a.manifestCalls.length).toBe(REPOS.length);
  expect(new Set(a.manifestCalls).size).toBe(REPOS.length);
});
