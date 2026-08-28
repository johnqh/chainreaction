# ChainReaction — Atomic Change Across a Polyrepo Dependency Graph

**Date:** 2026-08-28
**Event:** Agent Harness Hackathon (TrueForge) — build window closes 2026-08-30, 20:00 London
**Status:** Design, pending approval

---

## 1. Problem

A monorepo gives you atomic cross-cutting change for free: edit a shared component, and every
consumer compiles against it in the same commit. A polyrepo org has no such thing.

In `~/projects`, **59 repositories depend on `@sudobility/design`.** Changing one token in the
design system means:

1. Bump and publish `@sudobility/design`.
2. Wait for npm propagation.
3. Bump `@sudobility/components` to the new range, wait for its CI, merge, publish.
4. Repeat for `di_web`, then `building_blocks`, then each of the 50+ leaf apps.

Every level is gated on the previous level's **publish**, not merely its merge. A downstream PR
opened early is red by construction — its CI resolves `@sudobility/design@^1.2.0` from the registry,
where that version does not yet exist. So the human ends up approving PRs in dependency order, one
level at a time, waiting on a publish between each. A five-level chain is five round trips. Fifty-nine
repos is a week.

The existing tooling does not help. Dependabot and Renovate open the PR and stop; neither understands
that repo B's PR cannot go green until repo A has published, and neither fixes the breakage the bump
causes.

## 2. What ChainReaction Is

An agent that takes a single change to an upstream package and drives it all the way to every
downstream consumer — validating the entire affected subgraph *before* anything is published,
then letting the change cascade through GitHub unattended, with exactly one human approval at the
front and an interrupt only when reality diverges from what was validated.

The insight the design turns on: **validation and publication must be decoupled.** Validation happens
once, in a sandbox, against source. Publication happens afterward, in topological order, driven by
GitHub's own machinery rather than by the agent holding a loop open.

## 3. Scope

### In

- Compute the affected subgraph from a changed package, in topological order.
- Validate the whole subgraph in one sandbox using local overrides — no publishes.
- Open PRs across every affected repo, sweep-approve, arm auto-merge.
- A `repository_dispatch` cascade so each publish re-triggers the next level's CI.
- Supervise the cascade; detect stalls; diagnose; re-interrupt the human on divergence.
- One web screen: live DAG, approval gate, log drawer.

### Out (explicitly)

- Multi-family support. The demo pins one subgraph; the resolver is general, the rehearsal is not.
- Rollback. npm publishes are not cleanly reversible; a halted train leaves published levels in place.
- Webhooks. Polling only — a public tunnel is a dependency we will not take on in two days.
- Any settings UI, repo browser, or auth beyond a token in `.env`.
- Cross-org support. `johnqh/*` only.

### The scoping guard

A naive run against `@sudobility/design` would try to publish 59 repos. The agent **must** take an
explicit target set or depth limit. Default behavior is to compute the full affected set, show it,
and refuse to proceed without either an explicit `--targets` list or `--all` plus approval. This is a
correctness requirement, not a convenience.

## 4. Architecture

Four components. Credentials live only in the harness layer.

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (React, TrueForge React SDK)                       │
│  DAG view · Approve button · log drawer. No tokens.         │
└────────────────────────┬────────────────────────────────────┘
                         │  SSE (state down) / resolve-interrupt (up)
┌────────────────────────┴────────────────────────────────────┐
│  TrueForge harness (Bun/TS, local)                          │
│  Agent loop · session · sandbox · interrupts · subagents     │
│  Holds GITHUB_APP_TOKEN, NPM_TOKEN                           │
└────────────────────────┬────────────────────────────────────┘
                         │  gh CLI inside sandbox / GitHub MCP
┌────────────────────────┴────────────────────────────────────┐
│  GitHub                                                      │
│  unified-cicd.yml · repository_dispatch · auto-merge · npm   │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 Graph resolver

Reads every `package.json` under `~/projects`, maps npm name → local dir → GitHub repo, builds the
dependency DAG over `@sudobility/*` edges only, and computes the affected subgraph plus a topological
order. Pure function over the filesystem; no network, no agent. Fully unit-testable, and it should be
the first thing written and the first thing tested.

### 4.2 Sandbox validator

One TrueForge **sandbox** holds the entire affected subgraph checked out together. Every
`@sudobility/*` dependency edge inside the subgraph is rewritten to a local path / `workspace:`
override, so the whole cascade builds and tests against source with zero publishes. If a level breaks,
a **subagent** scoped to that repo fixes it in place and re-validates.

