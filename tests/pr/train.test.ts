import { test, expect } from "bun:test";
import { runTrain, type TrainDeps } from "../../src/pr/train";
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

/**
 * Fake TrainDeps that logs every call for ordering assertions. `sleep` never
 * touches a real timer — it just records the requested delay and resolves
 * immediately, which is what keeps this whole suite instantaneous.
 */
function makeDeps(opts: {
  mergeResults?: Record<string, boolean>;
  resolveSequences?: Record<string, boolean[]>;
  maxPollAttempts?: number;
  pollIntervalMs?: number;
}): { deps: TrainDeps; log: string[] } {
  const log: string[] = [];
  const resolveQueues = new Map(
    Object.entries(opts.resolveSequences ?? {}).map(([pkg, seq]) => [pkg, [...seq]]),
  );
  const deps: TrainDeps = {
    async mergePr(e, pr) {
      log.push(`merge:${e.pkg}:${pr}`);
      return opts.mergeResults?.[e.pkg] ?? true;
    },
    async isResolvable(e) {
      const queue = resolveQueues.get(e.pkg);
      const result = queue && queue.length > 0 ? (queue.shift() as boolean) : true;
      log.push(`resolve:${e.pkg}:${result}`);
      return result;
    },
    async sleep(ms) {
      log.push(`sleep:${ms}`);
    },
    maxPollAttempts: opts.maxPollAttempts,
    pollIntervalMs: opts.pollIntervalMs,
  };
  return { deps, log };
}

test("merges a single-entry chain and reports success", async () => {
  const a = entry({ pkg: "proj-a" });
  const entries = [a];
  const prs = new Map([[a.repo, 101]]);
  const { deps, log } = makeDeps({});

  const outcome = await runTrain(entries, prs, deps);

  expect(outcome.status).toBe("success");
  if (outcome.status !== "success") throw new Error("expected success");
  expect(outcome.merged).toEqual([{ pkg: "proj-a", repo: a.repo }]);
  expect(log).toContain("merge:proj-a:101");
});

test("merges bottom-up, never touching a blocked PR", async () => {
  const a = entry({ pkg: "proj-a" });
  const b = entry({ pkg: "proj-b", depBumps: { "proj-a": "^1.0.1" } });
  // Downstream listed first in the input array — merge order must come from
  // readiness (classifyPr), not from array position.
  const entries = [b, a];
  const prs = new Map([
    [a.repo, 201],
    [b.repo, 202],
  ]);
  const { deps, log } = makeDeps({});

  const outcome = await runTrain(entries, prs, deps);

  expect(outcome.status).toBe("success");
  if (outcome.status !== "success") throw new Error("expected success");
  expect(outcome.merged.map((m) => m.pkg)).toEqual(["proj-a", "proj-b"]);
  const mergeAIdx = log.indexOf("merge:proj-a:201");
  const mergeBIdx = log.indexOf("merge:proj-b:202");
  expect(mergeAIdx).toBeGreaterThanOrEqual(0);
  expect(mergeBIdx).toBeGreaterThan(mergeAIdx);
});

test("waits for resolvability before advancing to the next level", async () => {
  const a = entry({ pkg: "proj-a" });
  const b = entry({ pkg: "proj-b", depBumps: { "proj-a": "^1.0.1" } });
  const entries = [a, b];
  const prs = new Map([
    [a.repo, 301],
    [b.repo, 302],
  ]);
  const { deps, log } = makeDeps({
    resolveSequences: { "proj-a": [false, false, true] },
  });

  const outcome = await runTrain(entries, prs, deps);

  expect(outcome.status).toBe("success");
  const mergeBIdx = log.indexOf("merge:proj-b:302");
  const lastResolveAIdx = log.lastIndexOf("resolve:proj-a:true");
  expect(lastResolveAIdx).toBeGreaterThanOrEqual(0);
  expect(mergeBIdx).toBeGreaterThan(lastResolveAIdx);
  // Two "false" checks means the train slept twice before advancing.
  expect(log.filter((l) => l.startsWith("sleep:")).length).toBe(2);
});

