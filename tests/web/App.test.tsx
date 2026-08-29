// Proves App actually renders RepoList, Graph and Updates wired to a single
// shared `selected` state — the requirement this task exists to satisfy
// ("nothing renders them" was the bug). No fetch is exercised: every action
// is a plain callback prop.
import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RepoNode } from "../../src/graph/types";
import { App, type AppProps } from "../../src/web/App";

afterEach(cleanup);

function nodes(): RepoNode[] {
  return [
    { pkg: "core", repo: "acme/core", version: "1.0.0", deps: [] },
    { pkg: "app", repo: "acme/app", version: "2.0.0", deps: ["core"] },
  ];
}

function baseProps(overrides: Partial<AppProps> = {}): AppProps {
  return {
    nodes: nodes(),
    prepared: {},
    onPlanUpdate: async () => [],
    onPlanUpdateChain: async () => [],
    onOpenPrs: async () => new Map(),
    onMerge: async () => true,
    onAutoMerge: async () => ({ status: "success", merged: [] }),
    onRefresh: async () => ({ published: new Set(), observed: {} }),
    ...overrides,
  };
}

test("App renders RepoList, Graph and Updates together", () => {
  render(<App {...baseProps()} />);
  expect(screen.getByTestId("repo-list")).toBeTruthy();
  expect(screen.getByTestId("graph")).toBeTruthy();
  expect(screen.getByTestId("updates")).toBeTruthy();
  // Nothing selected yet: Updates shows its empty state.
  expect(screen.getByTestId("updates-empty")).toBeTruthy();
});

test("selecting a repo in RepoList drives both Graph and Updates from the same state", () => {
  render(<App {...baseProps()} />);

  fireEvent.click(screen.getByTestId("repo-item-app"));

  expect(screen.getByTestId("node-app").getAttribute("data-selected")).toBe("true");
  expect(screen.getByTestId("updates-selected").textContent).toBe("app");
});

test("selecting a repo in Graph drives both RepoList and Updates from the same state", () => {
  render(<App {...baseProps()} />);

  fireEvent.click(screen.getByTestId("node-core"));

  expect(screen.getByTestId("repo-item-core").getAttribute("data-selected")).toBe("true");
  expect(screen.getByTestId("updates-selected").textContent).toBe("core");
});
