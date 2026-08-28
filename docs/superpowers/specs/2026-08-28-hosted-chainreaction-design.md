# ChainReaction (Hosted) — Atomic Change Across a Polyrepo Dependency Graph

**Date:** 2026-08-28
**Supersedes:** `2026-08-28-cascade-agent-design.md` (local-tool design)
**Status:** Design, pending approval

---

## 1. What changed and why

The original design was a local tool run by one developer against `~/projects`. It works, and eight
reviewed PRs implement most of it. But it has a defect that only shows up in use: **a cascade takes
10–15 minutes and can stall at 2am.** A local tool cannot supervise a cascade after the developer
closes their laptop — so the supervisor, the entire reason this is more than a script, stops working
exactly when it matters most.

Hosting fixes that, and two other things follow from it:

- **Webhooks replace polling.** A public URL receives `workflow_run` and `check_suite` events, so the
  cascade becomes event-driven. The poller becomes a reconciliation fallback, not the mechanism.
- **TrueForge fits natively.** Its MCP transport is remote-only (`streamable-http` | `sse`, no stdio).
  That forced local-mode TrueForge before; hosted, a public MCP endpoint is simply reachable.

The problem statement is unchanged. In `~/projects`, **57 repositories depend on
`@sudobility/design`**, and a change to it transitively affects **60**. Every level is gated on the
previous level's *publish*, not merely its merge, so a downstream PR opened early is red by
construction. Dependabot and Renovate open the PR and stop; neither understands that repo B cannot go
green until repo A has published, and neither fixes the breakage the bump causes.

## 2. The hard problem, and where it goes

Hosting creates one serious problem: **sandbox validation means running arbitrary customer code.**
Their build scripts, their tests, their `postinstall` hooks. Measured on the real five-repo chain:
**1296 packages, 77 seconds** just to install. A 60-repo affected set is minutes of CPU and gigabytes
of disk, per validation, per user. Hosting that means microVM isolation, compute cost exposure, and —
worst — asking customers for npm credentials so their private packages resolve.

**So we do not host it. Validation runs in the customer's own GitHub Actions.**

ChainReaction dispatches a single workflow job into one of their repos. That job checks out the whole
affected set, assembles it as one Bun workspace, runs `assertLinked`, builds and tests every member,
and reports results back. Their runner, their toolchain, their secrets, their minutes.

This is not a compromise. It is better:

| | Hosted sandbox | Customer CI |
|---|---|---|
| Arbitrary code on our infra | yes | **never** |
| Registry credential custody | required | **none** |
| Compute cost per validation | ours | theirs, already budgeted |
| Environment fidelity | approximate | **exact** |

The control plane keeps what hosting is genuinely good at — always-on supervision, webhooks, the DAG,
the approval gate — and pushes the dangerous, expensive part back to where it already runs safely.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                          │
│  Sign in · repo list + graph · Prepare · Trigger · live DAG       │
└───────────────────────────┬──────────────────────────────────────┘
                            │ SSE
┌───────────────────────────┴──────────────────────────────────────┐
│  ChainReaction control plane (public)                             │
│  GitHub App auth · cascade state · webhook sink · SSE fanout      │
│  MCP server (streamable-http) ──────────────┐                     │
└───────────────────────────┬─────────────────┼────────────────────┘
                            │                 │
              GitHub API    │                 │  MCP over HTTPS
                            │                 │
