# ChainReaction

Atomic changes across a dependency graph spread over many GitHub repositories. When a change to a
shared package would break its dependents, ChainReaction plans the affected set, cascades the change
through it level by level, and validates each level in the customer's own GitHub Actions before it
merges — never on ChainReaction's own infrastructure, and never with a customer's package registry
credentials.

## How it works, briefly

1. **Prepare** — an explicit, per-repo action that enables auto-merge, sets branch protection on the
   default branch (status checks only, never reviews), and verifies the validation workflow (below)
   exists on that branch.
2. **Plan** — from one changed package, ChainReaction computes every repo transitively affected and
   the order changes must land in.
3. **Cascade** — each level is applied as a changeset, dispatched into the customer's own CI for
   validation, and merged only once that validation passes.

ChainReaction is installed as a GitHub App. It never sees a customer's npm credentials, and it never
runs a customer's build or test commands on ChainReaction's own infrastructure — see below for why.

## Adding the validation workflow

Every repository that takes part in a cascade needs one workflow file:
[`docs/chainreaction-validate.yml`](docs/chainreaction-validate.yml). Copy it into your repository at:

```
.github/workflows/chainreaction-validate.yml
```

and commit it to your default branch. **Prepare checks for this exact path** and will show you this
same file, with instructions, if it is missing — it will not proceed until the file is there.

**ChainReaction cannot add this file for you.** The GitHub App deliberately does not request the
`Workflows: write` permission, because that permission would let it modify CI on *every* repository in
the installation, not only the ones you have prepared — for a product whose entire job is touching
your release pipeline, that is exactly the permission to withhold. So adding this one file per repo is
a one-time, explicit action you take yourself; not asking for the permission that would let
ChainReaction do it silently is a deliberate trust boundary, not an oversight.

### What the workflow does, and why it's safe to add

The workflow is short enough to read in full before you add it. In summary:

- It only runs on `workflow_dispatch`, triggered by ChainReaction when your repo is picked to validate
  a cascade — it never runs on your own pushes or PRs.
- It requests `permissions: id-token: write`, nothing else. That lets it ask GitHub for a short-lived
  OIDC token identifying *this specific repository* — cryptographically signed by GitHub, not by
  ChainReaction.
- It exchanges that OIDC token at the ChainReaction control plane for a short-lived, scoped token plus
  the changeset to validate. **This workflow holds no secret of your own** — there is nothing to add
  to your repository's secrets, and nothing long-lived for anyone to steal from your CI configuration.
- The exchange's response is written straight to a file and never echoed to the log; the token is
  masked (`::add-mask::`) the instant it's read back out, so GitHub itself redacts any accidental
  echo of it for the rest of the run.
- The actual checkout, workspace assembly, install, build, and test work happens inside a published
  package the workflow invokes (`bunx ...`), not inline in the YAML — so the file you're auditing stays
  short, and fixes to that logic ship without asking every repository to update its copy of this file.

### The required status check is your own CI, never this workflow

This workflow (`chainreaction-validate`) only ever runs via `workflow_dispatch`, dispatched once per
level of a cascade to prove the whole changeset builds and tests together *before* any pull request
exists. A required status check, by contrast, is evaluated against a pull request's head commit — a
dispatched run never attaches to one. So `chainreaction-validate` can never be, and must never be
configured as, a required status check: doing so would make branch protection wait forever on a check
that never arrives, and **every** pull request to your repository — yours as much as ChainReaction's —
would become permanently unmergeable.

The status check that actually gates merging is the one your repository's **own existing CI** already
produces on pull requests (e.g. `build`, `test`, `ci`). Set that name via `CR_REQUIRED_CHECKS` when
running ChainReaction's CLI — there is no default, on purpose, so this can never silently be filled in
with the wrong check. **Prepare verifies the name you gave actually exists** — it lists the check-runs
GitHub has reported on your default branch and blocks, naming what it found instead, if the one you
configured has never appeared there. This is why a downstream cascade PR can start red: its manifest
references a version not yet published, so its own CI fails at install; once the upstream package
publishes and that PR is updated, the same CI re-runs and turns green. That red-then-green cycle, on
your own CI's check, is the entire cascade mechanism — `chainreaction-validate`'s job name has no part
in it, and you are free to rename it.

The job name and file path are still both worth getting right for a different reason: **Prepare checks
for the file at the exact path** `.github/workflows/chainreaction-validate.yml` (see above) and won't
proceed until it's there, and the job's `name:` field is only ever seen by a human reading your Actions
log. `tests/validate/workflowTemplate.test.ts` asserts the properties that are actually load-bearing —
the `workflow_dispatch` trigger with its `cascade_id` input, the `id-token: write` permission, and that
the claim response is never echoed — not the job name.

## Development

- Package manager: [Bun](https://bun.sh).
- Install: `bun install`
- Run the CLI: `bun run chainreaction <command>` (see `chainreaction --help` via the CLI itself for
  `prepare` and `plan`)
- Test: `bun test tests/`
- Typecheck: `bunx tsc --noEmit -p tsconfig.json`
