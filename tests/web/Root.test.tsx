// Root is the real, server-backed wiring App.tsx deliberately doesn't own
// (App takes callbacks and never calls fetch). These tests prove: (1) a
// successful load renders App with the graph's nodes and a pkg-keyed
// prepared map, (2) a failed initial load renders a *readable error*, never
// an empty repo list that looks like a legitimate "you have no
// repositories" answer, and (3) a 401 is called out as a signed-out session.
import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Root } from "../../src/web/Root";
import { ApiError, type ApiClient, type GraphResult, type RepoStatus } from "../../src/web/apiClient";
import type { ChangesetEntry } from "../../src/graph/types";

afterEach(cleanup);

function neverCalled(name: string) {
  return async () => {
    throw new Error(`${name} should not have been called in this test`);
  };
}

function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getRepos: neverCalled("getRepos"),
    getGraph: neverCalled("getGraph"),
    postUpdate: neverCalled("postUpdate"),
    postPrs: neverCalled("postPrs"),
    postMerge: neverCalled("postMerge"),
    postTrain: neverCalled("postTrain"),
    postPublished: neverCalled("postPublished"),
    ...overrides,
  };
}

function sampleGraph(): GraphResult {
  return {
    nodes: [
      { pkg: "@acme/core", repo: "acme/core", version: "1.0.0", deps: [] },
      { pkg: "@acme/app", repo: "acme/app", version: "2.0.0", deps: ["@acme/core"] },
    ],
    edges: [{ from: "@acme/app", to: "@acme/core", kind: "dependency" }],
    skipped: [],
  };
}

function sampleRepos(): RepoStatus[] {
  return [
    { name: "acme/core", private: false, prepared: { repo: "acme/core", ready: true, mechanism: "auto-merge", blockers: [] } },
    { name: "acme/app", private: true, prepared: { repo: "acme/app", ready: false, mechanism: "auto-merge", blockers: ["no ci"] } },
  ];
}

test("a successful load renders App with the graph's nodes and a pkg-keyed prepared map", async () => {
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => sampleGraph(),
  });
  render(<Root client={client} />);

  await screen.findByTestId("repo-list");
  // Both repos from the graph are present, and RepoList's own count proves
  // Root did not drop one of them or invent an extra.
  expect(screen.getByTestId("repo-count").textContent).toBe("2 of 2 repos");
  // acme/core is prepared:true, keyed by its pkg name "@acme/core" — proves
  // buildPrepared actually cross-references repo full name -> pkg, not just
  // passing the server's repo-keyed object straight through.
  expect(screen.getByTestId("prepared-@acme/core")).toBeTruthy();
  expect(screen.queryByTestId("prepared-@acme/app")).toBeNull();
});

test("a failed initial load renders a readable error, never an empty repo list", async () => {
  const client = fakeClient({
    getRepos: async () => {
      throw new ApiError(502, "installation token exchange failed: bad credentials");
    },
    getGraph: async () => sampleGraph(),
  });
  render(<Root client={client} />);

  const error = await screen.findByTestId("root-error");
  expect(error.textContent).toContain("installation token exchange failed: bad credentials");
  // The failure must not silently degrade into App's empty-repos view.
  expect(screen.queryByTestId("repo-list")).toBeNull();
  expect(screen.queryByTestId("repo-count")).toBeNull();
});

test("a 401 from either initial call is reported as a signed-out session, not a generic error", async () => {
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => {
      throw new ApiError(401, "unauthorized");
    },
  });
  render(<Root client={client} />);

  const error = await screen.findByTestId("root-error-message");
  expect(error.textContent).toBe("You've been signed out — sign in again to continue.");
});

function entryFor(pkg: string, repo: string): ChangesetEntry {
  return {
    pkg,
    repo,
    fromVersion: "2.0.0",
    toVersion: "2.1.0",
    // Empty depBumps: classifyPr has no in-chain dependency to wait on, so
    // the opened PR is immediately "ready" — lets these tests reach the
    // Merge button without also exercising the blocked/ready chain logic,
    // which is updatesModel's/lifecycle's own test's job.
    depBumps: {},
    level: 0,
  };
}