┌───────────────────────────┴──────┐   ┌──────┴───────────────────┐
│  Customer's GitHub               │   │  TrueForge (hosted)       │
│  repos · Actions (validation)    │   │  agent loop · sessions    │
│  PRs · auto-merge · npm publish  │   │  approvals · subagents    │
└──────────────────────────────────┘   └───────────────────────────┘
```

### 3.1 Identity: a GitHub App

Not an OAuth App and not a PAT. Users **install** ChainReaction on the repos they choose; the control
plane mints short-lived installation tokens from the App private key. Nothing long-lived is stored on
our side beyond the installation id.

Permissions requested:

| Permission | Level | Why |
|---|---|---|
| Contents | read & write | read manifests, push changeset branches |
| Pull requests | read & write | open PRs, enable auto-merge |
| Actions | read & write | dispatch validation, re-run a waiting PR's checks |
| Administration | write | **Prepare** sets branch protection and `allow_auto_merge` |
| Metadata | read | mandatory |
| ~~Workflows~~ | **not requested** | writing `.github/workflows/**` is 403 without it; we require the customer to add the validation workflow instead — see §3.2 |
| Webhooks | — | `workflow_run`, `check_suite`, `pull_request`, `push` |

The App identity also solves a bug the local design hit in practice: **GitHub refuses to let anyone
approve their own pull request** (verified: `Can not approve your own pull request`). With the App
opening PRs and the user's own identity available for review, a two-identity flow is possible where a
customer's protection rules require reviews. Where they don't — our default — no approval is needed
at all, and Gate 1 is ChainReaction's own approve button.

### 3.2 Prepare for Chain Reaction

A repo may participate only after it is **prepared**. Prepare is an explicit, user-initiated action
per repo that:

1. Enables `allow_auto_merge` on the repository.
2. Sets branch protection on the default branch requiring **status checks only, never reviews**.
3. Verifies that `.github/workflows/chainreaction-validate.yml` exists on the default branch, and
   shows the file to add when it does not.

**Step 3 is manual by choice, and the choice is deliberate.** A GitHub App cannot write any path
under `.github/workflows/` without the separate `Workflows: write` permission — measured against a
real installation:

```
PUT contents cr-probe.txt                    -> 201 OK
PUT contents .github/workflows/cr-probe.yml  -> 403 Resource not accessible by integration
```

We do not request that permission. It means *this app can modify your CI*, it applies to every repo
in the installation rather than only prepared ones, and it is exactly the permission a team should
hesitate over for a product whose job is touching their release pipeline. Not asking for it is a
trust advantage; it can be added later as a convenience, but it cannot be un-asked.

The cost is honest: adding a file per repo is real friction at 60 repos. Prepare mitigates it by
showing the exact file and verifying it landed, so an unprepared repo is greyed out with a stated
reason rather than silently stalling a cascade at level 3.

Making the precondition explicit and gating participation on it converts an invisible failure into a
visible one — a repo that was never prepared is greyed out with a reason, rather than silently
stalling a cascade at level 3.

Two measured constraints:

- **Neither branch protection nor rulesets work on a free-tier private repo.** Both measured against
  the same private repo, both HTTP 403:
  `Upgrade to GitHub Pro or make this repository public to enable this feature`
  (`PUT /branches/main/protection` and `POST /rulesets` alike). The open question is answered, and the
  answer is negative: rulesets are not an escape hatch.
- **Auto-merge needs an unsatisfied requirement to wait on.** A PR with nothing blocking it is simply
  mergeable, so protection must set at least one *required status check*.

**Consequence: auto-merge cannot be the only merge mechanism, or the product excludes every free-tier
private repo.** The escape is that a hosted, always-on control plane does not need GitHub to merge on
its behalf. It already receives `check_suite` webhooks; when a waiting PR's checks go green it can
simply call the merge API itself. Two mechanisms, chosen per repo at Prepare time:

| Repo can be protected | Merge mechanism |
|---|---|
| yes | GitHub auto-merge, armed at launch — survives our downtime |
| no (free-tier private) | **control-plane merge** on the `check_suite` green webhook |

This reframes Prepare rather than removing it. Prepare still verifies access, records which mechanism
a repo will use, and gates participation on a successful check — so an unpreparable repo is greyed out
with a stated reason instead of silently stalling a cascade at level 3. Where protection is available
it is still applied, because it also stops a human merging level 3 before level 1 has published.

The cost of the fallback is honest: a control-plane merge depends on us being up, whereas an armed
auto-merge does not. That is a real difference in failure mode and Prepare should say which one a repo
got.

### 3.3 Validation in customer CI

`validate_changeset` dispatches `chainreaction-validate.yml` — the workflow the customer added during
Prepare — via `workflow_dispatch` in one repo of the installation. GitHub requires a dispatchable
workflow to exist on the default branch, which is why Prepare verifies it rather than assuming it.

**The workflow holds no credentials.** It authenticates to the control plane with a GitHub Actions
**OIDC token**, which is signed by GitHub and carries verifiable `repository` and `repository_owner`
claims. The control plane validates it against GitHub's JWKS and returns a short-lived installation
token scoped to the affected repos, along with the changeset. Nothing is stored in the customer's
secrets, and nothing sensitive appears in a workflow input or a log line.

```yaml
name: ChainReaction Validate
on:
  workflow_dispatch:
    inputs:
      cascade_id: { required: true, type: string }

permissions:
  id-token: write   # request the OIDC token
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: oven-sh/setup-bun@v2
      - name: Exchange OIDC token for a scoped checkout token
        id: auth
        run: |
          OIDC=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=chainreaction" | jq -r .value)
          curl -sS -X POST "$CR_URL/api/ci/claim" \
            -H "authorization: Bearer $OIDC" \
            -d "{\"cascade_id\":\"${{ inputs.cascade_id }}\"}" -o /tmp/cr.json
        env:
          CR_URL: https://chainreaction.dev
      - name: Assemble the workspace and validate
        run: bunx @chainreaction/validate /tmp/cr.json
```

The heavy lifting lives in a published `@chainreaction/validate` package rather than inline YAML, so
the file customers paste stays short enough to read and audit, and fixes ship without asking 60 repos
to update a workflow.

That job:

1. Checks out every repo in the affected set using an installation token.
2. Writes a private workspace root listing them all as members.
3. `bun install`.
4. **`assertLinked`** — proves every intra-subgraph edge resolved to a symlink into a local member.
   Bun silently installs the *registry* copy when a declared range is not satisfied, and the install
   still succeeds; without this check, validation reports a confident PASS while testing published
   code instead of the changeset.
5. Builds and tests each member in topological order.
6. Posts results back to the control plane.

Behind an interface with two implementations, so the local path we already built stays alive:

```ts
interface Validator {
  validate(changeset: ChangesetEntry[]): Promise<ValidationResult[]>;
}
```

`LocalWorkspaceValidator` (built, reviewed, PR #3) and `ActionsValidator` (new). Same `assertLinked`
contract, same `ValidationResult`.

### 3.4 The cascade

Unchanged in principle, with the dispatch shim deleted. Because the control plane holds an
installation token, **it performs the downstream re-run itself** rather than asking a workflow to do
it. No `repository_dispatch` step in `unified-cicd.yml`, no `cascade_rerun` job in ~100 repo stubs, no
per-repo secret. **Nothing about a customer's CI configuration changes to adopt ChainReaction.**

1. Approved changeset → push a branch and open a PR per repo, arm `--auto --squash` on each.
2. Level 0 is green → auto-merges → publishes.
3. Control plane observes the publish (`workflow_run` webhook), **waits for the version to be
   resolvable on npm**, then re-runs the waiting downstream PR's failed checks via the Actions API.
4. That PR goes green, auto-merges, publishes, and the cycle repeats to the leaves.

The npm wait is mandatory. `unified-cicd.yml`'s `check-npm-version` compares local against published
purely to decide whether to publish — it is an idempotency guard, **not** a propagation wait. Firing a
re-run before the version resolves fails the downstream install against a version that does not exist
and stalls the cascade on the exact race this design removes.

Two mechanism facts, both measured on real infrastructure:

- A `repository_dispatch` run carries **no PR association** — its check attaches to the default
  branch's SHA, never the PR head. Dispatch alone can never turn a waiting PR green.
- Re-running the PR's own `pull_request` run **does** turn it green once external state resolves.

### 3.5 Supervision

The control plane owns cascade state and is always on. Webhooks drive transitions; a reconciliation
poll catches anything missed. `Cascade` seeds a last-change timestamp for every package at
construction, so a node stuck at `pending` since the start — the likeliest stall there is — is
detectable. Once `stalled`, a node stays stalled until GitHub reports genuine resolution; otherwise
the flag erases itself on the next poll and a dead cascade reads as busy forever.

### 3.6 TrueForge

The agent is where judgment is required, and nowhere else. Graph resolution, version bumping, PR
mechanics, webhook handling and stall detection are deterministic and stay as plain TypeScript.

ChainReaction exposes a **streamable-http MCP server** on its public URL, registered once in
TrueForge's connectors and referenced by name from an `AgentSpec`:

| Tool | Approval |
|---|---|
| `list_repos` / `prepare_repo` | `prepare_repo` requires approval |
| `plan_cascade(changedPkg, targets)` | none — read-only |
| `validate_changeset(entries)` | none — dispatches CI, publishes nothing |
| `launch_cascade(entries)` | **required** |
| `cascade_status()` | none |

Gate 1 is declarative, not code:

```ts
mcpServers: [{
  name: "chainreaction",
  requireApprovalForTools: ["launch_cascade", "prepare_repo"],
}]
```

TrueForge emits `tool.approval_required` on the turn stream carrying the pending tool calls; the web
app renders the changeset and answers with a `user.tool_approval` turn input. **Sessions** matter
here for a real reason: a cascade outlives any single turn.

The agent earns its place on the **repair path**. When a level stalls, a subagent reads the failing
job's logs, determines whether the breakage is a renamed export, a type error or a peer-dependency
conflict, proposes a patch, and re-validates through the same `Validator` interface. That is judgment
over unstructured text, and it is the one part genuinely painful to write as deterministic code.

## 4. What carries forward

| PR | Component | Status under this design |
|---|---|---|
| #1 | `affectedSubgraph`, `topoLevels` | unchanged, pure graph functions |
| #1 | `scanRepos` (filesystem) | keeps working locally; needs an API-backed sibling |
| #2 | `changeset.ts` incl. the scoping guard | unchanged |
| #3 | workspace validator + `assertLinked` | becomes `LocalWorkspaceValidator`; `assertLinked` reused verbatim by `ActionsValidator` |
| #5 | `GhClient`, `orchestrator` | unchanged; token source becomes an installation token |
| #6 | `dependentsOf` | unchanged |
| #7 | `Cascade`, `detectStall` | unchanged |
| #8 | SSE server, DAG view | extended with auth, repo list, prepare |

Deleted: the `repository_dispatch` sender, the `cascade_rerun` receiver, and every per-repo secret.
Never written: `src/harness/agent.ts`.

## 5. Sequencing

The hackathon window closes **2026-08-30 20:00 London**. A complete hosted product does not fit, and
pretending otherwise produces neither a product nor a submission. So the phases are ordered such that
the submission is a genuine slice of the product, not a detour.

**`ActionsValidator` is not deferrable, and an earlier draft of this section was wrong to defer it.**
A hosted control plane cannot run `LocalWorkspaceValidator` — there is no local machine. Pairing
hosted orchestration with local validation produces a hybrid that is neither the product nor a
coherent demo. Validation in customer CI *is* the hosted validation path, so it belongs in the first
phase and something else gets cut instead.

**Phase 1 — the working core.** GitHub App and install flow, repo list and graph, Prepare, Trigger,
`ActionsValidator`, the cascade with control-plane-driven re-runs, live DAG, public MCP server, and
the TrueForge agent with its declarative approval gate. This satisfies every hackathon requirement and
is a real, if narrow, product.

Cut from Phase 1, in this order if time runs short: the repair subagent (§3.6), organisation and
multi-installation support, the graph visualisation beyond a topological list, and stall *diagnosis*
narrowing to halt-and-report.

**Phase 2 — repair.** The stall subagent: read the failing job's logs, diagnose, patch, re-validate.

**Phase 3 — breadth.** Organisations, multiple installations, non-npm ecosystems.

`LocalWorkspaceValidator` (PR #3) is not throwaway: it stays the implementation used by the CLI and by
tests, and `assertLinked` is shared verbatim with `ActionsValidator`.

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| ~~Rulesets vs branch protection plan gating~~ | **resolved** — both 403 on free-tier private repos; control-plane merge is the fallback | measured, §3.2 |
| Deployment target unproven for a public MCP endpoint | High | Prove one round-trip from hosted TrueForge before building tools on it |
| `ActionsValidator` checkout of N repos hits token/permission limits | **High** — it is now Phase 1 and the only validation path | Prove a two-repo checkout and build under an installation token before anything else in Phase 1 |
| Validation consumes customer Actions minutes at 60-repo scale | Medium | Show the estimate before Trigger; let the user scope the target set |
| Self-approval blocks `armAll` where protection requires reviews | Medium — **measured**, not theoretical | Prepare sets checks-only protection; two-identity flow only where a customer overrides it |

## 7. Open questions

1. Deployment target for the control plane — Cloudflare Workers with Durable Objects for cascade state
   and SSE fanout matches the existing `wrangler` experience, but Workers cannot host TrueForge itself.
2. Where TrueForge runs — self-hosted (its hosted mode wants Postgres + Redis) or a managed instance.
3. Whether Prepare should offer to *create* a minimal CI workflow for a repo that has none, given that
   a repo with no required status check cannot participate.
