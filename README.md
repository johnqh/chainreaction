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

### The job name must not change

The job in this workflow is named `chainreaction-validate`. That exact name is the **required status
check** ChainReaction sets on your default branch during Prepare. If you rename the job, GitHub will
never report a check by that name again, branch protection will wait on it forever, and **every** pull
request to your repository — yours as much as ChainReaction's — becomes permanently unmergeable. A test
in this repository (`tests/validate/workflowTemplate.test.ts`) parses the shipped template and asserts
its job name against the constant ChainReaction uses (`DEFAULT_REQUIRED_CHECK` in
`src/prepare/probe.ts`), so the two cannot silently drift apart in what ChainReaction ships — but if you
edit your own copy of the file, keep that name exactly as it is.

## Development

- Package manager: [Bun](https://bun.sh).
- Install: `bun install`
- Run the CLI: `bun run chainreaction <command>` (see `chainreaction --help` via the CLI itself for
  `prepare` and `plan`)
- Test: `bun test tests/`
- Typecheck: `bunx tsc --noEmit -p tsconfig.json`
