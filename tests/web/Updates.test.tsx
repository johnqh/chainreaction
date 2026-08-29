import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChangesetEntry } from "../../src/graph/types";
import type { TrainOutcome } from "../../src/pr/train";
import type { SkippedRepo } from "../../src/web/apiClient";
import { Updates, type RefreshResult, type UpdatesProps } from "../../src/web/Updates";

afterEach(cleanup);

function entry(over: Partial<ChangesetEntry> & { pkg: string; repo: string }): ChangesetEntry {
  return { dir: undefined, fromVersion: "1.0.0", toVersion: "1.0.1", depBumps: {}, level: 0, ...over };
}

/** Chain: core (leaf) <- app (blocked on core) ; tool has only an out-of-chain dep bump. */
function chainEntries(): ChangesetEntry[] {
  return [
    entry({ pkg: "core", repo: "acme/core", fromVersion: "1.0.0", toVersion: "1.0.1" }),
    entry({
      pkg: "app",
      repo: "acme/app",
      fromVersion: "2.0.0",
      toVersion: "2.0.1",
      depBumps: { core: "^1.0.1" },
      level: 1,
    }),
    // Has a non-empty depBumps, but the referenced package ("external-lib")
    // is not part of this changeset — classifyPr must still call this ready.
    entry({
      pkg: "tool",
      repo: "acme/tool",
      fromVersion: "3.0.0",
      toVersion: "3.0.1",
      depBumps: { "external-lib": "^9.9.9" },
    }),
  ];
}

/** Wraps entries as the {entries, skipped} shape onPlanUpdate/onPlanUpdateChain resolve. */
function planned(entries: ChangesetEntry[], skipped: SkippedRepo[] = []): { entries: ChangesetEntry[]; skipped: SkippedRepo[] } {
  return { entries, skipped };
}

function prMap(): Map<string, number> {
  return new Map([
    ["acme/core", 101],
    ["acme/app", 102],
    ["acme/tool", 103],
  ]);
}

function calls<T extends unknown[], R>(impl: (...args: T) => R | Promise<R>) {
  const log: T[] = [];
  const fn = (...args: T) => {
    log.push(args);
    return Promise.resolve(impl(...args));
  };
  return { fn: fn as unknown as (...args: T) => Promise<R>, log };
}

function baseProps(overrides: Partial<UpdatesProps> = {}): UpdatesProps {
  return {
    selected: "app",
    onPlanUpdate: async () => planned([]),
    onPlanUpdateChain: async () => planned([]),
    onOpenPrs: async () => new Map(),
    onMerge: async () => true,
    onAutoMerge: async () => ({ status: "success", merged: [] }) as TrainOutcome,
    onRefresh: async () => ({ published: new Set(), observed: {} }) as RefreshResult,
    ...overrides,
  };
}

test("with nothing selected, shows a placeholder and no action buttons", () => {
  render(<Updates {...baseProps({ selected: null })} />);
  expect(screen.getByTestId("updates-empty")).toBeTruthy();
  expect(screen.queryByTestId("updates-actions")).toBeNull();
});

test("plain Update calls onPlanUpdate, not onPlanUpdateChain, and proposes its result", async () => {
  const updateEntries = [
    entry({ pkg: "app", repo: "acme/app", fromVersion: "2.0.0", toVersion: "2.0.1" }),
  ];
  const planUpdate = calls(async (_pkg: string) => planned(updateEntries));
  const planChain = calls(async (_pkg: string) => planned(chainEntries()));
  render(
    <Updates {...baseProps({ onPlanUpdate: planUpdate.fn, onPlanUpdateChain: planChain.fn })} />,
  );

  fireEvent.click(screen.getByText("Update"));

  const proposal = await screen.findByTestId("updates-proposal");
  expect(proposal.querySelector("p")?.textContent).toBe(
    "Proposed update — 1 repo(s). Nothing has been opened yet.",
  );
  expect(planUpdate.log.length).toBe(1);
  expect(planUpdate.log[0]?.[0]).toBe("app");
  expect(planChain.log.length).toBe(0);
});

