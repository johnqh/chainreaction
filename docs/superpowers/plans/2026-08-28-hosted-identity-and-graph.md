# ChainReaction Hosted — Plan A: Identity and Graph

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a GitHub App installation, compute the affected subgraph and full changeset for a package change entirely from the GitHub API — no filesystem access anywhere.

**Architecture:** A GitHub App mints short-lived installation tokens; a `GraphSource` interface loads `RepoNode`s from any backing store, with `GitHubGraphSource` reading manifests over the API and the existing filesystem scanner becoming the interface's second implementation. Everything downstream — `affectedSubgraph`, `topoLevels`, `assertScoped`, `computeChangeset` — is already written, already reviewed, and takes this data unchanged.

**Tech Stack:** Bun, TypeScript, `bun:test`, Web Crypto (`crypto.subtle`), GitHub REST API.

**Spec:** `docs/superpowers/specs/2026-08-28-hosted-chainreaction-design.md`

## Why this is its own plan

Phase 1 of the spec is three independent subsystems. This plan is the first, and it produces working, testable software on its own: *plan a cascade from an installation*. The other two follow separately —

- **Plan B — Prepare and Validation:** capability detection, protection vs control-plane-merge, `ActionsValidator`.
- **Plan C — Cascade, UI, and Agent:** webhook sink, cascade advancement, DAG screen, MCP server, TrueForge.

Plan A is a hard prerequisite for both. Neither can be started without installation tokens and an API-backed graph.

## Global Constraints

- Package manager is **Bun** everywhere. Never npm/yarn/pnpm. Test runner is `bun test`.
- Every substantive change goes through a GitHub PR reviewed by Qodo before merge. Never commit to `main`.
- TypeScript pinned to `^5`; `tsc --noEmit -p tsconfig.json` must exit clean. `noUncheckedIndexedAccess` is on and stays on.
- Only `@sudobility/*`-style scoped edges form the dependency graph — the scope is a parameter, not a hardcoded string. **This is a product now; nothing may hardcode `@sudobility` or `johnqh`.**
- **No secret is ever logged.** The App private key and installation tokens must not appear in any log line, error message, or report.
- Nothing under `src/graph/resolver.ts`, `src/sandbox/`, `src/github/client.ts`, `src/github/orchestrator.ts`, `src/github/dispatch.ts`, or `src/supervisor/` may be modified by this plan. Those are reviewed and carry forward.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/auth/appAuth.ts` | Sign the App JWT, mint and cache installation tokens |
| `src/auth/pem.ts` | PEM → DER conversion for `crypto.subtle.importKey` |
| `src/graph/source.ts` | `GraphSource` interface; `FilesystemGraphSource` wrapping the existing scanner |
| `src/graph/githubSource.ts` | `GitHubGraphSource` — list installation repos, read manifests, build the graph |
| `src/graph/types.ts` | *(modified)* `dir` becomes optional |
| `src/plan/planCascade.ts` | The one entry point: source → affected → scoped → levels → changeset |

---

### Task 1: Register and install the GitHub App (do this first)

Not a gate — a prerequisite. Tasks 2 and 3 need a real App ID, a private key, and an installation to code against, and only a human can create those in a browser.

Private-repo reading is recorded here as an **observation, not an acceptance criterion**. It is expected to work: installation permissions are granted per-repo regardless of visibility, which is a principal reason to use an App rather than an OAuth token. If it turns out not to, that narrows the product to public repos rather than stopping this plan — note it and carry on.

The genuinely measured private-repo limitation is a different one, already handled: branch protection and rulesets both return 403 on a free-tier private repo, which is why the spec pairs auto-merge with a control-plane merge fallback (§3.2). Reading is not affected by that.

**Files:**
- Create: `docs/spike-app-auth.md`
- Creates a real GitHub App under the `johnqh` account (manual, in the browser)

**Interfaces:**
- Consumes: nothing
- Produces: a confirmed answer, the App ID, and the exact API shapes Task 2 and Task 3 code against

- [ ] **Step 1: Register the App**

In the browser at **github.com/settings/apps/new**:

- Name: `chainreaction-dev`
- Homepage: `https://github.com/johnqh/chainreaction`
- **Uncheck "Active" under Webhook** for now — Plan C adds the webhook URL.
- Repository permissions: **Contents** read & write, **Pull requests** read & write, **Actions** read & write, **Administration** read & write, **Metadata** read.
- "Only on this account".

