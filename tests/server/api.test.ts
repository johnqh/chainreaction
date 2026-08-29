import { test, expect } from "bun:test";
import { handleApiRequest, type ApiDeps, type InstallationApis, type InstallationApiFactory } from "../../src/server/api";
import type { SessionPayload } from "../../src/auth/session";
import type { GitHubApi, RepoRef } from "../../src/graph/githubSource";
import type { RepoAdminApi, RepoMeta, ProtectionProbe } from "../../src/prepare/adminApi";
import type { PrApi } from "../../src/github/prApi";
import type { ChangesetEntry } from "../../src/graph/types";

// --- fakes ---------------------------------------------------------------------

function fakeGitHubApi(opts: {
  repos?: RepoRef[];
  manifests?: Record<string, string | null>;
} = {}): { api: GitHubApi; calls: string[] } {
  const repos = opts.repos ?? [
    { fullName: "acme/design", private: false, defaultBranch: "trunk" },
    { fullName: "acme/components", private: true, defaultBranch: "trunk" },
  ];
  const manifests = opts.manifests ?? {
    "acme/design": JSON.stringify({ name: "@acme/design", version: "1.0.0" }),
    "acme/components": JSON.stringify({
      name: "@acme/components",
      version: "2.0.0",
      dependencies: { "@acme/design": "^1.0.0" },
    }),
  };
  const calls: string[] = [];
  const api: GitHubApi = {
    listRepos: async () => {
      calls.push("listRepos");
      return repos;
    },
    getManifest: async (fullName) => {
      calls.push(`getManifest:${fullName}`);
      return manifests[fullName] ?? null;
    },
  };
  return { api, calls };
}

/** A RepoAdminApi that reports every repo as ready (unprotected, has the workflow, "ci" observed). */
function fakeAdminApi(): RepoAdminApi {
  return {
    getRepo: async (full): Promise<RepoMeta> => ({ defaultBranch: "trunk", isPrivate: false, allowAutoMerge: false }),
    getProtection: async (): Promise<ProtectionProbe> => ({ status: 404 }),
    hasFile: async () => true,
    recentPrHeadSha: async () => null,
    listCheckRuns: async () => ["ci"],
    setProtection: async () => {},
    enableAutoMerge: async () => {},
  };
}

function fakePrApi(opts: { mergeShouldFail?: boolean } = {}): { api: PrApi; calls: string[] } {
  const calls: string[] = [];
  let nextPr = 100;
  const api: PrApi = {
    defaultBranchSha: async (full, branch) => {
      calls.push(`defaultBranchSha:${full}:${branch}`);
      return `sha-${full}`;
    },
    createBranch: async (full, branch, fromSha) => {
      calls.push(`createBranch:${full}:${branch}:${fromSha}`);
    },
    putFile: async (full, branch, path, content) => {
      calls.push(`putFile:${full}:${branch}:${path}`);
    },
    openPr: async (full, head, base, title) => {
      calls.push(`openPr:${full}:${head}:${base}`);
      return nextPr++;
    },
    mergePr: async (full, pr) => {
      calls.push(`mergePr:${full}:${pr}`);
      if (opts.mergeShouldFail) throw new Error(`mergePr ${full}#${pr} failed: 405`);
    },
    prState: async () => "OPEN",
  };
  return { api, calls };
}

function makeApis(over: Partial<{ github: GitHubApi; admin: RepoAdminApi; pr: PrApi }> = {}): InstallationApis {
  return {
    githubApi: over.github ?? fakeGitHubApi().api,
    adminApi: over.admin ?? fakeAdminApi(),
    prApi: over.pr ?? fakePrApi().api,
  };
}

function factoryFor(apis: InstallationApis): { factory: InstallationApiFactory; calls: number[] } {
  const calls: number[] = [];
  const factory: InstallationApiFactory = (installationId) => {
    calls.push(installationId);
    return apis;
  };
  return { factory, calls };
}

function baseDeps(over: Partial<ApiDeps> = {}): ApiDeps {
  const { factory } = factoryFor(makeApis());
  return {
    apisFor: factory,
    scope: "@acme/",
    requiredChecks: ["ci"],
    isResolvable: async () => true,
    sleep: async () => {},
    ...over,
  };
}

