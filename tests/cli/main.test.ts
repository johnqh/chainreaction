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

test("an unknown command exits non-zero with usage", async () => {
  const d = deps();
  expect(await runCli(["frobnicate"], d)).not.toBe(0);
  expect(d.lines.join("\n")).toMatch(/usage/i);
});