Generate a private key; it downloads a `.pem`. Note the **App ID**.

```bash
mkdir -p ~/.chainreaction && mv ~/Downloads/chainreaction-dev.*.private-key.pem ~/.chainreaction/app.pem
chmod 600 ~/.chainreaction/app.pem
```

`~/.chainreaction/` is outside the repo. **The key must never be committed**; verify `git status` stays clean.

- [ ] **Step 2: Install it on the demo repos**

From the App's page, **Install App** → *Only select repositories* → `design_system`, `mail_box_components`, `di_web`, `building_blocks`, `sudobility`, and the private `cr-spike-b`.

Include a **private** repo deliberately: reading a private manifest is the thing being proven.

- [ ] **Step 3: Mint a JWT and exchange it for an installation token**

```bash
cd /tmp && cat > spike.ts <<'TS'
const appId = process.env.CR_APP_ID!;
const pem = await Bun.file(`${process.env.HOME}/.chainreaction/app.pem`).text();

const der = Uint8Array.from(
  atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0),
);
const key = await crypto.subtle.importKey(
  "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
);
const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const now = Math.floor(Date.now() / 1000);
const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
const sig = new Uint8Array(
  await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body)),
);
const jwt = `${body}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

const insts = await (await fetch("https://api.github.com/app/installations", {
  headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" },
})).json();
console.log("installations:", insts.map((i: any) => ({ id: i.id, account: i.account.login })));

