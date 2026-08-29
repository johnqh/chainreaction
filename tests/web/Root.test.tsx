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

test("Refresh marks a package published once the reloaded graph shows its bumped version, and merged for its repo", async () => {
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
  const client = fakeClient({
    getRepos: async () => sampleRepos(),
    getGraph: async () => {
      graphCallCount += 1;
      return graphCallCount === 1 ? sampleGraph() : bumpedGraph;
    },
    postUpdate: async () => [entry],
    postPrs: async () => new Map([[entry.repo, 42]]),
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
});