test("selecting a repo and clicking Update calls postUpdate('@acme/app', 'one') and renders its entries", async () => {
  const entry = entryFor("@acme/app", "acme/app");
  const calls: { pkg: string; mode: "one" | "chain" }[] = [];
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => sampleGraph(),
    postUpdate: async (pkg, mode) => {
      calls.push({ pkg, mode });
      return [entry];
    },
  });
  render(<Root client={client} />);
  await screen.findByTestId("repo-list");

  fireEvent.click(screen.getByTestId("repo-item-@acme/app"));
  fireEvent.click(screen.getByText("Update"));

  await screen.findByTestId("updates-proposal");
  expect(calls).toEqual([{ pkg: "@acme/app", mode: "one" }]);
  expect(screen.getByTestId(`proposal-bump-${entry.repo}`).textContent).toBe("2.0.0 → 2.1.0");
});

test("Update Chain calls postUpdate with mode 'chain', not 'one'", async () => {
  const calls: { pkg: string; mode: "one" | "chain" }[] = [];
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => sampleGraph(),
    postUpdate: async (pkg, mode) => {
      calls.push({ pkg, mode });
      return [entryFor(pkg, "acme/app")];
    },
  });
  render(<Root client={client} />);
  await screen.findByTestId("repo-list");

  fireEvent.click(screen.getByTestId("repo-item-@acme/app"));
  fireEvent.click(screen.getByText("Update Chain"));

  await screen.findByTestId("updates-proposal");
  expect(calls).toEqual([{ pkg: "@acme/app", mode: "chain" }]);
});

test("a 502 from postMerge renders the PR as failed, not a thrown-error banner", async () => {
  const entry = entryFor("@acme/app", "acme/app");
  const mergeCalls: { repo: string; pr: number }[] = [];
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => sampleGraph(),
    postUpdate: async () => [entry],
    postPrs: async () => new Map([[entry.repo, 42]]),
    postMerge: async (repo, pr) => {
      mergeCalls.push({ repo, pr });
      throw new ApiError(502, "required status check has not succeeded");
    },
  });
  render(<Root client={client} />);
  await screen.findByTestId("repo-list");

  fireEvent.click(screen.getByTestId("repo-item-@acme/app"));
  fireEvent.click(screen.getByText("Update"));
  await screen.findByTestId("updates-proposal");
  fireEvent.click(screen.getByTestId("confirm-changeset"));
  await screen.findByTestId("updates-open");

  fireEvent.click(screen.getByTestId(`merge-${entry.repo}`));
  await screen.findByText("failed", { selector: `[data-testid="pr-state-${entry.repo}"]` });

  expect(mergeCalls).toEqual([{ repo: "acme/app", pr: 42 }]);
  // A 502 ordinary merge failure must render as the PR's own failed state,
  // never as Updates' generic error banner (which would look identical to
  // a real problem — session loss, a network failure — and give the user
  // no way to tell the two apart).
  expect(screen.queryByTestId("updates-error")).toBeNull();
});

test("a 403 from postMerge (repo not part of this installation) surfaces as a visible error, not a silent 'failed'", async () => {
  const entry = entryFor("@acme/app", "acme/app");
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => sampleGraph(),
    postUpdate: async () => [entry],
    postPrs: async () => new Map([[entry.repo, 42]]),
    postMerge: async () => {
      throw new ApiError(403, "not part of this installation: acme/app");
    },
  });
  render(<Root client={client} />);
  await screen.findByTestId("repo-list");

  fireEvent.click(screen.getByTestId("repo-item-@acme/app"));
  fireEvent.click(screen.getByText("Update"));
  await screen.findByTestId("updates-proposal");
  fireEvent.click(screen.getByTestId("confirm-changeset"));
  await screen.findByTestId("updates-open");

  fireEvent.click(screen.getByTestId(`merge-${entry.repo}`));

  const error = await screen.findByTestId("updates-error");
  expect(error.textContent).toBe("not part of this installation: acme/app");
  // Must not have been quietly recolored as "failed" instead of surfaced.
  expect(screen.getByTestId(`pr-state-${entry.repo}`).textContent?.trim()).toBe("ready");
});

