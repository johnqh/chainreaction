import { test, expect } from "bun:test";
import { handleApiRequest, type ApiDeps, type InstallationApis, type InstallationApiFactory } from "../../src/server/api";
import type { SessionPayload } from "../../src/auth/session";
import { MEMBERSHIP_VERIFICATION_FAILED } from "../../src/auth/oauth";
import type { GitHubApi, RepoRef } from "../../src/graph/githubSource";
import type { RepoAdminApi, RepoMeta, ProtectionProbe } from "../../src/prepare/adminApi";
import type { PrApi } from "../../src/github/prApi";
import type { ChangesetEntry } from "../../src/graph/types";

// --- fakes ---------------------------------------------------------------------

// The App's own installation-wide reach (used only for graph-building and
// readiness assessment — `apis.githubApi.listRepos()`, fetched with the
// App's installation token). Deliberately named separately from the user-
// scoped repos below: the whole point of Critical-C's fix is that these two
// lists can legitimately differ, and authorization must only ever follow
// the user-scoped one.
const DEFAULT_REPOS: RepoRef[] = [
  { fullName: "acme/design", private: false, defaultBranch: "trunk" },
  { fullName: "acme/components", private: true, defaultBranch: "trunk" },
];

function fakeGitHubApi(opts: {
  repos?: RepoRef[];
  manifests?: Record<string, string | null>;
} = {}): { api: GitHubApi; calls: string[] } {
  const repos = opts.repos ?? DEFAULT_REPOS;
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

const DEFAULT_INSTALLATION_ID = 42;
const DEFAULT_USER_TOKEN = "user-oauth-token-abc123";

/**
 * A fetch double for the two user-token-authenticated GitHub endpoints
 * Critical-C's fix (and Important-H's membership recheck) depend on:
 * `GET /user/installations` (membership — `assertInstallationMembership`)
 * and `GET /user/installations/{id}/repositories` (the user's own
 * accessible repos — `ownedRepos`). Deliberately never answers
 * `/installation/repositories` (the App-token endpoint `fakeGitHubApi`
 * serves) — the two are never the same call, and a route that accidentally
 * used the wrong one would hit this double's 404 fallthrough.
 */
function userScopedFetch(
  opts: {
    installationId?: number;
    /** The repos *this user* can access within the installation — may deliberately differ from fakeGitHubApi's repos. */
    repos?: RepoRef[];
    /** Installation ids this user belongs to at all, for the membership recheck. Defaults to just `installationId`. */
    memberOf?: number[];
    /** Simulate GitHub rejecting the repos call outright (401/403) — Critical-C's "sign out, don't fall back" case. */
    reposRejected?: boolean;
    /** Simulate some other non-2xx failure fetching repos (a systemic outage, not a rejected token). */
    reposFailStatus?: number;
    /** Simulate the membership check itself failing (a verification failure, not a clean non-member). */
    membershipFailStatus?: number;
  } = {},
): { fetchFn: typeof fetch; calls: string[] } {
  const installationId = opts.installationId ?? DEFAULT_INSTALLATION_ID;
  const repos = opts.repos ?? DEFAULT_REPOS;
  const memberOf = opts.memberOf ?? [installationId];
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url.startsWith(`https://api.github.com/user/installations/${installationId}/repositories`)) {
      if (opts.reposRejected) return new Response("token rejected", { status: 403 });
      if (opts.reposFailStatus) return new Response("upstream failure", { status: opts.reposFailStatus });
      return new Response(
        JSON.stringify({
          repositories: repos.map((r) => ({ full_name: r.fullName, private: r.private, default_branch: r.defaultBranch })),
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://api.github.com/user/installations")) {
      if (opts.membershipFailStatus) return new Response("upstream failure", { status: opts.membershipFailStatus });
      return new Response(
        JSON.stringify({ installations: memberOf.map((id) => ({ id, account: { login: "acme" } })) }),
        { status: 200 },
      );
    }
    return new Response("unexpected request in test double: " + url, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function baseDeps(over: Partial<ApiDeps> = {}): ApiDeps {
  const { factory } = factoryFor(makeApis());
  return {
    apisFor: factory,
    scopeFor: () => "@acme/",
    requiredChecksFor: () => ["ci"],
    isResolvable: async () => true,
    sleep: async () => {},
    fetchFn: userScopedFetch().fetchFn,
    ...over,
  };
}

function session(installationId = DEFAULT_INSTALLATION_ID): SessionPayload {
  return { userId: "555", installationId, userToken: DEFAULT_USER_TOKEN, exp: Number.MAX_SAFE_INTEGER };
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
  const repos: RepoRef[] = [
    { fullName: "acme/design", private: false, defaultBranch: "trunk" },
    { fullName: "acme/components", private: false, defaultBranch: "trunk" },
    { fullName: "acme/broken", private: false, defaultBranch: "trunk" },
  ];
  const { api: github } = fakeGitHubApi({
    repos,
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
  // The user's own accessible repos must include acme/broken too — this
  // test isn't exercising the read-side confused-deputy filter, so keep the
  // two lists in sync (see the dedicated read-side tests below for what
  // happens when they deliberately differ).
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ repos }).fetchFn });
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
  const repos: RepoRef[] = [
    { fullName: "acme/design", private: false, defaultBranch: "trunk" },
    { fullName: "acme/components", private: false, defaultBranch: "trunk" },
    { fullName: "acme/toolkit", private: false, defaultBranch: "trunk" },
  ];
  const { api: github } = fakeGitHubApi({
    repos,
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
  // The user's own accessible repos must also include acme/toolkit — this
  // test isn't exercising Critical-C's confused-deputy gap, so keep the two
  // lists in sync (see the dedicated confused-deputy tests below for what
  // happens when they deliberately differ).
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ repos }).fetchFn });

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

// --- Important 2: the semver allowlist must accept what the planner
// actually emits. planUpdateOne builds a dependency's depBumps value as
// `^${depNode.version}` straight from that dependency's CURRENT graph
// version, untouched by bumpPatch — so a dependency published at a
// prerelease tag produces a depBumps range like "^1.2.3-beta.1". Nothing
// before this test round-tripped /api/update's own output through
// /api/prs, which is how the too-narrow grammar got through: read alone,
// /api/update looked fine, and /api/prs's own tests only ever hand-built
// entries with plain-semver depBumps values. ---------------------------------

test("POST /api/update's own output, for a dependency published at a prerelease version, is accepted verbatim by POST /api/prs — the round trip a real 'Open PRs' click performs", async () => {
  const { api: github } = fakeGitHubApi({
    manifests: {
      // @acme/design is currently published at a prerelease tag.
      "acme/design": JSON.stringify({ name: "@acme/design", version: "1.2.3-beta.1" }),
      "acme/components": JSON.stringify({
        name: "@acme/components",
        version: "2.0.0",
        dependencies: { "@acme/design": "^1.0.0" },
      }),
    },
  });
  const { api: pr, putFileContents } = fakePrApi();
  const { factory } = factoryFor(makeApis({ github, pr }));
  const deps = baseDeps({ apisFor: factory });

  const updateRes = await call("/api/update", deps, session(), {
    method: "POST",
    body: JSON.stringify({ pkg: "@acme/components", mode: "one" }),
  });
  expect(updateRes.status).toBe(200);
  const updateBody = (await updateRes.json()) as { entries: ChangesetEntry[] };
  expect(updateBody.entries).toHaveLength(1);
  // Sanity: this is genuinely the shape that used to 400 — a prerelease tag
  // in the depBumps value, not something this test manufactured by hand.
  expect(updateBody.entries[0]!.depBumps["@acme/design"]).toBe("^1.2.3-beta.1");

  const prsRes = await call("/api/prs", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries: updateBody.entries }),
  });
  expect(prsRes.status).toBe(200);
  const components = JSON.parse(putFileContents["acme/components:package.json"]!);
  expect(components.dependencies["@acme/design"]).toBe("^1.2.3-beta.1");
});

