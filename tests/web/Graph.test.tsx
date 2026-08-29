import { test, expect, afterEach } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RepoNode } from "../../src/graph/types";
import { Graph } from "../../src/web/Graph";

afterEach(cleanup);

function nodes(): RepoNode[] {
  return [
    { pkg: "core", repo: "acme/core", version: "1.0.0", deps: [] },
    { pkg: "tooling", repo: "acme/tooling", version: "1.0.0", deps: [] },
    // depends on core (dependency edge) and dev-depends on tooling (devDependency edge)
    { pkg: "app", repo: "acme/app", version: "1.0.0", deps: ["core"], devDeps: ["tooling"] },
  ];
}

test("Graph renders one SVG node per repo", () => {
  render(<Graph nodes={nodes()} selected={null} onSelect={() => {}} />);
  expect(screen.getByTestId("node-core")).toBeTruthy();
  expect(screen.getByTestId("node-tooling")).toBeTruthy();
  expect(screen.getByTestId("node-app")).toBeTruthy();
});

test("Graph renders both a dependency and a devDependency edge, visibly distinct", () => {
  render(<Graph nodes={nodes()} selected={null} onSelect={() => {}} />);
  const depEdge = screen.getByTestId("edge-dependency");
  const devEdge = screen.getByTestId("edge-devDependency");
  expect(depEdge.getAttribute("data-from")).toBe("app");
  expect(depEdge.getAttribute("data-to")).toBe("core");
  expect(devEdge.getAttribute("data-from")).toBe("app");
  expect(devEdge.getAttribute("data-to")).toBe("tooling");

  // Colour differs.
  const depStroke = depEdge.getAttribute("stroke");
  const devStroke = devEdge.getAttribute("stroke");
  expect(depStroke).toBeTruthy();
  expect(devStroke).toBeTruthy();
  expect(depStroke).not.toBe(devStroke);

  // Stroke pattern differs too — colour alone must not be the only signal.
  const depDash = depEdge.getAttribute("stroke-dasharray");
  const devDash = devEdge.getAttribute("stroke-dasharray");
  expect(depDash).not.toBe(devDash);
});

test("Graph shows a legend naming both dependency and devDependency", () => {
  render(<Graph nodes={nodes()} selected={null} onSelect={() => {}} />);
  const legend = screen.getByTestId("legend");
  expect(legend.textContent).toContain("dependency");
  expect(legend.textContent).toContain("devDependency");
  expect(screen.getByTestId("legend-dependency")).toBeTruthy();
  expect(screen.getByTestId("legend-devDependency")).toBeTruthy();
});

test("clicking a node calls onSelect with its pkg", () => {
  const calls: string[] = [];
  render(
    <Graph
      nodes={nodes()}
      selected={null}
      onSelect={(pkg) => {
        calls.push(pkg);
      }}
    />,
  );
  fireEvent.click(screen.getByTestId("node-tooling"));
  expect(calls).toEqual(["tooling"]);
});

test("Graph reflects the selected prop without owning its own selection state", () => {
  const { rerender } = render(<Graph nodes={nodes()} selected={null} onSelect={() => {}} />);
  expect(screen.getByTestId("node-core").getAttribute("data-selected")).toBe("false");

  rerender(<Graph nodes={nodes()} selected="core" onSelect={() => {}} />);
  expect(screen.getByTestId("node-core").getAttribute("data-selected")).toBe("true");
  expect(screen.getByTestId("node-app").getAttribute("data-selected")).toBe("false");
});

test("Graph handles nodes with no devDeps key at all without crashing", () => {
  const bare: RepoNode[] = [
    { pkg: "a", repo: "acme/a", version: "1.0.0", deps: [] },
    { pkg: "b", repo: "acme/b", version: "1.0.0", deps: ["a"] },
  ];
  render(<Graph nodes={bare} selected={null} onSelect={() => {}} />);
  expect(screen.getByTestId("edge-dependency")).toBeTruthy();
  expect(screen.queryByTestId("edge-devDependency")).toBeNull();
});