test("Update Chain proposes the changeset and does NOT open any PR before confirmation", async () => {
  const plan = calls(async (_pkg: string) => planned(chainEntries()));
  const open = calls(async (_entries: ChangesetEntry[]) => prMap());
  render(
    <Updates
      {...baseProps({ onPlanUpdateChain: plan.fn, onOpenPrs: open.fn })}
    />,
  );

  fireEvent.click(screen.getByText("Update Chain"));

  const proposal = await screen.findByTestId("updates-proposal");
  expect(proposal.querySelector("p")?.textContent).toBe(
    "Proposed update chain — 3 repo(s). Nothing has been opened yet.",
  );
  expect(screen.getByTestId("proposal-bump-acme/core").textContent).toBe("1.0.0 → 1.0.1");
  expect(screen.getByTestId("proposal-bump-acme/app").textContent).toBe("2.0.0 → 2.0.1");
  expect(screen.getByTestId("proposal-bump-acme/tool").textContent).toBe("3.0.0 → 3.0.1");

  // The whole point: proposing must not have opened anything yet.
  expect(open.log.length).toBe(0);
  expect(screen.queryByTestId("updates-open")).toBeNull();
});

// IMPORTANT 3: a repo whose manifest couldn't be parsed while planning is
// silently missing from the whole cascade if this doesn't reach a pixel.
test("skipped repos from planning are shown in the proposal, not silently dropped", async () => {
  const skipped: SkippedRepo[] = [{ repo: "acme/broken", reason: "manifest has no name field" }];
  render(
    <Updates
      {...baseProps({ onPlanUpdateChain: async () => planned(chainEntries(), skipped) })}
    />,
  );

  fireEvent.click(screen.getByText("Update Chain"));

  const notice = await screen.findByTestId("proposal-skipped");
  expect(notice.textContent).toBe(
    "1 repo(s) could not be planned and are missing from this proposal: acme/broken (manifest has no name field)",
  );
});

test("no skipped notice is rendered when planning reports nothing skipped", async () => {
  render(
    <Updates {...baseProps({ onPlanUpdateChain: async () => planned(chainEntries()) })} />,
  );

  fireEvent.click(screen.getByText("Update Chain"));

  await screen.findByTestId("updates-proposal");
  expect(screen.queryByTestId("proposal-skipped")).toBeNull();
});

test("confirming opens exactly the proposed entries, once", async () => {
  const open = calls(async (_entries: ChangesetEntry[]) => prMap());
  render(
    <Updates
      {...baseProps({ onPlanUpdateChain: async () => planned(chainEntries()), onOpenPrs: open.fn })}
    />,
  );

  fireEvent.click(screen.getByText("Update Chain"));
  await screen.findByTestId("updates-proposal");
  fireEvent.click(screen.getByTestId("confirm-changeset"));

  await screen.findByTestId("updates-open");
  expect(open.log.length).toBe(1);
  expect(open.log[0]?.[0]).toEqual(chainEntries());
  expect(screen.getByTestId("pr-number-acme/core").textContent).toBe(" PR #101");
  expect(screen.queryByTestId("updates-proposal")).toBeNull();
});

test("cancelling a proposal never opens any PR", async () => {
  const open = calls(async (_entries: ChangesetEntry[]) => prMap());
  render(
    <Updates
      {...baseProps({ onPlanUpdateChain: async () => planned(chainEntries()), onOpenPrs: open.fn })}
    />,
  );

  fireEvent.click(screen.getByText("Update Chain"));
  await screen.findByTestId("updates-proposal");
  fireEvent.click(screen.getByTestId("cancel-changeset"));

  expect(screen.queryByTestId("updates-proposal")).toBeNull();
  expect(screen.getByTestId("updates-actions")).toBeTruthy();
  expect(open.log.length).toBe(0);
});

async function renderOpen(overrides: Partial<UpdatesProps> = {}) {
  const utils = render(
    <Updates
      {...baseProps({ onPlanUpdateChain: async () => planned(chainEntries()), onOpenPrs: async () => prMap(), ...overrides })}
    />,
  );
  fireEvent.click(screen.getByText("Update Chain"));
  await screen.findByTestId("updates-proposal");
  fireEvent.click(screen.getByTestId("confirm-changeset"));
  await screen.findByTestId("updates-open");
  return utils;
}