test("the semver-range grammar still rejects a scheme smuggled in alongside a valid-looking prerelease/build suffix", async () => {
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
        // Anchored full-string match means a trailing/leading scheme can't
        // ride along with an otherwise-valid-looking version suffix either.
        depBumps: { "@acme/design": "^1.0.0-git+ssh://evil.example/pwn.git" },
        level: 0,
      },
    ],
  };
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify(raw) });
  expect(res.status).toBe(400);
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

// --- Important 1: the ownedRepos fail-open path is untested on 3 of 4
// mutating routes — only /api/merge had these. Verified: without these,
// reverting /api/prs's ownedRepos catch to fall back to
// apis.githubApi.listRepos() (the App's own reach) leaves the suite green. --

test("POST /api/prs reports 502 when ownedRepos itself fails for a reason other than a rejected token (a systemic failure)", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ reposFailStatus: 500 }).fetchFn });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "1.0.1" })];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(502);
  expect(prCalls).toEqual([]);
});

test("POST /api/prs reports 401 (sign in again), not a fallback to the App's own repo list, when the user's own token is rejected fetching their accessible repos", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ reposRejected: true }).fetchFn });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "1.0.1" })];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).not.toContain(DEFAULT_USER_TOKEN);
  expect(prCalls).toEqual([]);
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

