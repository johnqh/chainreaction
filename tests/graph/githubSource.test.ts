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

test("refuses a graph where two repos declare the same package name", async () => {
  const dupeRepos: RepoRef[] = [
    { fullName: "acme/design_system", private: false, defaultBranch: "main" },
    { fullName: "acme/design_system_fork", private: false, defaultBranch: "main" },
  ];
  const dupeApi: GitHubApi = {
    listRepos: async () => dupeRepos,
    getManifest: async (fullName) =>
      JSON.stringify({ name: "@acme/design", version: fullName === "acme/design_system" ? "1.1.49" : "0.9.0" }),
  };
  let message = "";
  try {
    await new GitHubGraphSource(dupeApi, "@acme/").load();
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("acme/design_system");
  expect(message).toContain("acme/design_system_fork");
});

test("a graph with one unparseable and one nameless manifest reports two skipped entries naming both repos", async () => {
  const repos: RepoRef[] = [
    { fullName: "acme/broken", private: false, defaultBranch: "main" },
    { fullName: "acme/nameless", private: false, defaultBranch: "main" },
    { fullName: "acme/design_system", private: false, defaultBranch: "main" },
  ];
  const manifests: Record<string, string> = {
    "acme/broken": "{ this is not json",
    "acme/nameless": JSON.stringify({ version: "1.0.0" }),
    "acme/design_system": JSON.stringify({ name: "@acme/design", version: "1.1.49" }),
  };
  const source = new GitHubGraphSource(
    { listRepos: async () => repos, getManifest: async (f) => manifests[f] ?? null },
    "@acme/",
  );
  const original = console.error;
  console.error = () => {};
  try { await source.load(); } finally { console.error = original; }

  expect(source.skipped.length).toBe(2);
  expect(source.skipped.map((s) => s.repo).sort()).toEqual(["acme/broken", "acme/nameless"]);
});

test("a repo with no package.json (raw === null) produces no skipped entry", async () => {
  const source = new GitHubGraphSource(api(), "@acme/");
  await source.load();
  expect(source.skipped.some((s) => s.repo === "acme/no-manifest")).toBe(false);
});

test("one manifest request per repo, no duplicates", async () => {
  const a = api();
  await new GitHubGraphSource(a, "@acme/").load();
  expect(a.manifestCalls.length).toBe(REPOS.length);
  expect(new Set(a.manifestCalls).size).toBe(REPOS.length);
});

// --- peerDependencies edge-set pinning (Important E) --------------------------
//
// No fixture above ever gave a manifest a `peerDependencies` block, so a
// regression that dropped it from the `Object.keys({ ...dependencies,
// ...peerDependencies })` merge (mirroring `scanRepos`) would have left this
// whole suite green.
test("peerDependencies are folded into deps, same as dependencies", async () => {
  const repos: RepoRef[] = [
    { fullName: "acme/design_system", private: false, defaultBranch: "main" },
    { fullName: "acme/peer-consumer", private: false, defaultBranch: "main" },
  ];
  const manifests: Record<string, string> = {
    "acme/design_system": JSON.stringify({ name: "@acme/design", version: "1.1.49" }),
    // Its ONLY edge to @acme/design is a peerDependency.
    "acme/peer-consumer": JSON.stringify({
      name: "@acme/peer-consumer", version: "1.0.0",
      peerDependencies: { "@acme/design": "^1.1.49" },
    }),
  };
  const source = new GitHubGraphSource(
    { listRepos: async () => repos, getManifest: async (f) => manifests[f] ?? null },
    "@acme/",
  );
  const g = await source.load();
  expect(g.get("@acme/peer-consumer")!.deps).toEqual(["@acme/design"]);
});