This is the only place a cross-repo change can be proven correct as a unit, and it is the single
strongest justification for the harness in the whole project.

Output: a validated changeset — per-repo diffs, new version numbers, and the test results that
justified them.

### 4.3 Cascade orchestrator

Once the human approves the changeset:

1. Push a branch per repo, open a PR per repo. Levels 2+ are red; nobody is looking at them yet.
2. Sweep `gh pr review --approve` across all PRs, then `gh pr merge --auto --squash` on each. Every PR
   is now armed to merge itself the instant its checks pass.
3. Level 0's PR is already green → auto-merges → `unified-cicd.yml` publishes to npm →
   **the publish job fires a `repository_dispatch` at each direct dependent.**
4. Each dependent receives the dispatch, waits for the new version to be resolvable, re-runs CI on its
   open PR branch, goes green, auto-merges, publishes, dispatches onward.
5. The cascade runs to the leaves with nobody watching.

Approval and ordering become independent concerns. The human approves once, up front; ordering is
enforced by the dependency graph itself. Critically, **the cascade lives in GitHub, so it survives the
agent's process dying** — which is strictly more robust than an agent holding an imperative loop open
for fifteen minutes.

### 4.4 Supervisor + web app

GitHub provides the cascade. It does not provide supervision. A level goes red at 2am and the chain
stalls *silently* — no error, nothing moves, and half the fleet is on the new version while half is not.

The supervisor polls `gh run list` / `gh pr view` on a few-second tick, maintains DAG node state, and
pushes deltas to the browser over SSE. On a stall it diagnoses in the sandbox, compares against what
was validated, and raises a TrueForge **interrupt** carrying the divergence.

The web app is one screen: the DAG laid out topologically, each node lit by state
(`pending · validated · pr-open · ci-running · merged · published · stalled`), edges animating as the
cascade propagates, one Approve button for the whole changeset, and a log drawer on node click.

## 5. The dispatch shim

Every repo's `.github/workflows/ci-cd.yml` is a ~25-line stub delegating to
`johnqh/workflows/.github/workflows/unified-cicd.yml@main`.

Therefore the `repository_dispatch` step is added **once**, in `~/projects/workflows`, and all ~100
repos inherit it on their next run. There is no bootstrap PR per repo. This was the largest plumbing
cost in the original plan and it is eliminated by infrastructure that already exists.

`unified-cicd.yml` already guards publishes with a `check-npm-version` / `version_exists` check, so
re-running a level is idempotent — that is the stall-recovery safety net, for free.

### Known GitHub constraints

| Constraint | Consequence |
|---|---|
| Events dispatched with the default `GITHUB_TOKEN` do not trigger workflow runs in the target repo | The dispatch step needs a GitHub App installation token or PAT |
| GitHub blocks approving your own PR | The agent opens PRs under an App identity; the human's sweep-approve is a separate identity |
| npm propagation races the dispatch | The downstream workflow must poll for version resolvability before `bun install` |
| `--auto` requires branch protection with required status checks | Detect absence and fall back to polling + explicit merge |

## 6. Approval model

Exactly two interrupts, and the second one usually never fires:

- **Gate 1 — approve the changeset.** After sandbox validation, before any PR exists. The human sees
  the full affected set, the diffs, the version bumps, and the test results. One decision.
- **Gate 2 — divergence.** Fires only when the cascade stalls or when CI observes something the
  sandbox did not. Carries the diff between validated and actual.

The contrast with the status quo is the demo: 59 PRs and 59 ordered approvals across a week, versus
one approval and a graph that lights up.

## 7. Failure handling

A level goes red mid-cascade after upstream levels have already published. npm publishes cannot be
cleanly retracted, so there is no rollback. The train **halts**, leaves published levels in place,
and raises Gate 2 with the divergence attached.

Self-repair — the agent fixes the failing level, re-validates in the sandbox, and resumes the cascade —
is the better product and the better demo, and is also the piece most likely to consume the remaining
budget. It is therefore the **first cut** (see §10).

## 8. Demo

The payload is chosen to be *visible*, which is what makes this a demo rather than a log.

Chain (verified against the real graph):

```
@sudobility/design      (design_system)          ← repoint `defaultTheme` at another preset
   └→ @sudobility/components   (mail_box_components)
        └→ @sudobility/di_web
             └→ @sudobility/building_blocks
                  └→ sudobility-landing (sudobility)   ← refresh, the whole page has changed palette
```

