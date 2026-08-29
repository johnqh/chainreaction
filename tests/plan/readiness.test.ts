import { test, expect } from "bun:test";
import { assertPrepared, participationBlocker } from "../../src/plan/readiness";
import type { PrepareResult } from "../../src/prepare/types";

const ok = (repo: string): PrepareResult =>
  ({ repo, ready: true, mechanism: "auto-merge", blockers: [] });
const bad = (repo: string, why: string): PrepareResult =>
  ({ repo, ready: false, mechanism: "auto-merge", blockers: [why] });
const controlPlane = (repo: string): PrepareResult =>
  ({ repo, ready: true, mechanism: "control-plane", blockers: [] });

test("passes when every required repo is ready", () => {
  const m = new Map([["acme/a", ok("acme/a")], ["acme/b", ok("acme/b")]]);
  expect(() => assertPrepared(m, ["acme/a", "acme/b"])).not.toThrow();
});

test("refuses when a required repo is not ready, naming it and why", () => {
  const m = new Map([["acme/a", ok("acme/a")], ["acme/b", bad("acme/b", "missing workflow")]]);
  expect(() => assertPrepared(m, ["acme/a", "acme/b"])).toThrow(/acme\/b.*missing workflow/s);
});

test("refuses when a required repo was never prepared at all", () => {
  const m = new Map([["acme/a", ok("acme/a")]]);
  expect(() => assertPrepared(m, ["acme/a", "acme/b"])).toThrow(/acme\/b.*never prepared/s);
});

test("reports every unready repo, not just the first", () => {
  const m = new Map([
    ["acme/a", bad("acme/a", "x")],
    ["acme/b", bad("acme/b", "y")],
  ]);
  let msg = "";
  try { assertPrepared(m, ["acme/a", "acme/b"]); } catch (e) { msg = (e as Error).message; }
  expect(msg).toContain("acme/a");
  expect(msg).toContain("acme/b");
});

test("ignores prepared repos that are not required", () => {
  const m = new Map([["acme/a", ok("acme/a")], ["acme/z", bad("acme/z", "irrelevant")]]);
  expect(() => assertPrepared(m, ["acme/a"])).not.toThrow();
});

test("a repo that is ready:true via control-plane merge is still refused — that mechanism is not implemented", () => {
  const m = new Map([["acme/a", ok("acme/a")], ["acme/b", controlPlane("acme/b")]]);
  expect(() => assertPrepared(m, ["acme/a", "acme/b"])).toThrow(/acme\/b.*control-plane merge/s);
});

test("refuses to certify an empty repository set", () => {
  const m = new Map([["acme/a", ok("acme/a")]]);
  expect(() => assertPrepared(m, [])).toThrow(/empty repository set/);
});

// --- FIX 2: participationBlocker is the single definition both sides use ---

test("participationBlocker: a ready auto-merge repo has no blocker", () => {
  expect(participationBlocker(ok("acme/a"))).toBeUndefined();
});

test("participationBlocker: an unready repo's blocker is its own blockers list", () => {
  expect(participationBlocker(bad("acme/a", "missing workflow"))).toBe("missing workflow");
});

test("participationBlocker: a ready control-plane repo is still blocked from taking part", () => {
  expect(participationBlocker(controlPlane("acme/a"))).toMatch(/control-plane merge/);
});
