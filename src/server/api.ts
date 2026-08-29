// The hosted HTTP surface the browser calls: repos, dependency graph, plan a
// changeset, open its PRs, merge one, run the Auto Merge train.
//
// Every handler here is deliberately thin — it validates its input, scopes
// every GitHub call to the session's installation, and delegates the actual
// work to src/graph, src/plan, src/pr and src/prepare. Nothing here
// reimplements planning, PR lifecycle, or readiness logic.
//
// Cross-tenant safety is the whole point of this file: every route takes
// `session: SessionPayload | null` (never reads a cookie or a client-supplied
// installation id itself) and is scoped to `session.installationId` alone. A
// missing/invalid session is always a flat 401 — never a fall-through to a
// default installation. A repo or PR named in a request body is only ever
// acted on after confirming it belongs to `session.installationId`'s own
// repository list, freshly re-checked on every mutating call — a client
// cannot merge or open a PR against a repo it doesn't own by simply naming it.
import type { SessionPayload } from "../auth/session";
import { TokenStore, type AppCredentials } from "../auth/appAuth";
import { InstallationGitHubApi } from "../github/installationApi";
import { InstallationPrApi, type PrApi } from "../github/prApi";
import { InstallationRepoAdminApi } from "../prepare/installationAdminApi";
import type { RepoAdminApi } from "../prepare/adminApi";
import type { GitHubApi, RepoRef } from "../graph/githubSource";
import { GitHubGraphSource } from "../graph/githubSource";
import { assessRepo } from "../prepare/prepare";
import type { PrepareResult } from "../prepare/types";
import { planUpdateOne, planUpdateChain } from "../plan/planUpdate";
import { openUpdatePrs, classifyPr, type PrState } from "../pr/lifecycle";
import { runTrain, type TrainDeps, type TrainOutcome } from "../pr/train";
import type { ChangesetEntry, RepoNode } from "../graph/types";
import { classifyEdges } from "../web/graphModel";
import { applyEntry } from "../sandbox/workspace";

// --- Wiring: one InstallationGitHubApi/RepoAdminApi/PrApi trio per installation ---

export interface InstallationApis {
  githubApi: GitHubApi;
  adminApi: RepoAdminApi;
  prApi: PrApi;
}

/** Builds the trio of installation-scoped APIs for a given installation id. */
export type InstallationApiFactory = (installationId: number) => InstallationApis;

/**
 * The real `InstallationApiFactory`, wired the same way `src/cli/deps.ts`
 * wires the CLI's single-installation `realDeps` — one shared `TokenStore`
 * (so concurrent requests for the same installation share one token
 * exchange), and the same `Installation*Api` classes. Unlike `realDeps`,
 * this is keyed by installation id at call time rather than fixed at
 * construction: the hosted app serves many installations, one per session,
 * never one baked in at startup.
 */
export function createInstallationApiFactory(
  creds: AppCredentials,
  fetchFn: typeof fetch = fetch,
): InstallationApiFactory {
  const tokens = new TokenStore(creds, fetchFn);
  const getToken = (installationId: number) => tokens.get(installationId);
  return (installationId: number) => ({
    githubApi: new InstallationGitHubApi(getToken, installationId, fetchFn),
    adminApi: new InstallationRepoAdminApi(getToken, installationId, fetchFn),
    prApi: new InstallationPrApi(getToken, installationId, fetchFn),
  });
}

