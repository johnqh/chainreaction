import { test, expect } from "bun:test";
import { GhClient } from "../../src/github/client";
import { classifyPr, openUpdatePrs } from "../../src/pr/lifecycle";
import type { ChangesetEntry } from "../../src/graph/types";

function entry(over: Partial<ChangesetEntry> & { pkg: string }): ChangesetEntry {
  return {
    dir: undefined,
    repo: `acme/${over.pkg}`,
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    depBumps: {},
    level: 0,
    ...over,
  };
}

// --- classifyPr ---

test("an entry with no in-chain dependencies is ready", () => {
  // A sibling entry exists in the cascade, but it is not named in this
  // entry's own depBumps, and it has not published. If classifyPr blocked
  // on the mere presence of other entries (rather than on depBumps),
  // this would wrongly come back "blocked".
  const target = entry({ pkg: "proj-a", depBumps: {} });
  const sibling = entry({ pkg: "proj-b", depBumps: { "proj-a": "^1.0.1" } });
  const entries = [target, sibling];
  const published = new Set<string>();

  expect(classifyPr(target, entries, published)).toBe("ready");
});

test("an entry whose dependency has not published is blocked", () => {
  const upstream = entry({ pkg: "proj-a" });
  const downstream = entry({ pkg: "proj-b", depBumps: { "proj-a": "^1.0.1" } });
  const entries = [upstream, downstream];
  const published = new Set<string>();

  expect(classifyPr(downstream, entries, published)).toBe("blocked");
});

test("the same entry becomes ready once its dependency publishes", () => {
  const upstream = entry({ pkg: "proj-a" });
  const downstream = entry({ pkg: "proj-b", depBumps: { "proj-a": "^1.0.1" } });
  const entries = [upstream, downstream];
  const published = new Set(["proj-a"]);

  expect(classifyPr(downstream, entries, published)).toBe("ready");
});

test("only in-chain dependencies matter — an unrelated unpublished package does not block", () => {
  // "third-party-lib" is a real dependency bump, but it is not part of this
  // cascade (no entry in `entries` publishes it) — e.g. a third-party
  // package, or a repo the user chose not to update. It can never appear in
  // `published`, so if classifyPr didn't intersect depBumps against
  // entries, this PR would be blocked forever with no way to unblock it.
  const target = entry({ pkg: "proj-c", depBumps: { "third-party-lib": "^2.0.0" } });
  const entries = [target];
  const published = new Set<string>();

  expect(classifyPr(target, entries, published)).toBe("ready");
});

test("an entry with multiple in-chain dependencies is ready only once all of them publish", () => {
  const a = entry({ pkg: "proj-a" });
  const b = entry({ pkg: "proj-b" });
  const c = entry({
    pkg: "proj-c",
    depBumps: { "proj-a": "^1.0.1", "proj-b": "^1.0.1" },
  });
  const entries = [a, b, c];

  expect(classifyPr(c, entries, new Set(["proj-a"]))).toBe("blocked");
  expect(classifyPr(c, entries, new Set(["proj-a", "proj-b"]))).toBe("ready");
});

// --- openUpdatePrs ---

function recorder() {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    if (args.includes("create")) return "https://github.com/acme/x/pull/99\n";
    return "";
  };
  return { calls, exec };
}

test("openUpdatePrs opens one PR per entry and returns the PR numbers", async () => {
  const entries: ChangesetEntry[] = [
    entry({ pkg: "proj-a", repo: "acme/proj-a" }),
    entry({
      pkg: "proj-b",
      repo: "acme/proj-b",
      depBumps: { "proj-a": "^1.0.1" },
    }),
  ];
  const { calls, exec } = recorder();
  const prs = await openUpdatePrs(entries, new GhClient(exec), "cr/update-1.0.1");

  expect(prs.get("acme/proj-a")).toBe(99);
  expect(prs.get("acme/proj-b")).toBe(99);
  expect(calls.filter((c) => c.includes("create")).length).toBe(2);
});
