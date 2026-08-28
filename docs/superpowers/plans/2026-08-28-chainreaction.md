# ChainReaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive a single change to an upstream `@sudobility/*` package all the way to every downstream consumer, with one human approval, via a self-propagating GitHub cascade the agent supervises.

**Architecture:** The core is plain TypeScript with no TrueForge dependency — a graph resolver, a changeset computer, a Bun-workspace validator, a GitHub orchestrator, and a supervisor state machine. TrueForge sits behind one thin adapter (Task 7) that exposes these as tools and raises interrupts. The cascade itself runs inside GitHub via `repository_dispatch` + auto-merge, so it survives the agent's process dying.

**Tech Stack:** Bun, TypeScript, `bun:test`, `gh` CLI, GitHub Actions, React + Vite, TrueForge.

**Spec:** `docs/superpowers/specs/2026-08-28-cascade-agent-design.md`

## Global Constraints

- Package manager is **Bun** everywhere. Never npm/yarn/pnpm for local work.
- **Every substantive change goes through a GitHub PR reviewed by Qodo before merge.** Never commit to `main`. This is a hackathon judging requirement — retrofitting PR history forfeits the Code Quality track.
- Build window closes **2026-08-30, 20:00 London**.
- Only `@sudobility/*` edges form the dependency graph. Ignore all other dependencies.
- Org is `johnqh` only. No cross-org support.
- The agent must never publish without an explicit target set — see Task 3's guard.
- Test runner is `bun test`. Test files are `*.test.ts` colocated under `tests/`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/graph/types.ts` | Shared types: `RepoNode`, `ChangesetEntry`, `NodeState` |
| `src/graph/resolver.ts` | Scan `~/projects`, build the DAG, compute affected subgraph + topological levels |
| `src/graph/changeset.ts` | Version bumping and dependency-range rewriting |
| `src/sandbox/workspace.ts` | Build an ephemeral Bun workspace root; run install + test across the subgraph |
| `src/github/client.ts` | Thin `gh` wrapper with injectable exec (makes everything above testable) |
| `src/github/orchestrator.ts` | Open PRs, sweep-approve, arm auto-merge |
| `src/supervisor/state.ts` | Node state machine + stall detection |
| `src/supervisor/poller.ts` | Poll `gh` for run/PR status, emit deltas |
| `src/mcp/server.ts` | Streamable-http MCP server exposing the four tools to TrueForge |
| `src/server/index.ts` | Bun HTTP server, SSE stream, approve endpoint |
| `src/web/App.tsx` | The one screen: DAG view, approve button, log drawer |

---

### Task 1: Prove the dispatch cascade (SPIKE — do this first)

Per spec §11, this is the riskiest mechanism and everything else depends on it. If a `repository_dispatch` from repo A cannot re-trigger and auto-merge a red PR in repo B, the architecture is wrong. Find out in hour two, not hour fifteen.

This spike deliberately does **not** involve npm. It isolates the GitHub mechanism: dispatch identity, workflow re-trigger, auto-merge. npm timing is a separate, smaller risk handled in Task 5.

**Files:**
- Create: two throwaway GitHub repos, `johnqh/cr-spike-a` and `johnqh/cr-spike-b`
- Create: `docs/spike-findings.md`

**Interfaces:**
- Consumes: nothing
- Produces: a confirmed answer to "does the cascade fire?", and the working dispatch YAML that Task 6 copies into `unified-cicd.yml`

- [ ] **Step 1: Create two throwaway repos**

```bash
cd /tmp && rm -rf cr-spike-a cr-spike-b
gh repo create johnqh/cr-spike-a --private --clone
gh repo create johnqh/cr-spike-b --private --clone
```

- [ ] **Step 2: Give repo B a workflow that runs on both PR and dispatch**

Create `/tmp/cr-spike-b/.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
  repository_dispatch:
    types: [upstream-published]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Gate on a sentinel file
        run: test -f READY || (echo "not ready" && exit 1)
```

Commit to `main`, push. Then enable branch protection so `--auto` is available:

```bash
cd /tmp/cr-spike-b
git add -A && git commit -m "ci: add gated workflow" && git push
gh api -X PUT repos/johnqh/cr-spike-b/branches/main/protection \
  -f 'required_status_checks[strict]=false' \
  -f 'required_status_checks[contexts][]=check' \
  -F 'enforce_admins=false' \
  -F 'required_pull_request_reviews=null' \
  -F 'restrictions=null'
gh api -X PATCH repos/johnqh/cr-spike-b -F allow_auto_merge=true
```

- [ ] **Step 3: Open a red PR in repo B and arm auto-merge**

```bash
cd /tmp/cr-spike-b
git checkout -b cascade-test
echo "consumer change" > consumer.txt
git add -A && git commit -m "feat: consumer change" && git push -u origin cascade-test
gh pr create --title "cascade test" --body "should go green on dispatch" --base main
gh pr merge --auto --squash
```

Confirm the PR check is **failing** (the `READY` sentinel does not exist yet). This is the "red by construction" state from spec §1.

- [ ] **Step 4: Add the sentinel to main so a re-run would pass**

```bash
cd /tmp/cr-spike-b && git checkout main
touch READY && git add -A && git commit -m "chore: mark ready" && git push
```

The open PR's check does **not** re-run on its own. That is the whole problem.

- [ ] **Step 5: Fire the dispatch from repo A and observe**

Create a fine-grained PAT with `contents: write` and `actions: write` on both spike repos, export as `CR_DISPATCH_TOKEN`, then:

```bash
curl -X POST \
  -H "Authorization: Bearer $CR_DISPATCH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/johnqh/cr-spike-b/dispatches \
  -d '{"event_type":"upstream-published"}'
```

- [ ] **Step 6: Record the finding**

Watch with `gh run list -R johnqh/cr-spike-b` and `gh pr view cascade-test -R johnqh/cr-spike-b`.

**Acceptance:** the dispatch triggers a run, the run passes, and the armed PR auto-merges with no human action.

Write `docs/spike-findings.md` recording: whether it fired, whether `repository_dispatch` re-evaluates the **PR branch** or only `main` (this is the critical unknown — a `repository_dispatch` run has no PR context, so it may not satisfy the PR's required check), the token scopes needed, and the working YAML.

- [ ] **Step 7: If the dispatch does not satisfy the PR check, fall back**

The likely failure: `repository_dispatch` runs against `main`, so it does not produce a check run attached to the open PR, and auto-merge never fires.

Fallback, which Task 6 will use instead: the dispatch payload carries the downstream PR number, and the workflow re-runs the PR's failed checks directly:

```yaml
on:
  repository_dispatch:
    types: [upstream-published]
jobs:
  rerun:
    runs-on: ubuntu-latest
    steps:
      - name: Re-run failed checks on the waiting PR
        env:
          GH_TOKEN: ${{ secrets.CR_DISPATCH_TOKEN }}
        run: |
          RUN_ID=$(gh run list -R ${{ github.repository }} \
            --branch "${{ github.event.client_payload.branch }}" \
            --limit 1 --json databaseId --jq '.[0].databaseId')
          gh run rerun "$RUN_ID" --failed