test("a 503 from postMerge (a systemic failure) surfaces as a visible error, never a per-PR 'failed' badge", async () => {
  // The specific conflation the fix round flagged: handleMerge's 502 could
  // mean either "this PR's merge was rejected" or "the membership check
  // itself failed" (a systemic, account-wide problem). The server now
  // reports the latter as 503; Root.tsx's onMerge must only convert 502 to
  // `false` — everything else, 503 included, must rethrow.
  const entry = entryFor("@acme/app", "acme/app");
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => sampleGraph(),
    postUpdate: async () => [entry],
    postPrs: async () => new Map([[entry.repo, 42]]),
    postMerge: async () => {
      throw new ApiError(503, "installation token exchange failed: bad credentials");
    },
  });
  render(<Root client={client} />);
  await screen.findByTestId("repo-list");

  fireEvent.click(screen.getByTestId("repo-item-@acme/app"));
  fireEvent.click(screen.getByText("Update"));
  await screen.findByTestId("updates-proposal");
  fireEvent.click(screen.getByTestId("confirm-changeset"));
  await screen.findByTestId("updates-open");

  fireEvent.click(screen.getByTestId(`merge-${entry.repo}`));

  const error = await screen.findByTestId("updates-error");
  expect(error.textContent).toBe("installation token exchange failed: bad credentials");
  expect(screen.getByTestId(`pr-state-${entry.repo}`).textContent?.trim()).toBe("ready");
});

test("confirming a proposal calls postPrs with exactly the proposed entries — not a caller that discards them", async () => {
  const entry = entryFor("@acme/app", "acme/app");
  const prsCalls: ChangesetEntry[][] = [];
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => sampleGraph(),
    postUpdate: async () => [entry],
    postPrs: async (entries) => {
      prsCalls.push(entries);
      return new Map([[entry.repo, 42]]);
    },
  });
  render(<Root client={client} />);
  await screen.findByTestId("repo-list");

  fireEvent.click(screen.getByTestId("repo-item-@acme/app"));
  fireEvent.click(screen.getByText("Update"));
  await screen.findByTestId("updates-proposal");
  fireEvent.click(screen.getByTestId("confirm-changeset"));
  await screen.findByTestId("updates-open");

  expect(prsCalls).toEqual([[entry]]);
});

test("clicking Auto Merge calls postTrain with exactly the open entries and the PR map postPrs returned — not a caller that discards them", async () => {
  const entry = entryFor("@acme/app", "acme/app");
  const trainCalls: { entries: ChangesetEntry[]; prs: Map<string, number> }[] = [];
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => sampleGraph(),
    postUpdate: async () => [entry],
    postPrs: async () => new Map([[entry.repo, 42]]),
    postTrain: async (entries, prs) => {
      trainCalls.push({ entries, prs });
      return { status: "success", merged: [{ pkg: entry.pkg, repo: entry.repo }] };
    },
  });
  render(<Root client={client} />);
  await screen.findByTestId("repo-list");

  fireEvent.click(screen.getByTestId("repo-item-@acme/app"));
  fireEvent.click(screen.getByText("Update"));
  await screen.findByTestId("updates-proposal");
  fireEvent.click(screen.getByTestId("confirm-changeset"));
  await screen.findByTestId("updates-open");
  fireEvent.click(screen.getByTestId("auto-merge"));
  await screen.findByTestId("train-outcome");

  expect(trainCalls).toEqual([{ entries: [entry], prs: new Map([[entry.repo, 42]]) }]);
});