test("PR rows are coloured by classifyPr's real classification, not by depBumps presence alone", async () => {
  await renderOpen();

  // core has no dep bumps at all: ready.
  expect(screen.getByTestId("pr-row-acme/core").getAttribute("data-state")).toBe("ready");
  // app depends in-chain on core, which hasn't published: blocked.
  expect(screen.getByTestId("pr-row-acme/app").getAttribute("data-state")).toBe("blocked");
  // tool has a non-empty depBumps, but the dependency is out-of-chain — must
  // still be ready. A component that recomputes "blocked if depBumps
  // non-empty" instead of delegating to classifyPr would get this wrong.
  expect(screen.getByTestId("pr-row-acme/tool").getAttribute("data-state")).toBe("ready");
});

test("a blocked PR names exactly what it is waiting for — no more, no less", async () => {
  await renderOpen();
  const waiting = screen.getByTestId("pr-waiting-acme/app").textContent ?? "";
  // Exact match, not toContain: `app` only depends (in-chain) on `core`.
  // `tool` is also open and unpublished, but has no dependency relationship
  // to `app` at all, so it must never be named as something app is waiting
  // on — an over-inclusive computation (e.g. "every other unpublished
  // in-chain package") would pass a toContain("core") check while still
  // being wrong, and would falsely blame `tool` here.
  expect(waiting).toBe(" — waiting for: core");
  expect(waiting).not.toContain("tool");
  // No merge button on a blocked PR.
  expect(screen.queryByTestId("merge-acme/app")).toBeNull();
});

// CRITICAL 1: merging is not publishing. Merging core's PR must NOT flip
// `published` — that is the merge/publish race this product exists to
// remove (see Root.tsx's own onRefresh doc comment and the sibling fix on
// that path). Renamed and rewritten from the old (bugged) expectation that
// merging alone unblocked `app` in the same render.
test("merging the ready core PR leaves app blocked; only a Refresh reporting core published unblocks it", async () => {
  const merge = calls(async (_entry: ChangesetEntry, _pr: number) => true);
  const refresh = calls(
    async (_entries: ChangesetEntry[], _prs: Map<string, number>): Promise<RefreshResult> => ({
      published: new Set(["core"]),
      observed: {},
    }),
  );
  await renderOpen({ onMerge: merge.fn, onRefresh: refresh.fn });

  fireEvent.click(screen.getByTestId("merge-acme/core"));

  // Wait for merge to resolve and re-render.
  await waitFor(() => {
    expect(screen.getByTestId("pr-row-acme/core").getAttribute("data-state")).toBe("merged");
  });

  expect(merge.log.length).toBe(1);
  const [mergedEntry, prNumber] = merge.log[0] ?? [];
  expect(mergedEntry?.repo).toBe("acme/core");
  expect(prNumber).toBe(101);

  // core's own row reflects the merge (an "observed" claim, not `published`)...
  expect(screen.getByTestId("pr-row-acme/core").getAttribute("data-state")).toBe("merged");
  // ...but app must NOT go ready from the merge alone: nothing has checked
  // whether core@1.0.1 is actually resolvable yet. A regression that
  // re-adds `setPublished` inside `merge()` makes this assertion (and the
  // next two) fail.
  expect(screen.getByTestId("pr-row-acme/app").getAttribute("data-state")).toBe("blocked");
  expect(screen.getByTestId("pr-waiting-acme/app").textContent).toBe(" — waiting for: core");
  expect(screen.queryByTestId("merge-acme/app")).toBeNull();
  expect(refresh.log.length).toBe(0);

  // It only becomes ready once a Refresh actually reports core as published.
  fireEvent.click(screen.getByTestId("refresh"));

  await waitFor(() => {
    expect(screen.getByTestId("pr-row-acme/app").getAttribute("data-state")).toBe("ready");
  });
  expect(refresh.log.length).toBe(1);
  expect(screen.queryByTestId("pr-waiting-acme/app")).toBeNull();
});

test("Auto Merge success reports the count and marks merged entries", async () => {
  const outcome: TrainOutcome = { status: "success", merged: [{ pkg: "core", repo: "acme/core" }] };
  await renderOpen({ onAutoMerge: async () => outcome });

  fireEvent.click(screen.getByTestId("auto-merge"));
  const banner = await screen.findByTestId("train-outcome");
  expect(banner.textContent).toBe("Auto Merge complete — 1 merged.");
  expect(screen.getByTestId("pr-row-acme/core").getAttribute("data-state")).toBe("merged");
});

