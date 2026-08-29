import { useEffect, useState } from "react";
import type { ChangesetEntry } from "../graph/types";
import type { PrState } from "../pr/lifecycle";
import type { TrainOutcome } from "../pr/train";
import type { SkippedRepo } from "./apiClient";
import { describeWaiting, resolvePrState, waitingFor } from "./updatesModel";

/** What a refresh pulls back from GitHub/the registry: no polling loop lives in this component. */
export interface RefreshResult {
  /** Packages whose bumped version is now resolvable — feeds `classifyPr`. */
  published: Set<string>;
  /** Observed terminal PR states, keyed by repo. Anything absent is still ready/blocked. */
  observed: Record<string, "merged" | "failed">;
}

export interface UpdatesProps {
  /** The repo currently selected in RepoList/Graph, or null if none. */
  selected: string | null;
  /**
   * Plan an "Update": refresh `pkg`'s own direct dependencies to their
   * currently published versions. Must NOT open any PR — this only proposes
   * the changeset for confirmation. `skipped` names repos whose manifest
   * could not be parsed while planning — a repo silently missing from the
   * graph is a repo silently missing from the cascade, so it must reach the
   * proposal view, not just `entries`.
   */
  onPlanUpdate: (pkg: string) => Promise<{ entries: ChangesetEntry[]; skipped: SkippedRepo[] }>;
  /**
   * Plan an "Update Chain": `pkg`'s full dependency closure, bumped bottom-up.
   * Must NOT open any PR — this only proposes the changeset for confirmation.
   */
  onPlanUpdateChain: (pkg: string) => Promise<{ entries: ChangesetEntry[]; skipped: SkippedRepo[] }>;
  /** Open one PR per entry. Called only after the user confirms the proposed changeset. */
  onOpenPrs: (entries: ChangesetEntry[]) => Promise<Map<string, number>>;
  /** Merge one ready PR. Resolves `false` (does not throw) for an ordinary merge failure. */
  onMerge: (entry: ChangesetEntry, pr: number) => Promise<boolean>;
  /** Run the whole train: merge every ready PR in turn, waiting for each publish. */
  onAutoMerge: (entries: ChangesetEntry[], prs: Map<string, number>) => Promise<TrainOutcome>;
  /** Pull current published/observed state from GitHub. Replaces live updates with a manual pull. */
  onRefresh: (entries: ChangesetEntry[], prs: Map<string, number>) => Promise<RefreshResult>;
}

const STATE_COLOR: Record<PrState, string> = {
  ready: "#2f855a",
  blocked: "#c05621",
  merged: "#2c7a7b",
  failed: "#c53030",
};

type Proposal = { kind: "update" | "chain"; entries: ChangesetEntry[]; skipped: SkippedRepo[] };

/**
 * The Update / Update Chain / PR-status / Merge / Auto Merge screen for the
 * currently selected repo.
 *
 * Deliberately takes every side effect as a callback prop and calls no
 * `fetch` of its own, so it can be fully exercised in tests with no network,
 * and so the real GitHub/registry wiring can land as a separate, reviewable
 * step. PR colouring always goes through `classifyPr` (via `resolvePrState`
 * in `./updatesModel`) — this component holds `published`/`observed` state
 * but never re-derives readiness itself.
 */