```

Record which path worked. **Task 6 depends on this answer.**

- [ ] **Step 8: Commit findings**

```bash
cd /Users/johnhuang/projects/chainreaction
git checkout -b spike/dispatch
git add docs/spike-findings.md
git commit -m "docs: record dispatch cascade spike findings"
git push -u origin spike/dispatch && gh pr create --fill
```

---

### Task 2: Graph resolver

**Files:**
- Create: `src/graph/types.ts`, `src/graph/resolver.ts`
- Test: `tests/graph/resolver.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface RepoNode { pkg: string; dir: string; repo: string; version: string; deps: string[] }`
  - `scanRepos(root: string): Map<string, RepoNode>`
  - `affectedSubgraph(graph: Map<string, RepoNode>, changed: string): Set<string>`
  - `topoLevels(graph: Map<string, RepoNode>, subset: Set<string>): string[][]`

- [ ] **Step 1: Scaffold the project**

```bash
cd /Users/johnhuang/projects/chainreaction
git checkout main 2>/dev/null || git checkout -b main
bun init -y
bun add -d typescript @types/bun
mkdir -p src/graph tests/graph
```

- [ ] **Step 2: Write the failing test**

Create `tests/graph/resolver.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanRepos, affectedSubgraph, topoLevels } from "../../src/graph/resolver";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cr-"));
  const write = (dir: string, pkg: object) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkg));
  };
  write("design_system", { name: "@sudobility/design", version: "1.1.49" });
  write("mail_box_components", {
    name: "@sudobility/components", version: "5.3.13",
    dependencies: { "@sudobility/design": "^1.1.49", react: "^18.0.0" },
  });
  write("di_web", {
    name: "@sudobility/di_web", version: "0.1.224",
    dependencies: { "@sudobility/components": "^5.3.13" },
  });
  write("sudobility", {
    name: "sudobility-landing", version: "1.0.96",
    dependencies: { "@sudobility/di_web": "^0.1.224", "@sudobility/design": "^1.1.49" },
  });
  write("unrelated", { name: "@sudobility/music_types", version: "1.0.0" });
  return root;
}

test("scanRepos maps package names to repo nodes and @sudobility deps only", () => {
  const g = scanRepos(fixture());
  expect(g.size).toBe(5);
  const components = g.get("@sudobility/components")!;
  expect(components.dir.endsWith("mail_box_components")).toBe(true);
  expect(components.repo).toBe("johnqh/mail_box_components");
  expect(components.version).toBe("5.3.13");
  expect(components.deps).toEqual(["@sudobility/design"]);
});

test("affectedSubgraph finds all transitive dependents, including the root", () => {
  const g = scanRepos(fixture());
  const affected = affectedSubgraph(g, "@sudobility/design");
  expect([...affected].sort()).toEqual([
    "@sudobility/components",
    "@sudobility/design",
    "@sudobility/di_web",
    "sudobility-landing",
  ]);
});

test("topoLevels orders dependencies before dependents", () => {
  const g = scanRepos(fixture());
  const levels = topoLevels(g, affectedSubgraph(g, "@sudobility/design"));
  expect(levels).toEqual([
    ["@sudobility/design"],
    ["@sudobility/components"],
    ["@sudobility/di_web"],
    ["sudobility-landing"],
  ]);
});

test("topoLevels throws on a dependency cycle", () => {
  const g = new Map([
    ["a", { pkg: "a", dir: "/a", repo: "johnqh/a", version: "1.0.0", deps: ["b"] }],
    ["b", { pkg: "b", dir: "/b", repo: "johnqh/b", version: "1.0.0", deps: ["a"] }],
  ]);
  expect(() => topoLevels(g, new Set(["a", "b"]))).toThrow(/cycle/i);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/graph/resolver.test.ts`
Expected: FAIL — cannot resolve `../../src/graph/resolver`.

- [ ] **Step 4: Write the types**

Create `src/graph/types.ts`:

```ts
export interface RepoNode {
  pkg: string;
  dir: string;
  repo: string;
  version: string;
  deps: string[];
}
```

- [ ] **Step 5: Implement the resolver**

Create `src/graph/resolver.ts`:

```ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { RepoNode } from "./types";

const SCOPE = "@sudobility/";
const ORG = "johnqh";

export function scanRepos(root: string): Map<string, RepoNode> {
  const graph = new Map<string, RepoNode>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;

    let pkg: any;
    try {
      pkg = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      continue; // an unparseable manifest is not a graph node
    }
    if (!pkg?.name) continue;

    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })
      .filter((d) => d.startsWith(SCOPE))
      .sort();

    graph.set(pkg.name, {
      pkg: pkg.name,
      dir,
      repo: `${ORG}/${basename(dir)}`,
      version: pkg.version ?? "0.0.0",
      deps,
    });
  }
  return graph;
}

export function affectedSubgraph(
  graph: Map<string, RepoNode>,
  changed: string,
): Set<string> {
  const affected = new Set<string>([changed]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of graph.values()) {
      if (affected.has(node.pkg)) continue;
      if (node.deps.some((d) => affected.has(d))) {
        affected.add(node.pkg);
        grew = true;
      }
    }
  }
  return affected;
}

