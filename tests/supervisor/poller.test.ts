import { test, expect } from "bun:test";
import { GhClient } from "../../src/github/client";
import { Cascade } from "../../src/supervisor/state";
import { pollOnce } from "../../src/supervisor/poller";
import type { ChangesetEntry } from "../../src/graph/types";

const entries: ChangesetEntry[] = [
  { pkg: "@sudobility/design", dir: "/design_system", repo: "johnqh/design_system",
    fromVersion: "1.1.49", toVersion: "1.1.50", depBumps: {}, level: 0 },
];

function ghReturning(state: string) {
  return new GhClient(async () => JSON.stringify({ state }));
}

test("pollOnce maps a MERGED PR to merged", async () => {
  const cascade = new Cascade(entries);
  const prs = new Map([["johnqh/design_system", 7]]);
  await pollOnce(cascade, entries, prs, ghReturning("MERGED"));
  expect(cascade.get("@sudobility/design")).toBe("merged");
});

test("pollOnce maps an OPEN PR to ci-running", async () => {
  const cascade = new Cascade(entries);
  const prs = new Map([["johnqh/design_system", 7]]);
  await pollOnce(cascade, entries, prs, ghReturning("OPEN"));
  expect(cascade.get("@sudobility/design")).toBe("ci-running");
});

test("pollOnce maps a CLOSED (unmerged) PR to stalled", async () => {
  const cascade = new Cascade(entries);
  const prs = new Map([["johnqh/design_system", 7]]);
  await pollOnce(cascade, entries, prs, ghReturning("CLOSED"));
  expect(cascade.get("@sudobility/design")).toBe("stalled");
});

test("a stalled node stays stalled across another pollOnce with unchanged gh state", async () => {
  const cascade = new Cascade(entries);
  const prs = new Map([["johnqh/design_system", 7]]);
  const t0 = 1_000_000;

  // Force the node into "stalled" directly (as detectStall would), the way it
  // gets there in production: a real change, which bumps lastChange to t0.
  cascade.set("@sudobility/design", "stalled", t0);
  expect(cascade.get("@sudobility/design")).toBe("stalled");

  // gh still reports the PR as open (nothing happened) on the very next poll.
  // Before the Critical-2 fix, the per-entry loop would unconditionally map
  // OPEN -> "ci-running", which is a real change from "stalled", so it would
  // both flip the node back to "ci-running" AND reset lastChange to t1 --
  // erasing the stall it just detected.
  const t1 = t0 + 60_000;
  await pollOnce(cascade, entries, prs, ghReturning("OPEN"), t1);

  expect(cascade.get("@sudobility/design")).toBe("stalled");
});

test("a stalled node recovers to merged if gh later reports MERGED", async () => {
  const cascade = new Cascade(entries);
  const prs = new Map([["johnqh/design_system", 7]]);
  const t0 = 1_000_000;

  cascade.set("@sudobility/design", "stalled", t0);

  const t1 = t0 + 60_000;
  await pollOnce(cascade, entries, prs, ghReturning("MERGED"), t1);

  expect(cascade.get("@sudobility/design")).toBe("merged");
});
