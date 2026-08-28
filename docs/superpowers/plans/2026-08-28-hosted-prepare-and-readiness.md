# ChainReaction Hosted — Plan B: Prepare and Readiness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide whether a repository can take part in a cascade, make it able to, record how it will merge, and refuse to plan a cascade that includes a repository which cannot.

**Architecture:** A read-only capability probe classifies each repo from GitHub's own responses; `prepareRepo` then applies what it can and records what it could not. Because branch protection is unavailable on free-tier private repos, each repo carries a **merge mechanism** — GitHub auto-merge where protection exists, control-plane merge where it does not. A readiness gate sits in front of planning so an unprepared repo is refused loudly instead of stalling a cascade at level 3.

**Tech Stack:** Bun, TypeScript, `bun:test`, GitHub REST API.

**Spec:** `docs/superpowers/specs/2026-08-28-hosted-chainreaction-design.md` §3.2

## Scope, and a re-split

The spec's Phase 1 named Plan B as "Prepare and Validation". That is too large for one plan: validation needs an OIDC verification endpoint, a published runner package, and a workflow file, none of which share code with Prepare. So:

- **Plan B (this one)** — capability probe, Prepare, merge-mechanism selection, the validation closure, and the readiness gate.
- **Plan C** — `ActionsValidator`: the workflow, the OIDC exchange, the runner.
- **Plan D** — cascade execution, webhooks, UI, MCP server, TrueForge.

Plan B produces working software on its own: *tell me which of my repos can take part, make them able to, and refuse to plan around ones that cannot.*

Plan A is a hard prerequisite — everything here runs on installation tokens and `RepoNode`s.

## Global Constraints

- Package manager is **Bun** everywhere. Never npm/yarn/pnpm. Test runner is `bun test`.
- Every substantive change goes through a GitHub PR reviewed by Qodo before merge. Never commit to `main`.
- TypeScript `^5`; `tsc --noEmit -p tsconfig.json` must exit clean. `noUncheckedIndexedAccess` is on and stays on.
- The package scope is a parameter. **Nothing may hardcode `@sudobility` or `johnqh`.**
- **No secret is ever logged** — not the App key, not an installation token, not in an error message.
- **No network calls in tests.** Every GitHub interaction goes through an injectable interface.
- Nothing under `src/auth/`, `src/sandbox/`, `src/supervisor/`, `src/server/`, `src/web/`, or `src/plan/planCascade.ts` may be modified except where a task says so explicitly.

## Measured facts this plan is built on

All four were measured against the real installation (157364042); do not re-derive them.

1. **`GET /repos/{o}/{r}/branches/{b}/protection` classifies a repo read-only**, by status code alone:
   - `403` with *"Upgrade to GitHub Pro or make this repository public"* — protection is **unavailable** (free-tier private repo)
   - `404` *"Branch not protected"* — protection is **available and unset**
   - `200` — **already protected**
