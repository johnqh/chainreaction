# ChainReaction Hosted — Plan D: Validation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a cross-repo changeset builds and tests **before** anything is published — in the customer's own CI, with no credential stored in their repository.

**Architecture:** ChainReaction dispatches a workflow the customer added during Prepare. That run holds no secret: it presents a GitHub Actions **OIDC token** to the control plane, which verifies it against GitHub's JWKS and returns a short-lived installation token scoped to the affected repos, plus the changeset. The run assembles every affected repo as one Bun workspace, asserts the intra-subgraph links resolved to local members, builds and tests in dependency order, and reports back.

**Tech Stack:** Bun, TypeScript, `bun:test`, Web Crypto, GitHub REST + Actions APIs.

**Spec:** `docs/superpowers/specs/2026-08-28-hosted-chainreaction-design.md` §3.3

## Why validation is worth this much machinery

A cascade republishes a package and every dependent of it. If a downstream repo does not compile against the new version, the cascade discovers that only after publishing — and npm publishes are not retractable. Validation is the difference between a bad change being *refused* and being *permanent*.

The hard part is that validation must run arbitrary customer code — their builds, their tests, their `postinstall` hooks. Hosting that means microVM isolation, compute cost, and asking for npm credentials so private packages resolve. So it does not run on our infrastructure. It runs in the customer's CI, on their runners, with their secrets, in their exact environment.

## Measured facts this plan is built on

All measured against real infrastructure; do not re-derive them.

1. **`workflow_dispatch` works with an installation token.** `POST /repos/{o}/{r}/actions/workflows/{id}/dispatches` with `{ref, inputs}` returned **204** and the run executed to `conclusion: success`. This is the mechanism the whole plan rests on.
2. **The workflow must already exist on the default branch.** The App cannot create it — writing `.github/workflows/**` returns `403 Resource not accessible by integration` without `Workflows: write`, which this product deliberately does not request. Prepare verifies the file; the customer adds it.
3. **GitHub's OIDC discovery**: issuer `https://token.actions.githubusercontent.com`, JWKS at `/.well-known/jwks`, **RS256 only**, currently **4 keys** each with its own `kid`.
4. **`claims_supported` includes `repository_id` and `repository_owner_id`** alongside the name-based claims.
5. **Bun workspace linking resolves intra-subgraph deps to local members** — verified on a real five-repo chain, 1296 packages, 77s. Bun does **not** hoist members to the root `node_modules`; links live in each member's own. And linking is conditional on the declared range being satisfied, so a mismatch silently installs the **registry** copy instead.

## Global Constraints

- Package manager is **Bun** everywhere. Never npm/yarn/pnpm. Test runner is `bun test`.
- Every substantive change goes through a GitHub PR reviewed by Qodo before merge. Never commit to `main`.
- TypeScript `^5`; `bunx tsc --noEmit -p tsconfig.json` must exit clean (`tsc` is not on PATH). `noUncheckedIndexedAccess` is on and stays on.
- The package scope is a parameter. **Nothing may hardcode `@sudobility` or `johnqh`.**
- **No secret in any log, error, or response body** — not the App key, not an installation token, not an OIDC token.
- **No network calls in tests.** Every HTTP interaction goes through an injectable `fetch`.
- Response shapes are validated, never cast.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/oidc/jwks.ts` | Fetch and cache GitHub's JWKS; select by `kid` |
| `src/oidc/verify.ts` | Verify an Actions OIDC token and its claims |
| `src/validate/types.ts` | `ValidationRequest`, `ValidationOutcome` |
| `src/validate/claim.ts` | Exchange a verified OIDC token for a scoped token + changeset |
| `src/validate/actionsValidator.ts` | `Validator` implementation: dispatch, await, report |
| `src/validate/runner.ts` | What the workflow runs: assemble, assert links, build, test |
| `docs/chainreaction-validate.yml` | The template customers add |

---

### Task 1: Verify a GitHub Actions OIDC token

**Files:**
- Create: `src/oidc/jwks.ts`, `src/oidc/verify.ts`
- Test: `tests/oidc/verify.test.ts`

**Interfaces:**
- Produces:
  - `interface Jwk { kid: string; kty: string; alg: string; n: string; e: string }`
  - `class JwksCache { constructor(fetchFn?: typeof fetch, jwksUri?: string); keyFor(kid: string): Promise<CryptoKey> }`
  - `interface OidcClaims { repositoryId: string; repositoryOwnerId: string; repository: string; ref: string; sha: string }`
  - `verifyOidcToken(token: string, jwks: JwksCache, expect: { audience: string; ownerId: string }, now?: number): Promise<OidcClaims>`

**Validate the numeric claims, not the names.** `repository` and `repository_owner` are mutable — a repo can be renamed or transferred, and a name freed by deletion can be reclaimed by someone else. `repository_id` and `repository_owner_id` cannot. A control plane that authorises a checkout token on a *name* match is one rename away from handing an installation-scoped token to the wrong repository.

**Select the key by `kid`, and refetch on an unknown one.** The JWKS currently holds 4 keys and GitHub rotates them. A time-based cache fails closed exactly when a new key appears; refetching when a `kid` is unrecognised does not.

- [ ] **Step 1: Write the failing test**

Create `tests/oidc/verify.test.ts`. Generate an RSA keypair with `crypto.subtle.generateKey`, export the public half as a JWK, serve it from a stubbed `fetch` as a JWKS, and sign tokens locally. Cover:

```ts
test("accepts a well-formed token and returns its claims", ...)
test("rejects a token signed by a key absent from the JWKS", ...)
test("rejects a token whose kid is unknown even after a refetch", ...)
test("refetches the JWKS once when it sees an unknown kid, then succeeds", ...)  // assert fetch call count
test("rejects an expired token", ...)
test("rejects a token whose audience does not match", ...)
test("rejects a token whose repository_owner_id does not match", ...)
test("rejects alg=none and alg=HS256 — only RS256 is accepted", ...)
test("rejects a token with a valid signature but a missing repository_id claim", ...)
```

The `alg` test is not decoration: accepting `none` would let anyone mint a token authorising a checkout of any repo in the installation.

- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement `JwksCache`**

Fetch `https://token.actions.githubusercontent.com/.well-known/jwks`. Cache by `kid`. On a miss, refetch **once** and retry; if still missing, throw. Import each key with `crypto.subtle.importKey("jwk", …, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])`.

