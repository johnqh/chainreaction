// apiClient is a trust boundary: every method must issue exactly the
// documented request, validate the response shape, and never turn a
// non-2xx or malformed response into a plausible-looking default (an empty
// array, a silently-accepted garbage object). Every assertion below checks
// the *complete* value returned/sent, not a fragment, so a client that
// quietly drops or invents data cannot pass these tests.
import { test, expect } from "bun:test";
import {
  createApiClient,
  ApiError,
  type RepoStatus,
  type GraphResult,
} from "../../src/web/apiClient";
import type { ChangesetEntry } from "../../src/graph/types";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(
  responder: (call: Call) => Response,
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call = { url, method, body };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// --- getRepos ------------------------------------------------------------------

function sampleRepoStatus(): RepoStatus {
  return {
    name: "acme/core",
    private: false,
    prepared: { repo: "acme/core", ready: true, mechanism: "auto-merge", blockers: [] },
  };
}

test("getRepos issues GET /api/repos and returns the exact validated repos array", async () => {
  const { fetchFn, calls } = fakeFetch(() => json({ repos: [sampleRepoStatus()] }));
  const client = createApiClient({ fetchFn });
  const repos = await client.getRepos();
  expect(calls).toEqual([{ url: "/api/repos", method: "GET", body: undefined }]);
  expect(repos).toEqual([sampleRepoStatus()]);
});

test("getRepos throws ApiError carrying the server's message on a non-2xx response, not an empty array", async () => {
  const { fetchFn } = fakeFetch(() => json({ error: "installation token exchange failed" }, 502));
  const client = createApiClient({ fetchFn });
  await expect(client.getRepos()).rejects.toThrow("installation token exchange failed");
});

test("getRepos surfaces a 401 as ApiError with unauthorized:true", async () => {
  const { fetchFn } = fakeFetch(() => json({ error: "unauthorized" }, 401));
  const client = createApiClient({ fetchFn });
  try {
    await client.getRepos();
    throw new Error("expected getRepos to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).unauthorized).toBe(true);
  }
});

test("getRepos rejects a malformed (but 2xx) response instead of casting it", async () => {
  const { fetchFn } = fakeFetch(() => json({ repos: [{ name: "acme/core" }] }));
  const client = createApiClient({ fetchFn });
  await expect(client.getRepos()).rejects.toThrow(/expected shape/);
});

test("getRepos surfaces a network-level failure as ApiError, not an empty array", async () => {
  const fetchFn = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const client = createApiClient({ fetchFn });
  try {
    const result = await client.getRepos().catch((e) => e);
    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).status).toBe(0);
  } catch {
    throw new Error("getRepos must reject, not throw synchronously in a way that escapes the catch");
  }
});

// --- getGraph --------------------------------------------------------------------

function sampleGraph(): GraphResult {
  return {
    nodes: [{ pkg: "@acme/core", repo: "acme/core", version: "1.0.0", deps: [] }],
    edges: [{ from: "@acme/app", to: "@acme/core", kind: "dependency" }],
    skipped: [{ repo: "acme/broken", reason: "manifest has no name field" }],
  };
}

test("getGraph issues GET /api/graph and returns the exact validated nodes/edges/skipped", async () => {
  const { fetchFn, calls } = fakeFetch(() => json(sampleGraph()));
  const client = createApiClient({ fetchFn });
  const graph = await client.getGraph();
  expect(calls).toEqual([{ url: "/api/graph", method: "GET", body: undefined }]);
  expect(graph).toEqual(sampleGraph());
});

test("getGraph throws on a 502, never resolving to an empty graph", async () => {
  const { fetchFn } = fakeFetch(() => json({ error: "could not reach GitHub" }, 502));
  const client = createApiClient({ fetchFn });
  await expect(client.getGraph()).rejects.toThrow("could not reach GitHub");
});

// --- postUpdate ------------------------------------------------------------------

function sampleEntry(): ChangesetEntry {
  return {
    pkg: "@acme/app",
    repo: "acme/app",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    depBumps: { "@acme/core": "1.1.0" },
    level: 1,
  };
}

test("postUpdate('one') POSTs exactly {pkg, mode: 'one'} and returns the entries", async () => {
  const { fetchFn, calls } = fakeFetch(() => json({ entries: [sampleEntry()], skipped: [] }));
  const client = createApiClient({ fetchFn });
  const entries = await client.postUpdate("@acme/app", "one");
  expect(calls).toEqual([
    { url: "/api/update", method: "POST", body: { pkg: "@acme/app", mode: "one" } },
  ]);
  expect(entries).toEqual([sampleEntry()]);
});