2. **Rulesets are not an escape hatch.** `POST /repos/{o}/{r}/rulesets` returns the identical 403 on the same repo.
3. **`allow_auto_merge` defaults to `false`** on every repo in the reference installation, so Prepare must set it.
4. **A GitHub App cannot write `.github/workflows/**`** without `Workflows: write`, which this product deliberately does not request. `PUT` of a workflow file returns `403 Resource not accessible by integration`. The customer adds the validation workflow; Prepare only *verifies* it.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/prepare/types.ts` | `MergeMechanism`, `RepoCapabilities`, `PrepareResult` |
| `src/prepare/probe.ts` | Read-only capability probe |
| `src/prepare/prepare.ts` | Apply protection and auto-merge; select the mechanism; report blockers |
| `src/prepare/adminApi.ts` | `RepoAdminApi` interface + `InstallationRepoAdminApi` |
| `src/graph/closure.ts` | The validation closure — devDependency-aware |
| `src/graph/types.ts` | *(modified)* `RepoNode` gains optional `devDeps` |
| `src/graph/githubSource.ts` | *(modified)* populate `devDeps` |
| `src/graph/resolver.ts` | *(modified)* populate `devDeps` |
| `src/plan/readiness.ts` | `assertPrepared` — the gate in front of planning |

---

### Task 1: Capability probe

**Files:**
- Create: `src/prepare/types.ts`, `src/prepare/adminApi.ts`, `src/prepare/probe.ts`
- Test: `tests/prepare/probe.test.ts`

**Interfaces:**
- Consumes: nothing from other Plan B tasks
- Produces:
  - `type MergeMechanism = "auto-merge" | "control-plane"`
  - `type ProtectionState = "protected" | "unprotected" | "unavailable"`
  - `interface RepoCapabilities { repo: string; defaultBranch: string; isPrivate: boolean; protection: ProtectionState; autoMergeEnabled: boolean; hasValidationWorkflow: boolean }`
  - `interface RepoAdminApi { getRepo(full: string): Promise<RepoMeta>; getProtection(full: string, branch: string): Promise<number>; hasFile(full: string, path: string): Promise<boolean>; setProtection(full: string, branch: string, contexts: string[]): Promise<void>; enableAutoMerge(full: string): Promise<void> }`
  - `probeRepo(api: RepoAdminApi, full: string, workflowPath?: string): Promise<RepoCapabilities>`

- [ ] **Step 1: Write the failing test**

Create `tests/prepare/probe.test.ts`:

```ts
import { test, expect } from "bun:test";
import { probeRepo } from "../../src/prepare/probe";
import type { RepoAdminApi, RepoMeta } from "../../src/prepare/adminApi";

function api(over: Partial<{ meta: RepoMeta; protection: number; file: boolean }> = {}): RepoAdminApi {
  return {
    getRepo: async () => over.meta ?? { defaultBranch: "main", isPrivate: false, allowAutoMerge: false },
    getProtection: async () => over.protection ?? 404,
    hasFile: async () => over.file ?? false,
    setProtection: async () => { throw new Error("not called in probe"); },
    enableAutoMerge: async () => { throw new Error("not called in probe"); },
  };
}

test("404 on protection means protection is available but unset", async () => {
  const caps = await probeRepo(api({ protection: 404 }), "acme/lib");
  expect(caps.protection).toBe("unprotected");
});

test("200 on protection means already protected", async () => {
  const caps = await probeRepo(api({ protection: 200 }), "acme/lib");
  expect(caps.protection).toBe("protected");
});

test("403 on protection means unavailable — a free-tier private repo", async () => {
  const caps = await probeRepo(
    api({ protection: 403, meta: { defaultBranch: "main", isPrivate: true, allowAutoMerge: false } }),
    "acme/lib",
  );
  expect(caps.protection).toBe("unavailable");
  expect(caps.isPrivate).toBe(true);
});

test("an unexpected status is not silently treated as unavailable", async () => {
  await expect(probeRepo(api({ protection: 500 }), "acme/lib")).rejects.toThrow(/500/);
});

test("carries the default branch, auto-merge flag and workflow presence through", async () => {
  const caps = await probeRepo(
    api({ meta: { defaultBranch: "trunk", isPrivate: false, allowAutoMerge: true }, file: true }),
    "acme/lib",
  );
  expect(caps).toEqual({
    repo: "acme/lib",
    defaultBranch: "trunk",
    isPrivate: false,
    protection: "unprotected",
    autoMergeEnabled: true,
    hasValidationWorkflow: true,
  });
});