test("POST /api/merge reports 503, not 502, when the fresh membership recheck itself fails (a systemic failure, not this PR's)", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const { fetchFn, calls: fetchCalls } = userScopedFetch({ membershipFailStatus: 500 });
  const deps = baseDeps({ apisFor: factory, fetchFn });

  const res = await call("/api/merge", deps, session(), {
    method: "POST",
    body: JSON.stringify({ repo: "acme/design", pr: 55 }),
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: MEMBERSHIP_VERIFICATION_FAILED });
  // mergePr must never even be attempted once the membership recheck itself
  // failed, and ownedRepos's own (user-scoped repos) call must never even be
  // reached — the membership recheck runs first and short-circuits.
  expect(prCalls).toEqual([]);
  expect(fetchCalls.some((u) => u.includes("/repositories"))).toBe(false);
});

test("POST /api/merge reports 503, not 502, when ownedRepos itself fails for a reason other than a rejected token (a systemic failure, not this PR's)", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ reposFailStatus: 500 }).fetchFn });

  const res = await call("/api/merge", deps, session(), {
    method: "POST",
    body: JSON.stringify({ repo: "acme/design", pr: 55 }),
  });
  expect(res.status).toBe(503);
  expect(prCalls).toEqual([]);
});

// Critical-C: a rejected user token (revoked/expired) must read as "sign in
// again", not as a generic systemic failure — and never fall back to the
// App's own installation-wide repo list just because this check failed.
test("POST /api/merge reports 401 (sign in again), not 503, when the user's own token is rejected fetching their accessible repos", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ reposRejected: true }).fetchFn });

  const res = await call("/api/merge", deps, session(), {
    method: "POST",
    body: JSON.stringify({ repo: "acme/design", pr: 55 }),
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).not.toContain(DEFAULT_USER_TOKEN);
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

// --- Important 1: the ownedRepos fail-open path is untested here too. ------

test("POST /api/train reports 502 when ownedRepos itself fails for a reason other than a rejected token (a systemic failure)", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ reposFailStatus: 500 }).fetchFn });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design" })];
  const res = await call("/api/train", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries, prs: { "acme/design": 10 } }),
  });
  expect(res.status).toBe(502);
  expect(prCalls).toEqual([]);
});

test("POST /api/train reports 401 (sign in again), not a fallback to the App's own repo list, when the user's own token is rejected", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ reposRejected: true }).fetchFn });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design" })];
  const res = await call("/api/train", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries, prs: { "acme/design": 10 } }),
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).not.toContain(DEFAULT_USER_TOKEN);
  expect(prCalls).toEqual([]);
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

// --- Important 1: the ownedRepos fail-open path is untested here too. ------

