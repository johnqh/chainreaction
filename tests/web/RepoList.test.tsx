import { test, expect, afterEach } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RepoNode } from "../../src/graph/types";
import { RepoList } from "../../src/web/RepoList";

afterEach(cleanup);

function nodes(): RepoNode[] {
  return [
    { pkg: "@scope/widget-core", repo: "acme/widget-core", version: "1.0.0", deps: [] },
    { pkg: "@scope/widget-ui", repo: "acme/widget-ui", version: "1.0.0", deps: ["@scope/widget-core"] },
    { pkg: "@scope/other-thing", repo: "acme/other-thing", version: "2.0.0", deps: [] },
  ];
}

test("RepoList renders every repo and shows prepared status", () => {
  render(
    <RepoList
      nodes={nodes()}
      prepared={{ "@scope/widget-core": true }}
      selected={null}
      onSelect={() => {}}
    />,
  );
  expect(screen.getByTestId("repo-item-@scope/widget-core")).toBeTruthy();
  expect(screen.getByTestId("repo-item-@scope/widget-ui")).toBeTruthy();
  expect(screen.getByTestId("prepared-@scope/widget-core")).toBeTruthy();
  expect(screen.queryByTestId("prepared-@scope/widget-ui")).toBeNull();
});

test("RepoList search is case-insensitive and narrows the visible set", () => {
  render(<RepoList nodes={nodes()} prepared={{}} selected={null} onSelect={() => {}} />);
  const input = screen.getByLabelText("Search repos");

  fireEvent.change(input, { target: { value: "WIDGET" } });
  expect(screen.getByTestId("repo-item-@scope/widget-core")).toBeTruthy();
  expect(screen.getByTestId("repo-item-@scope/widget-ui")).toBeTruthy();
  expect(screen.queryByTestId("repo-item-@scope/other-thing")).toBeNull();
  expect(screen.getByTestId("repo-count").textContent).toBe("2 of 3 repos");
});

test("clicking a repo calls onSelect with its pkg", () => {
  const calls: string[] = [];
  render(
    <RepoList
      nodes={nodes()}
      prepared={{}}
      selected={null}
      onSelect={(pkg) => {
        calls.push(pkg);
      }}
    />,
  );
  fireEvent.click(screen.getByTestId("repo-item-@scope/other-thing"));
  expect(calls).toEqual(["@scope/other-thing"]);
});

test("RepoList reflects the selected prop without owning its own selection state", () => {
  const { rerender } = render(
    <RepoList nodes={nodes()} prepared={{}} selected={null} onSelect={() => {}} />,
  );
  expect(screen.getByTestId("repo-item-@scope/widget-core").getAttribute("data-selected")).toBe(
    "false",
  );

  rerender(
    <RepoList nodes={nodes()} prepared={{}} selected="@scope/widget-core" onSelect={() => {}} />,
  );
  expect(screen.getByTestId("repo-item-@scope/widget-core").getAttribute("data-selected")).toBe(
    "true",
  );
});
