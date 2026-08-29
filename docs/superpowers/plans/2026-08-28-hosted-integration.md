# ChainReaction Hosted — Plan C: Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Plan B's safety properties **enforced** rather than merely available, and produce the first thing a developer can actually run: prepare your repositories, then plan a cascade that refuses to proceed around any repo that cannot take part.

**Architecture:** A concrete `RepoAdminApi` over the REST API completes Prepare. A single package-name → repo-name mapping joins the graph's vocabulary to Prepare's. `planCascade` takes prepared state as a **required** argument, so a cascade cannot be planned without it. A thin CLI composes them into something runnable.

**Tech Stack:** Bun, TypeScript, `bun:test`, GitHub REST API.

**Spec:** `docs/superpowers/specs/2026-08-28-hosted-chainreaction-design.md`

## Why this plan exists

Plan B's whole-branch review established that `validationClosure`, `assertPrepared`, `prepareRepo`, `probeRepo` and `mergeMechanismFor` have **zero production callers**. Every reference outside their own module is a test. Plan B produced a correct library and no product, and its own Global Constraints — which forbade touching `planCascade` — are where that contradiction came from.

The review named four conditions that must hold before any of it is load-bearing. This plan is those four conditions, plus an entry point so the result can be run rather than only imported.

Deliberately **not** in this plan: `ActionsValidator`, the OIDC exchange and the runner package (now Plan D), and cascade execution, webhooks, the UI, the MCP server and TrueForge (now Plan E). Validation and execution both depend on this wiring existing first.

## Global Constraints

- Package manager is **Bun** everywhere. Never npm/yarn/pnpm. Test runner is `bun test`.
- Every substantive change goes through a GitHub PR reviewed by Qodo before merge. Never commit to `main`.
- TypeScript `^5`; `tsc --noEmit -p tsconfig.json` must exit clean. `noUncheckedIndexedAccess` is on and stays on.
- The package scope is a parameter. **Nothing may hardcode `@sudobility` or `johnqh`.**
- **No secret is ever logged** — not the App key, not an installation token, not in an error message, not in CLI output.
- **No network calls in tests.** Every GitHub interaction goes through an injectable interface.
- **Response shapes are validated, never cast.** `src/github/installationApi.ts` is the pattern: check the field, throw naming what was wrong. A cast that turns a malformed response into `undefined` typed as `string` is how this project's worst bugs have started.

## Measured facts this plan is built on

1. **`GET /branches/{b}/protection` classifies read-only by status**, but a 403 is ambiguous — it means the free-tier plan limit *only* when the body matches `/Upgrade to GitHub Pro|make this repository public/i`. A missing `Administration` scope, a secondary rate limit and SAML enforcement all return 403 too. `ProtectionProbe` carries `message` and `body` for exactly this reason, and a concrete implementation **must populate them**.
2. **`PUT .../protection` is a whole-object replace.** ChainReaction refuses to modify already-protected branches rather than risk stripping a customer's review requirements.
3. **`accept: application/vnd.github.raw+json` returns raw JSON** on the contents endpoint, not base64.
4. **`/installation/repositories` paginates** at 30 by default; follow `Link: rel="next"` to exhaustion.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/prepare/installationAdminApi.ts` | Concrete `RepoAdminApi` over REST |
| `src/graph/mapping.ts` | The single package-name → repo-name mapping |
| `src/plan/planCascade.ts` | *(modified)* prepared state becomes a required argument |
| `src/cli/main.ts` | `prepare` and `plan` commands |

---

### Task 1: Concrete `RepoAdminApi`

**Files:**
- Create: `src/prepare/installationAdminApi.ts`
- Test: `tests/prepare/installationAdminApi.test.ts`

**Interfaces:**
- Consumes: `RepoAdminApi`, `RepoMeta`, `ProtectionProbe` from `src/prepare/adminApi.ts`; `TokenProvider` from `src/github/installationApi.ts`
- Produces: `class InstallationRepoAdminApi implements RepoAdminApi`

- [ ] **Step 1: Write the failing test**

Create `tests/prepare/installationAdminApi.test.ts`:

```ts
import { test, expect } from "bun:test";
import { InstallationRepoAdminApi } from "../../src/prepare/installationAdminApi";

const token = async () => "tok";

function stub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("getRepo maps the fields it needs and validates them", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({
    default_branch: "trunk", private: true, allow_auto_merge: true,
  })));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  expect(await api.getRepo("acme/lib")).toEqual({
    defaultBranch: "trunk", isPrivate: true, allowAutoMerge: true,
  });
});