export function Updates({
  selected,
  onPlanUpdate,
  onPlanUpdateChain,
  onOpenPrs,
  onMerge,
  onAutoMerge,
  onRefresh,
}: UpdatesProps) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [planning, setPlanning] = useState(false);
  const [openEntries, setOpenEntries] = useState<ChangesetEntry[] | null>(null);
  const [prs, setPrs] = useState<Map<string, number>>(new Map());
  const [published, setPublished] = useState<Set<string>>(new Set());
  const [observed, setObserved] = useState<Record<string, "merged" | "failed">>({});
  const [busyRepo, setBusyRepo] = useState<string | null>(null);
  const [autoMerging, setAutoMerging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [trainOutcome, setTrainOutcome] = useState<TrainOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Changing the selected repo abandons any in-progress proposal/PR view for
  // the previous one — RepoList/Graph selection and this screen must never
  // disagree about which repo is being acted on.
  useEffect(() => {
    setProposal(null);
    setOpenEntries(null);
    setPrs(new Map());
    setPublished(new Set());
    setObserved({});
    setTrainOutcome(null);
    setError(null);
  }, [selected]);

  if (!selected) {
    return (
      <div data-testid="updates">
        <p data-testid="updates-empty">Select a repo to update it.</p>
      </div>
    );
  }

  async function plan(kind: "update" | "chain") {
    setError(null);
    setPlanning(true);
    try {
      const result = kind === "update" ? await onPlanUpdate(selected!) : await onPlanUpdateChain(selected!);
      setProposal({ kind, entries: result.entries, skipped: result.skipped });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  }

  async function confirm() {
    if (!proposal) return;
    setError(null);
    setPlanning(true);
    try {
      const prMap = await onOpenPrs(proposal.entries);
      setOpenEntries(proposal.entries);
      setPrs(prMap);
      setPublished(new Set());
      setObserved({});
      setTrainOutcome(null);
      setProposal(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  }

  function cancel() {
    setProposal(null);
  }

  async function merge(entry: ChangesetEntry) {
    const pr = prs.get(entry.repo);
    if (pr === undefined || !openEntries) return;
    setError(null);
    setBusyRepo(entry.repo);
    try {
      const ok = await onMerge(entry, pr);
      if (ok) {
        // Merging only *starts* a publish (see the module doc on the
        // product this is) — it is NOT evidence `entry.pkg` is resolvable.
        // `published` may only ever be set from a real registry check
        // (`onRefresh`'s result). Setting it here would let a downstream PR
        // go `ready` before its dependency is actually installable — the
        // exact merge/publish race this product exists to remove. See
        // CRITICAL 1 in the final-review report.
        setObserved((o) => ({ ...o, [entry.repo]: "merged" }));
      } else {
        setObserved((o) => ({ ...o, [entry.repo]: "failed" }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyRepo(null);
    }
  }

  async function autoMerge() {
    if (!openEntries) return;
    setError(null);
    setAutoMerging(true);
    try {
      const outcome = await onAutoMerge(openEntries, prs);
      setTrainOutcome(outcome);
      setObserved((o) => {
        const next = { ...o };
        for (const step of outcome.merged) next[step.repo] = "merged";
        return next;
      });
      setPublished((p) => {
        const next = new Set(p);
        for (const step of outcome.merged) next.add(step.pkg);
        return next;
      });
      if (outcome.status === "stalled") {
        setObserved((o) => ({ ...o, [outcome.repo]: "failed" }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAutoMerging(false);
    }
  }

  async function refresh() {
    if (!openEntries) return;
    setError(null);
    setRefreshing(true);
    try {
      const result = await onRefresh(openEntries, prs);
      setPublished(result.published);
      // Merge, never replace: `onRefresh` only ever reports "merged" (a
      // stall's "failed" badge comes from onAutoMerge/onMerge observing it
      // directly, not from a version comparison after the fact — see
      // RefreshResult's doc comment). Replacing `observed` wholesale would
      // erase a previously observed "failed" the instant a Refresh has
      // nothing new to say about that repo. A later "merged" for the same
      // repo DOES override an earlier "failed", deliberately — a merge that
      // is later reported by a fresh graph read is newer, more authoritative
      // information than a past failure. See IMPORTANT 4 in the
      // final-review report.
      setObserved((prev) => ({ ...prev, ...result.observed }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div data-testid="updates">
      <h2 data-testid="updates-selected">{selected}</h2>

      {error && <p data-testid="updates-error">{error}</p>}

      {!proposal && !openEntries && (
        <div data-testid="updates-actions">
          <button type="button" onClick={() => plan("update")} disabled={planning}>
            Update
          </button>
          <button type="button" onClick={() => plan("chain")} disabled={planning}>
            Update Chain
          </button>
        </div>
      )}

      {proposal && (
        <div data-testid="updates-proposal">
          <p>
            Proposed {proposal.kind === "update" ? "update" : "update chain"} —{" "}
            {proposal.entries.length} repo(s). Nothing has been opened yet.
          </p>
          {proposal.skipped.length > 0 && (
            <p data-testid="proposal-skipped">
              {proposal.skipped.length} repo(s) could not be planned and are missing from this
              proposal: {proposal.skipped.map((s) => `${s.repo} (${s.reason})`).join("; ")}
            </p>
          )}
          <table>
            <tbody>
              {proposal.entries.map((entry) => (
                <tr key={entry.repo} data-testid={`proposal-row-${entry.repo}`}>
                  <td>{entry.repo}</td>
                  <td>{entry.pkg}</td>
                  <td data-testid={`proposal-bump-${entry.repo}`}>
                    {entry.fromVersion} → {entry.toVersion}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" data-testid="confirm-changeset" onClick={confirm} disabled={planning}>
            Confirm and open PRs
          </button>
          <button type="button" data-testid="cancel-changeset" onClick={cancel} disabled={planning}>
            Cancel
          </button>
        </div>
      )}

      {openEntries && (
        <div data-testid="updates-open">
          <div>
            <button type="button" data-testid="auto-merge" onClick={autoMerge} disabled={autoMerging}>
              {autoMerging ? "Auto Merging…" : "Auto Merge"}
            </button>
            <button type="button" data-testid="refresh" onClick={refresh} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {trainOutcome && (
            <p data-testid="train-outcome">
              {trainOutcome.status === "success"
                ? `Auto Merge complete — ${trainOutcome.merged.length} merged.`
                : `Auto Merge stalled: ${trainOutcome.reason}`}
            </p>
          )}

          <ul data-testid="pr-list">
            {openEntries.map((entry) => {
              const pr = prs.get(entry.repo);
              const state = resolvePrState(entry, openEntries, published, observed[entry.repo]);
              const names = waitingFor(entry, openEntries, published);
              return (
                <li
                  key={entry.repo}
                  data-testid={`pr-row-${entry.repo}`}
                  data-state={state}
                  style={{ borderLeft: `4px solid ${STATE_COLOR[state]}` }}
                >
                  <span>{entry.repo}</span>
                  <span>
                    {" "}
                    ({entry.pkg}: {entry.fromVersion} → {entry.toVersion})
                  </span>
                  {pr !== undefined && <span data-testid={`pr-number-${entry.repo}`}> PR #{pr}</span>}
                  <span data-testid={`pr-state-${entry.repo}`}> {state}</span>
                  {state === "blocked" && (
                    <span data-testid={`pr-waiting-${entry.repo}`}> — {describeWaiting(names)}</span>
                  )}
                  {state === "ready" && (
                    <button
                      type="button"
                      data-testid={`merge-${entry.repo}`}
                      onClick={() => merge(entry)}
                      disabled={busyRepo === entry.repo}
                    >
                      Merge
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
