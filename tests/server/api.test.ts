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

function fakePrApi(opts: {
  mergeShouldFail?: boolean;
  /** mergePr rejects for this exact repo/pr, but prState reports it already MERGED. */
  alreadyMerged?: { repo: string; pr: number };
  /** putFile rejects for every call, simulating a GitHub-side write failure. */
  putFileShouldFail?: boolean;
} = {}): { api: PrApi; calls: string[]; putFileContents: Record<string, string> } {
  const calls: string[] = [];
  // Keyed by `${full}:${path}` — the actual manifest text committed, not just
  // that a call happened. A fake that discards `content` cannot tell "the
  // right manifest was committed" from "the original, unbumped manifest was
  // committed" apart, which is exactly the shape that let Critical A through.
  const putFileContents: Record<string, string> = {};
  let nextPr = 100;
  const isAlreadyMerged = (full: string, pr: number) =>
    opts.alreadyMerged?.repo === full && opts.alreadyMerged?.pr === pr;
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
      if (opts.putFileShouldFail) {
        throw new Error(`putFile ${full}:${path} failed: 502`);
      }
      putFileContents[`${full}:${path}`] = content;
    },
    openPr: async (full, head, base, title) => {
      calls.push(`openPr:${full}:${head}:${base}`);
      return nextPr++;
    },
    mergePr: async (full, pr) => {
      calls.push(`mergePr:${full}:${pr}`);
      if (opts.mergeShouldFail || isAlreadyMerged(full, pr)) {
        throw new Error(`mergePr ${full}#${pr} failed: 405`);
      }
    },
    prState: async (full, pr) => {
      calls.push(`prState:${full}:${pr}`);
      return isAlreadyMerged(full, pr) ? "MERGED" : "OPEN";
    },
  };
  return { api, calls, putFileContents };
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
    scopeFor: () => "@acme/",
    requiredChecksFor: () => ["ci"],
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
  { path: "/api/published", init: { method: "POST", body: JSON.stringify({ entries: [] }) } },
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

test("POST /api/prs commits a manifest with the bumped version and every depBump written into the right block — including an in-graph devDependency edge", async () => {
  // A third package, @acme/toolkit, devDepends on @acme/design only — the
  // exact shape (proj1 -> devDependency of proj2) that Critical A's own
  // worked example uses. If applyEntry stops rewriting devDependencies, this
  // is the fixture that catches it: the components/dependencies assertion
  // alone would not, since that block was never broken.
  const { api: github } = fakeGitHubApi({
    repos: [
      { fullName: "acme/design", private: false, defaultBranch: "trunk" },
      { fullName: "acme/components", private: false, defaultBranch: "trunk" },
      { fullName: "acme/toolkit", private: false, defaultBranch: "trunk" },
    ],
    manifests: {
      "acme/design": JSON.stringify({ name: "@acme/design", version: "1.0.0" }),
      "acme/components": JSON.stringify({
        name: "@acme/components",
        version: "2.0.0",
        dependencies: { "@acme/design": "^1.0.0", react: "^18.0.0" },
      }),
      "acme/toolkit": JSON.stringify({
        name: "@acme/toolkit",
        version: "3.0.0",
        devDependencies: { "@acme/design": "^1.0.0" },
      }),
    },
  });
  const { api: pr, putFileContents } = fakePrApi();
  const { factory } = factoryFor(makeApis({ github, pr }));
  const deps = baseDeps({ apisFor: factory });

  const entries = [
    entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "1.0.1" }),
    entry({ pkg: "@acme/components", repo: "acme/components", toVersion: "2.0.1", depBumps: { "@acme/design": "^1.0.1" } }),
    entry({ pkg: "@acme/toolkit", repo: "acme/toolkit", fromVersion: "3.0.0", toVersion: "3.0.1", depBumps: { "@acme/design": "^1.0.1" } }),
  ];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(200);

  const design = JSON.parse(putFileContents["acme/design:package.json"]!);
  expect(design.version).toBe("1.0.1");

  const components = JSON.parse(putFileContents["acme/components:package.json"]!);
  expect(components.version).toBe("2.0.1");
  expect(components.dependencies["@acme/design"]).toBe("^1.0.1");
  expect(components.dependencies.react).toBe("^18.0.0"); // untouched

  const toolkit = JSON.parse(putFileContents["acme/toolkit:package.json"]!);
  expect(toolkit.version).toBe("3.0.1");
  expect(toolkit.devDependencies["@acme/design"]).toBe("^1.0.1");
});