export function topoLevels(
  graph: Map<string, RepoNode>,
  subset: Set<string>,
): string[][] {
  const remaining = new Set(subset);
  const levels: string[][] = [];

  while (remaining.size > 0) {
    const level = [...remaining]
      .filter((pkg) => {
        const node = graph.get(pkg);
        if (!node) return true; // not in graph => nothing to wait for
        return node.deps.every((d) => !remaining.has(d));
      })
      .sort();

    if (level.length === 0) {
      throw new Error(
        `dependency cycle among: ${[...remaining].sort().join(", ")}`,
      );
    }
    for (const pkg of level) remaining.delete(pkg);
    levels.push(level);
  }
  return levels;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/graph/resolver.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Verify against the real workspace**

```bash
bun -e 'import{scanRepos,affectedSubgraph,topoLevels}from"./src/graph/resolver";
const g=scanRepos("/Users/johnhuang/projects");
const a=affectedSubgraph(g,"@sudobility/design");
console.log("nodes:",g.size,"affected:",a.size);
console.log(topoLevels(g,a).map((l,i)=>`L${i}: ${l.length}`).join("\n"));'
```

Expected: ~120 nodes, **60 affected** (the 59 dependents plus `design` itself), and a level breakdown. If affected is not ~60, the resolver disagrees with the spec's headline number — stop and reconcile before continuing.

- [ ] **Step 8: Commit**

```bash
git checkout -b feat/graph-resolver
git add src/graph tests/graph package.json tsconfig.json
git commit -m "feat: dependency graph resolver with topological levels"
git push -u origin feat/graph-resolver && gh pr create --fill
```

---

### Task 3: Changeset computation and the scoping guard

**Files:**
- Create: `src/graph/changeset.ts`
- Modify: `src/graph/types.ts`
- Test: `tests/graph/changeset.test.ts`

**Interfaces:**
- Consumes: `RepoNode`, `scanRepos`, `affectedSubgraph`, `topoLevels` from Task 2
- Produces:
  - `interface ChangesetEntry { pkg: string; dir: string; repo: string; fromVersion: string; toVersion: string; depBumps: Record<string, string>; level: number }`
  - `bumpPatch(version: string): string`
  - `computeChangeset(graph, levels): ChangesetEntry[]`
  - `assertScoped(affected: Set<string>, targets: string[] | "all"): void`

- [ ] **Step 1: Write the failing test**

Create `tests/graph/changeset.test.ts`:

```ts
import { test, expect } from "bun:test";
import { bumpPatch, computeChangeset, assertScoped } from "../../src/graph/changeset";
import type { RepoNode } from "../../src/graph/types";

const graph = new Map<string, RepoNode>([
  ["@sudobility/design", { pkg: "@sudobility/design", dir: "/design_system", repo: "johnqh/design_system", version: "1.1.49", deps: [] }],
  ["@sudobility/components", { pkg: "@sudobility/components", dir: "/mail_box_components", repo: "johnqh/mail_box_components", version: "5.3.13", deps: ["@sudobility/design"] }],
]);

test("bumpPatch increments the patch segment", () => {
  expect(bumpPatch("1.1.49")).toBe("1.1.50");
  expect(bumpPatch("0.0.293")).toBe("0.0.294");
  expect(bumpPatch("5.3.9")).toBe("5.3.10");
});

test("bumpPatch rejects a non-semver version", () => {
  expect(() => bumpPatch("1.2")).toThrow(/semver/i);
});

test("computeChangeset bumps each package and rewrites in-subgraph dep ranges", () => {
  const levels = [["@sudobility/design"], ["@sudobility/components"]];
  const cs = computeChangeset(graph, levels);

  expect(cs[0]).toMatchObject({
    pkg: "@sudobility/design", fromVersion: "1.1.49", toVersion: "1.1.50",
    depBumps: {}, level: 0,
  });
  expect(cs[1]).toMatchObject({
    pkg: "@sudobility/components", fromVersion: "5.3.13", toVersion: "5.3.14",
    depBumps: { "@sudobility/design": "^1.1.50" }, level: 1,
  });
});

test("assertScoped rejects an unscoped run over a large affected set", () => {
  const affected = new Set(Array.from({ length: 60 }, (_, i) => `pkg-${i}`));
  expect(() => assertScoped(affected, [])).toThrow(/explicit target set/i);
});

test("assertScoped allows an explicit target list or an explicit all", () => {
  const affected = new Set(["a", "b"]);
  expect(() => assertScoped(affected, ["a"])).not.toThrow();
  expect(() => assertScoped(affected, "all")).not.toThrow();
});

test("assertScoped rejects a target that is not in the affected set", () => {
  expect(() => assertScoped(new Set(["a"]), ["zzz"])).toThrow(/not in the affected set/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/graph/changeset.test.ts`
Expected: FAIL — cannot resolve `../../src/graph/changeset`.

- [ ] **Step 3: Add the ChangesetEntry type**

Append to `src/graph/types.ts`:

```ts
export interface ChangesetEntry {
  pkg: string;
  dir: string;
  repo: string;
  fromVersion: string;
  toVersion: string;
  depBumps: Record<string, string>;
  level: number;
}
```

- [ ] **Step 4: Implement changeset computation**

Create `src/graph/changeset.ts`:

```ts
import type { RepoNode, ChangesetEntry } from "./types";

export function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a plain semver version: ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

export function computeChangeset(
  graph: Map<string, RepoNode>,
  levels: string[][],
): ChangesetEntry[] {
  const newVersions = new Map<string, string>();
  const entries: ChangesetEntry[] = [];

  levels.forEach((level, index) => {
    for (const pkg of level) {
      const node = graph.get(pkg);
      if (!node) continue;
      const toVersion = bumpPatch(node.version);
      newVersions.set(pkg, toVersion);

      const depBumps: Record<string, string> = {};
      for (const dep of node.deps) {
        const bumped = newVersions.get(dep);
        if (bumped) depBumps[dep] = `^${bumped}`;
      }

      entries.push({
        pkg, dir: node.dir, repo: node.repo,
        fromVersion: node.version, toVersion, depBumps, level: index,
      });
    }
  });
  return entries;
}

export function assertScoped(
  affected: Set<string>,
  targets: string[] | "all",
): void {
  if (targets === "all") return;
  if (targets.length === 0) {
    throw new Error(
      `refusing to run unscoped: ${affected.size} packages are affected. ` +
        `Pass an explicit target set or "all".`,
    );
  }
  const unknown = targets.filter((t) => !affected.has(t));
  if (unknown.length > 0) {
    throw new Error(`not in the affected set: ${unknown.join(", ")}`);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/graph/changeset.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/changeset
git add src/graph tests/graph
git commit -m "feat: changeset computation with scoping guard"
git push -u origin feat/changeset && gh pr create --fill
```

---

### Task 4: Bun-workspace sandbox validator

Rather than rewriting dependency ranges to `file:` overrides, build an ephemeral **Bun workspace root** whose members are the affected repos. Bun links workspace members by package name when the declared range is satisfied — and Task 3 already bumped versions so the ranges match. No override rewriting, no registry access.

**Files:**
- Create: `src/sandbox/workspace.ts`
- Test: `tests/sandbox/workspace.test.ts`

**Interfaces:**
- Consumes: `ChangesetEntry` from Task 3
- Produces:
  - `applyEntry(entry: ChangesetEntry, manifest: any): any`
  - `buildWorkspaceRoot(entries: ChangesetEntry[], dest: string): void`
  - `interface ValidationResult { pkg: string; ok: boolean; output: string }`
  - `validate(dest: string, entries: ChangesetEntry[], run: Runner): Promise<ValidationResult[]>`
  - `type Runner = (cmd: string[], cwd: string) => Promise<{ code: number; output: string }>`

- [ ] **Step 1: Write the failing test**

Create `tests/sandbox/workspace.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyEntry, buildWorkspaceRoot, validate } from "../../src/sandbox/workspace";
import type { ChangesetEntry } from "../../src/graph/types";

const entries: ChangesetEntry[] = [
  { pkg: "@sudobility/design", dir: "/design_system", repo: "johnqh/design_system",
    fromVersion: "1.1.49", toVersion: "1.1.50", depBumps: {}, level: 0 },
  { pkg: "@sudobility/components", dir: "/mail_box_components", repo: "johnqh/mail_box_components",
    fromVersion: "5.3.13", toVersion: "5.3.14",
    depBumps: { "@sudobility/design": "^1.1.50" }, level: 1 },
];

test("applyEntry writes the new version and rewrites only in-subgraph dep ranges", () => {
  const manifest = {
    name: "@sudobility/components", version: "5.3.13",
    dependencies: { "@sudobility/design": "^1.1.49", react: "^18.0.0" },
  };
  const out = applyEntry(entries[1], manifest);
  expect(out.version).toBe("5.3.14");
  expect(out.dependencies["@sudobility/design"]).toBe("^1.1.50");
  expect(out.dependencies.react).toBe("^18.0.0");
});

test("applyEntry does not mutate its input", () => {
  const manifest = { name: "x", version: "5.3.13", dependencies: { "@sudobility/design": "^1.1.49" } };
  applyEntry(entries[1], manifest);
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
    const d = join(dest, "repos", e.repo.split("/")[1]);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: e.pkg, version: e.fromVersion }));
  }
  const results = await validate(dest, entries, async (cmd, cwd) => {
    if (cmd[0] === "bun" && cmd[1] === "install") return { code: 0, output: "installed" };
    return cwd.includes("mail_box_components")
      ? { code: 1, output: "TypeError: Button color missing" }
      : { code: 0, output: "ok" };
  });
  expect(results.map((r) => [r.pkg, r.ok])).toEqual([
    ["@sudobility/design", true],
    ["@sudobility/components", false],
  ]);
  expect(results[1].output).toContain("Button color missing");
});

test("validate throws when the workspace install fails", async () => {
  const dest = mkdtempSync(join(tmpdir(), "cr-val2-"));
  buildWorkspaceRoot(entries, dest);
  await expect(
    validate(dest, entries, async () => ({ code: 1, output: "lockfile conflict" })),
  ).rejects.toThrow(/workspace install failed/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/sandbox/workspace.test.ts`
Expected: FAIL — cannot resolve `../../src/sandbox/workspace`.

- [ ] **Step 3: Implement the validator**

Create `src/sandbox/workspace.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
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

const memberDir = (entry: ChangesetEntry) => `repos/${entry.repo.split("/")[1]}`;

export function applyEntry(entry: ChangesetEntry, manifest: any): any {
  const next = structuredClone(manifest);
  next.version = entry.toVersion;
  for (const [dep, range] of Object.entries(entry.depBumps)) {
    if (next.dependencies?.[dep]) next.dependencies[dep] = range;
    if (next.peerDependencies?.[dep]) next.peerDependencies[dep] = range;
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

export async function validate(
  dest: string,
  entries: ChangesetEntry[],
  run: Runner,
): Promise<ValidationResult[]> {
  const install = await run(["bun", "install"], dest);
  if (install.code !== 0) {
    throw new Error(`workspace install failed: ${install.output}`);
  }

  const results: ValidationResult[] = [];
  for (const entry of entries) {
    const cwd = join(dest, memberDir(entry));
    const built = await run(["bun", "run", "build"], cwd);
    const tested = built.code === 0 ? await run(["bun", "test"], cwd) : built;
    results.push({ pkg: entry.pkg, ok: tested.code === 0, output: tested.output });
  }
  return results;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/sandbox/workspace.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: (ALREADY VERIFIED — read, do not re-run)**

The controller ran this against the real five-repo chain before Task 4 was dispatched. Bun 1.3.10, 1296 packages, 77s install, and **every intra-subgraph edge resolved to a symlink** into the local workspace member. No `overrides` / `file:` fallback is needed. Two behaviours differ from what this plan originally assumed, and both bind your implementation:

1. **Bun does not hoist workspace members to the root `node_modules`.** The root `node_modules/@sudobility` is *empty*; links live in each member's own `node_modules` (e.g. `repos/di_web/node_modules/@sudobility/components -> ../../../mail_box_components`). A check that looks only at the root will wrongly conclude linking failed.
2. **Linking is conditional on the declared range being satisfied by the local version.** If a range does not match, Bun silently installs the **registry** copy instead. The install still succeeds, and validation then tests published code rather than the changeset — a confident false PASS, which is worse than no validation at all.

Because of (2), `validate` gains a required assertion, and this is the reason it exists:

```ts
export function assertLinked(
  dest: string,
  entries: ChangesetEntry[],
  isSymlink: (p: string) => boolean,
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
```

Call it from `validate` immediately after the install succeeds and before any build or test runs. Inject `isSymlink` (default `(p) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false`) so it is testable without a real install.

Add a test asserting `assertLinked` throws when an edge is not a symlink, and does not throw when every edge is.

```bash
WS=/tmp/cr-manual && rm -rf $WS && mkdir -p $WS/repos
for r in design_system mail_box_components di_web building_blocks sudobility; do
  cp -R /Users/johnhuang/projects/$r $WS/repos/$r
  rm -rf $WS/repos/$r/node_modules $WS/repos/$r/.git
done
cat > $WS/package.json <<'JSON'
{ "name": "chainreaction-validation", "private": true,
  "workspaces": ["repos/design_system","repos/mail_box_components","repos/di_web","repos/building_blocks","repos/sudobility"] }
JSON
cd $WS && bun install
ls -la node_modules/@sudobility/design
```

**Acceptance:** `node_modules/@sudobility/design` is a **symlink** into `repos/design_system`, not a fetched tarball. If it is not, record why in `docs/spike-findings.md` and fall back to `overrides` with `file:` specifiers in the root manifest.

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/sandbox-validator
git add src/sandbox tests/sandbox docs/spike-findings.md
git commit -m "feat: bun workspace sandbox validator"
git push -u origin feat/sandbox-validator && gh pr create --fill
```

---

### Task 5: GitHub orchestrator

**Files:**
- Create: `src/github/client.ts`, `src/github/orchestrator.ts`
- Test: `tests/github/orchestrator.test.ts`

**Interfaces:**
- Consumes: `ChangesetEntry` from Task 3
- Produces:
  - `type Exec = (args: string[]) => Promise<string>`
  - `class GhClient { constructor(exec: Exec); openPr(repo, branch, title, body): Promise<number>; approve(repo, pr): Promise<void>; armAutoMerge(repo, pr): Promise<void>; prState(repo, pr): Promise<string> }`
  - `openChangesetPrs(entries: ChangesetEntry[], gh: GhClient, branch: string): Promise<Map<string, number>>`
  - `armAll(prs: Map<string, number>, entries: ChangesetEntry[], gh: GhClient): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/github/orchestrator.test.ts`:

```ts
import { test, expect } from "bun:test";
import { GhClient } from "../../src/github/client";
import { openChangesetPrs, armAll } from "../../src/github/orchestrator";
import type { ChangesetEntry } from "../../src/graph/types";

const entries: ChangesetEntry[] = [
  { pkg: "@sudobility/design", dir: "/design_system", repo: "johnqh/design_system",
    fromVersion: "1.1.49", toVersion: "1.1.50", depBumps: {}, level: 0 },
  { pkg: "@sudobility/components", dir: "/mail_box_components", repo: "johnqh/mail_box_components",
    fromVersion: "5.3.13", toVersion: "5.3.14",
    depBumps: { "@sudobility/design": "^1.1.50" }, level: 1 },
];

function recorder() {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    if (args.includes("create")) return "https://github.com/johnqh/x/pull/42\n";
    return "";
  };
  return { calls, exec };
}

test("openChangesetPrs opens one PR per entry and returns the PR numbers", async () => {
  const { calls, exec } = recorder();
  const prs = await openChangesetPrs(entries, new GhClient(exec), "cr/design-1.1.50");
  expect(prs.get("johnqh/design_system")).toBe(42);
  expect(prs.get("johnqh/mail_box_components")).toBe(42);
  expect(calls.filter((c) => c.includes("create")).length).toBe(2);
});

test("PR body names the version bump and the upstream cause", async () => {
  const { calls, exec } = recorder();
  await openChangesetPrs(entries, new GhClient(exec), "cr/design-1.1.50");
  const body = calls.find((c) => c.includes("create") && c.join(" ").includes("mail_box_components"))!
    .join(" ");
  expect(body).toContain("5.3.13 -> 5.3.14");
  expect(body).toContain("@sudobility/design");
});

test("armAll approves before arming auto-merge, for every PR", async () => {
  const { calls, exec } = recorder();
  const prs = new Map([["johnqh/design_system", 7], ["johnqh/mail_box_components", 8]]);
  await armAll(prs, entries, new GhClient(exec));

  const verbs = calls.filter((c) => c[0] === "pr").map((c) => `${c[1]}:${c[2] ?? ""}`);
  expect(verbs).toEqual(["review:--approve", "merge:--auto", "review:--approve", "merge:--auto"]);
});

test("prState parses the gh JSON response", async () => {
  const gh = new GhClient(async () => JSON.stringify({ state: "OPEN" }));
  expect(await gh.prState("johnqh/design_system", 7)).toBe("OPEN");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/github/orchestrator.test.ts`
Expected: FAIL — cannot resolve `../../src/github/client`.

- [ ] **Step 3: Implement the gh client**

Create `src/github/client.ts`:

```ts
export type Exec = (args: string[]) => Promise<string>;

export const realExec: Exec = async (args) => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${err}`);
  }
  return out;
};