test("postUpdate('chain') sends mode: 'chain'", async () => {
  const { fetchFn, calls } = fakeFetch(() => json({ entries: [], skipped: [] }));
  const client = createApiClient({ fetchFn });
  await client.postUpdate("@acme/app", "chain");
  expect(calls[0]!.body).toEqual({ pkg: "@acme/app", mode: "chain" });
});

test("postUpdate throws on 404 unknown package, carrying the server's message", async () => {
  const { fetchFn } = fakeFetch(() => json({ error: "unknown package: @acme/missing" }, 404));
  const client = createApiClient({ fetchFn });
  await expect(client.postUpdate("@acme/missing", "one")).rejects.toThrow("unknown package: @acme/missing");
});

// --- postPrs ------------------------------------------------------------------

test("postPrs POSTs {entries} and returns a Map keyed by repo with the exact PR numbers", async () => {
  const entry = sampleEntry();
  const { fetchFn, calls } = fakeFetch(() =>
    json({ prs: [{ pkg: entry.pkg, repo: entry.repo, pr: 42, state: "ready" }] }),
  );
  const client = createApiClient({ fetchFn });
  const prs = await client.postPrs([entry]);
  expect(calls).toEqual([{ url: "/api/prs", method: "POST", body: { entries: [entry] } }]);
  expect(prs).toEqual(new Map([["acme/app", 42]]));
});

test("postPrs throws on a partial-failure 502, never returning a Map for what wasn't opened", async () => {
  const { fetchFn } = fakeFetch(() =>
    json({ error: "opening PR for acme/app failed: rate limited", opened: [] }, 502),
  );
  const client = createApiClient({ fetchFn });
  await expect(client.postPrs([sampleEntry()])).rejects.toThrow("opening PR for acme/app failed: rate limited");
});

// --- postMerge ------------------------------------------------------------------

test("postMerge POSTs exactly {repo, pr} and resolves on success", async () => {
  const { fetchFn, calls } = fakeFetch(() => json({ merged: true, repo: "acme/app", pr: 7 }));
  const client = createApiClient({ fetchFn });
  await client.postMerge("acme/app", 7);
  expect(calls).toEqual([{ url: "/api/merge", method: "POST", body: { repo: "acme/app", pr: 7 } }]);
});

test("postMerge throws ApiError(502) with the server's message on an ordinary merge failure", async () => {
  const { fetchFn } = fakeFetch(() => json({ error: "required status check has not succeeded" }, 502));
  const client = createApiClient({ fetchFn });
  try {
    await client.postMerge("acme/app", 7);
    throw new Error("expected postMerge to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as Error).message).toBe("required status check has not succeeded");
  }
});

test("postMerge throws ApiError(403) when the repo isn't part of this installation", async () => {
  const { fetchFn } = fakeFetch(() => json({ error: "not part of this installation: acme/app" }, 403));
  const client = createApiClient({ fetchFn });
  const err = await client.postMerge("acme/app", 7).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(403);
  expect((err as ApiError).unauthorized).toBe(false);
});

// --- postTrain ------------------------------------------------------------------

test("postTrain POSTs {entries, prs} with prs as a plain object, and returns the exact outcome", async () => {
  const entry = sampleEntry();
  const { fetchFn, calls } = fakeFetch(() =>
    json({ outcome: { status: "success", merged: [{ pkg: entry.pkg, repo: entry.repo }] } }),
  );
  const client = createApiClient({ fetchFn });
  const outcome = await client.postTrain([entry], new Map([[entry.repo, 42]]));
  expect(calls).toEqual([
    { url: "/api/train", method: "POST", body: { entries: [entry], prs: { "acme/app": 42 } } },
  ]);
  expect(outcome).toEqual({ status: "success", merged: [{ pkg: entry.pkg, repo: entry.repo }] });
});

test("postTrain returns a stalled outcome verbatim, including pkg/repo/reason", async () => {
  const entry = sampleEntry();
  const stalled = {
    status: "stalled" as const,
    merged: [],
    pkg: "@acme/core",
    repo: "acme/core",
    reason: "@acme/core@1.1.0 never became resolvable",
  };
  const { fetchFn } = fakeFetch(() => json({ outcome: stalled }));
  const client = createApiClient({ fetchFn });
  const outcome = await client.postTrain([entry], new Map());
  expect(outcome).toEqual(stalled);
});

test("postTrain rejects an outcome missing the stalled-specific fields instead of casting it", async () => {
  const { fetchFn } = fakeFetch(() => json({ outcome: { status: "stalled", merged: [] } }));
  const client = createApiClient({ fetchFn });
  await expect(client.postTrain([sampleEntry()], new Map())).rejects.toThrow(/expected shape/);
});