const id = insts[0].id;
const tok = await (await fetch(
  `https://api.github.com/app/installations/${id}/access_tokens`,
  { method: "POST", headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" } },
)).json();
console.log("token expires_at:", tok.expires_at);

const repos = await (await fetch("https://api.github.com/installation/repositories", {
  headers: { authorization: `Bearer ${tok.token}`, accept: "application/vnd.github+json" },
})).json();
console.log("repos:", repos.total_count, repos.repositories.map((r: any) => `${r.full_name}${r.private ? " (private)" : ""}`));

const priv = repos.repositories.find((r: any) => r.private);
const file = await fetch(
  `https://api.github.com/repos/${priv.full_name}/contents/package.json`,
  { headers: { authorization: `Bearer ${tok.token}`, accept: "application/vnd.github.raw+json" } },
);
console.log("private manifest status:", file.status, "bytes:", (await file.text()).length);
TS
CR_APP_ID=<the app id> bun spike.ts
```

- [ ] **Step 4: Record findings**

**What must work** (Tasks 2 and 3 cannot be written without these): the installations list returns your installation, the token exchange returns an `expires_at` roughly an hour out, and `/installation/repositories` lists the selected repos.

**What is merely observed:** the status of reading the *private* repo's `package.json`. A 200 means private repos are in scope. Anything else means the product launches public-only — record it, open an issue, and continue; nothing in this plan changes either way.

Write `docs/spike-app-auth.md` recording: whether it worked, the token TTL, whether `accept: application/vnd.github.raw+json` returns raw bytes (vs base64-in-JSON, which changes Task 3's parsing), and what `/installation/repositories` pagination looks like. If a repo has **no** `package.json`, note the exact status so Task 3 handles it rather than crashing.

- [ ] **Step 5: Commit findings**

```bash
cd /Users/johnhuang/projects/chainreaction
git checkout -b spike/app-auth
git add docs/spike-app-auth.md
git commit -m "docs: record GitHub App installation-token spike findings"
git push -u origin spike/app-auth
```

Confirm the `.pem` is **not** in the diff.

---

### Task 2: App authentication

**Files:**
- Create: `src/auth/pem.ts`, `src/auth/appAuth.ts`
- Test: `tests/auth/appAuth.test.ts`

**Interfaces:**
- Consumes: findings from Task 1
- Produces:
  - `pemToPkcs8Der(pem: string): Uint8Array` — accepts PKCS#1 or PKCS#8
  - `pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array`
  - `interface AppCredentials { appId: string; privateKeyPem: string }`
  - `mintAppJwt(creds: AppCredentials, nowSeconds: number): Promise<string>`
  - `interface InstallationToken { token: string; expiresAt: number }`
  - `class TokenStore { constructor(creds: AppCredentials, fetchFn?: typeof fetch, now?: () => number); get(installationId: number): Promise<string> }`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/appAuth.test.ts`:

```ts
import { test, expect } from "bun:test";
import { pemToPkcs8Der, pkcs1ToPkcs8 } from "../../src/auth/pem";
import { mintAppJwt, TokenStore, type AppCredentials } from "../../src/auth/appAuth";

async function generatePem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** Strip the fixed PKCS#8 envelope to recover the inner PKCS#1 RSAPrivateKey. */
function extractPkcs1(pkcs8: Uint8Array): Uint8Array {
  // SEQUENCE hdr, INTEGER 0 (3 bytes), AlgorithmIdentifier (15 bytes), then OCTET STRING.
  let i = 1;
  i += pkcs8[i]! & 0x80 ? (pkcs8[i]! & 0x7f) + 1 : 1; // skip outer length
  i += 3 + 15;
  if (pkcs8[i] !== 0x04) throw new Error("expected OCTET STRING");
  i += 1;
  const lenByte = pkcs8[i]!;
  i += lenByte & 0x80 ? (lenByte & 0x7f) + 1 : 1;
  return pkcs8.slice(i);
}

test("pemToPkcs8Der strips armour and whitespace on a PKCS#8 key", async () => {
  const der = pemToPkcs8Der(await generatePem());
  expect(der.byteLength).toBeGreaterThan(1000);
  expect(der[0]).toBe(0x30); // DER SEQUENCE
});

test("pemToPkcs8Der rejects a non-PEM string", () => {
  expect(() => pemToPkcs8Der("not a key")).toThrow(/pem/i);
});

test("a PKCS#1 key round-trips to importable PKCS#8", async () => {
  // GitHub hands out PKCS#1; crypto.subtle only accepts PKCS#8. This is the
  // conversion, and the assertion that matters is that importKey accepts the result.
  const pkcs8 = pemToPkcs8Der(await generatePem());
  const rewrapped = pkcs1ToPkcs8(extractPkcs1(pkcs8));
  expect(Array.from(rewrapped)).toEqual(Array.from(pkcs8));
  await expect(
    crypto.subtle.importKey("pkcs8", rewrapped,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]),
  ).resolves.toBeDefined();
});

test("a PKCS#1 PEM is detected by its armour and converted", async () => {
  const pkcs8 = pemToPkcs8Der(await generatePem());
  const pkcs1 = extractPkcs1(pkcs8);
  const armoured =
    "-----BEGIN RSA PRIVATE KEY-----\n" +
    btoa(String.fromCharCode(...pkcs1)).replace(/(.{64})/g, "$1\n") +
    "\n-----END RSA PRIVATE KEY-----\n";
  const der = pemToPkcs8Der(armoured);
  await expect(
    crypto.subtle.importKey("pkcs8", der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]),
  ).resolves.toBeDefined();
});

test("mintAppJwt produces three base64url segments with the right claims", async () => {
  const jwt = await mintAppJwt({ appId: "12345", privateKeyPem: await generatePem() }, 1_000_000);
  const parts = jwt.split(".");
  expect(parts.length).toBe(3);
  const decode = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
  expect(decode(parts[0]!)).toEqual({ alg: "RS256", typ: "JWT" });
  const payload = decode(parts[1]!);
  expect(payload.iss).toBe("12345");
  expect(payload.iat).toBe(1_000_000 - 60);
  expect(payload.exp).toBeLessThanOrEqual(1_000_000 + 600);
  expect(parts[2]!.length).toBeGreaterThan(0);
  expect(jwt).not.toContain("=");
});

test("TokenStore mints a token and caches it until near expiry", async () => {
  const creds: AppCredentials = { appId: "1", privateKeyPem: await generatePem() };
  let calls = 0;
  let clock = 1_000_000;
  const fetchFn = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ token: `tok-${calls}`, expires_at: new Date((clock + 3600) * 1000).toISOString() }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const store = new TokenStore(creds, fetchFn, () => clock);
  expect(await store.get(42)).toBe("tok-1");
  expect(await store.get(42)).toBe("tok-1");
  expect(calls).toBe(1);

  clock += 3540; // inside the 120s safety margin
  expect(await store.get(42)).toBe("tok-2");
  expect(calls).toBe(2);
});

test("TokenStore keys the cache per installation", async () => {
  const creds: AppCredentials = { appId: "1", privateKeyPem: await generatePem() };
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ token: `tok-${calls}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;
  const store = new TokenStore(creds, fetchFn);
  expect(await store.get(1)).toBe("tok-1");
  expect(await store.get(2)).toBe("tok-2");
});