export class GhClient {
  constructor(private exec: Exec) {}

  async openPr(repo: string, branch: string, title: string, body: string): Promise<number> {
    const out = await this.exec([
      "pr", "create", "-R", repo, "--head", branch, "--base", "main",
      "--title", title, "--body", body,
    ]);
    const m = /\/pull\/(\d+)/.exec(out);
    if (!m) throw new Error(`could not parse PR number from: ${out}`);
    return Number(m[1]);
  }

  async approve(repo: string, pr: number): Promise<void> {
    await this.exec(["pr", "review", "--approve", "-R", repo, String(pr)]);
  }

  async armAutoMerge(repo: string, pr: number): Promise<void> {
    await this.exec(["pr", "merge", "--auto", "--squash", "-R", repo, String(pr)]);
  }

  async prState(repo: string, pr: number): Promise<string> {
    const out = await this.exec([
      "pr", "view", String(pr), "-R", repo, "--json", "state",
    ]);
    return JSON.parse(out).state;
  }
}
```

- [ ] **Step 4: Implement the orchestrator**

Create `src/github/orchestrator.ts`:

```ts
import type { ChangesetEntry } from "../graph/types";
import type { GhClient } from "./client";

function prBody(entry: ChangesetEntry): string {
  const causes = Object.entries(entry.depBumps)
    .map(([dep, range]) => `- \`${dep}\` -> \`${range}\``)
    .join("\n");
  return [
    `Automated by ChainReaction.`,
    ``,
    `**Version:** ${entry.fromVersion} -> ${entry.toVersion}`,
    `**Cascade level:** ${entry.level}`,
    causes ? `\n**Upstream bumps:**\n${causes}` : `\nThis is the root of the cascade.`,
    ``,
    `Validated against the full affected subgraph in a Bun workspace before this PR was opened.`,
  ].join("\n");
}