test("POST /api/published reports 502 when ownedRepos itself fails for a reason other than a rejected token (a systemic failure)", async () => {
  let calls = 0;
  const deps = baseDeps({
    fetchFn: userScopedFetch({ reposFailStatus: 500 }).fetchFn,
    isResolvable: async () => {
      calls++;
      return true;
    },
  });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design" })];
  const res = await call("/api/published", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(502);
  expect(calls).toBe(0);
});

test("POST /api/published reports 401 (sign in again), not a fallback to the App's own repo list, when the user's own token is rejected", async () => {
  let calls = 0;
  const deps = baseDeps({
    fetchFn: userScopedFetch({ reposRejected: true }).fetchFn,
    isResolvable: async () => {
      calls++;
      return true;
    },
  });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design" })];
  const res = await call("/api/published", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).not.toContain(DEFAULT_USER_TOKEN);
  expect(calls).toBe(0);
});

test("POST /api/published with no session is a flat 401", async () => {
  const deps = baseDeps();
  const res = await call("/api/published", deps, null, {
    method: "POST",
    body: JSON.stringify({ entries: [entry({ pkg: "@acme/design", repo: "acme/design" })] }),
  });
  expect(res.status).toBe(401);
});

// --- Critical C: confused deputy — authorization must follow the signed-in
// user's own accessible repos, never the App installation's full reach -----
//
// The fixture below is the whole point: `acme/secret` sits in the App's own
// installation-wide repo list (what `GET /installation/repositories` would
// return, and what `fakeGitHubApi`/the graph-building path sees) but is
// deliberately absent from the signed-in user's own accessible repos (what
// `GET /user/installations/{id}/repositories`, i.e. `userScopedFetch`,
// returns). A fixture where the two lists are identical would never
// distinguish "authorized against the App's reach" from "authorized against
// the user's own reach" — this one does.

const SECRET_REPO: RepoRef = { fullName: "acme/secret", private: true, defaultBranch: "trunk" };

function confusedDeputyFixture() {
  // The App can reach acme/secret (e.g. some other, unrelated installation
  // member added it) — this is deliberately part of the graph-building
  // repo list, never the authorization list.
  const { api: github } = fakeGitHubApi({
    repos: [...DEFAULT_REPOS, SECRET_REPO],
    manifests: {
      "acme/design": JSON.stringify({ name: "@acme/design", version: "1.0.0" }),
      "acme/components": JSON.stringify({
        name: "@acme/components",
        version: "2.0.0",
        dependencies: { "@acme/design": "^1.0.0" },
      }),
      "acme/secret": JSON.stringify({ name: "@acme/secret", version: "9.0.0" }),
    },
  });
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ github, pr }));
  // The signed-in user's own accessible repos deliberately exclude acme/secret.
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ repos: DEFAULT_REPOS }).fetchFn });
  return { deps, prCalls };
}

test("POST /api/prs rejects a repo the App can reach but the signed-in user cannot, even though the installation's own repo list contains it", async () => {
  const { deps, prCalls } = confusedDeputyFixture();
  const entries = [entry({ pkg: "@acme/secret", repo: "acme/secret", toVersion: "9.0.1" })];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(403);
  expect(prCalls).toEqual([]); // no branch/commit/PR ever attempted against acme/secret
});

test("POST /api/merge rejects a PR on a repo the App can reach but the signed-in user cannot", async () => {
  const { deps, prCalls } = confusedDeputyFixture();
  const res = await call("/api/merge", deps, session(), {
    method: "POST",
    body: JSON.stringify({ repo: "acme/secret", pr: 1 }),
  });
  expect(res.status).toBe(403);
  expect(prCalls).toEqual([]);
});

test("POST /api/train rejects a repo the App can reach but the signed-in user cannot, whether named in entries or in prs", async () => {
  const { deps, prCalls } = confusedDeputyFixture();
  const entries = [entry({ pkg: "@acme/secret", repo: "acme/secret" })];
  const res = await call("/api/train", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries, prs: { "acme/secret": 1 } }),
  });
  expect(res.status).toBe(403);
  expect(prCalls).toEqual([]);
});

test("POST /api/published rejects a repo the App can reach but the signed-in user cannot", async () => {
  const { deps } = confusedDeputyFixture();
  let resolvableCalls = 0;
  deps.isResolvable = async () => {
    resolvableCalls++;
    return true;
  };
  const entries = [entry({ pkg: "@acme/secret", repo: "acme/secret", toVersion: "9.0.1" })];
  const res = await call("/api/published", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(403);
  expect(resolvableCalls).toBe(0);
});

// The contrapositive of the four tests above, on the same fixture: a repo
// that genuinely is in the user's own accessible list still works, proving
// the 403s above are about acme/secret specifically and not some blanket
// failure of the fixture itself.
test("POST /api/merge still succeeds for a repo the signed-in user does own, on the very same confused-deputy fixture", async () => {
  const { deps, prCalls } = confusedDeputyFixture();
  const res = await call("/api/merge", deps, session(), {
    method: "POST",
    body: JSON.stringify({ repo: "acme/design", pr: 7 }),
  });
  expect(res.status).toBe(200);
  expect(prCalls).toEqual(["mergePr:acme/design:7"]);
});

// --- Re-review Critical 1: the confused deputy was closed on the write
// side only — every read route must also filter to the signed-in user's
// own accessible repos, on the exact same confusedDeputyFixture. ------------

test("GET /api/repos never returns a repo the App can reach but the signed-in user cannot", async () => {
  const { deps } = confusedDeputyFixture();
  const res = await call("/api/repos", deps, session());
  expect(res.status).toBe(200);
  const body = (await res.json()) as { repos: { name: string }[] };
  const names = body.repos.map((r) => r.name).sort();
  expect(names).toEqual(["acme/components", "acme/design"]);
  expect(names).not.toContain("acme/secret");
});

test("GET /api/graph never returns a node, or an edge naming it, for a package in a repo the signed-in user cannot see", async () => {
  const { deps } = confusedDeputyFixture();
  const res = await call("/api/graph", deps, session());
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    nodes: { pkg: string; repo: string }[];
    edges: { from: string; to: string }[];
  };
  expect(body.nodes.map((n) => n.pkg).sort()).toEqual(["@acme/components", "@acme/design"]);
  expect(body.nodes.some((n) => n.repo === "acme/secret")).toBe(false);
  expect(body.edges.some((e) => e.from === "@acme/secret" || e.to === "@acme/secret")).toBe(false);
});