- [ ] **Step 4: Implement `verifyOidcToken`**

Split the token, parse the header, **reject any `alg` other than `RS256` before doing anything else**, resolve the key by `kid`, verify the signature over `header.payload`, then check `iss`, `aud`, `exp`/`nbf` against `now`, and `repository_owner_id` against the expected owner. Return the claims. Every rejection throws with a reason that names the check — and never includes the token.

- [ ] **Step 5: Run, then commit**

```bash
git checkout -b feat/oidc-verify
git add src/oidc tests/oidc && git commit -m "feat: verify github actions OIDC tokens"
git push -u origin feat/oidc-verify
```

---

### Task 2: The claim endpoint

The workflow presents its OIDC token and receives what it needs to do the work: a scoped installation token and the changeset.

**Files:**
- Create: `src/validate/types.ts`, `src/validate/claim.ts`
- Test: `tests/validate/claim.test.ts`

**Interfaces:**
- Produces:
  - `interface ValidationRequest { cascadeId: string; changeset: ChangesetEntry[]; repos: string[] }`
  - `interface ClaimResult { token: string; request: ValidationRequest }`
  - `handleClaim(oidcToken: string, cascadeId: string, deps: ClaimDeps): Promise<ClaimResult>`

`ClaimDeps` carries the `JwksCache`, a `TokenStore`, a lookup from `cascadeId` to a pending `ValidationRequest`, and the expected audience and owner id.

**The authorisation rule, and it is the point of the task:** the OIDC token proves *which repository* the run belongs to. `handleClaim` must confirm that repository is **in the cascade it is claiming**. Without that check, any repo in the installation with a workflow could claim any cascade and receive a token scoped to every repo in it.

- [ ] **Step 1: Write the failing test**

```ts
test("returns a token and the changeset for a legitimate claim", ...)
test("refuses when the OIDC token fails verification", ...)
test("refuses when the cascade id is unknown", ...)
test("refuses when the claiming repository is not part of that cascade", ...)  // the authorisation rule
test("refuses a second claim for the same cascade from the same run", ...)     // single-use
test("no token, OIDC or installation, appears in any thrown error", ...)
```

- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement**

Verify the token; look up the cascade; **assert the verified `repository` is in `request.repos`**; mint an installation token; mark the claim consumed; return. Any failure throws a message naming the reason and no token.

- [ ] **Step 4: Run, then commit**

---

### Task 3: `ActionsValidator`

**Files:**
- Create: `src/validate/actionsValidator.ts`
- Test: `tests/validate/actionsValidator.test.ts`

**Interfaces:**
- Produces:
  - `interface Validator { validate(changeset: ChangesetEntry[]): Promise<ValidationResult[]> }`
  - `class ActionsValidator implements Validator`

Dispatches `chainreaction-validate.yml` in one repo of the installation via `workflow_dispatch` with `{ cascade_id }`, then polls for the run's conclusion.

