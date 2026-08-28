# Spike Findings

Empirical results that changed the design. Each was measured, not inferred.

---

## 1. The cascade mechanism (Task 1)

**Question:** can a `repository_dispatch` from an upstream repo turn a downstream repo's red PR green and let auto-merge fire?

**Answer: no.** The originally planned mechanism does not work.

Measured on `johnqh/cr-spike-b`, with a workflow gated on external state:

| Step | Observed |
|---|---|
| PR opened while the gate was unsatisfied | check `FAILURE` — the "red by construction" state |
| `repository_dispatch` fired; run **succeeded** on `main` | PR check **still `FAILURE`** |
| Gate satisfied, then `gh run rerun <id> --failed` on the PR's own run | run `SUCCESS`, PR check `SUCCESS` |

A `repository_dispatch` run carries **no PR association**. Its check attaches to `main`'s SHA and never to the PR head, so `gh pr merge --auto` never fires. A cascade built on it would stall silently at level 1 — no error, nothing moving, half the fleet upgraded and half not.

**The design that works:** the dispatch payload carries the downstream branch, and the receiving workflow re-runs *that PR's own* failed run.

```yaml
on:
  repository_dispatch:
    types: [upstream-published]

jobs:
  cascade_rerun:
    if: github.event_name == 'repository_dispatch'
    runs-on: ubuntu-latest
    steps:
      - name: Re-run the waiting PR's own failed checks
        env:
          GH_TOKEN: ${{ secrets.CR_DISPATCH_TOKEN }}
          BRANCH: ${{ github.event.client_payload.branch }}
        run: |
          RUN_ID=$(gh run list -R "${{ github.repository }}" \
            --branch "$BRANCH" --event pull_request \
            --limit 1 --json databaseId --jq '.[0].databaseId')
          if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
            echo "no pull_request run found for $BRANCH"; exit 0
          fi
          gh run rerun "$RUN_ID" --failed
```

Two consequences, both binding:

- `client_payload.branch` is **mandatory**. Without it the handler cannot locate the run.
- `CR_DISPATCH_TOKEN` needs **`actions: write`** as well as `contents: write`. A `contents`-only token fires the dispatch and then silently fails to re-run anything — which looks exactly like a stalled cascade.

**Not verified:** auto-merge arming. GitHub requires a paid plan for branch protection on private repos, and the spike repos were private. The real target repos are public, so this is a spike-environment limit rather than a design risk. Verify during rehearsal.

---

## 2. Bun workspace linking (Task 4)

**Question:** does staging the affected repos as a Bun workspace actually resolve `@sudobility/*` to local sources, rather than fetching from npm?

**Answer: yes** — with a sharp edge.

Measured on the real five-repo chain (`bun 1.3.10`, 1296 packages, 77s):

```
mail_box_components -> @sudobility/design           SYMLINK ../../../design_system
di_web              -> @sudobility/components       SYMLINK ../../../mail_box_components
building_blocks     -> @sudobility/di_web           SYMLINK ../../../di_web
sudobility          -> @sudobility/building_blocks  SYMLINK ../../../building_blocks
```

No `overrides` or `file:` specifiers needed. Two behaviours differ from the obvious assumption:

1. **Bun does not hoist workspace members to the root `node_modules`.** The root `node_modules/@sudobility` is *empty*; links live in each member's own `node_modules`. A check looking at the root would wrongly conclude linking failed.

2. **Linking is conditional on the declared range being satisfied by the local version.** When a range does not match, Bun silently installs the **registry** copy. The install still succeeds, and validation then tests published code instead of the changeset — a confident false PASS.

That second point is why `assertLinked` exists. Without it, the validator's entire promise — *proven against source before anything publishes* — can quietly be false, and the failure only surfaces after a bad cascade has reached npm.

---

## 3. The TrueForge SDK surface (Task 9)

**Question:** how are ChainReaction's four operations registered as agent tools?

**Answer: not the way the plan assumed.** Read from the shipped `.d.ts` files of `@truefoundry/trueforge-sdk@0.1.3`, because the published prose summary was wrong on this point.

- The SDK is a Fern-generated REST client for a TrueForge **server**. There is no in-process agent runtime.
- `AgentSpec = { model, instructions?, mcpServers?, skills?, config?, responseFormat?, messages? }` — **no `tools` field**. Tools reach an agent only through MCP.
- `McpServerType` is `"remote"` **only**; transports are `streamable-http` | `sse`. **No stdio.**
- `mcpServers` exposes no `create()`; servers are configured server-side and referenced by name.

So ChainReaction runs its own **streamable-http MCP server**, and TrueForge must run in **local mode** — a hosted instance could not reach a laptop-hosted MCP server without a tunnel.

The consolation: the approval gate got simpler than planned. It is configuration, not code.

```ts
mcpServers: [{ name: "chainreaction", requireApprovalForTools: ["launch_cascade"] }]
```

`requireApprovalForTools` accepts `@all | @write | @destructive | <tool name>` and already defaults to `["@write","@destructive"]`. TrueForge then emits on the turn stream:

```ts
ToolApprovalRequiredEvent { type: "tool.approval_required", threadId, toolCalls: [{ id, sourceEventId }] }
```

and the answer goes back as a turn input item:

```ts
UserToolApprovalEvent { type: "user.tool_approval", threadId, toolCallId, approval: { status: "allow" | "deny" } }
```

No interrupt-handling code required.

---

## 4. The demo payload (Task 9)

**Question:** what change best demonstrates a cascade?

`design_system` ships **46 theme presets** (`commodore-64`, `vaporwave`, `game-boy`, `neo-brutalism`, `dracula`, `y2k`, …), and `sudobility/src/main.tsx` does:

```ts
import { configureTheme } from '@sudobility/design';
import { defaultTheme, generateThemeCSS } from '@sudobility/design/themes';
configureTheme(defaultTheme);
```

The app imports `defaultTheme` **by name** and pins no preset of its own. Repointing `defaultTheme` one line deep in the design system repaints the entire landing page while `sudobility`'s own diff contains nothing but a version bump.

That is the point. A single button changing hue is hard to see on video and easy to attribute to a local edit or a cache. A whole-page palette transformation, in an app whose diff is empty, can only have arrived through four publishes.
