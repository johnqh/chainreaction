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
  const c = new Cascade(entries, 1_000);  // Seed at time 1_000
  c.set("a", "published", 1_000);  // "a" in terminal state, won't be checked
  c.set("b", "ci-running", 1_000);
  expect(detectStall(c, 1_000 + 20 * 60_000, 15 * 60_000)).toEqual(["b"]);
  expect(detectStall(c, 1_000 + 5 * 60_000, 15 * 60_000)).toEqual([]);
});

test("detectStall ignores terminal states", () => {
  const c = new Cascade(entries, 0);  // Seed at time 0
  c.set("a", "published", 0);  // "a" in terminal state
  c.set("b", "published", 0);
  expect(detectStall(c, 9_999_999, 1_000)).toEqual([]);
});

test("set/get throw on unknown package", () => {
  const c = new Cascade(entries);
  expect(() => c.get("z")).toThrow();
  expect(() => c.set("z", "published")).toThrow();
});

test("detectStall uses exact timeout boundary", () => {
  const c = new Cascade(entries, 1_000);  // Seed at time 1_000
  c.set("a", "published", 1_000);  // "a" in terminal state, won't be checked
  c.set("b", "ci-running", 1_000);
  // Exactly at timeout: 1_000 + 15_000 - 1_000 = 15_000, which is NOT > 15_000
  expect(detectStall(c, 1_000 + 15_000, 15_000)).toEqual([]);
  // Past timeout: 1_000 + 15_001 - 1_000 = 15_001, which is > 15_000
  expect(detectStall(c, 1_000 + 15_001, 15_000)).toEqual(["b"]);
});

test("detectStall flags a node stuck at pending since construction", () => {
  const c = new Cascade(entries, 0);  // Seed at time 0
  // Don't call set() on either package; both remain at pending
  expect(detectStall(c, 20 * 60_000, 15 * 60_000).sort()).toEqual(["a", "b"]);
});
