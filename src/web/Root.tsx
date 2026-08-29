import { useEffect, useState } from "react";
import type { ChangesetEntry, RepoNode } from "../graph/types";
import { App } from "./App";
import type { RefreshResult } from "./Updates";
import { ApiError, createApiClient, type ApiClient, type RepoStatus, type SkippedRepo } from "./apiClient";

export interface RootProps {
  /** Injected for tests; defaults to a real fetch-backed client (same-origin). */
  client?: ApiClient;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string; unauthorized: boolean }
  | { status: "ready"; nodes: RepoNode[]; prepared: Record<string, boolean>; skipped: SkippedRepo[] };

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
        setState({
          status: "ready",
          nodes: graph.nodes,
          prepared: buildPrepared(repos, graph.nodes),
          skipped: graph.skipped,
        });
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
            ? // A 401 here just as often means "never signed in" (a first-time
              // visitor) as "session expired" — never assert the former, and
              // always give an actual way forward: see CRITICAL 2 in the
              // final-review report.
              "Sign in with GitHub to see your repositories."
            : `Could not load ChainReaction: ${state.message}`}
        </p>
        {state.unauthorized && (
          <p>
            <a href="/auth/login" data-testid="sign-in-link">
              Sign in with GitHub
            </a>
          </p>
        )}
      </div>
    );
  }

  const onPlanUpdate = (pkg: string) => apiClient.postUpdate(pkg, "one");
  const onPlanUpdateChain = (pkg: string) => apiClient.postUpdate(pkg, "chain");

  // handlePrs (src/server/api.ts) can fail mid-chain after some PRs already
  // opened on GitHub — its 502 body carries `opened` for exactly that
  // reason. Losing that list would leave the user with real, open PRs they
  // don't know exist. `ApiError.message` alone is not enough here, so this
  // folds `opened` into the thrown message rather than swallowing it —
  // Updates.tsx already renders any thrown error's message as-is.
  async function onOpenPrs(entries: ChangesetEntry[]): Promise<Map<string, number>> {
    try {
      return await apiClient.postPrs(entries);
    } catch (err) {
      if (err instanceof ApiError && err.opened && err.opened.length > 0) {
        const openedList = err.opened.map((o) => `${o.repo} (PR #${o.pr})`).join(", ");
        throw new Error(`${err.message} — PRs already opened before the failure: ${openedList}`);
      }
      throw err;
    }
  }

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

  // `published` MUST come from a real registry-resolvability check
  // (POST /api/published), never from re-reading the graph: GitHubGraphSource
  // reads each repo's default-branch package.json, whose version flips the
  // instant a bump PR *merges* — before any CI publish has run. Feeding that
  // straight into `classifyPr` (via `published`) would let a downstream PR
  // go `ready`/mergeable the moment its dependency's PR merges, reopening
  // exactly the merge/publish race `runTrain`'s own `isResolvable` polling
  // exists to eliminate on the Auto Merge path — see handlePublished's own
  // doc comment in src/server/api.ts.
  //
  // `observed[repo] = "merged"` is a separate, narrower claim ("this PR's
  // change landed on the default branch") that the graph reload *is* the
  // right source for — it only ever marks "merged", never "failed": a
  // stall is something onMerge/onAutoMerge observe directly when they
  // happen, not something a version comparison can infer after the fact.
  async function onRefresh(entries: ChangesetEntry[], _prs: Map<string, number>): Promise<RefreshResult> {
    const [published, graph] = await Promise.all([apiClient.postPublished(entries), apiClient.getGraph()]);
    const nodeByPkg = new Map(graph.nodes.map((n) => [n.pkg, n]));
    const observed: Record<string, "merged" | "failed"> = {};
    for (const entry of entries) {
      const node = nodeByPkg.get(entry.pkg);
      if (node !== undefined && node.version === entry.toVersion) {
        observed[entry.repo] = "merged";
      }
    }
    return { published, observed };
  }

  return (
    <>
      {state.skipped.length > 0 && (
        // A repo GitHubGraphSource couldn't parse a manifest for is a repo
        // silently missing from the whole cascade if this is dropped on the
        // floor — see IMPORTANT 3 in the final-review report.
        <div data-testid="root-skipped">
          <p data-testid="root-skipped-message">
            {state.skipped.length} repo(s) could not be added to the dependency graph:{" "}
            {state.skipped.map((s) => `${s.repo} (${s.reason})`).join("; ")}
          </p>
        </div>
      )}
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
    </>
  );
}