function session(installationId = 42): SessionPayload {
  return { userId: "555", installationId, exp: Number.MAX_SAFE_INTEGER };
}

function req(path: string, init?: RequestInit): { req: Request; url: URL } {
  const url = new URL(`http://localhost${path}`);
  return { req: new Request(url, init), url };
}

async function call(path: string, deps: ApiDeps, sess: SessionPayload | null, init?: RequestInit) {
  const { req: r, url } = req(path, init);
  const res = await handleApiRequest(r, url, sess, deps);
  if (!res) throw new Error(`handleApiRequest returned null for ${path} — route not recognized`);
  return res;
}

function entry(over: Partial<ChangesetEntry> & { pkg: string; repo: string }): ChangesetEntry {
  return {
    dir: undefined,
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    depBumps: {},
    level: 0,
    ...over,
  };
}

// --- unrecognized path -----------------------------------------------------

test("an unrelated path is not handled (returns null so the caller can fall through)", async () => {
  const { req: r, url } = req("/api/whoami");
  const res = await handleApiRequest(r, url, session(), baseDeps());
  expect(res).toBeNull();
});

// --- every route: 401 without a session, never a default-scoped 200 --------

const ROUTES: { path: string; init?: RequestInit }[] = [
  { path: "/api/repos" },
  { path: "/api/graph" },
  { path: "/api/update", init: { method: "POST", body: JSON.stringify({ pkg: "x", mode: "one" }) } },
  { path: "/api/prs", init: { method: "POST", body: JSON.stringify({ entries: [] }) } },
  { path: "/api/merge", init: { method: "POST", body: JSON.stringify({ repo: "acme/x", pr: 1 }) } },
  { path: "/api/train", init: { method: "POST", body: JSON.stringify({ entries: [], prs: {} }) } },
];

for (const { path, init } of ROUTES) {
  test(`${init?.method ?? "GET"} ${path} with no session is a flat 401, not a default-scoped 200`, async () => {
    const { factory, calls } = factoryFor(makeApis());
    const deps = baseDeps({ apisFor: factory });
    const res = await call(path, deps, null, init);
    expect(res.status).toBe(401);
    // The installation-api factory must never even be consulted without a session.
    expect(calls).toEqual([]);
  });
}

// --- every route is scoped to session.installationId, never a body-supplied id --

test("apisFor is called with the session's installationId, and a body-supplied installationId is ignored", async () => {
  const { factory, calls } = factoryFor(makeApis());
  const deps = baseDeps({ apisFor: factory });
  await call("/api/repos", deps, session(42));
  expect(calls).toEqual([42]);

  const { factory: factory2, calls: calls2 } = factoryFor(makeApis());
  const deps2 = baseDeps({ apisFor: factory2 });
  await call("/api/merge", deps2, session(7), {
    method: "POST",
    body: JSON.stringify({ repo: "acme/design", pr: 1, installationId: 999 }),
  });
  expect(calls2).toEqual([7]);
});

// --- GET /api/repos ----------------------------------------------------------

test("GET /api/repos returns name, private flag, and prepared state for every installation repo", async () => {
  const deps = baseDeps();
  const res = await call("/api/repos", deps, session());
  expect(res.status).toBe(200);
  const body = (await res.json()) as { repos: { name: string; private: boolean; prepared: { ready: boolean } }[] };
  expect(body.repos.map((r) => r.name).sort()).toEqual(["acme/components", "acme/design"]);
  expect(body.repos.every((r) => r.prepared.ready === true)).toBe(true);
  const components = body.repos.find((r) => r.name === "acme/components")!;
  expect(components.private).toBe(true);
});

test("GET /api/repos reports a non-ready prepared state (never throws) when assessment fails", async () => {
  const admin: RepoAdminApi = {
    ...fakeAdminApi(),
    getRepo: async () => {
      throw new Error("getRepo acme/design failed: 500");
    },
  };
  const { factory } = factoryFor(makeApis({ admin }));
  const deps = baseDeps({ apisFor: factory });
  const res = await call("/api/repos", deps, session());
  expect(res.status).toBe(200);
  const body = (await res.json()) as { repos: { name: string; prepared: { ready: boolean; blockers: string[] } }[] };
  const design = body.repos.find((r) => r.name === "acme/design")!;
  expect(design.prepared.ready).toBe(false);
  expect(design.prepared.blockers.length).toBeGreaterThan(0);
});