test("Auto Merge stall names the stuck package and the reason, and colours it failed", async () => {
  const outcome: TrainOutcome = {
    status: "stalled",
    merged: [],
    pkg: "app",
    repo: "acme/app",
    reason: "app is blocked — waiting for upstream package(s) to publish: core",
  };
  await renderOpen({ onAutoMerge: async () => outcome });

  fireEvent.click(screen.getByTestId("auto-merge"));
  const banner = await screen.findByTestId("train-outcome");
  expect(banner.textContent).toBe(
    "Auto Merge stalled: app is blocked — waiting for upstream package(s) to publish: core",
  );
  expect(screen.getByTestId("pr-row-acme/app").getAttribute("data-state")).toBe("failed");
});

test("Refresh pulls published/observed state and re-colours rows accordingly", async () => {
  const refreshResult: RefreshResult = {
    published: new Set(["core"]),
    observed: { "acme/tool": "failed" },
  };
  await renderOpen({ onRefresh: async () => refreshResult });

  // Before refresh: app is blocked, tool is ready.
  expect(screen.getByTestId("pr-row-acme/app").getAttribute("data-state")).toBe("blocked");
  expect(screen.getByTestId("pr-row-acme/tool").getAttribute("data-state")).toBe("ready");

  fireEvent.click(screen.getByTestId("refresh"));

  await waitFor(() => {
    expect(screen.getByTestId("pr-row-acme/tool").getAttribute("data-state")).toBe("failed");
  });
  // core published -> app unblocked; tool observed failed overrides classifyPr's "ready".
  expect(screen.getByTestId("pr-row-acme/app").getAttribute("data-state")).toBe("ready");
});

// IMPORTANT 4: `observed` is a merge, not a replace. `onRefresh` only ever
// reports "merged" (see RefreshResult's doc comment) — a previously
// observed "failed" for a repo Refresh has nothing new to say about must
// survive, not silently revert to ready/blocked.
test("a 'failed' badge survives a Refresh that reports nothing new about that repo", async () => {
  const merge = calls(async (_entry: ChangesetEntry, _pr: number) => false);
  const refresh = calls(
    async (): Promise<RefreshResult> => ({ published: new Set(), observed: {} }),
  );
  await renderOpen({ onMerge: merge.fn, onRefresh: refresh.fn });

  // tool has no in-chain dependency: ready, so it has a Merge button.
  fireEvent.click(screen.getByTestId("merge-acme/tool"));
  await waitFor(() => {
    expect(screen.getByTestId("pr-row-acme/tool").getAttribute("data-state")).toBe("failed");
  });

  fireEvent.click(screen.getByTestId("refresh"));
  await waitFor(() => {
    expect(refresh.log.length).toBe(1);
  });
  // A regression that replaces `observed` wholesale (`setObserved(result.observed)`)
  // would revert this to "ready" the instant Refresh runs, since the mock's
  // `observed` is empty.
  expect(screen.getByTestId("pr-row-acme/tool").getAttribute("data-state")).toBe("failed");
});

test("a later 'merged' from Refresh overrides an earlier 'failed' for the same repo — merging is newer information", async () => {
  const merge = calls(async (_entry: ChangesetEntry, _pr: number) => false);
  const refresh = calls(
    async (): Promise<RefreshResult> => ({
      published: new Set(),
      observed: { "acme/tool": "merged" },
    }),
  );
  await renderOpen({ onMerge: merge.fn, onRefresh: refresh.fn });

  fireEvent.click(screen.getByTestId("merge-acme/tool"));
  await waitFor(() => {
    expect(screen.getByTestId("pr-row-acme/tool").getAttribute("data-state")).toBe("failed");
  });

  fireEvent.click(screen.getByTestId("refresh"));
  await waitFor(() => {
    expect(screen.getByTestId("pr-row-acme/tool").getAttribute("data-state")).toBe("merged");
  });
});

test("switching the selected repo abandons the in-flight proposal", async () => {
  const { rerender } = render(
    <Updates {...baseProps({ selected: "app", onPlanUpdateChain: async () => planned(chainEntries()) })} />,
  );
  fireEvent.click(screen.getByText("Update Chain"));
  await screen.findByTestId("updates-proposal");

  rerender(<Updates {...baseProps({ selected: "other" })} />);
  expect(screen.queryByTestId("updates-proposal")).toBeNull();
  expect(screen.getByTestId("updates-actions")).toBeTruthy();
});