test("getRepo rejects a response with no default_branch rather than yielding undefined", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ private: false })));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  await expect(api.getRepo("acme/lib")).rejects.toThrow(/default_branch/);
});

test("getRepo treats a missing allow_auto_merge as false, not undefined", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ default_branch: "main", private: false })));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  expect((await api.getRepo("acme/lib")).allowAutoMerge).toBe(false);
});

test("getProtection carries status, message and body — the 403 classification depends on them", async () => {
  const { fn } = stub(() => new Response(
    JSON.stringify({ message: "Upgrade to GitHub Pro or make this repository public." }),
    { status: 403 },
  ));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  const probe = await api.getProtection("acme/lib", "main");
  expect(probe.status).toBe(403);
  expect(probe.message).toMatch(/Upgrade to GitHub Pro/);
});

test("getProtection returns the body on 200 so requiresReviews can be derived", async () => {
  const { fn } = stub(() => new Response(
    JSON.stringify({ required_pull_request_reviews: { required_approving_review_count: 2 } }),
    { status: 200 },
  ));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  const probe = await api.getProtection("acme/lib", "main");
  expect(probe.status).toBe(200);
  expect(probe.body?.["required_pull_request_reviews"]).toBeDefined();
});

test("getProtection does not throw on 404 — an unprotected branch is normal", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ message: "Branch not protected" }), { status: 404 }));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  expect((await api.getProtection("acme/lib", "main")).status).toBe(404);
});

test("hasFile is true on 200, false on 404, and throws on anything else", async () => {
  const mk = (status: number) => new InstallationRepoAdminApi(token, 1, stub(() => new Response("{}", { status })).fn);
  expect(await mk(200).hasFile("acme/lib", "a.yml")).toBe(true);
  expect(await mk(404).hasFile("acme/lib", "a.yml")).toBe(false);
  // A 500 silently becoming "the file is absent" would block a ready repo for the wrong reason.
  await expect(mk(500).hasFile("acme/lib", "a.yml")).rejects.toThrow(/500/);
});

test("setProtection sends required status checks and no review requirement", async () => {
  const { fn, calls } = stub(() => new Response("{}", { status: 200 }));
  await new InstallationRepoAdminApi(token, 1, fn).setProtection("acme/lib", "main", ["ci"]);
  const body = JSON.parse(String(calls[0]!.init!.body));
  expect(calls[0]!.init!.method).toBe("PUT");
  expect(body.required_status_checks.contexts).toEqual(["ci"]);
  // An identity cannot approve its own PR, so requiring reviews would stall every cascade.
  expect(body.required_pull_request_reviews).toBeNull();
});

test("enableAutoMerge PATCHes the repo", async () => {
  const { fn, calls } = stub(() => new Response("{}", { status: 200 }));
  await new InstallationRepoAdminApi(token, 1, fn).enableAutoMerge("acme/lib");
  expect(calls[0]!.init!.method).toBe("PATCH");
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ allow_auto_merge: true });
});

