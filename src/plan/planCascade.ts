import type { GraphSource } from "../graph/source";
import type { ChangesetEntry } from "../graph/types";
import type { SkippedRepo } from "../graph/githubSource";
import type { PrepareResult } from "../prepare/types";
import { affectedSubgraph, topoLevels } from "../graph/resolver";
import { assertScoped, computeChangeset } from "../graph/changeset";
import { assertPrepared } from "./readiness";
import { reposForPackages } from "../graph/mapping";

export interface CascadePlan {
  changed: string;
  affected: string[];
  levels: string[][];
  changeset: ChangesetEntry[];
  skipped: SkippedRepo[];
}

/**
 * Supplies prepare state for exactly the repos `planCascade` asks about.
 *
 * A caller cannot know that set in advance — it falls out of
 * `source.load()` -> `affectedSubgraph` -> `reposForPackages`, all internal to
 * `planCascade`. The tempting alternative, calling `prepareRepo` per repo at
 * plan time, would mutate up to dozens of customer repos (`enableAutoMerge`,
 * `setProtection`) from a command every user assumes is read-only. A provider
 * keeps that decision — and any actual API calls — with the caller, who is
 * free to implement it with a plain in-memory map (tests), a cache, or
 * `assessRepo` (production, read-only).
 */
export type PreparedProvider = (repos: string[]) => Promise<Map<string, PrepareResult>>;

export async function planCascade(
  source: GraphSource,
  changed: string,
  targets: string[] | "all",
  prepared: PreparedProvider,
): Promise<CascadePlan> {
  const graph = await source.load();
  if (!graph.has(changed)) {
    throw new Error(`${changed} is not in the graph for this installation`);
  }

  // Feature-detect: only a source that tracks skipped repos (e.g.
  // GitHubGraphSource) exposes this. FilesystemGraphSource and test doubles
  // that satisfy plain GraphSource still work, and just report none skipped.
  const skipped: SkippedRepo[] =
    "skipped" in source && Array.isArray((source as { skipped: unknown }).skipped)
      ? (source as { skipped: SkippedRepo[] }).skipped
      : [];

  // An unparseable manifest means that repo's dependency edges are unknown.
  // It is absent from the graph, so affectedSubgraph cannot traverse THROUGH
  // it — every dependent reachable only via that repo silently disappears
  // from the affected set below. That set is unsound, so nothing downstream
  // (scoping against it, certifying it as ready) can be trusted either.
  // Refuse before any of that runs, rather than let a typo in someone else's
  // package.json quietly shrink both the cascade and the gate.
  //
  // A nameless manifest is not unsound in this sense: a package with no name
  // can never be a dependency target, so it cannot truncate reachability —
  // it stays a warning in `skipped`, not a refusal.
  const unsound = skipped.filter((s) => s.reason.startsWith("unparseable manifest"));
  if (unsound.length > 0) {
    throw new Error(
      `refusing to plan against an incomplete graph — ${unsound.length} repo(s) could not be read, ` +
        `so their dependencies are unknown and the affected set may be missing repos:\n` +
        unsound.map((s) => `  - ${s.repo}: ${s.reason}`).join("\n"),
    );
  }

  const affected = affectedSubgraph(graph, changed);
  // Before anything else: refuse to plan a publish nobody scoped.
  assertScoped(affected, targets);

  // Gate before anything is planned. A plan that reaches computeChangeset has
  // already assigned version numbers to repos it may not be allowed to touch.
  const requiredRepos = reposForPackages(graph, affected);
  const rawPrepared = await prepared(requiredRepos);
  // Lowercase both sides: prepareRepo/assessRepo return the caller's literal
  // spelling of a repo's full name, which need not match the casing a
  // GraphSource's listRepos() reports. Without normalizing, a repo that was
  // correctly prepared can look "never prepared" over a pure case mismatch —
  // it fails closed, which is safe, but baffling.
  const preparedMap = new Map(
    [...rawPrepared].map(([repo, result]) => [repo.toLowerCase(), result] as const),
  );
  assertPrepared(
    preparedMap,
    requiredRepos.map((r) => r.toLowerCase()),
  );

  const levels = topoLevels(graph, affected);
  return {
    changed,
    affected: [...affected].sort(),
    levels,
    changeset: computeChangeset(graph, levels),
    skipped,
  };
}