test("POST /api/update rejects the root package with the same 404 as a genuinely unknown one, when its repo is invisible to the signed-in user — no oracle for 'exists but hidden'", async () => {
  const { deps } = confusedDeputyFixture();
  const visible = await call("/api/update", deps, session(), {
    method: "POST",
    body: JSON.stringify({ pkg: "@acme/nope-does-not-exist-at-all", mode: "one" }),
  });
  const hidden = await call("/api/update", deps, session(), {
    method: "POST",
    body: JSON.stringify({ pkg: "@acme/secret", mode: "one" }),
  });
  expect(hidden.status).toBe(404);
  expect(hidden.status).toBe(visible.status);
  // Same message *template* for both — "unknown package: <the pkg you
  // asked about>" — so the response shape itself never distinguishes
  // "genuinely absent" from "exists, but not visible to you"; each body
  // naturally echoes back the caller's own requested pkg name (not a leak:
  // they already knew what they asked for), so the two bodies legitimately
  // differ only in that name, never in a graph-derived detail.
  const hiddenBody = (await hidden.json()) as { error: string };
  const visibleBody = (await visible.json()) as { error: string };
  expect(hiddenBody.error).toBe("unknown package: @acme/secret");
  expect(visibleBody.error).toBe("unknown package: @acme/nope-does-not-exist-at-all");
});

test("POST /api/update mode=chain filters a repo the signed-in user cannot see out of the returned changeset, even though the graph needed it to compute the chain correctly", async () => {
  const repos: RepoRef[] = [...DEFAULT_REPOS, SECRET_REPO];
  const { api: github } = fakeGitHubApi({
    repos,
    manifests: {
      "acme/design": JSON.stringify({ name: "@acme/design", version: "1.0.0" }),
      "acme/components": JSON.stringify({
        name: "@acme/components",
        version: "2.0.0",
        // @acme/components depends on @acme/secret too — dependencyClosure
        // (which planUpdateChain walks) must still traverse into it to
        // compute a correct chain, but the response must never say so.
        dependencies: { "@acme/design": "^1.0.0", "@acme/secret": "^9.0.0" },
      }),
      "acme/secret": JSON.stringify({ name: "@acme/secret", version: "9.0.0" }),
    },
  });
  const { factory } = factoryFor(makeApis({ github }));
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ repos: DEFAULT_REPOS }).fetchFn });

  const res = await call("/api/update", deps, session(), {
    method: "POST",
    body: JSON.stringify({ pkg: "@acme/components", mode: "chain" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries: { pkg: string; repo: string }[] };
  expect(body.entries.map((e) => e.pkg).sort()).toEqual(["@acme/components", "@acme/design"]);
  expect(body.entries.some((e) => e.repo === "acme/secret")).toBe(false);
});

// --- Re-review Critical 2: entry.repo was never checked against the repo
// the graph actually says owns entry.pkg — anyone who can merely *see* a
// repo could point the App's write access at it while naming a completely
// different package's identity and version. ---------------------------------

test("POST /api/prs rejects an entry whose repo does not match the graph's own repo for that pkg, even when the named repo is genuinely owned and every field is well-formed", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  // @acme/components really lives in acme/components — naming acme/design
  // (a real, owned repo, just the wrong one for this pkg) must be rejected,
  // not silently accepted and written to acme/design.
  const entries = [entry({ pkg: "@acme/components", repo: "acme/design", toVersion: "2.0.1", depBumps: {} })];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(400);
  expect(prCalls).toEqual([]); // no branch/commit/PR ever attempted
});