test("no token reaches an error message", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
  const api = new InstallationRepoAdminApi(async () => "super-secret-token", 1, fn);
  let msg = "";
  try { await api.getRepo("acme/lib"); } catch (e) { msg = (e as Error).message; }
  expect(msg).not.toContain("super-secret-token");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/prepare/installationAdminApi.test.ts`
Expected: FAIL — cannot resolve `../../src/prepare/installationAdminApi`.

- [ ] **Step 3: Implement**

Create `src/prepare/installationAdminApi.ts`:

```ts
import type { RepoAdminApi, RepoMeta, ProtectionProbe } from "./adminApi";
import type { TokenProvider } from "../github/installationApi";

const API_ROOT = "https://api.github.com";

export class InstallationRepoAdminApi implements RepoAdminApi {
  constructor(
    private getToken: TokenProvider,
    private installationId: number,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async request(url: string, init?: RequestInit): Promise<Response> {
    const token = await this.getToken(this.installationId);
    return this.fetchFn(url, {
      ...init,
      headers: {
        authorization: `token ${token}`,
        accept: "application/vnd.github+json",
        ...(init?.headers ?? {}),
      },
    });
  }

  async getRepo(full: string): Promise<RepoMeta> {
    const res = await this.request(`${API_ROOT}/repos/${full}`);
    // Never interpolate the response into the message — it can carry credentials.
    if (!res.ok) throw new Error(`getRepo ${full} failed: ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const defaultBranch = body["default_branch"];
    if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
      throw new Error(`getRepo ${full}: response has no usable default_branch`);
    }
    return {
      defaultBranch,
      isPrivate: body["private"] === true,
      allowAutoMerge: body["allow_auto_merge"] === true,
    };
  }

  async getProtection(full: string, branch: string): Promise<ProtectionProbe> {
    const res = await this.request(
      `${API_ROOT}/repos/${full}/branches/${branch}/protection`,
    );
    // 200, 404 and 403 are all meaningful to classify(); it needs the message and
    // body to tell a free-tier 403 from a scope or rate-limit 403.
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
    const message = typeof parsed?.["message"] === "string" ? (parsed["message"] as string) : undefined;
    return { status: res.status, message, body: parsed };
  }

  async hasFile(full: string, path: string): Promise<boolean> {
    const res = await this.request(`${API_ROOT}/repos/${full}/contents/${path}`);
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    // A 500 quietly becoming "absent" would block a ready repo for the wrong reason.
    throw new Error(`hasFile ${full}:${path} failed: ${res.status}`);
  }

  async setProtection(full: string, branch: string, contexts: string[]): Promise<void> {
    const res = await this.request(
      `${API_ROOT}/repos/${full}/branches/${branch}/protection`,
      {
        method: "PUT",
        body: JSON.stringify({
          required_status_checks: { strict: false, contexts },
          enforce_admins: false,
          // Explicitly null: an identity cannot approve its own pull request, so a
          // review requirement would stall every cascade at level 0.
          required_pull_request_reviews: null,
          restrictions: null,
        }),
      },
    );
    if (!res.ok) throw new Error(`setProtection ${full} failed: ${res.status}`);
  }

  async enableAutoMerge(full: string): Promise<void> {
    const res = await this.request(`${API_ROOT}/repos/${full}`, {
      method: "PATCH",
      body: JSON.stringify({ allow_auto_merge: true }),
    });
    if (!res.ok) throw new Error(`enableAutoMerge ${full} failed: ${res.status}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/` and `tsc --noEmit -p tsconfig.json`. Both clean.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/installation-admin-api
git add src/prepare tests/prepare
git commit -m "feat: concrete RepoAdminApi over the installation REST API"
git push -u origin feat/installation-admin-api
```

---

### Task 2: The package → repo mapping

`validationClosure` and `planCascade` speak **package names** (`@acme/design`). `assertPrepared` keys on **repo full names** (`acme/design`). Both are bare strings, so a mapping that silently drops an unknown package turns the readiness gate into a no-op that reports success.

Written once, in one place, and it **refuses** rather than dropping.

**Files:**
- Create: `src/graph/mapping.ts`
- Test: `tests/graph/mapping.test.ts`

**Interfaces:**
- Consumes: `RepoNode`
- Produces: `reposForPackages(graph: Map<string, RepoNode>, packages: Iterable<string>): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/graph/mapping.test.ts`:

```ts
import { test, expect } from "bun:test";
import { reposForPackages } from "../../src/graph/mapping";
import type { RepoNode } from "../../src/graph/types";

const graph = new Map<string, RepoNode>([
  ["@acme/design", { pkg: "@acme/design", repo: "acme/design_system", version: "1.0.0", deps: [] }],
  ["@acme/components", { pkg: "@acme/components", repo: "acme/components", version: "1.0.0", deps: [] }],
]);

test("maps package names to repo full names", () => {
  expect(reposForPackages(graph, ["@acme/design", "@acme/components"]))
    .toEqual(["acme/components", "acme/design_system"]);
});

test("refuses an unknown package rather than dropping it", () => {
  // Dropping would shrink the required set and let the readiness gate pass vacuously.
  expect(() => reposForPackages(graph, ["@acme/design", "@acme/ghost"]))
    .toThrow(/@acme\/ghost/);
});

test("names every unknown package, not just the first", () => {
  let msg = "";
  try { reposForPackages(graph, ["@acme/ghost", "@acme/phantom"]); } catch (e) { msg = (e as Error).message; }
  expect(msg).toContain("@acme/ghost");
  expect(msg).toContain("@acme/phantom");
});

test("deduplicates when two packages share a repo", () => {
  const g = new Map(graph);
  g.set("@acme/extra", { pkg: "@acme/extra", repo: "acme/components", version: "1.0.0", deps: [] });
  expect(reposForPackages(g, ["@acme/components", "@acme/extra"])).toEqual(["acme/components"]);
});

test("an empty input yields an empty result without throwing", () => {
  expect(reposForPackages(graph, [])).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/graph/mapping.test.ts`
Expected: FAIL — cannot resolve `../../src/graph/mapping`.

- [ ] **Step 3: Implement**

Create `src/graph/mapping.ts`:

```ts
import type { RepoNode } from "./types";

/**
 * Translate package names into repository full names.
 *
 * Refuses on an unknown package rather than dropping it. A silent drop shrinks the
 * set handed to `assertPrepared`, which then certifies a smaller set than the
 * cascade will actually touch — a gate that passes because it was asked about
 * nothing.
 */
export function reposForPackages(
  graph: Map<string, RepoNode>,
  packages: Iterable<string>,
): string[] {
  const repos = new Set<string>();
  const unknown: string[] = [];

  for (const pkg of packages) {
    const node = graph.get(pkg);
    if (!node) {
      unknown.push(pkg);
      continue;
    }
    repos.add(node.repo);
  }

  if (unknown.length > 0) {
    throw new Error(
      `no repository known for ${unknown.length} package(s): ${unknown.sort().join(", ")}`,
    );
  }
  return [...repos].sort();
}
```

- [ ] **Step 4: Run the tests, then commit**

```bash
bun test tests/ && bunx tsc --noEmit -p tsconfig.json
git checkout -b feat/package-repo-mapping
git add src/graph/mapping.ts tests/graph/mapping.test.ts
git commit -m "feat: package to repo mapping that refuses unknowns"
git push -u origin feat/package-repo-mapping
```

---

### Task 3: Make the gate required

Today `planCascade` can plan a cascade with no knowledge of whether any repo can take part. This task makes that impossible to express.

Prepared state becomes a **required** parameter. Optional would be worse than nothing: a caller who forgets it gets an ungated plan and no error, which is precisely the failure mode this project keeps finding.

**Files:**
- Modify: `src/plan/planCascade.ts`
- Modify: `tests/plan/planCascade.test.ts`

**Interfaces:**
- Consumes: `assertPrepared` and `PrepareResult` from Plan B; `reposForPackages` from Task 2
- Produces: `planCascade(source, changed, targets, prepared: Map<string, PrepareResult>): Promise<CascadePlan>`

- [ ] **Step 1: Write the failing test**

Add to `tests/plan/planCascade.test.ts` (keep the existing tests, updating their calls to pass a prepared map):

```ts
import type { PrepareResult } from "../../src/prepare/types";

const ready = (repo: string): PrepareResult =>
  ({ repo, ready: true, mechanism: "auto-merge", blockers: [] });

const allReady = (...repos: string[]) =>
  new Map(repos.map((r) => [r, ready(r)]));

test("refuses to plan when a repo in the cascade is not prepared", async () => {
  // acme/components is affected but absent from the prepared map.
  const prepared = allReady("acme/design_system");
  await expect(planCascade(source, "@acme/design", "all", prepared))
    .rejects.toThrow(/acme\/components.*never prepared/s);
});

test("refuses when a prepared repo is not ready, naming the blocker", async () => {
  const prepared = allReady("acme/design_system", "acme/components", "acme/app");
  prepared.set("acme/components", {
    repo: "acme/components", ready: false, mechanism: "auto-merge",
    blockers: ["missing chainreaction-validate.yml"],
  });
  await expect(planCascade(source, "@acme/design", "all", prepared))
    .rejects.toThrow(/missing chainreaction-validate\.yml/);
});

test("the gate runs before the changeset is computed", async () => {
  // A plan that reaches computeChangeset has already decided version numbers for
  // repos it may not be allowed to touch. Assert nothing is returned at all.
  const prepared = allReady("acme/design_system");
  let plan;
  try { plan = await planCascade(source, "@acme/design", "all", prepared); } catch { /* expected */ }
  expect(plan).toBeUndefined();
});

test("plans normally when every affected repo is ready", async () => {
  const prepared = allReady("acme/design_system", "acme/components", "acme/app");
  const plan = await planCascade(source, "@acme/design", "all", prepared);
  expect(plan.levels.length).toBe(3);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/plan/planCascade.test.ts`
Expected: FAIL — `planCascade` takes three arguments.

- [ ] **Step 3: Implement**

In `src/plan/planCascade.ts`, add the fourth parameter and gate before computing the changeset:

```ts
import type { PrepareResult } from "../prepare/types";
import { assertPrepared } from "./readiness";
import { reposForPackages } from "../graph/mapping";

export async function planCascade(
  source: GraphSource,
  changed: string,
  targets: string[] | "all",
  prepared: Map<string, PrepareResult>,
): Promise<CascadePlan> {
  const graph = await source.load();
  if (!graph.has(changed)) {
    throw new Error(`${changed} is not in the graph for this installation`);
  }

  const affected = affectedSubgraph(graph, changed);
  assertScoped(affected, targets);

  // Gate before anything is planned. A plan that reaches computeChangeset has
  // already assigned version numbers to repos it may not be allowed to touch.
  assertPrepared(prepared, reposForPackages(graph, affected));

  const levels = topoLevels(graph, affected);
  return { /* unchanged */ };
}
```

Update the existing tests to pass a fully-ready map so they keep asserting what they asserted before.

- [ ] **Step 4: Run the tests, then commit**

```bash
bun test tests/ && bunx tsc --noEmit -p tsconfig.json
git checkout -b feat/required-readiness-gate
git add src/plan tests/plan
git commit -m "feat: planCascade requires prepared state"
git push -u origin feat/required-readiness-gate
```

---

### Task 4: A runnable entry point

Until something can be run, this is a library. Two commands, no framework.

**Files:**
- Create: `src/cli/main.ts`
- Modify: `package.json` — add a `bin` entry and a `chainreaction` script
- Test: `tests/cli/main.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `runCli(argv: string[], deps: CliDeps): Promise<number>` — returns an exit code, never calls `process.exit`, so it is testable

- [ ] **Step 1: Write the failing test**

Create `tests/cli/main.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/cli/main.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/main`.

- [ ] **Step 3: Implement**

Create `src/cli/main.ts` with a `CliDeps` interface holding `log`, `prepare` and `plan`, and a `runCli` that dispatches on `argv[0]`. It **returns** an exit code rather than calling `process.exit`, which is what makes it testable. Print blockers one per line. Print `skipped` entries under a heading when non-empty. Refuse `plan` unless exactly one of `--all` or `--targets a,b,c` is given — the scoping guard exists to stop a 60-repo publish nobody asked for, and the CLI must not offer a way around it.

Add a separate, untested `src/cli/bin.ts` that wires real dependencies and calls `process.exit(await runCli(process.argv.slice(2), realDeps))`. Keep it under ten lines; everything worth testing lives in `main.ts`.

- [ ] **Step 4: Run the tests, then commit**

```bash
bun test tests/ && bunx tsc --noEmit -p tsconfig.json
git checkout -b feat/cli
git add src/cli tests/cli package.json
git commit -m "feat: prepare and plan commands"
git push -u origin feat/cli
```

---

## Cut List

1. **Task 4's `--targets` parsing** — support only `--all` at first. The guard still holds; the narrow path just isn't reachable from the CLI.
2. **Task 1's `setProtection` / `enableAutoMerge`** — ship the read-only half (`getRepo`, `getProtection`, `hasFile`) so `probeRepo` works end-to-end, and leave Prepare's mutations for a follow-up.

**Never cut:** Task 2's refusal on an unknown package, Task 3 entirely, or Task 1's response-shape validation. Each is the difference between a gate and the appearance of one.

---

## Self-Review Notes

**Spec coverage:** this plan is the four conditions the Plan B review named. §3.1's App identity is reused unchanged. §3.2's Prepare gains its concrete API in Task 1, including the `ProtectionProbe` `message`/`body` fields the 403 classification depends on and the whole-object-replace hazard handled by `setProtection`'s explicit `required_pull_request_reviews: null`. §3.3's validation is deliberately Plan D.

**Placeholder scan:** none. Task 4 Step 3 describes `main.ts` in prose rather than giving code, because its shape follows directly from the six tests above it; every other step is runnable.

**Type consistency:** `RepoMeta` and `ProtectionProbe` are consumed exactly as `src/prepare/adminApi.ts` declares them after Plan B's fix wave — `getProtection` returns `{ status, message?, body? }`, not a bare number. `TokenProvider` is reused from `src/github/installationApi.ts` rather than redeclared. `PrepareResult` is unchanged. `CascadePlan` gains no fields; `planCascade` gains a parameter.

**The signature change in Task 3 is deliberate and load-bearing.** Making `prepared` optional would let a caller silently skip the gate, which is the exact class of bug this plan exists to close.