test("the workflow path is a parameter, not hardcoded", async () => {
  const seen: string[] = [];
  const a = api();
  a.hasFile = async (_f, path) => { seen.push(path); return false; };
  await probeRepo(a, "acme/lib", ".github/workflows/custom.yml");
  expect(seen).toEqual([".github/workflows/custom.yml"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/prepare/probe.test.ts`
Expected: FAIL — cannot resolve `../../src/prepare/probe`.

- [ ] **Step 3: Define the types**

Create `src/prepare/types.ts`:

```ts
export type MergeMechanism = "auto-merge" | "control-plane";

export type ProtectionState = "protected" | "unprotected" | "unavailable";

export interface RepoCapabilities {
  repo: string;
  defaultBranch: string;
  isPrivate: boolean;
  protection: ProtectionState;
  autoMergeEnabled: boolean;
  hasValidationWorkflow: boolean;
}

export interface PrepareResult {
  repo: string;
  ready: boolean;
  mechanism: MergeMechanism;
  /** Human-readable reasons this repo cannot participate. Empty when ready. */
  blockers: string[];
}
```

Create `src/prepare/adminApi.ts`:

```ts
export interface RepoMeta {
  defaultBranch: string;
  isPrivate: boolean;
  allowAutoMerge: boolean;
}

export interface RepoAdminApi {
  getRepo(full: string): Promise<RepoMeta>;
  /** HTTP status of GET /branches/{branch}/protection — 200, 404 and 403 are all meaningful. */
  getProtection(full: string, branch: string): Promise<number>;
  hasFile(full: string, path: string): Promise<boolean>;
  setProtection(full: string, branch: string, contexts: string[]): Promise<void>;
  enableAutoMerge(full: string): Promise<void>;
}
```

- [ ] **Step 4: Implement the probe**

Create `src/prepare/probe.ts`:

```ts
import type { RepoAdminApi } from "./adminApi";
import type { RepoCapabilities, ProtectionState } from "./types";

export const DEFAULT_WORKFLOW_PATH = ".github/workflows/chainreaction-validate.yml";

function classify(status: number): ProtectionState {
  if (status === 200) return "protected";
  if (status === 404) return "unprotected";
  // 403 is GitHub's "Upgrade to GitHub Pro or make this repository public" —
  // branch protection and rulesets alike are unavailable on free-tier private repos.
  if (status === 403) return "unavailable";
  // Anything else is a real failure. Guessing here would silently misclassify a
  // repo and later stall a cascade with no explanation.
  throw new Error(`unexpected status probing branch protection: ${status}`);
}

export async function probeRepo(
  api: RepoAdminApi,
  full: string,
  workflowPath: string = DEFAULT_WORKFLOW_PATH,
): Promise<RepoCapabilities> {
  const meta = await api.getRepo(full);
  const [status, hasWorkflow] = await Promise.all([
    api.getProtection(full, meta.defaultBranch),
    api.hasFile(full, workflowPath),
  ]);
  return {
    repo: full,
    defaultBranch: meta.defaultBranch,
    isPrivate: meta.isPrivate,
    protection: classify(status),
    autoMergeEnabled: meta.allowAutoMerge,
    hasValidationWorkflow: hasWorkflow,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/prepare/probe.test.ts` — expect PASS, 6 tests.
Then `bun test tests/` and `tsc --noEmit -p tsconfig.json` — expect clean.

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/capability-probe
git add src/prepare tests/prepare
git commit -m "feat: read-only repository capability probe"
git push -u origin feat/capability-probe
```

---

### Task 2: Prepare a repository

**Files:**
- Create: `src/prepare/prepare.ts`
- Test: `tests/prepare/prepare.test.ts`

**Interfaces:**
- Consumes: `RepoAdminApi`, `RepoCapabilities`, `MergeMechanism`, `PrepareResult`, `probeRepo` from Task 1
- Produces:
  - `mergeMechanismFor(caps: RepoCapabilities): MergeMechanism`
  - `prepareRepo(api: RepoAdminApi, full: string, requiredChecks: string[], workflowPath?: string): Promise<PrepareResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/prepare/prepare.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mergeMechanismFor, prepareRepo } from "../../src/prepare/prepare";
import type { RepoAdminApi, RepoMeta } from "../../src/prepare/adminApi";
import type { RepoCapabilities } from "../../src/prepare/types";

const caps = (over: Partial<RepoCapabilities> = {}): RepoCapabilities => ({
  repo: "acme/lib", defaultBranch: "main", isPrivate: false,
  protection: "unprotected", autoMergeEnabled: false, hasValidationWorkflow: true, ...over,
});

function api(over: Partial<{ meta: RepoMeta; protection: number; file: boolean }> = {}) {
  const calls: string[] = [];
  const a: RepoAdminApi = {
    getRepo: async () => over.meta ?? { defaultBranch: "main", isPrivate: false, allowAutoMerge: false },
    getProtection: async () => over.protection ?? 404,
    hasFile: async () => over.file ?? true,
    setProtection: async (_f, _b, contexts) => { calls.push(`setProtection:${contexts.join("+")}`); },
    enableAutoMerge: async () => { calls.push("enableAutoMerge"); },
  };
  return { a, calls };
}

test("a protectable repo uses GitHub auto-merge", () => {
  expect(mergeMechanismFor(caps({ protection: "unprotected" }))).toBe("auto-merge");
  expect(mergeMechanismFor(caps({ protection: "protected" }))).toBe("auto-merge");
});

test("a repo that cannot be protected falls back to control-plane merge", () => {
  expect(mergeMechanismFor(caps({ protection: "unavailable" }))).toBe("control-plane");
});

test("prepare applies protection and enables auto-merge on a protectable repo", async () => {
  const { a, calls } = api({ protection: 404 });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(calls).toEqual(["enableAutoMerge", "setProtection:ci"]);
  expect(res).toMatchObject({ repo: "acme/lib", ready: true, mechanism: "auto-merge", blockers: [] });
});

test("prepare does not attempt protection when it is unavailable, and still succeeds", async () => {
  const { a, calls } = api({ protection: 403, meta: { defaultBranch: "main", isPrivate: true, allowAutoMerge: false } });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(calls.some((c) => c.startsWith("setProtection"))).toBe(false);
  expect(res.ready).toBe(true);
  expect(res.mechanism).toBe("control-plane");
});

test("a missing validation workflow blocks readiness and names the file", async () => {
  const { a } = api({ file: false });
  const res = await prepareRepo(a, "acme/lib", ["ci"]);
  expect(res.ready).toBe(false);
  expect(res.blockers.join(" ")).toMatch(/chainreaction-validate\.yml/);
});

test("no required checks blocks readiness — auto-merge has nothing to wait on", async () => {
  const { a } = api();
  const res = await prepareRepo(a, "acme/lib", []);
  expect(res.ready).toBe(false);
  expect(res.blockers.join(" ")).toMatch(/required status check/i);
});

test("a blocked repo reports every blocker, not just the first", async () => {
  const { a } = api({ file: false });
  const res = await prepareRepo(a, "acme/lib", []);
  expect(res.blockers.length).toBe(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/prepare/prepare.test.ts`
Expected: FAIL — cannot resolve `../../src/prepare/prepare`.

- [ ] **Step 3: Implement**

Create `src/prepare/prepare.ts`:

```ts
import type { RepoAdminApi } from "./adminApi";
import type { MergeMechanism, PrepareResult, RepoCapabilities } from "./types";
import { probeRepo, DEFAULT_WORKFLOW_PATH } from "./probe";

export function mergeMechanismFor(caps: RepoCapabilities): MergeMechanism {
  // Protection is unavailable on free-tier private repos, so GitHub cannot merge
  // on our behalf. The control plane watches check_suite and merges itself.
  return caps.protection === "unavailable" ? "control-plane" : "auto-merge";
}

export async function prepareRepo(
  api: RepoAdminApi,
  full: string,
  requiredChecks: string[],
  workflowPath: string = DEFAULT_WORKFLOW_PATH,
): Promise<PrepareResult> {
  const caps = await probeRepo(api, full, workflowPath);
  const mechanism = mergeMechanismFor(caps);
  const blockers: string[] = [];

  if (!caps.hasValidationWorkflow) {
    blockers.push(
      `${full} is missing ${workflowPath}. ChainReaction cannot add it — the App does not ` +
        `request Workflows:write — so add the file and merge it, then prepare again.`,
    );
  }
  if (requiredChecks.length === 0) {
    blockers.push(
      `${full} has no required status check. Auto-merge needs an unsatisfied requirement to ` +
        `wait on, so a repo with no CI cannot take part in a cascade.`,
    );
  }

  if (blockers.length === 0) {
    if (!caps.autoMergeEnabled) await api.enableAutoMerge(full);
    if (caps.protection !== "unavailable") {
      // Status checks only, never reviews: an identity cannot approve its own PR,
      // and the human decision is ChainReaction's own approval gate.
      await api.setProtection(full, caps.defaultBranch, requiredChecks);
    }
  }

  return { repo: full, ready: blockers.length === 0, mechanism, blockers };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/` — expect 7 new tests plus everything existing.
Then `tsc --noEmit -p tsconfig.json` — expect clean.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/prepare-repo
git add src/prepare tests/prepare
git commit -m "feat: prepare a repository and select its merge mechanism"
git push -u origin feat/prepare-repo
```

---

### Task 3: The validation closure

The publish graph and the validation set are **not the same set**, and conflating them lets a cascade report success while leaving a repo's `main` broken.

The graph follows `dependencies` and `peerDependencies`, which is correct for deciding who must be *republished* — bumping a devDependency requires no version bump in the dependent. But repos build and test against their devDependencies. Measured in the reference workspace: `building_blocks` lists `@sudobility/di_web` **only** under `devDependencies`, so a `di_web` change never reaches it through the publish graph while its test suite compiles against it.

**Files:**
- Create: `src/graph/closure.ts`
- Modify: `src/graph/types.ts` — `RepoNode` gains optional `devDeps`
- Modify: `src/graph/githubSource.ts` and `src/graph/resolver.ts` — populate `devDeps`
- Test: `tests/graph/closure.test.ts`

**Interfaces:**
- Consumes: `RepoNode`
- Produces: `validationClosure(graph: Map<string, RepoNode>, publishSet: Set<string>): Set<string>`

- [ ] **Step 1: Write the failing test**

Create `tests/graph/closure.test.ts`:

```ts
import { test, expect } from "bun:test";
import { validationClosure } from "../../src/graph/closure";
import type { RepoNode } from "../../src/graph/types";

const node = (pkg: string, deps: string[], devDeps: string[] = []): RepoNode => ({
  pkg, repo: `acme/${pkg.replace("@acme/", "")}`, version: "1.0.0", deps, devDeps,
});

const graph = new Map<string, RepoNode>([
  ["@acme/design", node("@acme/design", [])],
  ["@acme/components", node("@acme/components", ["@acme/design"])],
  // depends on components for publishing, but builds against di_web
  ["@acme/blocks", node("@acme/blocks", ["@acme/components"], ["@acme/di_web"])],
  ["@acme/di_web", node("@acme/di_web", ["@acme/components"])],
  ["@acme/unrelated", node("@acme/unrelated", [])],
]);

test("the closure contains the publish set", () => {
  const publish = new Set(["@acme/design", "@acme/components"]);
  const closure = validationClosure(graph, publish);
  expect(closure.has("@acme/design")).toBe(true);
  expect(closure.has("@acme/components")).toBe(true);
});

test("a repo that only devDepends on a publishing package is added", () => {
  // di_web publishes; blocks devDepends on it, so blocks must be validated
  // even though it is not republished.
  const closure = validationClosure(graph, new Set(["@acme/di_web"]));
  expect(closure.has("@acme/blocks")).toBe(true);
});

test("an unrelated repo is not added", () => {
  const closure = validationClosure(graph, new Set(["@acme/di_web"]));
  expect(closure.has("@acme/unrelated")).toBe(false);
});

test("the closure is transitive through devDependency edges", () => {
  const g = new Map(graph);
  g.set("@acme/top", node("@acme/top", [], ["@acme/blocks"]));
  const closure = validationClosure(g, new Set(["@acme/di_web"]));
  expect(closure.has("@acme/top")).toBe(true);
});

test("a node with no devDeps recorded is handled", () => {
  const g = new Map<string, RepoNode>([
    ["@acme/a", { pkg: "@acme/a", repo: "acme/a", version: "1.0.0", deps: [] }],
  ]);
  expect(() => validationClosure(g, new Set(["@acme/a"]))).not.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/graph/closure.test.ts`
Expected: FAIL — cannot resolve `../../src/graph/closure`.

- [ ] **Step 3: Add `devDeps` to the node type and both sources**

In `src/graph/types.ts`, add to `RepoNode`:

```ts
  /** devDependencies within scope. Not part of the publish graph — see src/graph/closure.ts. */
  devDeps?: string[];
```

In `src/graph/githubSource.ts`, alongside the existing `deps` computation:

```ts
      const devDeps = Object.keys(pkg.devDependencies ?? {})
        .filter((d) => d.startsWith(this.scope))
        .sort();
```

and include `devDeps` in the `graph.set(...)` object. Add `devDependencies?: Record<string, string>` to the parsed manifest type.

In `src/graph/resolver.ts`, do the same from the filesystem manifest. **`deps` must not change** — devDependencies stay out of the publish graph.

- [ ] **Step 4: Implement the closure**

Create `src/graph/closure.ts`:

```ts
import type { RepoNode } from "./types";

/**
 * Every package that must be VALIDATED when `publishSet` is republished.
 *
 * A superset of the publish set: a repo that only devDepends on a publishing
 * package is never republished, but it builds and tests against it, so a
 * breaking change reddens its CI. Omitting it lets a cascade report success
 * while leaving that repo's default branch broken.
 */
export function validationClosure(
  graph: Map<string, RepoNode>,
  publishSet: Set<string>,
): Set<string> {
  const closure = new Set(publishSet);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of graph.values()) {
      if (closure.has(node.pkg)) continue;
      const edges = [...node.deps, ...(node.devDeps ?? [])];
      if (edges.some((d) => closure.has(d))) {
        closure.add(node.pkg);
        grew = true;
      }
    }
  }
  return closure;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/` and `tsc --noEmit -p tsconfig.json` — both clean.

- [ ] **Step 6: Verify against the reference workspace**

```bash
bun -e 'import{scanRepos,affectedSubgraph}from"./src/graph/resolver";
import{validationClosure}from"./src/graph/closure";
const g=scanRepos("/Users/johnhuang/projects");
const pub=affectedSubgraph(g,"@sudobility/design");
const val=validationClosure(g,pub);
console.log("publish set:",pub.size," validation closure:",val.size);
console.log("validate-only:",[...val].filter(p=>!pub.has(p)).sort().join(", "));'
```

**Acceptance:** the validation closure is a strict superset of the publish set, and the validate-only list is non-empty — it is the set of repos a cascade would otherwise have broken silently. Record the numbers in your report.

- [ ] **Step 7: Commit**

```bash
git checkout -b feat/validation-closure
git add src/graph tests/graph
git commit -m "feat: validation closure covers devDependency edges"
git push -u origin feat/validation-closure
```

---

### Task 4: The readiness gate

**Files:**
- Create: `src/plan/readiness.ts`
- Test: `tests/plan/readiness.test.ts`

**Interfaces:**
- Consumes: `PrepareResult` from Task 1
- Produces: `assertPrepared(results: Map<string, PrepareResult>, required: string[]): void`

- [ ] **Step 1: Write the failing test**

Create `tests/plan/readiness.test.ts`:

```ts
import { test, expect } from "bun:test";
import { assertPrepared } from "../../src/plan/readiness";
import type { PrepareResult } from "../../src/prepare/types";

const ok = (repo: string): PrepareResult =>
  ({ repo, ready: true, mechanism: "auto-merge", blockers: [] });
const bad = (repo: string, why: string): PrepareResult =>
  ({ repo, ready: false, mechanism: "auto-merge", blockers: [why] });

test("passes when every required repo is ready", () => {
  const m = new Map([["acme/a", ok("acme/a")], ["acme/b", ok("acme/b")]]);
  expect(() => assertPrepared(m, ["acme/a", "acme/b"])).not.toThrow();
});

test("refuses when a required repo is not ready, naming it and why", () => {
  const m = new Map([["acme/a", ok("acme/a")], ["acme/b", bad("acme/b", "missing workflow")]]);
  expect(() => assertPrepared(m, ["acme/a", "acme/b"])).toThrow(/acme\/b.*missing workflow/s);
});

test("refuses when a required repo was never prepared at all", () => {
  const m = new Map([["acme/a", ok("acme/a")]]);
  expect(() => assertPrepared(m, ["acme/a", "acme/b"])).toThrow(/acme\/b.*never prepared/s);
});

test("reports every unready repo, not just the first", () => {
  const m = new Map([
    ["acme/a", bad("acme/a", "x")],
    ["acme/b", bad("acme/b", "y")],
  ]);
  let msg = "";
  try { assertPrepared(m, ["acme/a", "acme/b"]); } catch (e) { msg = (e as Error).message; }
  expect(msg).toContain("acme/a");
  expect(msg).toContain("acme/b");
});

test("ignores prepared repos that are not required", () => {
  const m = new Map([["acme/a", ok("acme/a")], ["acme/z", bad("acme/z", "irrelevant")]]);
  expect(() => assertPrepared(m, ["acme/a"])).not.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/plan/readiness.test.ts`
Expected: FAIL — cannot resolve `../../src/plan/readiness`.

- [ ] **Step 3: Implement**

Create `src/plan/readiness.ts`:

```ts
import type { PrepareResult } from "../prepare/types";

/**
 * Refuse to plan a cascade that includes a repository which cannot take part.
 *
 * An unprepared repo does not fail at launch — it fails silently in the middle,
 * when its PR never merges and every level below it waits forever. Failing here,
 * naming every repo and every reason, is the whole point.
 */
export function assertPrepared(
  results: Map<string, PrepareResult>,
  required: string[],
): void {
  const problems: string[] = [];
  for (const repo of required) {
    const result = results.get(repo);
    if (!result) {
      problems.push(`${repo}: never prepared`);
      continue;
    }
    if (!result.ready) {
      problems.push(`${repo}: ${result.blockers.join("; ")}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `cannot start a cascade — ${problems.length} repositor${problems.length === 1 ? "y is" : "ies are"} not ready:\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/` and `tsc --noEmit -p tsconfig.json` — both clean.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/readiness-gate
git add src/plan/readiness.ts tests/plan/readiness.test.ts
git commit -m "feat: refuse to plan a cascade including an unprepared repo"
git push -u origin feat/readiness-gate
```

---

## Cut List

If time is short, cut in this order:

1. **Task 3's transitive devDependency walk** — narrow to direct devDependents only. Still catches the measured `building_blocks` → `di_web` case.
2. **Task 2's multi-blocker reporting** — return the first blocker rather than all. Worse UX, same safety.

**Never cut:** Task 1's `classify` throwing on an unexpected status, Task 2's missing-workflow and no-required-check blockers, or Task 4 entirely. Each converts a silent mid-cascade stall into a refusal before anything starts, which is this project's entire thesis.

---

## Self-Review Notes

**Spec coverage:** §3.2's three Prepare actions map to Tasks 1 and 2, including the measured 403/404/200 classification and the auto-merge-needs-a-required-check constraint. The manual-workflow decision is honoured — `hasFile` only *verifies*; nothing writes to `.github/workflows/**`, which the App cannot do anyway. §3.2's per-repo merge mechanism is `mergeMechanismFor`. The devDependency finding added to §3.4's preamble is Task 3. `ActionsValidator` (§3.3) is deliberately Plan C, per the re-split at the top.

**Placeholder scan:** none. Every step has runnable content; Task 3 Step 6 is a verification command with a stated acceptance.

**Type consistency:** `RepoCapabilities`' six fields are identical across Tasks 1 and 2, and the Task 1 Step 5 test asserts the whole object shape, so a drifting field breaks loudly. `PrepareResult` is produced in Task 2 and consumed in Task 4 unchanged. `RepoNode.devDeps` is optional so `resolver.ts`, `changeset.ts`, `workspace.ts` and `orchestrator.ts` keep compiling; `validationClosure` reads it with `?? []`, and a test covers a node without it.

**Not hardcoded:** the workflow path is a parameter with a test asserting it, and `requiredChecks` is passed in rather than assumed.