test("POST /api/prs's repo-mismatch rejection never echoes the graph's real repo or version for a pkg the caller may not be entitled to see", async () => {
  // Same confused-deputy shape as the read-side tests: acme/secret is real,
  // has a real version, and is owned by nobody the caller controls — but
  // the caller names it alongside a repo they DO own. This is rejected by
  // the entry.repo===node.repo check itself (see the dedicated test above);
  // this test additionally pins that its *message* never leaks which repo
  // actually owns @acme/secret or what its real version is.
  const { deps, prCalls } = confusedDeputyFixture();
  const entries = [entry({ pkg: "@acme/secret", repo: "acme/design", toVersion: "1.0.1", depBumps: {} })];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  // The real secret version is "9.0.0" — must never appear. Its full-name
  // repo "acme/secret" is deliberately not asserted absent here: it happens
  // to be a substring of the caller's own supplied "@acme/secret" pkg name,
  // which is fine to echo (see the message-shape test below for the actual
  // repo-identity assertion).
  expect(body.error).not.toContain("9.0.0");
  expect(prCalls).toEqual([]);
});

test("POST /api/prs's toVersion-mismatch message no longer echoes the graph-derived bumped version, even for a pkg/repo pair the caller does own", async () => {
  // Once entry.repo===node.repo is required (Critical 2's primary fix), the
  // only way to ever reach this branch at all is with a repo the caller
  // already owns — so this pins general hygiene (an internal computed value
  // dropped from an error message), not a live cross-tenant exploit in this
  // codebase today. It is still exactly the line the review named, and
  // still worth pinning: a future change to the ordering of these two
  // checks would silently reopen the version-echo the review flagged.
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory });

  // @acme/design's real current version is "1.0.0" (bumpPatch -> "1.0.1");
  // the caller supplies a deliberately wrong toVersion against its own,
  // genuinely-owned repo.
  const entries = [entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "9.9.9" })];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).not.toContain("1.0.1"); // the graph-derived correct bump
  expect(prCalls).toEqual([]);
});

// --- Important H: mutating routes re-verify installation membership, not --
// just repo ownership — a removed collaborator must lose access before the
// session cookie's own TTL runs out. -----------------------------------------

test("POST /api/prs rejects with 403 when the user no longer belongs to the installation at all, even naming only owned-looking repos", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  // The user belongs to some other installation now, but not this session's.
  const { fetchFn, calls: fetchCalls } = userScopedFetch({ memberOf: [999] });
  const deps = baseDeps({ apisFor: factory, fetchFn });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design", toVersion: "1.0.1" })];
  const res = await call("/api/prs", deps, session(), { method: "POST", body: JSON.stringify({ entries }) });
  expect(res.status).toBe(403);
  expect(prCalls).toEqual([]);
  // The membership recheck must short-circuit before ownedRepos's own call.
  expect(fetchCalls.some((u) => u.includes("/repositories"))).toBe(false);
});

test("POST /api/train rejects with 403 when the user no longer belongs to the installation at all", async () => {
  const { api: pr, calls: prCalls } = fakePrApi();
  const { factory } = factoryFor(makeApis({ pr }));
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ memberOf: [999] }).fetchFn });

  const entries = [entry({ pkg: "@acme/design", repo: "acme/design" })];
  const res = await call("/api/train", deps, session(), {
    method: "POST",
    body: JSON.stringify({ entries, prs: { "acme/design": 10 } }),
  });
  expect(res.status).toBe(403);
  expect(prCalls).toEqual([]);
});

// --- Fix-round: scopeFor/requiredChecksFor are looked up per installation ------

test("GET /api/repos resolves requiredChecks via requiredChecksFor(installationId), not a single server-wide value", async () => {
  const seenIds: number[] = [];
  const deps = baseDeps({
    requiredChecksFor: (installationId) => {
      seenIds.push(installationId);
      return ["ci"];
    },
    fetchFn: userScopedFetch({ installationId: 77 }).fetchFn,
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
    fetchFn: userScopedFetch({ installationId: 91 }).fetchFn,
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
    fetchFn: userScopedFetch({ installationId: 13 }).fetchFn,
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
  const repos: RepoRef[] = [
    { fullName: "acme/design", private: false, defaultBranch: "trunk" },
    { fullName: "acme/components", private: true, defaultBranch: "trunk" },
    { fullName: "acme/broken", private: false, defaultBranch: "trunk" },
  ];
  const { api: github } = fakeGitHubApi({
    repos,
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
  const deps = baseDeps({ apisFor: factory, fetchFn: userScopedFetch({ repos }).fetchFn });

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
