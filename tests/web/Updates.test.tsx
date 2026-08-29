import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChangesetEntry } from "../../src/graph/types";
import type { TrainOutcome } from "../../src/pr/train";
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
    onPlanUpdate: async () => [],
    onPlanUpdateChain: async () => [],
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

test("Update Chain proposes the changeset and does NOT open any PR before confirmation", async () => {
  const plan = calls(async (_pkg: string) => chainEntries());
  const open = calls(async (_entries: ChangesetEntry[]) => prMap());
  render(
    <Updates
      {...baseProps({ onPlanUpdateChain: plan.fn, onOpenPrs: open.fn })}
    />,
  );

  fireEvent.click(screen.getByText("Update Chain"));

  const proposal = await screen.findByTestId("updates-proposal");
  expect(proposal.textContent).toContain("3 repo(s)");
  expect(screen.getByTestId("proposal-bump-acme/core").textContent).toBe("1.0.0 → 1.0.1");
  expect(screen.getByTestId("proposal-bump-acme/app").textContent).toBe("2.0.0 → 2.0.1");
  expect(screen.getByTestId("proposal-bump-acme/tool").textContent).toBe("3.0.0 → 3.0.1");

  // The whole point: proposing must not have opened anything yet.
  expect(open.log.length).toBe(0);
  expect(screen.queryByTestId("updates-open")).toBeNull();
});

test("confirming opens exactly the proposed entries, once", async () => {
  const open = calls(async (_entries: ChangesetEntry[]) => prMap());
  render(
    <Updates
      {...baseProps({ onPlanUpdateChain: async () => chainEntries(), onOpenPrs: open.fn })}
    />,
  );

  fireEvent.click(screen.getByText("Update Chain"));
  await screen.findByTestId("updates-proposal");
  fireEvent.click(screen.getByTestId("confirm-changeset"));

  await screen.findByTestId("updates-open");
  expect(open.log.length).toBe(1);
  expect(open.log[0]?.[0]).toEqual(chainEntries());
  expect(screen.getByTestId("pr-number-acme/core").textContent).toContain("101");
  expect(screen.queryByTestId("updates-proposal")).toBeNull();
});

test("cancelling a proposal never opens any PR", async () => {
  const open = calls(async (_entries: ChangesetEntry[]) => prMap());
  render(
    <Updates
      {...baseProps({ onPlanUpdateChain: async () => chainEntries(), onOpenPrs: open.fn })}
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
      {...baseProps({ onPlanUpdateChain: async () => chainEntries(), onOpenPrs: async () => prMap(), ...overrides })}
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

test("a blocked PR names what it is waiting for, not just the word 'blocked'", async () => {
  await renderOpen();
  const waiting = screen.getByTestId("pr-waiting-acme/app").textContent ?? "";
  expect(waiting).toContain("core");
  // Must be more specific than the bare word alone would communicate.
  expect(waiting.toLowerCase()).toContain("waiting for");
  // No merge button on a blocked PR.
  expect(screen.queryByTestId("merge-acme/app")).toBeNull();
});

test("merging the ready core PR unblocks app in the same render, still via classifyPr", async () => {
  const merge = calls(async (_entry: ChangesetEntry, _pr: number) => true);
  await renderOpen({ onMerge: merge.fn });

  fireEvent.click(screen.getByTestId("merge-acme/core"));

  // Wait for merge to resolve and re-render.
  await waitFor(() => {
    expect(screen.getByTestId("pr-row-acme/core").getAttribute("data-state")).toBe("merged");
  });

  expect(merge.log.length).toBe(1);
  const [mergedEntry, prNumber] = merge.log[0] ?? [];
  expect(mergedEntry?.repo).toBe("acme/core");
  expect(prNumber).toBe(101);

  expect(screen.getByTestId("pr-row-acme/core").getAttribute("data-state")).toBe("merged");
  // app's in-chain dependency (core) is now published: app becomes ready.
  expect(screen.getByTestId("pr-row-acme/app").getAttribute("data-state")).toBe("ready");
  expect(screen.queryByTestId("pr-waiting-acme/app")).toBeNull();
});

test("Auto Merge success reports the count and marks merged entries", async () => {
  const outcome: TrainOutcome = { status: "success", merged: [{ pkg: "core", repo: "acme/core" }] };
  await renderOpen({ onAutoMerge: async () => outcome });

  fireEvent.click(screen.getByTestId("auto-merge"));
  const banner = await screen.findByTestId("train-outcome");
  expect(banner.textContent).toContain("1 merged");
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
  expect(banner.textContent).toContain("app");
  expect(banner.textContent).toContain("core");
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

test("switching the selected repo abandons the in-flight proposal", async () => {
  const { rerender } = render(
    <Updates {...baseProps({ selected: "app", onPlanUpdateChain: async () => chainEntries() })} />,
  );
  fireEvent.click(screen.getByText("Update Chain"));
  await screen.findByTestId("updates-proposal");

  rerender(<Updates {...baseProps({ selected: "other" })} />);
  expect(screen.queryByTestId("updates-proposal")).toBeNull();
  expect(screen.getByTestId("updates-actions")).toBeTruthy();
});