test("stalls loudly, naming the PR, when a merge fails", async () => {
  const a = entry({ pkg: "proj-a" });
  const b = entry({ pkg: "proj-b", depBumps: { "proj-a": "^1.0.1" } });
  const entries = [a, b];
  const prs = new Map([
    [a.repo, 401],
    [b.repo, 402],
  ]);
  const { deps } = makeDeps({ mergeResults: { "proj-b": false } });

  const outcome = await runTrain(entries, prs, deps);

  expect(outcome.status).toBe("stalled");
  if (outcome.status !== "stalled") throw new Error("expected stalled");
  expect(outcome.pkg).toBe("proj-b");
  expect(outcome.repo).toBe(b.repo);
  expect(outcome.reason.length).toBeGreaterThan(0);
  expect(outcome.merged.map((m) => m.pkg)).toEqual(["proj-a"]);
});

test("stalls loudly when a publish never becomes resolvable", async () => {
  const a = entry({ pkg: "proj-a" });
  const entries = [a];
  const prs = new Map([[a.repo, 501]]);
  const { deps, log } = makeDeps({
    resolveSequences: { "proj-a": [false, false, false, false, false] },
    maxPollAttempts: 3,
    pollIntervalMs: 1,
  });

  const outcome = await runTrain(entries, prs, deps);

  expect(outcome.status).toBe("stalled");
  if (outcome.status !== "stalled") throw new Error("expected stalled");
  expect(outcome.pkg).toBe("proj-a");
  expect(outcome.repo).toBe(a.repo);
  expect(outcome.reason).toMatch(/resolvable/i);
  expect(log.filter((l) => l.startsWith("resolve:")).length).toBe(3);
  expect(log.filter((l) => l.startsWith("sleep:")).length).toBe(2);
});

test("re-classifies after each publish rather than trusting the initial order", async () => {
  const a = entry({ pkg: "proj-a" });
  const b = entry({ pkg: "proj-b", depBumps: { "proj-a": "^1.0.1" } });
  const c = entry({
    pkg: "proj-c",
    depBumps: { "proj-a": "^1.0.1", "proj-b": "^1.0.1" },
  });
  // Listed in reverse dependency order — a correct implementation must
  // recompute readiness with classifyPr each pass, not walk this array.
  const entries = [c, b, a];
  const prs = new Map([
    [a.repo, 601],
    [b.repo, 602],
    [c.repo, 603],
  ]);
  const { deps } = makeDeps({});

  const outcome = await runTrain(entries, prs, deps);

  expect(outcome.status).toBe("success");
  if (outcome.status !== "success") throw new Error("expected success");
  expect(outcome.merged.map((m) => m.pkg)).toEqual(["proj-a", "proj-b", "proj-c"]);
});

test("an independently-ready branch merges without waiting on an unrelated dependency chain", () =>
  (async () => {
    const a = entry({ pkg: "proj-a" });
    const x = entry({ pkg: "proj-x" }); // unrelated to a/b, ready immediately
    const b = entry({ pkg: "proj-b", depBumps: { "proj-a": "^1.0.1" } });
    const entries = [b, x, a];
    const prs = new Map([
      [a.repo, 701],
      [x.repo, 702],
      [b.repo, 703],
    ]);
    const { deps } = makeDeps({});

    const outcome = await runTrain(entries, prs, deps);

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("expected success");
    const pkgs = outcome.merged.map((m) => m.pkg);
    expect(pkgs).toContain("proj-a");
    expect(pkgs).toContain("proj-x");
    expect(pkgs).toContain("proj-b");
    expect(pkgs.indexOf("proj-b")).toBeGreaterThan(pkgs.indexOf("proj-a"));
  })());

test("stalls loudly when no open PR is recorded for a ready entry", async () => {
  const a = entry({ pkg: "proj-a" });
  const entries = [a];
  const prs = new Map<string, number>();
  const { deps } = makeDeps({});

  const outcome = await runTrain(entries, prs, deps);

  expect(outcome.status).toBe("stalled");
  if (outcome.status !== "stalled") throw new Error("expected stalled");
  expect(outcome.pkg).toBe("proj-a");
  expect(outcome.reason).toMatch(/no open pr/i);
});
