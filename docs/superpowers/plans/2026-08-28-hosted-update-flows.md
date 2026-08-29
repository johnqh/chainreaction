# ChainReaction Hosted — Plan E: Update Flows and the App

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app a developer actually uses. Sign in with GitHub, see every repo and how they depend on each other, pick one, and either refresh just that repo or refresh the whole chain it sits on — then watch the pull requests go green in order, merging them by hand or letting the app run the train.

**Spec:** `docs/superpowers/specs/2026-08-28-hosted-chainreaction-design.md`

---

## The two walks, and why they are different

This plan introduces a second graph traversal, and keeping the two straight is the difference between a coherent app and a confusing one.

| | Direction | Edges followed | Question it answers |
|---|---|---|---|
| `affectedSubgraph` *(exists)* | downstream, to dependents | `dependencies` + `peerDependencies` | **Who must republish** because this package changed |
| `dependencyClosure` *(new)* | upstream, to dependencies | **both**, including `devDependencies` | **What I have chosen to refresh** so this project gets the newest of everything |

A devDependency bump never *forces* a dependent to republish — that is why the publish graph excludes those edges, and why it is correct that a change to `proj1` does not oblige `proj2` or `proj3` to move.

But a user selecting `proj5` and asking for the chain is *electing* to propagate through those edges anyway. That is a choice, not an obligation, and the app should let them make it.

### Worked example, from the requirements

```
proj1
  └─ devDependency of proj2
       ├─ devDependency of proj3
       │    └─ dependency of proj5
       └─ dependency of proj4
```

`proj1` changes and publishes. Then:

- **Update on proj4** → one PR. `proj4`'s own `@scope` dependencies move to their latest published versions. `proj2` and `proj3` are untouched.
- **Update on proj2** → one PR. `proj2`'s `devDependency` on `proj1` moves to the newest `proj1`.
- **Update Chain on proj5** → three PRs, bottom-up: `proj2`, `proj3`, `proj5`.
  - `proj2`'s PR is **green** — everything it depends on is already published.
  - `proj3` and `proj5` are **red** — each waits on the one before it.
  - Merging `proj2` publishes it; `proj3` then turns green; and so on to the leaf.

---

## Global Constraints