test("POST /api/prs surfaces a 502 and never calls openPr when putFile rejects", async () => {
  const { api: pr, calls: prCalls } = fakePrApi({ putFileShouldFail: true });
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "1.0.1" })];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(502);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("putFile");
  expect(prCalls.some((c) => c.startsWith("openPr"))).toBe(false);
});

test("POST /api/prs rejects a changeset whose toVersion/depBumps disagree with the current graph, even though every repo is owned and every field is well-formed", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  // Well-formed (plain semver / caret-semver-range) but not what the graph
  // would actually produce for @acme/design (current version 1.0.0 ->
  // bumpPatch would be 1.0.1, not 9.9.9).
  const entries = [entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "9.9.9" })];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(400);
  expect(prCalls).toEqual([]);
});

test("POST /api/prs rejects a depBumps key that is not an in-graph dependency of that package", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  // @acme/design has no dependencies of its own — naming @acme/components
  // here (a real in-graph package, just not a dependency of @acme/design)
  // must be rejected.
  const entries = [
    entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "1.0.1", depBumps: { "@acme/components": "^2.0.1" } }),
  ];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(400);
  expect(prCalls).toEqual([]);
});

test("POST /api/prs rejects a depBumps value that is not a plain semver range (e.g. a git URL), even naming a real toVersion and a real in-graph dependency key", async () => {
  // Isolates the format-layer (isChangesetEntry) defense from the graph-
  // re-derivation layer: `toVersion` is exactly the graph-correct bump, and
  // `@acme/design` genuinely is a dependency of `@acme/components`, so
  // validateEntriesAgainstGraph's key/toVersion checks alone would let this
  // through — only the semver-range grammar on the depBumps *value* catches
  // the malicious git URL an attacker put in a syntactically-plausible slot.
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  const raw = {
    entries: [
      {
        pkg: "@acme/components",
        repo: "acme/components",
        toVersion: "2.0.1",
        fromVersion: "2.0.0",
        depBumps: { "@acme/design": "git+ssh://git@evil.example/pwn.git" },
        level: 0,
      },
    ],
  };
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify(raw) });
  expect(res.status).toBe(400); // rejected at parse time, before any graph lookup
  expect(prCalls).toEqual([]);
});

test("POST /api/prs never opens a PR for a repo with no package.json — rejected before any GitHub write, since a manifestless repo never enters the graph", async () => {
  const { api: github } = fakeGitHubApi({
    manifests: {
      "acme/design": null, // no package.json on the default branch
      "acme/components": JSON.stringify({
        name: "@acme/components",
        version: "2.0.0",
        dependencies: { "@acme/design": "^1.0.0" },
      }),
    },
  });
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ github, pr }));
  const deps = baseDeps({ apisFor: factory });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "1.0.1" })];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  // Rejected by validateEntriesAgainstGraph: a repo with no package.json
  // never makes it into GitHubGraphSource's graph in the first place, so
  // `@acme/design` looks like an unknown package rather than reaching
  // openPrForEntry's own (now unreachable in this path) null-manifest guard.
  expect(res.status).toBe(400);
  expect(prCalls.some((c) => c.startsWith("putFile"))).toBe(false);
  expect(prCalls.some((c) => c.startsWith("openPr"))).toBe(false);
});

test("POST /api/prs surfaces a failure and never calls putFile/openPr when createBranch rejects", async () => {
  const { calls: prCalls } = fakePrApi();
  const failingPr: PrApi = {
    defaultBranchSha: async (full, branch) => `sha-${full}`,
    createBranch: async () => {
      throw new Error("createBranch failed: 422 reference already exists");
    },
    putFile: async () => {
      throw new Error("must not be called: createBranch already failed");
    },
    openPr: async () => {
      throw new Error("must not be called: createBranch already failed");
    },
    mergePr: async () => {},
    prState: async () => "OPEN",
  };
  const { factory } = factoryFor(makeApis({ pr: failingPr }));
  const deps = baseDeps({ apisFor: factory });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "1.0.1" })];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(502);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("createBranch failed");
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

// --- Fix-round: 502 vs 503 must distinguish an ordinary merge failure from a
// systemic one (a caller like the hosted web client, which treats a 502 here
// as "this specific PR's merge was rejected", must never see that status for
// a failure that has nothing to do with the named PR at all). ------------------

test("POST /api/merge reports 503, not 502, when the fresh membership check itself fails (a systemic failure, not this PR's)", async () => {
  const brokenGithub: GitHubApi = {
    listRepos: async () => {
      throw new Error("installation token exchange failed: bad credentials");
    },
    getManifest: async () => null,
  };
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ github: brokenGithub, pr }));
  const deps = baseDeps({ apisFor: factory });

  const res = await call("/api/merge", deps, session(), {
    method: "POST",
    body: JSON.stringify({ repo: "acme/design", pr: 55 }),
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "installation token exchange failed: bad credentials" });
  // mergePr must never even be attempted once the membership check itself failed.
  expect(prCalls).toEqual([]);
});

