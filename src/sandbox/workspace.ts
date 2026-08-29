import { mkdirSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { ChangesetEntry } from "../graph/types";

export type Runner = (
  cmd: string[],
  cwd: string,
) => Promise<{ code: number; output: string }>;

export interface ValidationResult {
  pkg: string;
  ok: boolean;
  output: string;
}

export const memberDir = (entry: { repo: string }) => `repos/${entry.repo.split("/")[1]}`;

export function applyEntry(entry: ChangesetEntry, manifest: any): any {
  const next = structuredClone(manifest);
  next.version = entry.toVersion;
  for (const [dep, range] of Object.entries(entry.depBumps)) {
    let applied = false;
    if (next.dependencies?.[dep]) {
      next.dependencies[dep] = range;
      applied = true;
    }
    if (next.peerDependencies?.[dep]) {
      next.peerDependencies[dep] = range;
      applied = true;
    }
    if (next.devDependencies?.[dep]) {
      next.devDependencies[dep] = range;
      applied = true;
    }
    // A depBumps key that lands in none of the three blocks is indistinguishable
    // from success unless it throws: the manifest gets committed, CI installs
    // whatever range was already there, and every downstream badge still reads
    // "ready" because classifyPr trusts the plan, not the manifest it produced.
    if (!applied) {
      throw new Error(
        `applyEntry: ${entry.pkg} (${entry.repo}) has a depBumps entry for "${dep}" that appears in ` +
          `none of dependencies, peerDependencies, or devDependencies`,
      );
    }
  }
  return next;
}

export function buildWorkspaceRoot(
  entries: ChangesetEntry[],
  dest: string,
): void {
  mkdirSync(dest, { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify(
      { name: "chainreaction-validation", private: true, workspaces: entries.map(memberDir) },
      null,
      2,
    ),
  );
}

export function assertLinked(
  dest: string,
  entries: ChangesetEntry[],
  isSymlink: (p: string) => boolean = (p) =>
    lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false,
): void {
  const unlinked: string[] = [];
  const inSubgraph = new Set(entries.map((e) => e.pkg));
  for (const entry of entries) {
    for (const dep of Object.keys(entry.depBumps)) {
      if (!inSubgraph.has(dep)) continue;
      const link = join(dest, memberDir(entry), "node_modules", dep);
      if (!isSymlink(link)) unlinked.push(`${entry.pkg} -> ${dep}`);
    }
  }
  if (unlinked.length > 0) {
    throw new Error(
      `validation would be a lie: these edges resolved to the registry, not the workspace: ${unlinked.join(", ")}`,
    );
  }
}

export async function validate(
  dest: string,
  entries: ChangesetEntry[],
  run: Runner,
): Promise<ValidationResult[]> {
  const install = await run(["bun", "install"], dest);
  if (install.code !== 0) {
    throw new Error(`workspace install failed: ${install.output}`);
  }

  assertLinked(dest, entries);

  const results: ValidationResult[] = [];
  for (const entry of entries) {
    const cwd = join(dest, memberDir(entry));
    const built = await run(["bun", "run", "build"], cwd);
    const tested = built.code === 0 ? await run(["bun", "test"], cwd) : built;
    results.push({ pkg: entry.pkg, ok: tested.code === 0, output: tested.output });
  }
  return results;
}