**The payload is a theme swap, not a hex tweak.** `design_system` ships 46 theme presets
(`src/themes/presets/`: `commodore-64`, `vaporwave`, `game-boy`, `neo-brutalism`, `dracula`, `nord`,
`y2k`, …), and `sudobility/src/main.tsx` does:

```ts
import { configureTheme } from '@sudobility/design';
import { defaultTheme, generateThemeCSS } from '@sudobility/design/themes';
configureTheme(defaultTheme);
```

The app imports `defaultTheme` **by name** and pins no preset of its own. So a one-line change at the
deepest upstream repaints the entire landing page while the app's own diff stays empty — which is
exactly the claim being demonstrated. A single button changing hue is hard to see on video and easy
to attribute to a cache; a whole-page palette transformation that provably required four publishes
to arrive is not.

Five levels. `building_blocks` pulls in 11 `@sudobility` packages, so the rendered graph is a real DAG,
not a line.

**Script:** repoint `defaultTheme` in `design_system` → agent computes the affected set and
validates all five repos in one sandbox → one Approve click → cascade runs live in the DAG view →
refresh the landing page, the button has changed.

### Demo constraints

- **`sudobility` has no `.github/workflows`.** It is a Cloudflare app (`wrangler.toml`), so the final
  hop is a deploy, not a publish. Wire Cloudflare Pages auto-deploy on merge to main; fall back to a
  local `bun install && bun dev` if that fights back.
- **The cascade takes ~10–15 minutes.** Four sequential publishes, each gated on its own CI. The demo
  video is three minutes. Start the cascade at the top of the presentation and let the DAG animate
  while narrating; time-lapse it for the video.
- **Every rehearsal burns real npm versions permanently** in a public namespace. Rehearse against a
  local Verdaccio; run live against npm once.

## 9. Hackathon deliverables

| Requirement | How it is met |
|---|---|
| Runs on TrueForge, harness doing substantive work | Sandbox, subagents, interrupts, sessions, MCP — each load-bearing, §4 |
| Public open-source repo + README | `~/projects/chainreaction` |
| Qodo review evidence | Branch-and-PR from the first commit; never commit to main |
| 3-minute demo video | §8, time-lapsed |
| Write-up | Derived from this spec |
| Best UI track | §4.4, the DAG cascade view |

**Qodo is a process constraint starting now.** Retrofitting PR history on Aug 30 forfeits the Code
Quality track. Every substantive change goes through a PR that Qodo reviewed before merge.

## 10. Budget

~20 working hours: the evening of Aug 28, all of Aug 29 (in person in SF), the morning of Aug 30.

| Work | Hours |
|---|---|
| Scaffold + TrueForge hello-world agent | 2 |
| Graph resolver (+ tests) | 2 |
| Sandbox validator | 3 |
| GitHub orchestration (PRs, sweep-approve, auto-merge) | 3 |
| Dispatch shim in `workflows` | 2 |
| Web app: DAG view, approval gate, SSE | 4 |
| Stall detection + supervisor | 2 |
| Rehearsal, video, README, Qodo evidence | 3 |
| **Total** | **21** |

Over budget by design. **Cut list, in order:** self-repair (§7) → Verdaccio rehearsal path → stall
diagnosis narrows to "halt and report" → DAG view degrades to a static topological list with status
badges.

The last two hours are reserved for the video and README regardless of feature state. A working demo
with three features beats a broken one with six.

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Dispatch cascade does not fire (token scope) | **High** — it is the core mechanism | Prove the two-repo dispatch hop *first*, before anything else is built |
| Sandbox override rewriting fights Bun resolution | High | Validate the five-repo chain manually before automating |
| Cascade too slow to demo live | Medium | Time-lapse; narrate over it |
| npm version pollution from rehearsals | Medium | Verdaccio for rehearsal |
| Scope sprawl to 59 repos | Medium | Hard target-set guard, §3 |

**The first thing built must be the riskiest thing:** a two-repo dispatch hop proving that a publish in
repo A re-triggers and auto-merges a red PR in repo B. If that does not work, the entire architecture
is wrong and it is better to know in hour two than hour fifteen.

## 12. Open questions

1. Cloudflare Pages auto-deploy on the landing app, or local `bun dev` for the final hop?
2. Does `johnqh/workflows` change go through a PR too, or is it treated as infrastructure?
3. GitHub App or PAT for the dispatch identity?
