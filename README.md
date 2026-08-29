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

ChainReaction also runs as a hosted, multi-tenant web app — see
["Running the hosted app"](#running-the-hosted-app) below for the `serve` command, its required
environment variables, and the two separate GitHub registrations it needs.

## Adding the validation workflow

> **Status: this pillar is implemented but not yet wired up end to end.** The claim/exchange handler
> described below (`handleClaim` in `src/validate/claim.ts`) exists and is unit-tested, but as of this
> writing it is **mounted on no HTTP route** — there is no "ChainReaction control plane" endpoint
> listening for it yet — and nothing in the CLI (`src/cli/bin.ts`) dispatches the
> `chainreaction-validate` workflow that would call it. `src/validate/`, `src/oidc/`, and
> `src/github/dispatch.ts` are unreachable from the CLI entry point today. Read the rest of this
> section as the target design for the validation pillar, not a feature you can turn on by adding the
> workflow file — adding it will not connect to anything yet.

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
- It requests `permissions: id-token: write` and `contents: read`, nothing else. `id-token: write` lets
  it ask GitHub for a short-lived OIDC token identifying *this specific repository* — cryptographically
  signed by GitHub, not by ChainReaction; `contents: read` is only what checking out the repo needs.
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
produces on pull requests (e.g. `build`, `test`, `ci`, or a legacy-status context like
`ci/circleci: build`). Set that name via `CR_REQUIRED_CHECKS` when running ChainReaction's CLI — there
is no default, on purpose, so this can never silently be filled in with the wrong check.

**Prepare verifies the name you gave actually exists**, and it samples the right commit to check that
against: required status checks are evaluated against a pull request's **head commit**, not your
default branch tip, so Prepare looks at the head commit of your repository's most recently updated pull
request (falling back to the default branch tip only if the repo has never had one). It blocks — naming
what it found instead — if the check you configured has never been reported there. Sampling the default
branch instead would get this backwards in both directions: it would accept `chainreaction-validate`
itself as "observed" (its dispatched runs land on the default branch, not a PR head) and reject a
perfectly correct `ci` that only ever runs on PRs.

This is why a downstream cascade PR can start red: its manifest references a version not yet published,
so its own CI fails at install; once the upstream package publishes and that PR is updated, the same CI
re-runs and turns green. That red-then-green cycle, on your own CI's check, is the entire cascade
mechanism — `chainreaction-validate`'s job name has no part in it, and you are free to rename it.

**The file path is what Prepare verifies**, not the job name: it checks for the file at the exact path
`.github/workflows/chainreaction-validate.yml` (see above) and won't proceed until it's there. The
job's `name:` field is only ever seen by a human reading your Actions log.
`tests/validate/workflowTemplate.test.ts` asserts the properties that are actually load-bearing — the
`workflow_dispatch` trigger with its `cascade_id` input, the `id-token: write` permission, and that the
claim response is never echoed — not the job name.

## Running the hosted app

`chainreaction serve` starts the multi-tenant web app: a developer signs in with GitHub, and the app
acts as a GitHub App installation to open and merge pull requests across their repositories.

Two separate GitHub registrations are required — they are not the same thing:

- **A GitHub App.** This is the installation ChainReaction acts *as* when reading repo state and
  opening/merging pull requests (`CR_APP_ID` / `CR_PRIVATE_KEY_PATH` below).
- **A GitHub OAuth App.** This is used only for the "Sign in with GitHub" login flow
  (`CR_OAUTH_CLIENT_ID` / `CR_OAUTH_CLIENT_SECRET` below). Its **callback URL**, as registered with
  GitHub, must exactly match `CR_OAUTH_CALLBACK_URL`.

### Environment variables

Every variable below is read and validated by `src/cli/config.ts` (`loadConfig` for the first group,
`loadOAuthConfig` for the second) — nothing here is inferred, defaulted, or optional unless noted.

| Variable | Required for | What it is |
| --- | --- | --- |
| `CR_APP_ID` | every command | The GitHub App's numeric ID. |
| `CR_PRIVATE_KEY_PATH` | every command | Filesystem path to the GitHub App's private key (`.pem`). Never appears in a log line or error — a read failure is reported by path only. |
| `CR_INSTALLATION_ID` | `prepare`, `plan` | The numeric ID of the GitHub App installation to act on. **Loaded, but not used, by `serve`**: `loadConfig` is shared by every command and always requires this, but the hosted app resolves the installation from the signed-in session on each request, never from this variable. Running `serve` still needs some syntactically valid positive integer here — any placeholder value works — but its value has no effect on `serve`'s behavior. |
| `CR_SCOPE` | every command | The npm package scope this installation manages, e.g. `@acme/`. |
| `CR_REQUIRED_CHECKS` | every command | Comma-separated status check name(s) your own repos' CI already produces on pull requests, e.g. `build,test`. Never `chainreaction-validate` itself — see "The required status check is your own CI" above. `serve` uses this too (via `handleRepos` in `src/server/api.ts`), not just `prepare`/`plan`. |
| `CR_OAUTH_CLIENT_ID` | `serve` | The GitHub OAuth App's client ID. |
| `CR_OAUTH_CLIENT_SECRET` | `serve` | The GitHub OAuth App's client secret. Never logged. |
| `CR_SESSION_SECRET` | `serve` | A random secret used to sign session cookies, e.g. the output of `openssl rand -hex 32`. Never logged. |
| `CR_OAUTH_CALLBACK_URL` | `serve` | The full, absolute callback URL registered with the GitHub OAuth App, e.g. `https://app.example.com/auth/callback`. Use `https://` in any real deployment: an `http://` callback URL is a documented dev-only fallback (see `src/server/index.ts`) that drops the `__Host-` cookie name prefix and the `Secure` flag on every cookie the app sets. |

All five `loadConfig` variables (`CR_APP_ID`, `CR_PRIVATE_KEY_PATH`, `CR_INSTALLATION_ID`, `CR_SCOPE`,
`CR_REQUIRED_CHECKS`) are loaded unconditionally at startup regardless of which command you run
(`loadConfig` runs once, before the command is dispatched), so all five must be set even to run `serve`
alone — see `CR_INSTALLATION_ID` above for the one case where the value you set has no effect on the
command you're actually running.

### Starting it

```sh
cp .env.example .env   # then fill in the values described above
bun run chainreaction serve
```

Bun automatically loads a `.env` file from the project root, so no separate loader step is needed.
`serve` listens on `127.0.0.1:3737` and never returns during normal operation — stop it with Ctrl-C or
your process manager.

## Development

- Package manager: [Bun](https://bun.sh).
- Install: `bun install`
- Run the CLI: `bun run chainreaction <command>` — commands are `prepare`, `plan`, and `serve`. There is
  no `--help` flag: running with no command, or one it doesn't recognize (including `--help`), prints
  the usage text and exits with status **1**, not 0.
- Test: `bun test tests/`
- Typecheck: `bunx tsc --noEmit -p tsconfig.json`