// --- GET /api/graph ------------------------------------------------------------

test("GET /api/graph returns nodes, edges tagged dependency/devDependency, and skipped repos", async () => {
  const { api: github } = fakeGitHubApi({
    repos: [
      { fullName: "acme/design", private: false, defaultBranch: "trunk" },
      { fullName: "acme/components", private: false, defaultBranch: "trunk" },
      { fullName: "acme/broken", private: false, defaultBranch: "trunk" },
    ],
    manifests: {
      "acme/design": JSON.stringify({ name: "@acme/design", version: "1.0.0" }),
      "acme/components": JSON.stringify({
        name: "@acme/components",
        version: "2.0.0",
        dependencies: { "@acme/design": "^1.0.0" },
        devDependencies: { "@acme/tooling": "^1.0.0" },
      }),
      "acme/broken": "not json",
    },
  });
  const { factory } = factoryFor(makeApis({ github }));
  const deps = baseDeps({ apisFor: factory });
  const res = await call("/api/graph", deps, session());
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    nodes: { pkg: string }[];
    edges: { from: string; to: string; kind: string }[];
    skipped: { repo: string; reason: string }[];
  };
  expect(body.nodes.map((n) => n.pkg).sort()).toEqual(["@acme/components", "@acme/design"]);
  expect(body.edges).toEqual([{ from: "@acme/components", to: "@acme/design", kind: "dependency" }]);
  expect(body.skipped).toEqual([{ repo: "acme/broken", reason: expect.stringContaining("unparseable") as unknown as string }]);
});

// --- POST /api/update: preview only, never mutates ----------------------------

test("POST /api/update mode=one returns the changeset without opening anything", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });
  const res = await call("/api/update", deps, session(), {
    method: "POST",
    body: JSON.stringify({ pkg: "@acme/components", mode: "one" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries: ChangesetEntry[] };
  expect(body.entries).toHaveLength(1);
  expect(body.entries[0]!.pkg).toBe("@acme/components");
  expect(body.entries[0]!.toVersion).toBe("2.0.1");
  // The non-negotiable property: no PR API call of any kind happened.
  expect(prCalls).toEqual([]);
});

test("POST /api/update mode=chain returns every affected package, still without opening anything", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });
  const res = await call("/api/update", deps, session(), {
    method: "POST",
    body: JSON.stringify({ pkg: "@acme/components", mode: "chain" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries: ChangesetEntry[] };
  expect(body.entries.map((e) => e.pkg).sort()).toEqual(["@acme/components", "@acme/design"]);
  expect(prCalls).toEqual([]);
});

test("POST /api/update rejects a malformed body", async () => {
  const deps = baseDeps();
  const res = await call("/api/update", deps, session(), { method: "POST", body: JSON.stringify({ pkg: "x" }) });
  expect(res.status).toBe(400);
});

test("POST /api/update 404s an unknown package", async () => {
  const deps = baseDeps();
  const res = await call("/api/update", deps, session(), {
    method: "POST",
    body: JSON.stringify({ pkg: "@acme/nope", mode: "one" }),
  });
  expect(res.status).toBe(404);
});

// --- POST /api/prs -------------------------------------------------------------

test("POST /api/prs opens a branch/commit/PR per entry against the repo's real default branch, not \"main\"", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  const entries = [
    entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "1.0.1" }),
    entry({ pkg: "@acme/components", repo: "acme/components", toVersion: "2.0.1", depBumps: { "@acme/design": "^1.0.1" } }),
  ];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { prs: { pkg: string; repo: string; pr: number; state: string }[] };
  expect(body.prs).toHaveLength(2);

  // Every GitHub call for acme/design must use "trunk" (its real default
  // branch from listRepos), never a hardcoded "main".
  expect(prCalls.some((c) => c.startsWith("defaultBranchSha:acme/design:trunk"))).toBe(true);
  expect(prCalls.some((c) => c.includes("openPr:acme/design") && c.endsWith(":trunk"))).toBe(true);
  expect(prCalls.some((c) => c.includes(":main"))).toBe(false);

  const design = body.prs.find((p) => p.repo === "acme/design")!;
  const components = body.prs.find((p) => p.repo === "acme/components")!;
  expect(design.state).toBe("ready"); // no in-chain deps
  expect(components.state).toBe("blocked"); // depends on acme/design, not yet published
});

