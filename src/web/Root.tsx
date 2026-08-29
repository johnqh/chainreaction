import { useEffect, useState } from "react";
import type { ChangesetEntry, RepoNode } from "../graph/types";
import { App } from "./App";
import type { RefreshResult } from "./Updates";
import { ApiError, createApiClient, type ApiClient, type RepoStatus } from "./apiClient";

export interface RootProps {
  /** Injected for tests; defaults to a real fetch-backed client (same-origin). */
  client?: ApiClient;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string; unauthorized: boolean }
  | { status: "ready"; nodes: RepoNode[]; prepared: Record<string, boolean> };

/**
 * `GET /api/repos` reports readiness keyed by repo full name; RepoList/App
 * want it keyed by pkg name (see RepoListProps). The graph's own nodes are
 * the only place both names are known together, so this cross-references
 * them. A repo `/api/repos` reports that isn't in the graph (e.g. it has no
 * package.json, so GitHubGraphSource silently excludes it) is simply not
 * represented in `prepared` — RepoList already treats an absent key as "not
 * prepared", which is correct here too, not a masked failure.
 */
function buildPrepared(repos: RepoStatus[], nodes: RepoNode[]): Record<string, boolean> {
  const pkgByRepo = new Map(nodes.map((n) => [n.repo, n.pkg]));
  const prepared: Record<string, boolean> = {};
  for (const r of repos) {
    const pkg = pkgByRepo.get(r.name);
    if (pkg !== undefined) prepared[pkg] = r.prepared.ready;
  }
  return prepared;
}

/**
 * The real, server-backed root: loads repos and the dependency graph on
 * mount and renders `App` wired to `client`, or a readable error if either
 * call fails.
 *
 * A failed load must never fall back to an empty `nodes`/`prepared` — that
 * is indistinguishable from "you truly have no repositories" and is exactly
 * the failure this file exists to avoid (see apiClient's module doc). Any
 * thrown `ApiError`/`Error` from the initial load is rendered as text, with
 * a 401 called out specifically as a signed-out session rather than a
 * generic failure.
 */
export function Root({ client }: RootProps) {
  const [apiClient] = useState<ApiClient>(() => client ?? createApiClient());
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [repos, graph] = await Promise.all([apiClient.getRepos(), apiClient.getGraph()]);
        if (cancelled) return;
        setState({ status: "ready", nodes: graph.nodes, prepared: buildPrepared(repos, graph.nodes) });
      } catch (err) {
        if (cancelled) return;
        const unauthorized = err instanceof ApiError && err.unauthorized;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: "error", message, unauthorized });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  if (state.status === "loading") {
    return (
      <div data-testid="root-loading">
        <p>Loading your repositories…</p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div data-testid="root-error">
        <p data-testid="root-error-message">
          {state.unauthorized
            ? "You've been signed out — sign in again to continue."
            : `Could not load ChainReaction: ${state.message}`}
        </p>
      </div>
    );
  }

  const onPlanUpdate = (pkg: string) => apiClient.postUpdate(pkg, "one");
  const onPlanUpdateChain = (pkg: string) => apiClient.postUpdate(pkg, "chain");
  const onOpenPrs = (entries: ChangesetEntry[]) => apiClient.postPrs(entries);
  const onAutoMerge = (entries: ChangesetEntry[], prs: Map<string, number>) =>
    apiClient.postTrain(entries, prs);

  async function onMerge(entry: ChangesetEntry, pr: number): Promise<boolean> {
    try {
      await apiClient.postMerge(entry.repo, pr);
      return true;
    } catch (err) {
      // A 502 here is `handleMerge` reporting that GitHub itself rejected
      // the merge attempt (see src/server/api.ts) — an ordinary merge
      // failure Updates.tsx already renders via the PR's "failed" state.
      // Anything else — 403 the repo isn't part of this installation, 401
      // the session is gone, a network failure — is a real problem the
      // user must see (Updates.tsx surfaces a thrown error), not a quiet
      // "failed" badge indistinguishable from a normal rejected merge.
      if (err instanceof ApiError && err.status === 502) return false;
      throw err;
    }
  }

  // There is no dedicated "PR status" or "registry resolvable" route for
  // the browser to call (see the route list in src/server/api.ts) — a
  // manual Refresh's only source of truth is re-loading the graph and
  // checking whether each entry's own version bump has landed on its
  // repo's default branch, which is exactly what merging that entry's PR
  // does. This can only ever report "merged" this way, never "failed": a
  // stall is something onMerge/onAutoMerge observe directly when they
  // happen, not something a version comparison can infer after the fact.
  async function onRefresh(entries: ChangesetEntry[], _prs: Map<string, number>): Promise<RefreshResult> {
    const graph = await apiClient.getGraph();
    const nodeByPkg = new Map(graph.nodes.map((n) => [n.pkg, n]));
    const published = new Set<string>();
    const observed: Record<string, "merged" | "failed"> = {};
    for (const entry of entries) {
      const node = nodeByPkg.get(entry.pkg);
      if (node !== undefined && node.version === entry.toVersion) {
        published.add(entry.pkg);
        observed[entry.repo] = "merged";
      }
    }
    return { published, observed };
  }

  return (
    <App
      nodes={state.nodes}
      prepared={state.prepared}
      onPlanUpdate={onPlanUpdate}
      onPlanUpdateChain={onPlanUpdateChain}
      onOpenPrs={onOpenPrs}
      onMerge={onMerge}
      onAutoMerge={onAutoMerge}
      onRefresh={onRefresh}
    />
  );
}
