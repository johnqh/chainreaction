// This is the requirement the whole task hinges on: selecting a node in either
// view selects it in the other. We prove it by driving RepoList and Graph off
// ONE shared `selected`/`onSelect` pair — exactly the pattern App.tsx will use —
// and clicking in one view, then asserting the other view reflects the change.
import { test, expect, afterEach } from "bun:test";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RepoNode } from "../../src/graph/types";
import { RepoList } from "../../src/web/RepoList";
import { Graph } from "../../src/web/Graph";

afterEach(cleanup);

function nodes(): RepoNode[] {
  return [
    { pkg: "core", repo: "acme/core", version: "1.0.0", deps: [] },
    { pkg: "app", repo: "acme/app", version: "1.0.0", deps: ["core"] },
  ];
}

/** Minimal harness: one selection state, shared by both views — the same wiring App.tsx owns. */
function Harness() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div>
      <RepoList nodes={nodes()} prepared={{}} selected={selected} onSelect={setSelected} />
      <Graph nodes={nodes()} selected={selected} onSelect={setSelected} />
    </div>
  );
}

test("selecting a node in Graph selects it in RepoList", () => {
  render(<Harness />);
  expect(screen.getByTestId("repo-item-app").getAttribute("data-selected")).toBe("false");

  fireEvent.click(screen.getByTestId("node-app"));

  expect(screen.getByTestId("repo-item-app").getAttribute("data-selected")).toBe("true");
  expect(screen.getByTestId("repo-item-core").getAttribute("data-selected")).toBe("false");
  expect(screen.getByTestId("node-app").getAttribute("data-selected")).toBe("true");
});

test("selecting a repo in RepoList selects it in Graph", () => {
  render(<Harness />);
  expect(screen.getByTestId("node-core").getAttribute("data-selected")).toBe("false");

  fireEvent.click(screen.getByTestId("repo-item-core"));

  expect(screen.getByTestId("node-core").getAttribute("data-selected")).toBe("true");
  expect(screen.getByTestId("node-app").getAttribute("data-selected")).toBe("false");
  expect(screen.getByTestId("repo-item-core").getAttribute("data-selected")).toBe("true");
});

test("switching selection between views never leaves the two views disagreeing", () => {
  render(<Harness />);
  fireEvent.click(screen.getByTestId("node-app"));
  fireEvent.click(screen.getByTestId("repo-item-core"));

  // Latest click (RepoList -> core) must win everywhere.
  expect(screen.getByTestId("repo-item-core").getAttribute("data-selected")).toBe("true");
  expect(screen.getByTestId("node-core").getAttribute("data-selected")).toBe("true");
  expect(screen.getByTestId("repo-item-app").getAttribute("data-selected")).toBe("false");
  expect(screen.getByTestId("node-app").getAttribute("data-selected")).toBe("false");
});