- Package manager is **Bun** everywhere. Never npm/yarn/pnpm. Test runner is `bun test`.
- Every substantive change goes through a GitHub PR reviewed by Qodo before merge. Never commit to `main`.
- TypeScript `^5`; `bunx tsc --noEmit -p tsconfig.json` must exit clean (`tsc` is not on PATH). `noUncheckedIndexedAccess` is on and stays on.
- The package scope is a parameter. **Nothing hardcodes `@sudobility` or `johnqh`.**
- **No secret in any log, error, response body, or rendered page** — not the App key, not an installation token.
- **No network calls in tests.** Every GitHub interaction goes through an injectable interface.
- Response shapes are validated, never cast.
- **Deployment is out of scope.** The server runs locally; a public URL and webhooks are a later plan. Where this plan needs to observe GitHub state it polls, reusing the existing supervisor poller.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/graph/closure.ts` *(modified)* | add `dependencyClosure` beside the existing validation closure |
| `src/plan/planUpdate.ts` | `planUpdateOne` and `planUpdateChain` |
| `src/pr/lifecycle.ts` | open the changeset's PRs; classify each as ready or blocked |
| `src/pr/train.ts` | the Auto Merge train: merge, await publish, advance |
| `src/server/api.ts` | HTTP surface the app calls |
| `src/web/RepoList.tsx` | repo list with search |
| `src/web/Graph.tsx` | dependency graph, edges coloured by kind |
| `src/web/Updates.tsx` | Update / Update Chain / Merge / Auto Merge, and PR status |

---

### Task 1: `dependencyClosure`

**Files:** modify `src/graph/closure.ts`; test `tests/graph/dependencyClosure.test.ts`

**Produces:**
- `dependencyClosure(graph: Map<string, RepoNode>, pkg: string): Set<string>` — `pkg` plus everything it transitively depends on through **both** `deps` and `devDeps`, restricted to packages present in the graph.
- `dependencyLevels(graph: Map<string, RepoNode>, subset: Set<string>): string[][]` — bottom-up topological levels, so level 0 has no unpublished dependency inside the subset.

**Tests must cover:**

```ts
test("includes the package itself", ...)
test("follows dependency edges upstream", ...)
test("follows devDependency edges upstream too — the user is electing to propagate", ...)
test("excludes packages outside the graph", ...)          // third-party deps
test("excludes dependents — this walk goes the other way", ...)  // proj4 absent from proj5's chain
test("levels are bottom-up: a package never precedes something it depends on", ...)
test("throws on a dependency cycle rather than looping", ...)
```

The fifth test is the one that distinguishes this from `affectedSubgraph`. In the worked example, `dependencyClosure(graph, "proj5")` must **not** contain `proj4`. A walk that returned it has the direction backwards, and every other test would still pass.

---

### Task 2: Update planning

**Files:** `src/plan/planUpdate.ts`; test `tests/plan/planUpdate.test.ts`

**Produces:**
- `planUpdateOne(graph, pkg): ChangesetEntry[]` — exactly one entry. The selected package's own in-graph `deps` and `devDeps` are rewritten to `^<current version from the graph>`, and its own version is patch-bumped.
- `planUpdateChain(graph, pkg): ChangesetEntry[]` — `dependencyClosure` ordered by `dependencyLevels`, each entry bumped and its in-graph ranges rewritten to the *bumped* versions of anything earlier in the chain.

"Latest published version" is the version recorded in the graph, which is each repo's `package.json` version — what CI publishes on merge. No registry lookup is needed, and adding one would introduce a second source of truth that can disagree.

**Tests must cover:**

```ts
test("planUpdateOne produces exactly one entry", ...)
test("planUpdateOne rewrites both deps and devDeps to current graph versions", ...)
test("planUpdateOne leaves out-of-graph dependencies untouched", ...)
test("planUpdateChain orders entries bottom-up", ...)
test("a chain entry references the BUMPED version of its dependency, not the current one", ...)
test("planUpdateChain on a package with no in-graph dependencies is a single entry", ...)
test("refuses a package absent from the graph", ...)
```

The fifth is load-bearing: if `proj3` referenced `proj2`'s *current* version rather than its bumped one, its PR would go green immediately and merge before `proj2` published — the chain would break silently at the point it looked most healthy.

---

### Task 3: PR lifecycle and readiness colour

**Files:** `src/pr/lifecycle.ts`; test `tests/pr/lifecycle.test.ts`

**Produces:**
- `type PrState = "ready" | "blocked" | "merged" | "failed"`
- `openUpdatePrs(entries, gh, branch): Promise<Map<string, number>>` — reuses `openChangesetPrs` from `src/github/orchestrator.ts`; do not write a second PR opener.
- `classifyPr(entry, entries, published: Set<string>): PrState` — `ready` when every in-chain dependency of `entry` is already in `published`; `blocked` otherwise.

`classifyPr` is pure and takes the published set explicitly, so the rule is testable without GitHub and the UI cannot invent its own colouring.

**Tests must cover:**

```ts
test("an entry with no in-chain dependencies is ready", ...)
test("an entry whose dependency has not published is blocked", ...)
test("the same entry becomes ready once its dependency publishes", ...)
test("only in-chain dependencies matter — an unrelated unpublished package does not block", ...)
```

---

### Task 4: The Auto Merge train

**Files:** `src/pr/train.ts`; test `tests/pr/train.test.ts`

**Produces:** `runTrain(entries, prs, deps: TrainDeps): Promise<TrainOutcome>` — merges ready PRs, waits for each publish to become resolvable, re-classifies, and advances until every PR is merged or the train stalls.

**This is where the cascade's known hazards live, and each is already measured:**

- **Wait for the published version to be resolvable before advancing.** `unified-cicd.yml`'s `check-npm-version` is an idempotency guard, not a propagation wait. Advancing early makes the next repo's install fail against a version that does not exist yet, and the chain stalls on the exact race the design removes.
- **A stall must be reported, never silent.** A train that stops advancing with no signal is this project's defining failure mode. `TrainOutcome` names which PR stalled and why.
- **Nothing merges out of order.** Only `ready` PRs merge, and readiness is recomputed after each publish rather than assumed from the initial ordering.

Every dependency — merge, publish-check, clock — is injected. No test sleeps on a real timer.

**Tests must cover:**

```ts
test("merges a single-entry chain and reports success", ...)
test("merges bottom-up, never touching a blocked PR", ...)
test("waits for resolvability before advancing to the next level", ...)
test("stalls loudly, naming the PR, when a merge fails", ...)
test("stalls loudly when a publish never becomes resolvable", ...)
test("re-classifies after each publish rather than trusting the initial order", ...)
```

---

### Task 5: HTTP surface

**Files:** `src/server/api.ts`; test `tests/server/api.test.ts`

Routes the app calls, each thin over the modules above:

| Route | Returns |
|---|---|
| `GET /api/repos` | repo list with name, private flag, prepared state |
| `GET /api/graph` | nodes and edges, each edge tagged `dependency` or `devDependency` |
| `POST /api/update` | `{ pkg, mode: "one" \| "chain" }` → the changeset it would create |
| `POST /api/prs` | opens the PRs for a changeset, returns them with states |
| `POST /api/merge` | merges one PR |
| `POST /api/train` | starts the Auto Merge train |

**`POST /api/update` must return the changeset without opening anything.** A user is entitled to see exactly which repos and which version bumps before any PR exists, and the two-step shape is what makes that possible.

Reuse the auth and token plumbing from `src/cli/deps.ts` rather than building a second wiring path.

---

### Task 6: Repo list and graph

**Files:** `src/web/RepoList.tsx`, `src/web/Graph.tsx`; tests alongside

- The list is searchable by substring across a couple of hundred repos, and shows which are prepared.
- The graph draws nodes and edges with **`dependency` and `devDependency` in visibly different colours**, with a legend. That distinction is the whole reason the two walks differ, so the picture has to carry it.
- Selecting a node in either view selects it in the other.

Keep the rendering dependency-free — inline SVG over a graph library. A layered layout by dependency level is enough; this is a tool, not a diagramming app.

---

### Task 7: Update actions and PR status

**Files:** `src/web/Updates.tsx`; test alongside

- **Update** and **Update Chain** on the selected project, each first showing the changeset — repos, current version → new version — and requiring confirmation before any PR is opened.
- Once open, each PR is coloured by `PrState`: ready, blocked, merged, failed. The colours come from `classifyPr`, never recomputed in the component.
- **Merge** on an individual ready PR.
- **Auto Merge** to run the train, with the graph updating as it advances.

A blocked PR must say *what it is waiting for*, by name. "Blocked" alone sends someone to GitHub to work out why.

---

## Cut List

1. Task 6's graph layout sophistication — a level-ordered list with coloured edge labels conveys the same information.
2. Task 7's live updating during the train — a refresh button is honest and simpler.

**Never cut:** Task 1's direction test, Task 2's bumped-version test, or Task 4's stall reporting. Each is the difference between a chain that works and one that fails silently at the point it looks healthiest.

---

## Self-Review Notes

**Assumption stated:** "Update" refreshes the selected repo's own direct `@scope` dependencies to their latest published versions. The requirements' phrase about `proj4` receiving "the latest version of proj1" cannot hold literally — `proj1` is a devDependency of `proj2`, so a published `proj2` never carries it, and `proj4` can only receive `proj1` by depending on it directly. The later sentence — "the selected project should have all its devDependencies and dependencies updated" — is the reading implemented here.

**Reuse:** `openChangesetPrs`, `GhClient`, `computeChangeset`'s bump logic, the supervisor's `Cascade`, and the auth wiring in `deps.ts` are all reused. The only genuinely new graph operation is `dependencyClosure`.

**Deployment excluded** by instruction. The train therefore polls rather than consuming webhooks; the poller already exists.