test("POST /api/merge reports 502, not 503, when mergePr itself is reached and GitHub rejects it", async () => {
  const { api: pr, calls: prCalls } = fakePrApi({ mergeShouldFail: true });
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  const res = await call("/api/merge", deps, session(), {
    method: "POST",
    body: JSON.stringify({ repo: "acme/design", pr: 55 }),
  });
  expect(res.status).toBe(502);
  expect(prCalls).toEqual(["mergePr:acme/design:55"]);
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

// --- POST /api/published ---------------------------------------------------------
//
// Exists so a manual "Refresh" in the web UI can ask the real question —
// "is this genuinely published?" — instead of "has this merged?" (which is
// what re-reading /api/graph's default-branch manifest would answer). See
// handlePublished's own doc comment in src/server/api.ts for the race this
// prevents.

test("POST /api/published returns exactly the pkgs whose toVersion isResolvable reports true, and none of the rest", async () => {
  const seen: { pkg: string; toVersion: string }[] = [];
  const deps = baseDeps({
    isResolvable: async (e) => {
      seen.push({ pkg: e.pkg, toVersion: e.toVersion });
      return e.pkg === "@acme/design"; // only this one is "published"
    },
  });

  const entries = [
    entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "1.2.0" }),
    entry({ pkg: "@acme/components", repo: "acme/components", toVersion: "2.3.0" }),
  ];
  const res = await call("/api/published", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ resolvable: ["@acme/design"] });
  expect(seen).toEqual([
    { pkg: "@acme/design", toVersion: "1.2.0" },
    { pkg: "@acme/components", toVersion: "2.3.0" },
  ]);
});

test("POST /api/published refuses to probe a repo outside this installation, and calls isResolvable for none of them", async () => {
  let calls = 0;
  const deps = baseDeps({ isResolvable: async () => { calls++; return true; } });

  const entries = [
    entry({ pkg: "@acme/design", repo: "acme/design" }),
    entry({ pkg: "@evil/payload", repo: "attacker/payload" }),
  ];
  const res = await call("/api/published", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries }),
  });
  expect(res.status).toBe(403);
  expect(calls).toBe(0);
});

test("POST /api/published rejects a malformed body", async () => {
  const deps = baseDeps();
  const res = await call("/api/published", deps, session(), { method: "POST", body: JSON.stringify({ entries: [] }) });
  expect(res.status).toBe(400);
});

test("POST /api/published with no session is a flat 401", async () => {
  const deps = baseDeps();
  const res = await call("/api/published", deps, null, {
    method: "POST",
    body: JSON.stringify({ entries: [entry({ pkg: "@acme/design", repo: "acme/design" })] }),
  });
  expect(res.status).toBe(401);
});

// --- Fix-round: scopeFor/requiredChecksFor are looked up per installation ------

test("GET /api/repos resolves requiredChecks via requiredChecksFor(installationId), not a single server-wide value", async () => {
  const seenIds: number[] = [];
  const deps = baseDeps({
    requiredChecksFor: (installationId) => {
      seenIds.push(installationId);
      return ["ci"];
    },
  });
  const res = await call("/api/repos", deps, session(77));
  expect(res.status).toBe(200);
  expect(seenIds).toEqual([77]);
});

test("GET /api/graph resolves scope via scopeFor(installationId), and a wrong scope silently empties the graph (not an error) — proving the lookup is actually used", async () => {
  const deps = baseDeps({ scopeFor: () => "@other-tenant/" });
  const res = await call("/api/graph", deps, session());
  expect(res.status).toBe(200);
  const body = (await res.json()) as { nodes: unknown[]; edges: unknown[] };
  // @acme/* packages exist, but "@other-tenant/" filters out every deps/devDeps
  // edge — this is exactly the failure mode Important-3 named, reproduced
  // here to prove scopeFor's return value actually reaches GitHubGraphSource.
  expect(body.nodes).toHaveLength(2);
  expect(body.edges).toEqual([]);
});

test("GET /api/graph passes the session's own installationId to scopeFor, not a fixed/wrong one", async () => {
  const seenIds: number[] = [];
  const deps = baseDeps({
    scopeFor: (installationId) => {
      seenIds.push(installationId);
      return "@acme/";
    },
  });
  const res = await call("/api/graph", deps, session(91));
  expect(res.status).toBe(200);
  expect(seenIds).toEqual([91]);
});

