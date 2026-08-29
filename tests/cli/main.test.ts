import { test, expect } from "bun:test";
import { runCli, type CliDeps } from "../../src/cli/main";
import type { PrepareResult } from "../../src/prepare/types";

function deps(over: Partial<CliDeps> = {}): CliDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (l: string) => lines.push(l),
    prepare: async (repo) => ({ repo, ready: true, mechanism: "auto-merge", blockers: [] }) as PrepareResult,
    plan: async () => ({ changed: "@acme/design", affected: ["@acme/design"], levels: [["@acme/design"]], changeset: [], skipped: [] }),
    ...over,
  };
}

test("prepare reports a ready repo and exits 0", async () => {
  const d = deps();
  expect(await runCli(["prepare", "acme/lib"], d)).toBe(0);
  expect(d.lines.join("\n")).toMatch(/acme\/lib.*ready/i);
});

test("prepare exits non-zero and prints every blocker when a repo is not ready", async () => {
  const d = deps({
    prepare: async (repo) => ({
      repo, ready: false, mechanism: "auto-merge",
      blockers: ["missing workflow", "no required check"],
    }),
  });
  expect(await runCli(["prepare", "acme/lib"], d)).not.toBe(0);
  expect(d.lines.join("\n")).toContain("missing workflow");
  expect(d.lines.join("\n")).toContain("no required check");
});

test("prepare exits non-zero for a control-plane repo, naming why it cannot take part yet", async () => {
  // ready:true / mechanism:"control-plane" is a real, distinct state: the probe
  // found no blockers, but the fallback mechanism (control-plane merge) is not
  // implemented yet, so the repo cannot actually take part in a cascade today.
  // Printing "ready" here is the exact contradiction plan's own gate rejects.
  const d = deps({
    prepare: async (repo) => ({ repo, ready: true, mechanism: "control-plane", blockers: [] }),
  });
  const code = await runCli(["prepare", "acme/private-lib"], d);
  expect(code).not.toBe(0);
  const out = d.lines.join("\n");
  expect(out).toContain("acme/private-lib");
  expect(out).toMatch(/control-plane/);
});

test("plan prints the levels in dependency order", async () => {
  const d = deps({
    plan: async () => ({
      changed: "@acme/design", affected: ["@acme/design", "@acme/components"],
      levels: [["@acme/design"], ["@acme/components"]], changeset: [], skipped: [],
    }),
  });
  expect(await runCli(["plan", "@acme/design", "--all"], d)).toBe(0);
  const out = d.lines.join("\n");
  expect(out.indexOf("@acme/design")).toBeLessThan(out.indexOf("@acme/components"));
  // An empty `skipped` array must print no heading at all.
  expect(out).not.toContain("skipped repositories");
});

test("plan surfaces skipped repos rather than hiding them", async () => {
  const d = deps({
    plan: async () => ({
      changed: "@acme/design", affected: [], levels: [], changeset: [],
      skipped: [{ repo: "acme/broken", reason: "unparseable manifest" }],
    }),
  });
  await runCli(["plan", "@acme/design", "--all"], d);
  expect(d.lines.join("\n")).toContain("acme/broken");
});

test("plan without --all or --targets refuses", async () => {
  const d = deps();
  expect(await runCli(["plan", "@acme/design"], d)).not.toBe(0);
  expect(d.lines.join("\n")).toMatch(/--all|--targets/);
});

test("plan with both --all and --targets refuses", async () => {
  const d = deps();
  expect(await runCli(["plan", "@acme/design", "--all", "--targets", "x"], d)).not.toBe(0);
});

test("plan with a --targets value that parses to zero entries refuses at the CLI layer", async () => {
  const d = deps();
  // ",,," and " , " are truthy and not flag-shaped, so a naive check lets them
  // through; after filtering they must not be silently treated as "no targets".
  expect(await runCli(["plan", "@acme/design", "--targets", ",,,"], d)).not.toBe(0);
  expect(d.lines.join("\n")).toMatch(/--targets/);
  // Never reaches the injected plan function — refused before that.
});

test("a thrown scoping error from deps.plan is reported cleanly, not as an unhandled rejection", async () => {
  const d = deps({
    plan: async () => {
      throw new Error("targets do not cover the full affected set, missing: @acme/components");
    },
  });
  expect(await runCli(["plan", "@acme/design", "--all"], d)).not.toBe(0);
  expect(d.lines.join("\n")).toContain("targets do not cover the full affected set");
});

test("a thrown error from deps.prepare is reported cleanly, not as an unhandled rejection", async () => {
  const d = deps({
    prepare: async () => {
      throw new Error("no such repository: acme/lib");
    },
  });
  expect(await runCli(["prepare", "acme/lib"], d)).not.toBe(0);
  expect(d.lines.join("\n")).toContain("no such repository: acme/lib");
});

test("an unknown command exits non-zero with usage", async () => {
  const d = deps();
  expect(await runCli(["frobnicate"], d)).not.toBe(0);
  expect(d.lines.join("\n")).toMatch(/usage/i);
});