export interface ApiDeps {
  apisFor: InstallationApiFactory;
  /**
   * The npm scope a given installation manages — same meaning as
   * `CliConfig.scope`, but keyed per installation rather than a single
   * server-wide value: two installations can manage packages under
   * different scopes, and a scope wrong for a given installation doesn't
   * fail loudly — `GitHubGraphSource` just excludes every dependency edge,
   * producing an empty-looking graph that reads as a legitimate answer.
   * The entrypoint may return the same value for every installation today;
   * what matters is that the shape doesn't foreclose per-installation
   * configuration later.
   */
  scopeFor: (installationId: number) => string | Promise<string>;
  /** Same meaning as `CliConfig.requiredChecks`, keyed per installation for the same reason as `scopeFor`. */
  requiredChecksFor: (installationId: number) => string[] | Promise<string[]>;
  /**
   * Whether `entry.toVersion` is currently resolvable, for the Auto Merge
   * train. Defaults to a real npm registry lookup. Overridden in tests so no
   * suite run ever makes a network call.
   */
  isResolvable?: (entry: ChangesetEntry, fetchFn: typeof fetch) => Promise<boolean>;
  fetchFn?: typeof fetch;
  /** Injected clock for the train's poll loop. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

// --- helpers -----------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Every error surfaced here already comes from modules that scrub secrets
 * from their own thrown messages (see e.g. InstallationGitHubApi, PrApi,
 * TokenStore) — this only adds the "never leak an internal exception shape"
 * backstop those modules don't need to.
 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorResponse(err: unknown, status: number): Response {
  return jsonResponse({ error: messageOf(err) }, status);
}

async function readJsonBody(req: Request): Promise<unknown | undefined> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function defaultIsResolvable(entry: ChangesetEntry, fetchFn: typeof fetch): Promise<boolean> {
  const res = await fetchFn(
    `https://registry.npmjs.org/${encodeURIComponent(entry.pkg)}/${encodeURIComponent(entry.toVersion)}`,
  );
  return res.ok;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `pkg` slugified into a git-safe branch component: `@acme/foo` -> `acme-foo`. */
function slugify(pkg: string): string {
  return pkg.replace(/^@/, "").replace(/\//g, "-");
}

function branchNameFor(entry: ChangesetEntry): string {
  return `chainreaction/update-${slugify(entry.pkg)}-${entry.toVersion}`;
}

function prTitleFor(entry: ChangesetEntry): string {
  return `chore: ${entry.pkg}@${entry.toVersion}`;
}

// --- request body validation (never cast blindly) -----------------------------

interface UpdateRequestBody {
  pkg: string;
  mode: "one" | "chain";
}

function parseUpdateBody(raw: unknown): UpdateRequestBody | null {
  if (!isRecord(raw)) return null;
  const { pkg, mode } = raw;
  if (typeof pkg !== "string" || pkg.length === 0) return null;
  if (mode !== "one" && mode !== "chain") return null;
  return { pkg, mode };
}

function isChangesetEntry(v: unknown): v is ChangesetEntry {
  if (!isRecord(v)) return false;
  if (typeof v["pkg"] !== "string" || v["pkg"].length === 0) return false;
  if (typeof v["repo"] !== "string" || v["repo"].length === 0) return false;
  if (typeof v["fromVersion"] !== "string") return false;
  if (typeof v["toVersion"] !== "string") return false;
  if (typeof v["level"] !== "number") return false;
  if (v["dir"] !== undefined && typeof v["dir"] !== "string") return false;
  const depBumps = v["depBumps"];
  if (!isRecord(depBumps)) return false;
  for (const value of Object.values(depBumps)) {
    if (typeof value !== "string") return false;
  }
  return true;
}

function parseEntriesBody(raw: unknown): ChangesetEntry[] | null {
  if (!isRecord(raw)) return null;
  const entries = raw["entries"];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (!entries.every(isChangesetEntry)) return null;
  return entries as ChangesetEntry[];
}

interface MergeRequestBody {
  repo: string;
  pr: number;
}

function parseMergeBody(raw: unknown): MergeRequestBody | null {
  if (!isRecord(raw)) return null;
  const { repo, pr } = raw;
  if (typeof repo !== "string" || repo.length === 0) return null;
  if (typeof pr !== "number" || !Number.isInteger(pr)) return null;
  return { repo, pr };
}

interface TrainRequestBody {
  entries: ChangesetEntry[];
  prs: Record<string, number>;
}

function parseTrainBody(raw: unknown): TrainRequestBody | null {
  if (!isRecord(raw)) return null;
  const entries = parseEntriesBody(raw);
  if (!entries) return null;
  const prsRaw = raw["prs"];
  if (!isRecord(prsRaw)) return null;
  const prs: Record<string, number> = {};
  for (const [repo, pr] of Object.entries(prsRaw)) {
    if (typeof pr !== "number" || !Number.isInteger(pr)) return null;
    prs[repo] = pr;
  }
  return { entries, prs };
}

// --- membership: never act on a repo the request names without checking ------

/**
 * Fetches this installation's own repo list fresh and returns it as a
 * lookup — the one source of truth every mutating route below checks a
 * client-supplied repo name against before acting on it. Mirrors
 * `assertInstallationMembership`'s "never trust the id/name alone, always
 * recheck against a fresh listing" shape, one layer down (repos within an
 * installation, rather than installations within a user).
 */
async function ownedRepos(apis: InstallationApis): Promise<Map<string, RepoRef>> {
  const repos = await apis.githubApi.listRepos();
  return new Map(repos.map((r) => [r.fullName, r]));
}

// --- route handlers ------------------------------------------------------------

async function handleRepos(apis: InstallationApis, deps: ApiDeps, installationId: number): Promise<Response> {
  let repos: RepoRef[];
  try {
    repos = await apis.githubApi.listRepos();
  } catch (err) {
    return errorResponse(err, 502);
  }

  const requiredChecks = await deps.requiredChecksFor(installationId);

  const results: { name: string; private: boolean; prepared: PrepareResult }[] = [];
  // Serial loop, deliberately: assessRepo issues 6+ requests per repo, and a
  // burst of concurrent requests across many repos gets 403'd by GitHub's
  // secondary rate limits — see src/cli/deps.ts's realDeps for the same
  // reasoning applied to the CLI's cascade-planning path.
  for (const repo of repos) {
    let prepared: PrepareResult;
    try {
      prepared = await assessRepo(apis.adminApi, repo.fullName, requiredChecks);
    } catch (err) {
      prepared = {
        repo: repo.fullName,
        ready: false,
        mechanism: "control-plane",
        blockers: [`could not assess readiness: ${messageOf(err)}`],
      };
    }
    results.push({ name: repo.fullName, private: repo.private, prepared });
  }
  return jsonResponse({ repos: results });
}

async function handleGraph(apis: InstallationApis, deps: ApiDeps, installationId: number): Promise<Response> {
  const scope = await deps.scopeFor(installationId);
  const source = new GitHubGraphSource(apis.githubApi, scope);
  let graph: Map<string, RepoNode>;
  try {
    graph = await source.load();
  } catch (err) {
    return errorResponse(err, 502);
  }
  const nodes = [...graph.values()];
  const edges = classifyEdges(nodes);
  return jsonResponse({ nodes, edges, skipped: source.skipped });
}

async function handleUpdate(
  req: Request,
  apis: InstallationApis,
  deps: ApiDeps,
  installationId: number,
): Promise<Response> {
  const raw = await readJsonBody(req);
  const body = parseUpdateBody(raw);
  if (!body) {
    return jsonResponse({ error: 'expected { pkg: string, mode: "one" | "chain" }' }, 400);
  }

  const scope = await deps.scopeFor(installationId);
  const source = new GitHubGraphSource(apis.githubApi, scope);
  let graph: Map<string, RepoNode>;
  try {
    graph = await source.load();
  } catch (err) {
    return errorResponse(err, 502);
  }

  if (!graph.has(body.pkg)) {
    return jsonResponse({ error: `unknown package: ${body.pkg}` }, 404);
  }

  // No PR, branch, or file write happens on this path — see the module
  // comment. This handler only ever calls `apis.githubApi` (read-only:
  // listRepos/getManifest via GitHubGraphSource) and the pure planners.
  // `apis.prApi` is never referenced here.
  let entries: ChangesetEntry[];
  try {
    entries = body.mode === "one" ? planUpdateOne(graph, body.pkg) : planUpdateChain(graph, body.pkg);
  } catch (err) {
    return errorResponse(err, 400);
  }

  return jsonResponse({ entries, skipped: source.skipped });
}

/**
 * Creates one branch, commits the updated manifest to it, and opens the PR
 * for a single changeset entry — the three GitHub-mutating steps
 * `openUpdatePrs` alone does not cover, since it only calls `openPr` and
 * assumes the head branch already carries the change. `base` must be the
 * repo's own actual default branch (from the fresh `ownedRepos` lookup the
 * caller already did), never a hardcoded "main" — see the module doc on
 * `openUpdatePrs`/`openChangesetPrs` for why that default is unsafe.
 */
async function openPrForEntry(
  entry: ChangesetEntry,
  apis: InstallationApis,
  base: string,
): Promise<number> {
  const branch = branchNameFor(entry);
  const fromSha = await apis.prApi.defaultBranchSha(entry.repo, base);
  await apis.prApi.createBranch(entry.repo, branch, fromSha);

  const raw = await apis.githubApi.getManifest(entry.repo);
  if (raw === null) {
    throw new Error(`${entry.repo} has no package.json to update`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${entry.repo}: package.json is not valid JSON: ${messageOf(err)}`);
  }
  const updated = applyEntry(entry, manifest);
  const content = `${JSON.stringify(updated, null, 2)}\n`;
  await apis.prApi.putFile(entry.repo, branch, "package.json", content, prTitleFor(entry));

  const prs = await openUpdatePrs([entry], apis.prApi, branch, base);
  const pr = prs.get(entry.repo);
  if (pr === undefined) {
    // Unreachable in practice: openUpdatePrs always sets exactly the one
    // repo it was given, or throws. Kept as a guard, not error handling.
    throw new Error(`openUpdatePrs did not return a PR number for ${entry.repo}`);
  }
  return pr;
}

async function handlePrs(req: Request, apis: InstallationApis, _deps: ApiDeps): Promise<Response> {
  const raw = await readJsonBody(req);
  const entries = parseEntriesBody(raw);
  if (!entries) {
    return jsonResponse({ error: "expected { entries: ChangesetEntry[] } (non-empty)" }, 400);
  }

  let owned: Map<string, RepoRef>;
  try {
    owned = await ownedRepos(apis);
  } catch (err) {
    return errorResponse(err, 502);
  }

  // Never open a PR against a repo the client named that isn't actually part
  // of this installation — a tampered/hand-built changeset body must not be
  // able to point PR-opening at an arbitrary repo.
  const foreign = entries.filter((e) => !owned.has(e.repo));
  if (foreign.length > 0) {
    return jsonResponse(
      { error: `not part of this installation: ${foreign.map((e) => e.repo).join(", ")}` },
      403,
    );
  }

  const prsMap = new Map<string, number>();
  // Serial loop, deliberately — see handleRepos.
  for (const entry of entries) {
    const base = owned.get(entry.repo)!.defaultBranch;
    let pr: number;
    try {
      pr = await openPrForEntry(entry, apis, base);
    } catch (err) {
      return jsonResponse(
        {
          error: `opening PR for ${entry.repo} failed: ${messageOf(err)}`,
          opened: [...prsMap.entries()].map(([repo, prNumber]) => ({ repo, pr: prNumber })),
        },
        502,
      );
    }
    prsMap.set(entry.repo, pr);
  }

  const published = new Set<string>(); // nothing has published yet at the moment PRs are opened
  const results: { pkg: string; repo: string; pr: number; state: PrState }[] = entries.map((entry) => ({
    pkg: entry.pkg,
    repo: entry.repo,
    pr: prsMap.get(entry.repo)!,
    state: classifyPr(entry, entries, published),
  }));

  return jsonResponse({ prs: results });
}

async function handleMerge(req: Request, apis: InstallationApis, _deps: ApiDeps): Promise<Response> {
  const raw = await readJsonBody(req);
  const body = parseMergeBody(raw);
  if (!body) {
    return jsonResponse({ error: "expected { repo: string, pr: number }" }, 400);
  }

  let owned: Map<string, RepoRef>;
  try {
    owned = await ownedRepos(apis);
  } catch (err) {
    // Deliberately 503, not 502: this is `ownedRepos` (a fresh `listRepos`
    // call) failing before this merge attempt ever reaches `mergePr` — a
    // systemic problem (the installation token exchange is broken, GitHub
    // itself is unreachable) that has nothing to do with *this* PR. A
    // caller that reads any non-2xx here as "this PR's merge failed" (the
    // hosted web client does exactly that, deliberately, for the ordinary
    // case below) would badge a perfectly healthy PR "failed" because the
    // installation's credentials went bad — a confident, wrong, per-item
    // diagnosis of what is actually an account-wide outage. Giving the two
    // failure modes distinct statuses is what lets a caller tell them apart
    // without parsing the message.
    return errorResponse(err, 503);
  }

  if (!owned.has(body.repo)) {
    return jsonResponse({ error: `not part of this installation: ${body.repo}` }, 403);
  }

  try {
    await apis.prApi.mergePr(body.repo, body.pr);
  } catch (err) {
    // 502: mergePr itself was reached and GitHub rejected it — an ordinary,
    // per-PR merge failure (a required check hasn't passed, a conflict,
    // etc.), not a systemic one. See the 503 above for the failure mode
    // this is deliberately kept distinct from.
    return errorResponse(err, 502);
  }

  return jsonResponse({ merged: true, repo: body.repo, pr: body.pr });
}

async function handleTrain(req: Request, apis: InstallationApis, deps: ApiDeps): Promise<Response> {
  const raw = await readJsonBody(req);
  const body = parseTrainBody(raw);
  if (!body) {
    return jsonResponse({ error: "expected { entries: ChangesetEntry[], prs: Record<string, number> }" }, 400);
  }

  let owned: Map<string, RepoRef>;
  try {
    owned = await ownedRepos(apis);
  } catch (err) {
    return errorResponse(err, 502);
  }

  // Same membership check as /api/prs and /api/merge, applied to every repo
  // this train would touch: each entry's repo, and every repo named as a key
  // in the caller-supplied PR map (the two can differ if the client hand-
  // edits the body).
  const namedRepos = new Set([...body.entries.map((e) => e.repo), ...Object.keys(body.prs)]);
  const foreign = [...namedRepos].filter((repo) => !owned.has(repo));
  if (foreign.length > 0) {
    return jsonResponse({ error: `not part of this installation: ${foreign.join(", ")}` }, 403);
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const isResolvable = deps.isResolvable ?? defaultIsResolvable;
  const trainDeps: TrainDeps = {
    async mergePr(entry, pr) {
      try {
        await apis.prApi.mergePr(entry.repo, pr);
        return true;
      } catch {
        // A rejected mergePr can mean the merge genuinely failed, or that
        // this exact PR was already merged — e.g. a client retry after a
        // gateway timeout re-issuing a call whose original attempt actually
        // succeeded (mergePr can take longer than common gateway idle
        // timeouts under this route's default poll settings). GitHub
        // rejects a second merge attempt on an already-merged PR, and
        // reporting that as a stall would tell the user the chain broke
        // when the step in question actually completed. Re-check the PR's
        // own state before giving up — only a genuine, still-open PR is a
        // real failure.
        try {
          const state = await apis.prApi.prState(entry.repo, pr);
          if (state === "MERGED") return true;
        } catch {
          // Could not even check state — fall through to reporting the
          // original failure; this is a second chance, not a replacement
          // for a meaningful error.
        }
        return false;
      }
    },
    isResolvable: (entry) => isResolvable(entry, fetchFn),
    sleep: deps.sleep ?? defaultSleep,
    pollIntervalMs: deps.pollIntervalMs,
    maxPollAttempts: deps.maxPollAttempts,
  };

  const prsMap = new Map(Object.entries(body.prs));
  const outcome: TrainOutcome = await runTrain(body.entries, prsMap, trainDeps);
  return jsonResponse({ outcome });
}

/**
 * Which of `entries[].toVersion` are genuinely resolvable right now — i.e.
 * actually published, not merely merged to a default branch.
 *
 * This exists for the manual "Refresh" action in the web UI. `GET
 * /api/graph` reads each repo's default-branch `package.json`, so a
 * package's version there flips the instant its bump PR *merges* — before
 * any CI publish has run. Feeding that straight into `classifyPr` (via
 * `published`) would let a downstream PR go `ready` and mergeable the
 * moment its dependency's PR merges, which is exactly the merge/publish
 * race `runTrain`'s own `isResolvable` polling (see `handleTrain` above)
 * exists to eliminate on the Auto Merge path. This route gives the manual
 * path the same real signal, via the same injectable `deps.isResolvable`
 * (defaulting to a real npm registry lookup, overridden in every test so no
 * suite run ever makes a network call) — never the graph reload.
 */
async function handlePublished(req: Request, apis: InstallationApis, deps: ApiDeps): Promise<Response> {
  const raw = await readJsonBody(req);
  const entries = parseEntriesBody(raw);
  if (!entries) {
    return jsonResponse({ error: "expected { entries: ChangesetEntry[] } (non-empty)" }, 400);
  }

  let owned: Map<string, RepoRef>;
  try {
    owned = await ownedRepos(apis);
  } catch (err) {
    return errorResponse(err, 502);
  }

  // Same membership check as /api/prs, /api/merge and /api/train — a
  // tampered changeset body must not be able to make this route probe the
  // registry on behalf of a repo outside this installation.
  const foreign = entries.filter((e) => !owned.has(e.repo));
  if (foreign.length > 0) {
    return jsonResponse(
      { error: `not part of this installation: ${foreign.map((e) => e.repo).join(", ")}` },
      403,
    );
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const isResolvable = deps.isResolvable ?? defaultIsResolvable;
  const resolvable: string[] = [];
  for (const entry of entries) {
    if (await isResolvable(entry, fetchFn)) {
      resolvable.push(entry.pkg);
    }
  }

  return jsonResponse({ resolvable });
}

// --- dispatch ------------------------------------------------------------------

const API_ROUTES = new Set([
  "/api/repos",
  "/api/graph",
  "/api/update",
  "/api/prs",
  "/api/merge",
  "/api/train",
  "/api/published",
]);

/**
 * Routes one of the hosted API paths above. Returns `null` for any other
 * path so the caller (see `src/server/index.ts`) can fall through to its own
 * routes/404 unaffected.
 *
 * `session` must come from a freshly-verified `SessionStore.readSession` —
 * never from a client-supplied header/body field — and `null` (missing,
 * malformed, tampered, or expired) is always a flat 401 here, matching
 * `/api/whoami`'s contract in `src/server/index.ts`. There is no default
 * installation to fall back to.
 */
export async function handleApiRequest(
  req: Request,
  url: URL,
  session: SessionPayload | null,
  deps: ApiDeps,
): Promise<Response | null> {
  if (!API_ROUTES.has(url.pathname)) return null;

  if (!session) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // The only installation id ever used to build these APIs. Nothing below
  // this line reads an installation id from the request itself.
  const apis = deps.apisFor(session.installationId);

  if (url.pathname === "/api/repos" && req.method === "GET") return handleRepos(apis, deps, session.installationId);
  if (url.pathname === "/api/graph" && req.method === "GET") return handleGraph(apis, deps, session.installationId);
  if (url.pathname === "/api/update" && req.method === "POST") {
    return handleUpdate(req, apis, deps, session.installationId);
  }
  if (url.pathname === "/api/prs" && req.method === "POST") return handlePrs(req, apis, deps);
  if (url.pathname === "/api/merge" && req.method === "POST") return handleMerge(req, apis, deps);
  if (url.pathname === "/api/train" && req.method === "POST") return handleTrain(req, apis, deps);
  if (url.pathname === "/api/published" && req.method === "POST") return handlePublished(req, apis, deps);

  return jsonResponse({ error: "not found" }, 404);
}