test("POST /api/update resolves scope via scopeFor(installationId)", async () => {
  const seenIds: number[] = [];
  const deps = baseDeps({
    scopeFor: (installationId) => {
      seenIds.push(installationId);
      return "@acme/";
    },
  });
  const res = await call("/api/update", deps, session(13), {
    method: "POST",
    body: JSON.stringify({ pkg: "@acme/components", mode: "one" }),
  });
  expect(res.status).toBe(200);
  expect(seenIds).toEqual([13]);
});

// --- Fix-round: /api/update must surface skipped repos, not just /api/graph ----

test("POST /api/update surfaces skipped repos from the graph load, same as /api/graph", async () => {
  const { api: github } = fakeGitHubApi({
    repos: [
      { fullName: "acme/design", private: false, defaultBranch: "trunk" },
      { fullName: "acme/components", private: true, defaultBranch: "trunk" },
      { fullName: "acme/broken", private: false, defaultBranch: "trunk" },
    ],
    manifests: {
      "acme/design": JSON.stringify({ name: "@acme/design", version: "1.0.0" }),
      "acme/components": JSON.stringify({
        name: "@acme/components",
        version: "2.0.0",
        dependencies: { "@acme/design": "^1.0.0" },
      }),
      "acme/broken": "not json",
    },
  });
  const { factory } = factoryFor(makeApis({ github }));
  const deps = baseDeps({ apisFor: factory });

  const res = await call("/api/update", deps, session(), {
    method: "POST",
    body: JSON.stringify({ pkg: "@acme/components", mode: "one" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { skipped: { repo: string; reason: string }[] };
  expect(body.skipped).toHaveLength(1);
  expect(body.skipped[0]!.repo).toBe("acme/broken");
  expect(body.skipped[0]!.reason).toContain("unparseable");
});

// --- Fix-round: the train's poll settings are wired to the right TrainDeps fields --

test("POST /api/train wires pollIntervalMs and maxPollAttempts to the correct TrainDeps fields, not swapped", async () => {
  // Distinguishable values, and a fixture that genuinely needs more than one
  // poll: isResolvable never resolves, so runTrain exhausts every attempt
  // and sleeps between all but the last. If pollIntervalMs/maxPollAttempts
  // were swapped, either the sleep duration or the attempt count below would
  // come out wrong.
  const sleepCalls: number[] = [];
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({
    apisFor: factory,
    pollIntervalMs: 7,
    maxPollAttempts: 3,
    isResolvable: async () => false,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
  });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design" })];
  const res = await call("/api/train", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries, prs: { "acme/design": 10 } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { outcome: { status: string } };
  expect(body.outcome.status).toBe("stalled");

  // maxPollAttempts=3 => isResolvable called 3 times => 2 sleeps in between,
  // each of pollIntervalMs=7. A swap would produce 7 resolve calls and 6
  // sleeps of 3ms instead.
  expect(sleepCalls).toEqual([7, 7]);
  expect(prCalls.filter((c) => c.startsWith("mergePr:")).length).toBe(1);
});

// --- Fix-round: an already-merged PR is a success, not a merge failure --------

test("POST /api/train: a merge that fails because the PR is already merged counts as success, not a stall", async () => {
  const { api: pr, calls: prCalls } = fakePrApi({ alreadyMerged: { repo: "acme/design", pr: 10 } });
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory, isResolvable: async () => true, sleep: async () => {} });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design" })];
  const res = await call("/api/train", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries, prs: { "acme/design": 10 } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { outcome: { status: string; merged: { pkg: string; repo: string }[] } };
  expect(body.outcome.status).toBe("success");
  expect(body.outcome.merged).toEqual([{ pkg: "@acme/design", repo: "acme/design" }]);
  expect(prCalls).toContain("mergePr:acme/design:10");
  expect(prCalls).toContain("prState:acme/design:10");
});

test("POST /api/train: a merge that fails and stays open (not merged) still stalls", async () => {
  const { api: pr, calls: prCalls } = fakePrApi({ mergeShouldFail: true });
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory, isResolvable: async () => true, sleep: async () => {} });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design" })];
  const res = await call("/api/train", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries, prs: { "acme/design": 10 } }),
  });
  const body = (await res.json()) as { outcome: { status: string; pkg: string } };
  expect(body.outcome.status).toBe("stalled");
  expect(body.outcome.pkg).toBe("@acme/design");
  expect(prCalls).toContain("prState:acme/design:10");
});