export async function openChangesetPrs(
  entries: ChangesetEntry[],
  gh: GhClient,
  branch: string,
): Promise<Map<string, number>> {
  const prs = new Map<string, number>();
  for (const entry of entries) {
    const title = `chore: ${entry.pkg}@${entry.toVersion}`;
    prs.set(entry.repo, await gh.openPr(entry.repo, branch, title, prBody(entry)));
  }
  return prs;
}

export async function armAll(
  prs: Map<string, number>,
  entries: ChangesetEntry[],
  gh: GhClient,
): Promise<void> {
  for (const entry of entries) {
    const pr = prs.get(entry.repo);
    if (pr === undefined) continue;
    await gh.approve(entry.repo, pr);
    await gh.armAutoMerge(entry.repo, pr);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/github/orchestrator.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/github-orchestrator
git add src/github tests/github
git commit -m "feat: github orchestrator for changeset PRs"
git push -u origin feat/github-orchestrator && gh pr create --fill
```

---

### Task 6: Dispatch shim in the shared workflow

Added **once** in `~/projects/workflows`; all ~100 repos inherit it. Use whichever mechanism Task 1 proved.

**Files:**
- Modify: `/Users/johnhuang/projects/workflows/.github/workflows/unified-cicd.yml` — insert after the `"Publish to NPM"` step in the `release_npm` job
- Create: `src/github/dispatch.ts`
- Test: `tests/github/dispatch.test.ts`

**Interfaces:**
- Consumes: `ChangesetEntry` from Task 3, findings from Task 1
- Produces: `dependentsOf(entries: ChangesetEntry[], pkg: string): ChangesetEntry[]`, and the `cr-dispatch` workflow step

- [ ] **Step 1: Write the failing test for dependent lookup**

Create `tests/github/dispatch.test.ts`:

```ts
import { test, expect } from "bun:test";
import { dependentsOf } from "../../src/github/dispatch";
import type { ChangesetEntry } from "../../src/graph/types";

const entries: ChangesetEntry[] = [
  { pkg: "@sudobility/design", dir: "/d", repo: "johnqh/design_system",
    fromVersion: "1.1.49", toVersion: "1.1.50", depBumps: {}, level: 0 },
  { pkg: "@sudobility/components", dir: "/c", repo: "johnqh/mail_box_components",
    fromVersion: "5.3.13", toVersion: "5.3.14",
    depBumps: { "@sudobility/design": "^1.1.50" }, level: 1 },
  { pkg: "@sudobility/di_web", dir: "/w", repo: "johnqh/di_web",
    fromVersion: "0.1.224", toVersion: "0.1.225",
    depBumps: { "@sudobility/components": "^5.3.14" }, level: 2 },
];

test("dependentsOf returns only direct dependents", () => {
  expect(dependentsOf(entries, "@sudobility/design").map((e) => e.repo))
    .toEqual(["johnqh/mail_box_components"]);
});

test("dependentsOf returns empty for a leaf", () => {
  expect(dependentsOf(entries, "@sudobility/di_web")).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/github/dispatch.test.ts`
Expected: FAIL — cannot resolve `../../src/github/dispatch`.

- [ ] **Step 3: Implement dependent lookup**

Create `src/github/dispatch.ts`:

```ts
import type { ChangesetEntry } from "../graph/types";

export function dependentsOf(
  entries: ChangesetEntry[],
  pkg: string,
): ChangesetEntry[] {
  return entries.filter((e) => Object.hasOwn(e.depBumps, pkg));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/github/dispatch.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Add the dispatch step to the shared workflow**

In `/Users/johnhuang/projects/workflows/.github/workflows/unified-cicd.yml`, insert immediately **after** the `- name: "Publish to NPM"` step and **before** `- name: "Notify deployment success"`:

```yaml
      - name: "ChainReaction: notify dependents"
        if: steps.check-secrets.outputs.configured == 'true' && steps.check-npm-version.outputs.version_exists != 'true'
        continue-on-error: true
        env:
          CR_TOKEN: ${{ secrets.CR_DISPATCH_TOKEN }}
        run: |
          if [ -z "$CR_TOKEN" ]; then
            echo "ℹ️  CR_DISPATCH_TOKEN not set, skipping cascade notification"
            exit 0
          fi
          if [ ! -f .chainreaction.json ]; then
            echo "ℹ️  no .chainreaction.json in this repo, not part of an active cascade"
            exit 0
          fi
          PKG='${{ needs.check_for_release.outputs.package_name }}'
          VER='${{ needs.check_for_release.outputs.version }}'
          jq -c '.dependents[]' .chainreaction.json | while read -r dep; do
            REPO=$(echo "$dep" | jq -r '.repo')
            BRANCH=$(echo "$dep" | jq -r '.branch')
            echo "📡 dispatching to $REPO (branch $BRANCH)"
            curl -sS -X POST \
              -H "Authorization: Bearer $CR_TOKEN" \
              -H "Accept: application/vnd.github+json" \
              "https://api.github.com/repos/$REPO/dispatches" \
              -d "{\"event_type\":\"upstream-published\",\"client_payload\":{\"package\":\"$PKG\",\"version\":\"$VER\",\"branch\":\"$BRANCH\"}}"
          done
```

`continue-on-error: true` is deliberate: a cascade notification failure must never break an ordinary release for the other ~100 repos that are not part of a cascade. The `.chainreaction.json` guard is what keeps this inert outside a cascade — the orchestrator writes that file into each PR branch and it never reaches `main`.

- [ ] **Step 6: Add the receiving trigger — re-run path (CONFIRMED REQUIRED)**

The Task 1 spike settled this empirically: a `repository_dispatch` run carries **no PR association**. Its check attaches to `main`'s SHA, never the PR head, so the waiting PR stays red and auto-merge never fires. Measured on `johnqh/cr-spike-b`: the dispatch run *succeeded* on `main` while the PR check remained `FAILURE`. The re-run path is the design, not a contingency. See `docs/spike-findings.md` §1.

Because callers use `workflow_call`, the `repository_dispatch` trigger must live in each repo's **stub**, not in `unified-cicd.yml`. Add to the five demo repos now, and to the stub template Task 9 documents:

```yaml
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]
  repository_dispatch:
    types: [upstream-published]

jobs:
  cicd:
    if: github.event_name != 'repository_dispatch'
    uses: johnqh/workflows/.github/workflows/unified-cicd.yml@main
    with:
      npm-access: "public"
    secrets: inherit

  cascade_rerun:
    if: github.event_name == 'repository_dispatch'
    runs-on: ubuntu-latest
    steps:
      - name: Wait for the upstream version to be resolvable on npm
        env:
          PKG: ${{ github.event.client_payload.package }}
          VER: ${{ github.event.client_payload.version }}
        run: |
          for i in $(seq 1 30); do
            if npm view "$PKG@$VER" version >/dev/null 2>&1; then
              echo "resolvable after $((i*10))s"; exit 0
            fi
            echo "waiting for $PKG@$VER ($((i*10))s)"; sleep 10
          done
          echo "::error::$PKG@$VER never became resolvable"; exit 1

      - name: Re-run the waiting PR's own failed checks
        env:
          GH_TOKEN: ${{ secrets.CR_DISPATCH_TOKEN }}
          BRANCH: ${{ github.event.client_payload.branch }}
        run: |
          RUN_ID=$(gh run list -R "${{ github.repository }}" \
            --branch "$BRANCH" --event pull_request \
            --limit 1 --json databaseId --jq '.[0].databaseId')
          if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
            echo "::error::no pull_request run found for $BRANCH"; exit 1
          fi
          gh run rerun "$RUN_ID" --failed
```

**The wait step is not optional, and its placement is the point.** `unified-cicd.yml`'s existing `check-npm-version` step compares the local version against `npm view <pkg> version` only to decide whether to publish — it is an idempotency guard, **not** a propagation wait, and nothing else in that pipeline waits for anything. If the rerun fires before the upstream version is resolvable, the downstream `bun install` fails against a version that does not exist yet, the PR goes red for a reason unrelated to the change, and the cascade stalls on the exact race this design exists to eliminate. Waiting *before* triggering the rerun means the rerun only ever starts against an installable dependency.

Both failure paths `exit 1`, never `exit 0`. A cascade that cannot proceed must fail loudly: a silent success here produces a stalled chain that looks healthy, which is the worst failure mode in this system.

Two further consequences of the spike, both binding:

- `client_payload` must carry `branch`, `package`, and `version`. The sender in Step 5 already sends all three; without `branch` the handler cannot find the run, and without `package`/`version` it cannot wait.
- `CR_DISPATCH_TOKEN` needs **`actions: write`** in addition to `contents: write`. A `contents`-only token fires the dispatch and then silently fails to re-run anything.

- [ ] **Step 7: Verify on the spike repos, then commit**

Re-run the Task 1 acceptance against the real shim. Then:

```bash
cd /Users/johnhuang/projects/workflows
git checkout -b feat/chainreaction-dispatch
git add .github/workflows/unified-cicd.yml
git commit -m "feat: notify downstream dependents after npm publish"
git push -u origin feat/chainreaction-dispatch && gh pr create --fill
```

Answering spec §12 Q2: yes, this goes through a PR like everything else — it is the highest-blast-radius change in the project, touching every repo's CI.

---

### Task 7: Supervisor state machine

**Files:**
- Create: `src/supervisor/state.ts`
- Test: `tests/supervisor/state.test.ts`

**Interfaces:**
- Consumes: `ChangesetEntry` from Task 3
- Produces:
  - `type NodeState = "pending" | "validated" | "pr-open" | "ci-running" | "merged" | "published" | "stalled"`
  - `class Cascade { constructor(entries: ChangesetEntry[]); set(pkg, state): void; get(pkg): NodeState; stalled(): string[]; isComplete(): boolean; snapshot(): CascadeSnapshot }`
  - `detectStall(cascade: Cascade, now: number, lastChange: Map<string, number>, timeoutMs: number): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/supervisor/state.test.ts`:

```ts
import { test, expect } from "bun:test";
import { Cascade, detectStall } from "../../src/supervisor/state";
import type { ChangesetEntry } from "../../src/graph/types";

const entries: ChangesetEntry[] = [
  { pkg: "a", dir: "/a", repo: "johnqh/a", fromVersion: "1.0.0", toVersion: "1.0.1", depBumps: {}, level: 0 },
  { pkg: "b", dir: "/b", repo: "johnqh/b", fromVersion: "1.0.0", toVersion: "1.0.1", depBumps: { a: "^1.0.1" }, level: 1 },
];

test("every node starts pending", () => {
  const c = new Cascade(entries);
  expect(c.get("a")).toBe("pending");
  expect(c.isComplete()).toBe(false);
});

test("cascade is complete only when every node is published", () => {
  const c = new Cascade(entries);
  c.set("a", "published");
  expect(c.isComplete()).toBe(false);
  c.set("b", "published");
  expect(c.isComplete()).toBe(true);
});

test("stalled nodes are reported", () => {
  const c = new Cascade(entries);
  c.set("b", "stalled");
  expect(c.stalled()).toEqual(["b"]);
});

test("snapshot exposes nodes and edges for the UI", () => {
  const c = new Cascade(entries);
  c.set("a", "published");
  const s = c.snapshot();
  expect(s.nodes).toEqual([
    { pkg: "a", repo: "johnqh/a", level: 0, version: "1.0.1", state: "published" },
    { pkg: "b", repo: "johnqh/b", level: 1, version: "1.0.1", state: "pending" },
  ]);
  expect(s.edges).toEqual([{ from: "a", to: "b" }]);
});

test("detectStall flags a node stuck in ci-running past the timeout", () => {
  const c = new Cascade(entries);
  c.set("b", "ci-running");
  const last = new Map([["b", 1_000]]);
  expect(detectStall(c, 1_000 + 20 * 60_000, last, 15 * 60_000)).toEqual(["b"]);
  expect(detectStall(c, 1_000 + 5 * 60_000, last, 15 * 60_000)).toEqual([]);
});

test("detectStall ignores terminal states", () => {
  const c = new Cascade(entries);
  c.set("b", "published");
  const last = new Map([["b", 0]]);
  expect(detectStall(c, 9_999_999, last, 1_000)).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/supervisor/state.test.ts`
Expected: FAIL — cannot resolve `../../src/supervisor/state`.

- [ ] **Step 3: Implement the state machine**

Create `src/supervisor/state.ts`:

```ts
import type { ChangesetEntry } from "../graph/types";

export type NodeState =
  | "pending" | "validated" | "pr-open" | "ci-running"
  | "merged" | "published" | "stalled";

const TERMINAL: NodeState[] = ["published", "stalled"];

export interface CascadeSnapshot {
  nodes: { pkg: string; repo: string; level: number; version: string; state: NodeState }[];
  edges: { from: string; to: string }[];
}

export class Cascade {
  private states = new Map<string, NodeState>();

  constructor(private entries: ChangesetEntry[]) {
    for (const e of entries) this.states.set(e.pkg, "pending");
  }

  set(pkg: string, state: NodeState): void {
    if (!this.states.has(pkg)) throw new Error(`unknown package: ${pkg}`);
    this.states.set(pkg, state);
  }

  get(pkg: string): NodeState {
    const s = this.states.get(pkg);
    if (!s) throw new Error(`unknown package: ${pkg}`);
    return s;
  }

  stalled(): string[] {
    return [...this.states.entries()]
      .filter(([, s]) => s === "stalled")
      .map(([pkg]) => pkg);
  }

  isComplete(): boolean {
    return [...this.states.values()].every((s) => s === "published");
  }

  snapshot(): CascadeSnapshot {
    const nodes = this.entries.map((e) => ({
      pkg: e.pkg, repo: e.repo, level: e.level,
      version: e.toVersion, state: this.get(e.pkg),
    }));
    const edges = this.entries.flatMap((e) =>
      Object.keys(e.depBumps).map((from) => ({ from, to: e.pkg })),
    );
    return { nodes, edges };
  }
}

export function detectStall(
  cascade: Cascade,
  now: number,
  lastChange: Map<string, number>,
  timeoutMs: number,
): string[] {
  return [...lastChange.entries()]
    .filter(([pkg, at]) => {
      const state = cascade.get(pkg);
      return !TERMINAL.includes(state) && now - at > timeoutMs;
    })
    .map(([pkg]) => pkg);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/supervisor/state.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/supervisor-state
git add src/supervisor tests/supervisor
git commit -m "feat: cascade state machine with stall detection"
git push -u origin feat/supervisor-state && gh pr create --fill
```

---

### Task 8: Server, SSE, and the DAG screen

**Files:**
- Create: `src/server/index.ts`, `src/web/App.tsx`, `src/web/index.html`, `src/web/main.tsx`
- Create: `src/supervisor/poller.ts`

**Interfaces:**
- Consumes: `Cascade`, `CascadeSnapshot`, `detectStall` from Task 7; `GhClient` from Task 5
- Produces: `GET /api/state` (SSE stream of `CascadeSnapshot`), `POST /api/approve`

- [ ] **Step 1: Write the poller**

Create `src/supervisor/poller.ts`:

```ts
import type { ChangesetEntry } from "../graph/types";
import type { GhClient } from "../github/client";
import { Cascade, detectStall, type NodeState } from "./state";

const STALL_TIMEOUT_MS = 15 * 60_000;

export async function pollOnce(
  cascade: Cascade,
  entries: ChangesetEntry[],
  prs: Map<string, number>,
  gh: GhClient,
  lastChange: Map<string, number>,
  now: number = Date.now(),
): Promise<void> {
  for (const entry of entries) {
    const pr = prs.get(entry.repo);
    if (pr === undefined) continue;

    const ghState = await gh.prState(entry.repo, pr);
    const next: NodeState = ghState === "MERGED" ? "merged" : "ci-running";
    if (cascade.get(entry.pkg) !== next) {
      cascade.set(entry.pkg, next);
      lastChange.set(entry.pkg, now);
    }
  }
  for (const pkg of detectStall(cascade, now, lastChange, STALL_TIMEOUT_MS)) {
    cascade.set(pkg, "stalled");
  }
}
```

- [ ] **Step 2: Write the server**

Create `src/server/index.ts`:

```ts
import { Cascade } from "../supervisor/state";
import type { ChangesetEntry } from "../graph/types";

export interface ServerDeps {
  cascade: Cascade;
  entries: ChangesetEntry[];
  onApprove: () => void;
}

export function createServer(deps: ServerDeps, port = 3737) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/state") {
        const stream = new ReadableStream({
          start(controller) {
            const send = () =>
              controller.enqueue(
                `data: ${JSON.stringify(deps.cascade.snapshot())}\n\n`,
              );
            send();
            const timer = setInterval(send, 2000);
            req.signal.addEventListener("abort", () => clearInterval(timer));
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }

      if (url.pathname === "/api/approve" && req.method === "POST") {
        deps.onApprove();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(Bun.file("src/web/index.html"));
    },
  });
}
```

- [ ] **Step 3: Write the DAG screen**

```bash
bun add react react-dom
bun add -d @types/react @types/react-dom
```

Create `src/web/App.tsx`:

```tsx
import { useEffect, useState } from "react";

type NodeState =
  | "pending" | "validated" | "pr-open" | "ci-running"
  | "merged" | "published" | "stalled";

interface Snapshot {
  nodes: { pkg: string; repo: string; level: number; version: string; state: NodeState }[];
  edges: { from: string; to: string }[];
}

const COLOR: Record<NodeState, string> = {
  pending: "#3a3a3a", validated: "#4a5568", "pr-open": "#2b6cb0",
  "ci-running": "#b7791f", merged: "#2c7a7b", published: "#2f855a", stalled: "#c53030",
};

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/state");
    es.onmessage = (e) => setSnap(JSON.parse(e.data));
    return () => es.close();
  }, []);

  if (!snap) return <div style={{ padding: 32, color: "#eee" }}>connecting…</div>;

  const levels = [...new Set(snap.nodes.map((n) => n.level))].sort((a, b) => a - b);
  const stalled = snap.nodes.filter((n) => n.state === "stalled");

  return (
    <div style={{ background: "#111", color: "#eee", minHeight: "100vh", padding: 32,
                  fontFamily: "ui-monospace, monospace" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>ChainReaction</h1>
      <p style={{ opacity: 0.6, marginBottom: 24 }}>
        {snap.nodes.length} packages · {snap.nodes.filter((n) => n.state === "published").length} published
        {stalled.length > 0 && ` · ${stalled.length} stalled`}
      </p>

      {!approved && (
        <button
          onClick={() => { fetch("/api/approve", { method: "POST" }); setApproved(true); }}
          style={{ background: "#2f855a", color: "#fff", border: 0, padding: "12px 24px",
                   fontSize: 16, borderRadius: 6, cursor: "pointer", marginBottom: 32 }}
        >
          Approve changeset ({snap.nodes.length} repos)
        </button>
      )}

      {levels.map((level) => (
        <div key={level} style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
          <span style={{ opacity: 0.4, width: 32 }}>L{level}</span>
          {snap.nodes.filter((n) => n.level === level).map((n) => (
            <div key={n.pkg} title={`${n.repo} → ${n.version}`}
                 style={{ background: COLOR[n.state], padding: "8px 14px", borderRadius: 6,
                          fontSize: 13, transition: "background 400ms" }}>
              {n.pkg.replace("@sudobility/", "")}
              <span style={{ opacity: 0.65, marginLeft: 8 }}>{n.state}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

Create `src/web/main.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);
```

Create `src/web/index.html`:

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>ChainReaction</title></head>
<body style="margin:0"><div id="root"></div>
<script type="module" src="./main.tsx"></script></body></html>
```

- [ ] **Step 4: Verify against a fake cascade**

```bash
bun -e 'import{Cascade}from"./src/supervisor/state";
import{createServer}from"./src/server/index";
const entries=[
 {pkg:"@sudobility/design",dir:"/d",repo:"johnqh/design_system",fromVersion:"1.1.49",toVersion:"1.1.50",depBumps:{},level:0},
 {pkg:"@sudobility/components",dir:"/c",repo:"johnqh/mail_box_components",fromVersion:"5.3.13",toVersion:"5.3.14",depBumps:{"@sudobility/design":"^1.1.50"},level:1}];
const c=new Cascade(entries);
createServer({cascade:c,entries,onApprove:()=>console.log("approved")});
let i=0;const seq=["validated","pr-open","ci-running","merged","published"];
setInterval(()=>{if(i<seq.length){c.set("@sudobility/design",seq[i]);i++}},2000);
console.log("http://localhost:3737");'
```

Open `http://localhost:3737`. Expected: the `design` node walks through the state colors, the approve button posts once.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/web-dag
git add src/server src/web src/supervisor/poller.ts package.json
git commit -m "feat: SSE server and DAG cascade view"
git push -u origin feat/web-dag && gh pr create --fill
```

---

### Task 9: TrueForge adapter, demo rehearsal, and deliverables

The TrueForge SDK surface has not been verified first-hand — the published summary is second-hand. Pin it here, against the installed package, and keep it confined to one file.

**Files:**
- Create: `src/harness/agent.ts`, `README.md`, `.env.example`
- Modify: `docs/spike-findings.md`

**Interfaces:**
- Consumes: everything from Tasks 2–8
- Produces: a runnable agent and the hackathon submission

- [ ] **Step 1: (ALREADY VERIFIED — read, do not re-probe)**

The controller probed `@truefoundry/trueforge-sdk@0.1.3` directly from its shipped `.d.ts` files before this task was dispatched. The published docs summary was second-hand and **wrong on the central point**. What is actually true:

- The SDK is a Fern-generated REST client for a TrueForge **server**. There is no in-process agent runtime.
- `AgentSpec = { model, instructions?, mcpServers?, skills?, config?, responseFormat?, messages? }`. **There is no `tools` field.** Tools reach an agent only through MCP.
- `McpServerType` is `"remote"` **only**; transports are `streamable-http` | `sse`. **stdio is not supported.**
- `mcpServers` has no `create()` — servers are configured server-side (Settings → Connectors) and referenced by name from an `AgentSpec`.
- `McpServer.requireApprovalForTools` accepts `["@all" | "@write" | "@destructive" | <tool name>]` and **defaults to `["@write","@destructive"]`**.
- `sessions.createTurnStream()` returns `Stream<TurnStreamingEvent>` carrying `ToolApprovalRequiredEvent { type: "tool.approval_required", threadId, toolCalls: [{ id, sourceEventId }] }`.
- You answer an approval by posting a `TurnInputItem` via `sessions.createTurn()`: `UserToolApprovalEvent { type: "user.tool_approval", threadId, toolCallId, approval: { status: "allow" | "deny" } }`.

**Consequence: the in-process adapter this plan originally described is impossible.** ChainReaction must run its own **streamable-http MCP server**, registered once in TrueForge's connector settings and referenced by name.

Run TrueForge in **local mode** (`npx @truefoundry/trueforge`). Because MCP transport is remote-only, a hosted TrueForge could not reach a laptop-hosted MCP server without a tunnel, and spec §3 explicitly refuses tunnels.

- [ ] **Step 2: Write the MCP server (NEW FILE — not in the original File Structure)**

Create `src/mcp/server.ts`: a streamable-http MCP server exposing exactly four tools over the modules built in Tasks 2–8.

| Tool | Backing module |
|---|---|
| `plan_cascade(changedPkg, targets)` | `scanRepos` → `affectedSubgraph` → `assertScoped` → `topoLevels` → `computeChangeset` |
| `validate_changeset(entries)` | `buildWorkspaceRoot` → `validate` (which calls `assertLinked`) |
| `launch_cascade(entries)` | `openChangesetPrs` → `armAll` |
| `cascade_status()` | `pollOnce` → `cascade.snapshot()` |

Keep this file thin: argument parsing, a call into the module, and JSON out. No orchestration logic lives here — that is what Tasks 2–8 are for.

- [ ] **Step 3: Wire the approval gate (one config line)**

Gate 1 from spec §6 is **declarative**, not code. In the `AgentSpec` used to create the session:

```ts
mcpServers: [{
  name: "chainreaction",
  requireApprovalForTools: ["launch_cascade"],
}]
```

`plan_cascade`, `validate_changeset`, and `cascade_status` are read-only and run unattended; `launch_cascade` is the only tool that opens PRs and arms auto-merge, so it is the only one that pauses. Do not add interrupt-handling code — TrueForge raises `tool.approval_required` on the turn stream and waits.

The web app from Task 8 subscribes to `sessions.createTurnStream()`, renders the DAG when `tool.approval_required` arrives, and answers with a `user.tool_approval` turn input carrying the `toolCallId` from the event's `toolCalls[0].id`.

- [ ] **Step 4: Prepare the demo repos**

Add the `repository_dispatch` trigger (Task 6 Step 6) to the stubs in `design_system`, `mail_box_components`, `di_web`, `building_blocks`. Set `CR_DISPATCH_TOKEN` as an org secret. Enable auto-merge and branch protection on all five:

```bash
for r in design_system mail_box_components di_web building_blocks sudobility; do
  gh api -X PATCH repos/johnqh/$r -F allow_auto_merge=true
done
```

Answering spec §12 Q1: wire Cloudflare Pages auto-deploy on merge to `main` for `sudobility`. If it resists, end the demo with a local `bun install && bun dev` — decide this before rehearsal, not during.

- [ ] **Step 5: Rehearse against Verdaccio**

```bash
bunx verdaccio --listen 4873
```

Point `.npmrc` at `http://localhost:4873`, run the full cascade end to end. Rehearsing against real npm burns public version numbers permanently.

**Acceptance:** repoint `defaultTheme` in `design_system` at a visually distinct preset (`vaporwave`, `commodore-64`, `neo-brutalism`), approve once, and watch all five levels reach `published` with no further input. The landing page must repaint entirely although `sudobility`'s own diff contains nothing but a version bump.

- [ ] **Step 6: Run live once, and record**

Switch to real npm, run the cascade, screen-record the DAG view alongside the landing page. Time-lapse to three minutes.

- [ ] **Step 7: Write the README**

Sections: what it does and the 59-repo problem statement; architecture diagram from spec §4; setup; the demo script; **"Qodo Code Review Evidence"** listing every merged PR and the Qodo feedback on it; a "Built with TrueForge" section naming sandbox, subagents, interrupts, and sessions and what each is load-bearing for.

- [ ] **Step 8: Final commit and submission**

```bash
git checkout -b feat/harness-adapter
git add src/harness README.md .env.example docs/
git commit -m "feat: trueforge adapter and submission docs"
git push -u origin feat/harness-adapter && gh pr create --fill
```

---

## Cut List

Budget is now **23 hours against ~20 available**. The original 21 assumed an in-process TrueForge
adapter; Task 9's SDK probe found that impossible and added ~2h for `src/mcp/server.ts`
(spec §10 for the original breakdown). Cut in this order:

1. **Self-repair** — stall diagnosis narrows to "halt and report" (spec §7 already designates this the first cut)
2. **Verdaccio rehearsal** — rehearse on two repos against real npm instead of five
3. **Task 8 Step 4's animated states** — a static topological list with status badges still reads on video
4. **Task 7's `detectStall`** — a manual refresh button replaces automatic stall detection

**Never cut:** Task 1 (the spike), the Task 3 scoping guard, the Task 4 `assertLinked` check, or Task 9 Steps 6–8. The last two hours belong to the video and README regardless of feature state.

---

## Self-Review Notes

**Spec coverage:** §1 problem → Task 2 Step 7 verifies the 59-repo number. §4.1 → Task 2. §4.2 → Task 4. §4.3 → Tasks 5, 6. §4.4 → Tasks 7, 8. §5 shim → Task 6. §6 approval gates → Task 9 Step 2. §7 failure handling → Task 7 `detectStall` + cut list. §8 demo → Task 9 Steps 3–5. §9 deliverables → Task 9 Step 6. §11 risks → Task 1 and Task 4 Step 5 front-load the two highest.

**Open questions resolved:** §12 Q1 answered in Task 9 Step 3 (Cloudflare Pages, local `bun dev` fallback). §12 Q2 answered in Task 6 Step 7 (yes, via PR). §12 Q3 answered in Task 1 Step 5 (fine-grained PAT for the spike; org secret `CR_DISPATCH_TOKEN` for the real run).

**Type consistency:** `ChangesetEntry` fields (`pkg`, `dir`, `repo`, `fromVersion`, `toVersion`, `depBumps`, `level`) are identical across Tasks 3–8. `NodeState` values in `src/supervisor/state.ts` match the `COLOR` map keys in `src/web/App.tsx`. `Runner` (Task 4) and `Exec` (Task 5) are deliberately distinct types — one takes a `cwd`, the other does not.
