import { test, expect } from "bun:test";
import type { ChangesetEntry } from "../../src/graph/types";
import { classifyPr } from "../../src/pr/lifecycle";
import { describeWaiting, resolvePrState, waitingFor } from "../../src/web/updatesModel";

function entry(over: Partial<ChangesetEntry> & { pkg: string; repo: string }): ChangesetEntry {
  return {
    dir: undefined,
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    depBumps: {},
    level: 0,
    ...over,
  };
}

test("waitingFor names only in-chain, unpublished deps", () => {
  const upstream = entry({ pkg: "core", repo: "acme/core" });
  const target = entry({
    pkg: "app",
    repo: "acme/app",
    depBumps: { core: "^1.0.1", "third-party": "^2.0.0" },
  });
  const entries = [upstream, target];

  // Neither in-chain dep has published: only the in-chain one is named.
  // "third-party" is not a member of `entries` at all, so it must never appear.
  expect(waitingFor(target, entries, new Set())).toEqual(["core"]);

  // Once core has published, nothing is left to wait for.
  expect(waitingFor(target, entries, new Set(["core"]))).toEqual([]);
});

test("waitingFor and classifyPr agree on blocked-vs-ready", () => {
  const upstream = entry({ pkg: "core", repo: "acme/core" });
  const target = entry({ pkg: "app", repo: "acme/app", depBumps: { core: "^1.0.1" } });
  const entries = [upstream, target];

  // Unpublished: classifyPr says blocked, and waitingFor names the reason.
  expect(classifyPr(target, entries, new Set())).toBe("blocked");
  expect(waitingFor(target, entries, new Set())).toEqual(["core"]);

  // Published: classifyPr says ready, and waitingFor has nothing left to name.
  expect(classifyPr(target, entries, new Set(["core"]))).toBe("ready");
  expect(waitingFor(target, entries, new Set(["core"]))).toEqual([]);
});

test("describeWaiting names the dependencies, and is distinct from the empty case", () => {
  expect(describeWaiting(["core"])).toBe("waiting for: core");
  expect(describeWaiting(["core", "shared"])).toBe("waiting for: core, shared");

  const empty = describeWaiting([]);
  expect(empty).not.toBe("waiting for: ");
  expect(empty).not.toContain("waiting for:");
});

test("resolvePrState defers to classifyPr when nothing has been observed", () => {
  const upstream = entry({ pkg: "core", repo: "acme/core" });
  const readyTarget = entry({ pkg: "leaf", repo: "acme/leaf" });
  const blockedTarget = entry({ pkg: "app", repo: "acme/app", depBumps: { core: "^1.0.1" } });
  const entries = [upstream, readyTarget, blockedTarget];

  expect(resolvePrState(readyTarget, entries, new Set(), undefined)).toBe("ready");
  expect(resolvePrState(blockedTarget, entries, new Set(), undefined)).toBe("blocked");
});

test("resolvePrState lets an observed terminal state override classifyPr", () => {
  const upstream = entry({ pkg: "core", repo: "acme/core" });
  // classifyPr would call this "ready" (no in-chain deps) — an observed
  // "failed" (e.g. CI rejected the merge) must still win.
  const readyByShape = entry({ pkg: "leaf", repo: "acme/leaf" });
  const entries = [upstream, readyByShape];

  expect(classifyPr(readyByShape, entries, new Set())).toBe("ready");
  expect(resolvePrState(readyByShape, entries, new Set(), "failed")).toBe("failed");
  expect(resolvePrState(readyByShape, entries, new Set(), "merged")).toBe("merged");
});