test("TokenStore surfaces a failed exchange without leaking the JWT", async () => {
  const creds: AppCredentials = { appId: "1", privateKeyPem: await generatePem() };
  const fetchFn = (async () =>
    new Response('{"message":"Bad credentials"}', { status: 401 })) as unknown as typeof fetch;
  const store = new TokenStore(creds, fetchFn);
  let message = "";
  try { await store.get(7); } catch (e) { message = (e as Error).message; }
  expect(message).toMatch(/401/);
  expect(message).not.toMatch(/BEGIN PRIVATE KEY|eyJ/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/auth/appAuth.test.ts`
Expected: FAIL — cannot resolve `../../src/auth/pem`.

- [ ] **Step 3: Implement PEM conversion (PKCS#1 aware)**

Create `src/auth/pem.ts`:

```ts
// GitHub downloads App keys as PKCS#1 (-----BEGIN RSA PRIVATE KEY-----), but
// crypto.subtle.importKey supports only pkcs8/spki/raw/jwk — there is no "pkcs1".
// Feeding it PKCS#1 throws `DataError`. Measured against a real App key; see
// docs/spike-app-auth.md. A product cannot ask customers to run openssl, so we wrap
// the PKCS#1 body in the fixed PKCS#8 envelope. No key parsing is needed.

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}

function derWrap(tag: number, content: Uint8Array): Uint8Array {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

/** rsaEncryption AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL } */
const RSA_ALGORITHM_ID = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
  0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
  const privateKey = derWrap(0x04, pkcs1); // OCTET STRING
  const body = new Uint8Array(version.length + RSA_ALGORITHM_ID.length + privateKey.length);
  body.set(version, 0);
  body.set(RSA_ALGORITHM_ID, version.length);
  body.set(privateKey, version.length + RSA_ALGORITHM_ID.length);
  return derWrap(0x30, body); // SEQUENCE
}

/** Returns PKCS#8 DER regardless of whether the PEM was PKCS#1 or PKCS#8. */
export function pemToPkcs8Der(pem: string): Uint8Array {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const body = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, "").replace(/\s/g, "");
  if (body.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(body)) {
    throw new Error("not a PEM-encoded key");
  }
  const raw = atob(body);
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);
  return isPkcs1 ? pkcs1ToPkcs8(der) : der;
}
```

- [ ] **Step 4: Implement JWT minting and the token store**

Create `src/auth/appAuth.ts`:

```ts
import { pemToPkcs8Der } from "./pem";