test("POST /api/prs refuses a changeset naming a repo outside this installation, and opens nothing", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  const entries = [
    entry({ pkg: "@acme/design", repo: "acme/design" }),
    entry({ pkg: "@evil/payload", repo: "attacker/payload" }),
  ];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(403);
  expect(prCalls).toEqual([]);
});

test("POST /api/prs rejects a malformed body", async () => {
  const deps = baseDeps();
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries: [{}] }) });
  expect(res.status).toBe(400);
});

// --- POST /api/merge -----------------------------------------------------------

test("POST /api/merge merges the named PR after confirming the repo belongs to this installation", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  const res = await call("/api/merge", deps, session(), {
    method: "POST",
    body: JSON.stringify({ repo: "acme/design", pr: 55 }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ merged: true, repo: "acme/design", pr: 55 });
  expect(prCalls).toEqual(["mergePr:acme/design:55"]);
});

test("POST /api/merge refuses to merge a PR on a repo outside this installation", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  const res = await call("/api/merge", deps, session(), {
    method: "POST",
    body: JSON.stringify({ repo: "attacker/payload", pr: 1 }),
  });
  expect(res.status).toBe(403);
  expect(prCalls).toEqual([]);
});

test("POST /api/merge rejects a malformed body", async () => {
  const deps = baseDeps();
  const res = await call("/api/merge", deps, session(), { method: "POST", body: JSON.stringify({ repo: "acme/design" }) });
  expect(res.status).toBe(400);
});

// --- POST /api/train -------------------------------------------------------------

test("POST /api/train runs the train to completion, merging bottom-up", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory, isResolvable: async () => true, sleep: async () => {} });

  const entries = [
    entry({ pkg: "@acme/design", repo: "acme/design" }),
    entry({ pkg: "@acme/components", repo: "acme/components", depBumps: { "@acme/design": "^1.0.1" } }),
  ];
  const res = await call("/api/train", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries, prs: { "acme/design": 10, "acme/components": 11 } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { outcome: { status: string; merged: { pkg: string }[] } };
  expect(body.outcome.status).toBe("success");
  expect(body.outcome.merged.map((m) => m.pkg)).toEqual(["@acme/design", "@acme/components"]);
  const mergeDesignIdx = prCalls.indexOf("mergePr:acme/design:10");
  const mergeComponentsIdx = prCalls.indexOf("mergePr:acme/components:11");
  expect(mergeDesignIdx).toBeGreaterThanOrEqual(0);
  expect(mergeComponentsIdx).toBeGreaterThan(mergeDesignIdx);
});

test("POST /api/train refuses to touch a repo outside this installation named in prs, and merges nothing", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design" })];
  const res = await call("/api/train", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries, prs: { "acme/design": 10, "attacker/payload": 999 } }),
  });
  expect(res.status).toBe(403);
  expect(prCalls).toEqual([]);
});

test("POST /api/train refuses to touch an entry naming a repo outside this installation, and merges nothing", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  const entries = [
    entry({ pkg: "@acme/design", repo: "acme/design" }),
    entry({ pkg: "@evil/payload", repo: "attacker/payload" }),
  ];
  const res = await call("/api/train", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries, prs: { "acme/design": 10, "attacker/payload": 999 } }),
  });
  expect(res.status).toBe(403);
  expect(prCalls).toEqual([]);
});

test("POST /api/train reports a stall from runTrain rather than throwing when a merge fails", async () => {
  const { api: pr, calls: prCalls } = fakePrApi({ mergeShouldFail: true });
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory, isResolvable: async () => true, sleep: async () => {} });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design" })];
  const res = await call("/api/train", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries, prs: { "acme/design": 10 } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { outcome: { status: string; pkg: string } };
  expect(body.outcome.status).toBe("stalled");
  expect(body.outcome.pkg).toBe("@acme/design");
  expect(prCalls).toContain("mergePr:acme/design:10");
});

test("POST /api/train rejects a malformed body", async () => {
  const deps = baseDeps();
  const res = await call("/api/train", deps, session(), { method: "POST", body: JSON.stringify({ entries: [] }) });
  expect(res.status).toBe(400);
});