test("Refresh marks a package published from postPublished, and merged (from the graph) for its repo", async () => {
  const entry = entryFor("@acme/app", "acme/app");
  const bumpedGraph: GraphResult = {
    nodes: [
      { pkg: "@acme/core", repo: "acme/core", version: "1.0.0", deps: [] },
      { pkg: "@acme/app", repo: "acme/app", version: entry.toVersion, deps: ["@acme/core"] },
    ],
    edges: [],
    skipped: [],
  };
  let graphCallCount = 0;
  const publishedCalls: ChangesetEntry[][] = [];
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => {
      graphCallCount += 1;
      return graphCallCount === 1 ? sampleGraph() : bumpedGraph;
    },
    postUpdate: async () => [entry],
    postPrs: async () => new Map([[entry.repo, 42]]),
    postPublished: async (entries) => {
      publishedCalls.push(entries);
      return new Set([entry.pkg]);
    },
  });
  render(<Root client={client} />);
  await screen.findByTestId("repo-list");

  fireEvent.click(screen.getByTestId("repo-item-@acme/app"));
  fireEvent.click(screen.getByText("Update"));
  await screen.findByTestId("updates-proposal");
  fireEvent.click(screen.getByTestId("confirm-changeset"));
  await screen.findByTestId("updates-open");

  fireEvent.click(screen.getByTestId("refresh"));

  await screen.findByText("merged", { selector: `[data-testid="pr-state-${entry.repo}"]` });
  expect(graphCallCount).toBe(2);
  expect(publishedCalls).toEqual([[entry]]);
});

test("CRITICAL: Refresh keeps a downstream PR blocked while its dependency has merged but is not yet resolvable, then flips it ready once it is — never derives 'published' from the graph's version alone", async () => {
  // core is the dependency; app depends on it. A manifest version bump
  // (what GET /api/graph reports) lands the instant core's PR *merges* —
  // well before any registry publish. If Refresh derived `published` from
  // that alone, app would go `ready` (and mergeable) before core@1.1.0 is
  // actually installable — exactly the race POST /api/published exists to
  // close (see src/server/api.ts's handlePublished doc comment).
  const core: ChangesetEntry = {
    pkg: "@acme/core", repo: "acme/core", fromVersion: "1.0.0", toVersion: "1.1.0", depBumps: {}, level: 0,
  };
  const app: ChangesetEntry = {
    pkg: "@acme/app", repo: "acme/app", fromVersion: "2.0.0", toVersion: "2.1.0",
    depBumps: { "@acme/core": "1.1.0" }, level: 1,
  };
  // The graph always reports core's manifest as already bumped/merged —
  // simulating "someone merged core's PR" — for every call, including the
  // very first Refresh. What must NOT happen is app going `ready` from
  // that fact alone.
  const mergedGraph: GraphResult = {
    nodes: [
      { pkg: core.pkg, repo: core.repo, version: core.toVersion, deps: [] },
      { pkg: app.pkg, repo: app.repo, version: app.fromVersion, deps: [core.pkg] },
    ],
    edges: [{ from: app.pkg, to: core.pkg, kind: "dependency" }],
    skipped: [],
  };
  let publishedCallCount = 0;
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => mergedGraph,
    postUpdate: async () => [core, app],
    postPrs: async () => new Map([[core.repo, 10], [app.repo, 11]]),
    postPublished: async () => {
      publishedCallCount += 1;
      // First Refresh: core's manifest has landed, but the registry hasn't
      // caught up yet — not resolvable. Second Refresh: it now is.
      return publishedCallCount === 1 ? new Set<string>() : new Set([core.pkg]);
    },
  });
  render(<Root client={client} />);
  await screen.findByTestId("repo-list");

  fireEvent.click(screen.getByTestId("repo-item-@acme/app"));
  fireEvent.click(screen.getByText("Update Chain"));
  await screen.findByTestId("updates-proposal");
  fireEvent.click(screen.getByTestId("confirm-changeset"));
  await screen.findByTestId("updates-open");

  // Before any Refresh: published starts empty, so app is blocked on core
  // regardless of what the graph says.
  expect(screen.getByTestId(`pr-state-${app.repo}`).textContent?.trim()).toBe("blocked");

  fireEvent.click(screen.getByTestId("refresh"));
  // core's own row flips to "merged" (the graph's version comparison is the
  // right source for that specific, narrower claim)...
  await screen.findByText("merged", { selector: `[data-testid="pr-state-${core.repo}"]` });
  // ...but app must still be blocked: core is merged, not yet resolvable.
  expect(screen.getByTestId(`pr-state-${app.repo}`).textContent?.trim()).toBe("blocked");

  fireEvent.click(screen.getByTestId("refresh"));
  await screen.findByText("ready", { selector: `[data-testid="pr-state-${app.repo}"]` });

  expect(publishedCallCount).toBe(2);
});