**`workflow_dispatch` returns 204 with no run id.** There is no direct handle on the run it created. Poll `GET /repos/{o}/{r}/actions/runs?event=workflow_dispatch&created=>{iso}` filtered to runs created after the dispatch, and match on the run's `name`/`display_title` carrying the cascade id. **Record the dispatch time first**; matching only on "most recent" races an unrelated run and would report someone else's result as this cascade's validation.

- [ ] **Step 1: Write the failing test**

```ts
test("dispatches with the cascade id as an input", ...)
test("polls until the run completes and maps success to a passing result", ...)
test("maps a failed run to a failing result carrying the run url", ...)
test("does not match a run created before the dispatch", ...)   // the race
test("times out with a clear message rather than polling forever", ...)
test("surfaces a dispatch rejection rather than waiting for a run that will never exist", ...)
```

- [ ] **Step 2–4: Run, implement, run, commit**

---

### Task 4: The runner

What executes inside the customer's CI. Shipped as a package the workflow invokes, so the file customers paste stays short enough to audit and fixes ship without asking 60 repos to update a workflow.

**Files:**
- Create: `src/validate/runner.ts`
- Test: `tests/validate/runner.test.ts`

**Interfaces:**
- Produces: `runValidation(request: ValidationRequest, token: string, io: RunnerIo): Promise<ValidationOutcome>`

`RunnerIo` injects cloning, file writing and command execution, so every step is testable without a network or a filesystem.

**Reuse `src/sandbox/workspace.ts` rather than reimplementing it.** `buildWorkspaceRoot`, `applyEntry`, `assertLinked` and `validate` already exist, are reviewed, and encode the measured Bun behaviour. In particular `assertLinked` is not optional: Bun silently installs the **registry** copy when a declared range is not satisfied, the install still succeeds, and validation would then report a confident PASS while testing published code instead of the changeset.

Steps the runner performs: clone each repo in `request.repos` at its default branch using the scoped token; apply each `ChangesetEntry` to its manifest; write the workspace root; `bun install`; **`assertLinked`**; build and test each member in dependency order; return an outcome per package.

- [ ] **Step 1: Write the failing test**

```ts
test("clones every repo in the request", ...)
test("applies each changeset entry to its manifest before installing", ...)
test("fails loudly when assertLinked reports an unlinked edge", ...)   // the false-PASS guard
test("returns a per-package outcome in dependency order", ...)
test("a failing build stops the run and names the package", ...)
test("the scoped token never appears in an outcome or an error", ...)
```

- [ ] **Step 2–4: Run, implement, run, commit**

---

### Task 5: The workflow template

**Files:**
- Create: `docs/chainreaction-validate.yml`
- Modify: `README.md` — how to add it

The file customers add. It must be short enough to read and audit in full, and hold **no secret**: it requests an OIDC token, exchanges it, and invokes the runner.

**Its job name must equal `DEFAULT_REQUIRED_CHECK`.** Prepare sets that string as a required status check on the default branch. If they disagree, branch protection waits forever on a check that never arrives and **every** PR to that repo becomes unmergeable — the customer's as much as ChainReaction's.

- [ ] **Step 1: Write the template**, with `permissions: { id-token: write, contents: read }` and a job named exactly `DEFAULT_REQUIRED_CHECK`.
- [ ] **Step 2: Add a test** asserting the template's job name equals the constant — parse the YAML in a test rather than trusting a comment. This is the only thing that will hold the two in sync.
- [ ] **Step 3: Document it in the README**, including that ChainReaction cannot add it because the App does not request `Workflows: write`.

---

## Cut List

1. **Task 3's run-matching by cascade id** — fall back to "most recent dispatch run" and accept the race, in a single-cascade demo only.
2. **Task 4's dependency-order build** — build all members, report the first failure.

**Never cut:** Task 1's `alg` check, Task 2's repository-in-cascade authorisation, or Task 4's `assertLinked`. Each is the difference between validation and the appearance of it.

---

## Self-Review Notes

**Spec coverage:** §3.3's six numbered steps map to Tasks 4 (1–5) and 3 (6). The OIDC design recorded in §3.3 is Tasks 1 and 2. The `Validator` interface is honoured — `ActionsValidator` is its second implementation beside `LocalWorkspaceValidator`.

**Placeholder scan:** Tasks 1–4 give test names and behaviour rather than complete code, because each depends on shapes best read from the existing modules (`ChangesetEntry`, `ValidationResult`, `TokenStore`) at implementation time. Every step is runnable; no step says "handle errors appropriately".

**Type consistency:** `ChangesetEntry` and `ValidationResult` are reused unchanged from `src/graph/types.ts` and `src/sandbox/workspace.ts`. `TokenStore` and `JwksCache` are both constructor-injected with a `fetch` default, matching every other client in this codebase.