export interface AppCredentials {
  appId: string;
  privateKeyPem: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: number;
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlJson = (value: unknown): string =>
  b64url(new TextEncoder().encode(JSON.stringify(value)));

export async function mintAppJwt(
  creds: AppCredentials,
  nowSeconds: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8Der(creds.privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  // GitHub rejects a JWT older than 60s or living beyond 10 minutes.
  const body =
    `${b64urlJson({ alg: "RS256", typ: "JWT" })}.` +
    `${b64urlJson({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: creds.appId })}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body)),
  );
  return `${body}.${b64url(sig)}`;
}

const REFRESH_MARGIN_SECONDS = 120;

export class TokenStore {
  private cache = new Map<number, InstallationToken>();

  constructor(
    private creds: AppCredentials,
    private fetchFn: typeof fetch = fetch,
    private now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async get(installationId: number): Promise<string> {
    const now = this.now();
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt - now > REFRESH_MARGIN_SECONDS) return cached.token;

    const jwt = await mintAppJwt(this.creds, now);
    const res = await this.fetchFn(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      { method: "POST",
        headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" } },
    );
    if (!res.ok) {
      // Never include the JWT or the key in the message.
      throw new Error(`installation token exchange failed: ${res.status}`);
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    const minted: InstallationToken = {
      token: body.token,
      expiresAt: Math.floor(new Date(body.expires_at).getTime() / 1000),
    };
    this.cache.set(installationId, minted);
    return minted.token;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/auth/appAuth.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/app-auth
git add src/auth tests/auth
git commit -m "feat: github app jwt signing and installation token store"
git push -u origin feat/app-auth
```

---

### Task 3: GitHub-backed graph source

**Files:**
- Create: `src/graph/source.ts`, `src/graph/githubSource.ts`
- Modify: `src/graph/types.ts` — make `dir` optional
- Test: `tests/graph/githubSource.test.ts`

**Interfaces:**
- Consumes: `RepoNode` from `src/graph/types.ts`; `TokenStore` from Task 2
- Produces:
  - `interface GraphSource { load(): Promise<Map<string, RepoNode>> }`
  - `interface RepoRef { fullName: string; private: boolean; defaultBranch: string }`
  - `interface GitHubApi { listRepos(): Promise<RepoRef[]>; getManifest(fullName: string): Promise<string | null> }`
  - `class GitHubGraphSource implements GraphSource { constructor(api: GitHubApi, scope: string) }`

`dir` becomes optional because an API-backed node has no filesystem path. It is currently only copied through `computeChangeset` and never read — `src/sandbox/workspace.ts` derives member paths from `repo`, not `dir`.

- [ ] **Step 1: Write the failing test**

Create `tests/graph/githubSource.test.ts`:

```ts
import { test, expect } from "bun:test";
import { GitHubGraphSource, type GitHubApi, type RepoRef } from "../../src/graph/githubSource";

const REPOS: RepoRef[] = [
  { fullName: "acme/design_system", private: false, defaultBranch: "main" },
  { fullName: "acme/components", private: true, defaultBranch: "main" },
  { fullName: "acme/app", private: false, defaultBranch: "main" },
  { fullName: "acme/no-manifest", private: false, defaultBranch: "main" },
  { fullName: "acme/broken", private: false, defaultBranch: "main" },
];

const MANIFESTS: Record<string, string | null> = {
  "acme/design_system": JSON.stringify({ name: "@acme/design", version: "1.1.49" }),
  "acme/components": JSON.stringify({
    name: "@acme/components", version: "5.3.13",
    dependencies: { "@acme/design": "^1.1.49", react: "^18.0.0" },
  }),
  "acme/app": JSON.stringify({
    name: "acme-app", version: "1.0.96",
    dependencies: { "@acme/components": "^5.3.13" },
  }),
  "acme/no-manifest": null,
  "acme/broken": "{ this is not json",
};

function api(): GitHubApi & { manifestCalls: string[] } {
  const manifestCalls: string[] = [];
  return {
    manifestCalls,
    listRepos: async () => REPOS,
    getManifest: async (fullName) => { manifestCalls.push(fullName); return MANIFESTS[fullName] ?? null; },
  };
}

test("builds a graph from API manifests, following only in-scope edges", async () => {
  const g = await new GitHubGraphSource(api(), "@acme/").load();
  expect(g.size).toBe(3);
  const components = g.get("@acme/components")!;
  expect(components.repo).toBe("acme/components");
  expect(components.version).toBe("5.3.13");
  expect(components.deps).toEqual(["@acme/design"]);
});

test("a repo with no package.json is skipped, not fatal", async () => {
  const g = await new GitHubGraphSource(api(), "@acme/").load();
  expect([...g.keys()].some((k) => k.includes("no-manifest"))).toBe(false);
});

test("an unparseable manifest is skipped but warned about", async () => {
  const warnings: string[] = [];
  const original = console.error;
  console.error = (msg: string) => warnings.push(String(msg));
  try { await new GitHubGraphSource(api(), "@acme/").load(); } finally { console.error = original; }
  expect(warnings.some((w) => w.includes("acme/broken"))).toBe(true);
});

test("private repos are included", async () => {
  const g = await new GitHubGraphSource(api(), "@acme/").load();
  expect(g.has("@acme/components")).toBe(true);
});

test("the scope is a parameter — a different scope yields no edges", async () => {
  const g = await new GitHubGraphSource(api(), "@other/").load();
  expect(g.get("@acme/components")!.deps).toEqual([]);
});

test("one manifest request per repo, no duplicates", async () => {
  const a = api();
  await new GitHubGraphSource(a, "@acme/").load();
  expect(a.manifestCalls.length).toBe(REPOS.length);
  expect(new Set(a.manifestCalls).size).toBe(REPOS.length);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/graph/githubSource.test.ts`
Expected: FAIL — cannot resolve `../../src/graph/githubSource`.

- [ ] **Step 3: Make `dir` optional**

In `src/graph/types.ts`, change `dir: string;` to `dir?: string;` in **both** `RepoNode` and `ChangesetEntry`. Run `tsc --noEmit -p tsconfig.json`; if `computeChangeset` complains, it is because it copies `node.dir` — that assignment stays valid with an optional field.

- [ ] **Step 4: Define the source interface**

Create `src/graph/source.ts`:

```ts
import type { RepoNode } from "./types";

export interface GraphSource {
  load(): Promise<Map<string, RepoNode>>;
}
```

- [ ] **Step 5: Implement the GitHub source**

Create `src/graph/githubSource.ts`:

```ts
import type { RepoNode } from "./types";
import type { GraphSource } from "./source";

export interface RepoRef {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface GitHubApi {
  listRepos(): Promise<RepoRef[]>;
  /** Raw package.json text, or null when the repo has none. */
  getManifest(fullName: string): Promise<string | null>;
}

export class GitHubGraphSource implements GraphSource {
  constructor(private api: GitHubApi, private scope: string) {}

  async load(): Promise<Map<string, RepoNode>> {
    const repos = await this.api.listRepos();
    const graph = new Map<string, RepoNode>();

    for (const repo of repos) {
      const raw = await this.api.getManifest(repo.fullName);
      if (raw === null) continue; // no manifest is normal, not an error

      let pkg: { name?: string; version?: string;
                 dependencies?: Record<string, string>;
                 peerDependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(raw);
      } catch (err) {
        // A repo silently vanishing from a publish plan is the wrong failure mode.
        console.error(
          `GitHubGraphSource: skipping unparseable manifest in ${repo.fullName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      if (!pkg.name) continue;

      const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })
        .filter((d) => d.startsWith(this.scope))
        .sort();

      graph.set(pkg.name, {
        pkg: pkg.name,
        repo: repo.fullName,
        version: pkg.version ?? "0.0.0",
        deps,
      });
    }
    return graph;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/` — expect the 6 new tests plus all 42 existing ones.
Then: `tsc --noEmit -p tsconfig.json` — expect clean.

- [ ] **Step 7: Commit**

```bash
git checkout -b feat/github-graph-source
git add src/graph tests/graph
git commit -m "feat: github-backed graph source behind a GraphSource interface"
git push -u origin feat/github-graph-source
```

---

### Task 4: Plan a cascade from an installation

The payoff: the whole planning path running on API data, with the reviewed downstream code untouched.

**Files:**
- Create: `src/plan/planCascade.ts`
- Test: `tests/plan/planCascade.test.ts`

**Interfaces:**
- Consumes: `GraphSource` (Task 3); `affectedSubgraph`, `topoLevels` from `src/graph/resolver.ts`; `assertScoped`, `computeChangeset` from `src/graph/changeset.ts`
- Produces:
  - `interface CascadePlan { changed: string; affected: string[]; levels: string[][]; changeset: ChangesetEntry[] }`
  - `planCascade(source: GraphSource, changed: string, targets: string[] | "all"): Promise<CascadePlan>`

- [ ] **Step 1: Write the failing test**

Create `tests/plan/planCascade.test.ts`:

```ts
import { test, expect } from "bun:test";
import { planCascade } from "../../src/plan/planCascade";
import type { GraphSource } from "../../src/graph/source";
import type { RepoNode } from "../../src/graph/types";

const source: GraphSource = {
  load: async () =>
    new Map<string, RepoNode>([
      ["@acme/design", { pkg: "@acme/design", repo: "acme/design_system", version: "1.1.49", deps: [] }],
      ["@acme/components", { pkg: "@acme/components", repo: "acme/components", version: "5.3.13", deps: ["@acme/design"] }],
      ["acme-app", { pkg: "acme-app", repo: "acme/app", version: "1.0.96", deps: ["@acme/components"] }],
      ["@acme/unrelated", { pkg: "@acme/unrelated", repo: "acme/unrelated", version: "2.0.0", deps: [] }],
    ]),
};

test("plans the full chain from a source, in dependency order", async () => {
  const plan = await planCascade(source, "@acme/design", "all");
  expect(plan.affected.sort()).toEqual(["@acme/components", "@acme/design", "acme-app"]);
  expect(plan.levels).toEqual([["@acme/design"], ["@acme/components"], ["acme-app"]]);
  expect(plan.changeset.map((e) => [e.pkg, e.toVersion])).toEqual([
    ["@acme/design", "1.1.50"],
    ["@acme/components", "5.3.14"],
    ["acme-app", "1.0.97"],
  ]);
  expect(plan.changeset[1]!.depBumps).toEqual({ "@acme/design": "^1.1.50" });
});

test("an unrelated package is not in the affected set", async () => {
  const plan = await planCascade(source, "@acme/design", "all");
  expect(plan.affected).not.toContain("@acme/unrelated");
});

test("refuses an unscoped run", async () => {
  await expect(planCascade(source, "@acme/design", [])).rejects.toThrow(/explicit target set/i);
});

test("rejects a target outside the affected set", async () => {
  await expect(planCascade(source, "@acme/design", ["@acme/unrelated"])).rejects.toThrow(/not in the affected set/i);
});

test("throws when the changed package is not in the graph", async () => {
  await expect(planCascade(source, "@acme/ghost", "all")).rejects.toThrow(/not in the graph/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/plan/planCascade.test.ts`
Expected: FAIL — cannot resolve `../../src/plan/planCascade`.

- [ ] **Step 3: Implement**

Create `src/plan/planCascade.ts`:

```ts
import type { GraphSource } from "../graph/source";
import type { ChangesetEntry } from "../graph/types";
import { affectedSubgraph, topoLevels } from "../graph/resolver";
import { assertScoped, computeChangeset } from "../graph/changeset";

export interface CascadePlan {
  changed: string;
  affected: string[];
  levels: string[][];
  changeset: ChangesetEntry[];
}

export async function planCascade(
  source: GraphSource,
  changed: string,
  targets: string[] | "all",
): Promise<CascadePlan> {
  const graph = await source.load();
  if (!graph.has(changed)) {
    throw new Error(`${changed} is not in the graph for this installation`);
  }

  const affected = affectedSubgraph(graph, changed);
  // Before anything else: refuse to plan a publish nobody scoped.
  assertScoped(affected, targets);

  const levels = topoLevels(graph, affected);
  return {
    changed,
    affected: [...affected].sort(),
    levels,
    changeset: computeChangeset(graph, levels),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/` — expect 5 new tests plus all existing ones.
Then: `tsc --noEmit -p tsconfig.json` — expect clean.

- [ ] **Step 5: Verify against the real installation**

Using the App ID and installation from Task 1, run `planCascade` with a `GitHubGraphSource` against the five demo repos and confirm it produces the same chain the filesystem scanner does: `design → components → di_web → building_blocks → sudobility`.

**Acceptance:** the API-derived levels match the filesystem-derived levels for the same repos. A mismatch means the two sources disagree about the graph, which must be reconciled before Plan B.

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/plan-cascade
git add src/plan tests/plan
git commit -m "feat: plan a cascade from any graph source"
git push -u origin feat/plan-cascade
```

---

## Cut List

Nothing here is optional — this plan is the foundation both later plans require. If time is short, cut from **Plan C** instead (repair subagent first, then graph visuals).

**Never cut:** Task 1's App registration (nothing else can be written without it), and Task 3's warn-on-unparseable-manifest. A repo that silently vanishes from a publish plan is indistinguishable from a repo with no dependents.

---

## Self-Review Notes

**Spec coverage:** §3.1 (GitHub App identity, installation tokens) → Tasks 1, 2. §3.6's requirement that nothing hardcode a scope or org → Task 3's `scope` parameter, with a test asserting a different scope yields no edges. The §4 carry-forward table is honoured: `resolver.ts`, `changeset.ts`, `workspace.ts`, `client.ts`, `orchestrator.ts`, `dispatch.ts` and `supervisor/` are untouched; only `types.ts` changes, and only to relax a field. §3.2 (Prepare) and §3.3 (validation) are Plan B; §3.4, §3.5 and the UI are Plan C.

**Placeholder scan:** none. Task 1 Step 1 requires a human in a browser and says so; every other step has runnable content.

**Type consistency:** `RepoNode` is consumed with `dir` absent throughout Tasks 3 and 4, which is why Task 3 Step 3 relaxes it first. `ChangesetEntry`'s other six fields are unchanged, so `computeChangeset`, `workspace.ts` and `orchestrator.ts` keep compiling. `GitHubApi.getManifest` returns `string | null` and every call site handles `null`.

**Secret hygiene:** Task 2's error path is tested to prove the JWT and key never reach an error message, and Task 1 Step 5 requires confirming the `.pem` is absent from the diff.
