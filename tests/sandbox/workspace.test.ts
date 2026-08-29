import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyEntry, buildWorkspaceRoot, validate, assertLinked } from "../../src/sandbox/workspace";
import type { ChangesetEntry } from "../../src/graph/types";

const entries: ChangesetEntry[] = [
  { pkg: "@acme/design", dir: "/design_system", repo: "acme/design_system",
    fromVersion: "1.1.49", toVersion: "1.1.50", depBumps: {}, level: 0 },
  { pkg: "@acme/components", dir: "/mail_box_components", repo: "acme/mail_box_components",
    fromVersion: "5.3.13", toVersion: "5.3.14",
    depBumps: { "@acme/design": "^1.1.50" }, level: 1 },
];

test("applyEntry writes the new version and rewrites only in-subgraph dep ranges", () => {
  const manifest = {
    name: "@acme/components", version: "5.3.13",
    dependencies: { "@acme/design": "^1.1.49", react: "^18.0.0" },
  };
  const out = applyEntry(entries[1]!, manifest);
  expect(out.version).toBe("5.3.14");
  expect(out.dependencies["@acme/design"]).toBe("^1.1.50");
  expect(out.dependencies.react).toBe("^18.0.0");
});

test("applyEntry does not mutate its input", () => {
  const manifest = { name: "x", version: "5.3.13", dependencies: { "@acme/design": "^1.1.49" } };
  applyEntry(entries[1]!, manifest);
  expect(manifest.version).toBe("5.3.13");
});

test("buildWorkspaceRoot writes a private root listing every member", () => {
  const dest = mkdtempSync(join(tmpdir(), "cr-ws-"));
  buildWorkspaceRoot(entries, dest);
  const root = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
  expect(root.private).toBe(true);
  expect(root.workspaces).toEqual(["repos/design_system", "repos/mail_box_components"]);
});

test("validate reports per-package pass and failure from the runner", async () => {
  const dest = mkdtempSync(join(tmpdir(), "cr-val-"));
  for (const e of entries) {
    const d = join(dest, "repos", e.repo.split("/")[1]!);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: e.pkg, version: e.fromVersion }));
  }
  // Make the fixture honest: assertLinked runs for real inside validate(), so give it
  // a real symlink for the one in-subgraph edge (@acme/components -> @acme/design)
  // instead of bypassing the check.
  const componentsNodeModulesScope = join(dest, "repos", "mail_box_components", "node_modules", "@acme");
  mkdirSync(componentsNodeModulesScope, { recursive: true });
  symlinkSync(
    join(dest, "repos", "design_system"),
    join(componentsNodeModulesScope, "design"),
    "dir",
  );
  const results = await validate(dest, entries, async (cmd, cwd) => {
    if (cmd[0] === "bun" && cmd[1] === "install") return { code: 0, output: "installed" };
    return cwd.includes("mail_box_components")
      ? { code: 1, output: "TypeError: Button color missing" }
      : { code: 0, output: "ok" };
  });
  expect(results.map((r) => [r.pkg, r.ok])).toEqual([
    ["@acme/design", true],
    ["@acme/components", false],
  ]);
  expect(results[1]!.output).toContain("Button color missing");
});

test("validate throws when the workspace install fails", async () => {
  const dest = mkdtempSync(join(tmpdir(), "cr-val2-"));
  buildWorkspaceRoot(entries, dest);
  await expect(
    validate(dest, entries, async () => ({ code: 1, output: "lockfile conflict" })),
  ).rejects.toThrow(/workspace install failed/i);
});

test("assertLinked throws when an in-subgraph edge is not a symlink", () => {
  const dest = "/fake/dest";
  expect(() =>
    assertLinked(dest, entries, () => false),
  ).toThrow(/validation would be a lie/i);
});

test("assertLinked does not throw when every in-subgraph edge is a symlink", () => {
  const dest = "/fake/dest";
  expect(() => assertLinked(dest, entries, () => true)).not.toThrow();
});

test("assertLinked ignores dep bumps outside the changeset subgraph", () => {
  const dest = "/fake/dest";
  const withExternalDep: ChangesetEntry[] = [
    {
      pkg: "@acme/components", dir: "/mail_box_components", repo: "acme/mail_box_components",
      fromVersion: "5.3.13", toVersion: "5.3.14",
      depBumps: { react: "^18.1.0" }, level: 0,
    },
  ];
  expect(() => assertLinked(dest, withExternalDep, () => false)).not.toThrow();
});
