import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanRepos } from "../../src/graph/resolver";

// Covers fix #1 from the Task 2 review: a corrupted package.json must not
// silently vanish from the publish plan — scanRepos should still skip it
// (a bad manifest can't be a graph node), but it must warn on stderr so the
// gap is visible instead of reading as "this repo has no dependents".

test("scanRepos skips an unparseable manifest but warns to stderr, naming the file", () => {
  const root = mkdtempSync(join(tmpdir(), "cr-warn-"));

  mkdirSync(join(root, "broken_repo"), { recursive: true });
  const brokenManifest = join(root, "broken_repo", "package.json");
  writeFileSync(brokenManifest, "{ not valid json");

  mkdirSync(join(root, "good_repo"), { recursive: true });
  writeFileSync(
    join(root, "good_repo", "package.json"),
    JSON.stringify({ name: "@sudobility/good", version: "1.0.0" }),
  );

  const originalError = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };

  let graph;
  try {
    graph = scanRepos(root);
  } finally {
    console.error = originalError;
  }

  // The corrupted repo never entered the graph...
  expect(graph.size).toBe(1);
  expect(graph.has("@sudobility/good")).toBe(true);

  // ...but a warning naming the offending manifest was emitted.
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const warned = calls.some((args) =>
    args.some((a) => typeof a === "string" && a.includes(brokenManifest)),
  );
  expect(warned).toBe(true);
});
