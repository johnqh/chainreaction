import { test, expect } from "bun:test";
import { Cascade, detectStall } from "../../src/supervisor/state";
import type { ChangesetEntry } from "../../src/graph/types";

const entries: ChangesetEntry[] = [
  { pkg: "a", dir: "/a", repo: "johnqh/a", fromVersion: "1.0.0", toVersion: "1.0.1", depBumps: {}, level: 0 },
  { pkg: "b", dir: "/b", repo: "johnqh/b", fromVersion: "1.0.0", toVersion: "1.0.1", depBumps: { a: "^1.0.1" }, level: 1 },
];

test("every node starts pending", () => {
  const c = new Cascade(entries);
  expect(c.get("a")).toBe("pending");
  expect(c.isComplete()).toBe(false);
});

test("cascade is complete only when every node is published", () => {
  const c = new Cascade(entries);
  c.set("a", "published");
  expect(c.isComplete()).toBe(false);
  c.set("b", "published");
  expect(c.isComplete()).toBe(true);
});

test("stalled nodes are reported", () => {
  const c = new Cascade(entries);
  c.set("b", "stalled");
  expect(c.stalled()).toEqual(["b"]);
});

test("snapshot exposes nodes and edges for the UI", () => {
  const c = new Cascade(entries);
  c.set("a", "published");
  const s = c.snapshot();
  expect(s.nodes).toEqual([
    { pkg: "a", repo: "johnqh/a", level: 0, version: "1.0.1", state: "published" },
    { pkg: "b", repo: "johnqh/b", level: 1, version: "1.0.1", state: "pending" },
  ]);
  expect(s.edges).toEqual([{ from: "a", to: "b" }]);
});

test("detectStall flags a node stuck in ci-running past the timeout", () => {
  const c = new Cascade(entries);
  c.set("b", "ci-running");
  const last = new Map([["b", 1_000]]);
  expect(detectStall(c, 1_000 + 20 * 60_000, last, 15 * 60_000)).toEqual(["b"]);
  expect(detectStall(c, 1_000 + 5 * 60_000, last, 15 * 60_000)).toEqual([]);
});

test("detectStall ignores terminal states", () => {
  const c = new Cascade(entries);
  c.set("b", "published");
  const last = new Map([["b", 0]]);
  expect(detectStall(c, 9_999_999, last, 1_000)).toEqual([]);
});
