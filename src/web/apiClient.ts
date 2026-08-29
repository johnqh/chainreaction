// Typed client over the hosted HTTP API in src/server/api.ts
// (GET /api/repos, GET /api/graph, POST /api/update, POST /api/prs,
// POST /api/merge, POST /api/train).
//
// This is a trust boundary like any other: every response is validated
// field-by-field before it reaches the rest of the app, never cast with
// `as`. A non-2xx response always throws — carrying the server's own
// message — rather than resolving to some plausible-looking default (an
// empty array, an empty graph). Swallowing a failed request into an empty
// result is this project's signature failure mode: "the server is
// unreachable" must never quietly become "you have no repositories".
import type { ChangesetEntry, RepoNode } from "../graph/types";
import type { PrepareResult } from "../prepare/types";
import type { PrState } from "../pr/lifecycle";
import type { MergedStep, TrainOutcome } from "../pr/train";
import type { GraphEdge } from "./graphModel";

/** One entry from GET /api/repos. */
export interface RepoStatus {
  name: string;
  private: boolean;
  prepared: PrepareResult;
}

export interface SkippedRepo {
  repo: string;
  reason: string;
}

/** The response shape of GET /api/graph. */
export interface GraphResult {
  nodes: RepoNode[];
  edges: GraphEdge[];
  skipped: SkippedRepo[];
}

/** One entry from the `prs` array POST /api/prs returns. */
export interface PrResult {
  pkg: string;
  repo: string;
  pr: number;
  state: PrState;
}

/**
 * Thrown for any non-2xx response, and for a request that never reached the
 * server at all (network failure). Carries the server's own message where
 * one is available, and the HTTP status — 0 for a network-level failure —
 * so callers can tell a session that's gone (`unauthorized`) from every
 * other kind of failure, and never need to inspect `message` to branch on
 * that distinction.
 */
/** One PR that had already opened before a later entry in the same POST /api/prs call failed. */
export interface OpenedPr {
  repo: string;
  pr: number;
}

export class ApiError extends Error {
  readonly status: number;
  /**
   * Set only for a partial POST /api/prs failure (see handlePrs in
   * src/server/api.ts): the PRs that opened successfully before the entry
   * that failed. A caller MUST surface these alongside `message` — they are
   * real, already-open PRs on GitHub the user does not otherwise know about.
   */
  readonly opened?: OpenedPr[];

  constructor(status: number, message: string, opened?: OpenedPr[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (opened !== undefined) this.opened = opened;
  }

  /** True for a 401 — the session is gone or invalid, distinct from every other failure. */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

export interface ApiClientOptions {
  /** Injected so no test ever makes a real network call. Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Prepended to every request path. Defaults to "" (same-origin). */
  baseUrl?: string;
}

export interface ApiClient {
  getRepos(): Promise<RepoStatus[]>;
  getGraph(): Promise<GraphResult>;
  /**
   * Plans an Update (`mode: "one"`) or Update Chain (`mode: "chain"`). Opens
   * no PR. `skipped` names repos whose manifest could not be parsed while
   * planning — a repo silently missing from the graph is a repo silently
   * missing from the cascade, so this must reach the UI, not just `entries`.
   */
  postUpdate(pkg: string, mode: "one" | "chain"): Promise<{ entries: ChangesetEntry[]; skipped: SkippedRepo[] }>;
  /** Opens one PR per entry. Returns the PR number for each entry's repo. */
  postPrs(entries: ChangesetEntry[]): Promise<Map<string, number>>;
  /** Merges one PR. Throws on any failure — including an ordinary GitHub-side merge rejection. */
  postMerge(repo: string, pr: number): Promise<void>;
  /** Runs the Auto Merge train to completion (or stall). */
  postTrain(entries: ChangesetEntry[], prs: Map<string, number>): Promise<TrainOutcome>;
  /**
   * Which of `entries`' packages are genuinely resolvable right now (an
   * actual registry publish), not merely merged to a default branch. Used
   * by a manual "Refresh" — never conflate this with a version comparison
   * against `getGraph()`'s nodes, which reflects a merge, not a publish.
   */
  postPublished(entries: ChangesetEntry[]): Promise<Set<string>>;
}

// --- response validation (never cast) -----------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isPrepareResult(v: unknown): v is PrepareResult {
  if (!isRecord(v)) return false;
  if (typeof v["repo"] !== "string" || v["repo"].length === 0) return false;
  if (typeof v["ready"] !== "boolean") return false;
  if (v["mechanism"] !== "auto-merge" && v["mechanism"] !== "control-plane") return false;
  if (!isStringArray(v["blockers"])) return false;
  return true;
}

function isRepoStatus(v: unknown): v is RepoStatus {
  if (!isRecord(v)) return false;
  if (typeof v["name"] !== "string" || v["name"].length === 0) return false;
  if (typeof v["private"] !== "boolean") return false;
  if (!isPrepareResult(v["prepared"])) return false;
  return true;
}

function isRepoNode(v: unknown): v is RepoNode {
  if (!isRecord(v)) return false;
  if (typeof v["pkg"] !== "string" || v["pkg"].length === 0) return false;
  if (typeof v["repo"] !== "string" || v["repo"].length === 0) return false;
  if (typeof v["version"] !== "string") return false;
  if (!isStringArray(v["deps"])) return false;
  if (v["dir"] !== undefined && typeof v["dir"] !== "string") return false;
  if (v["devDeps"] !== undefined && !isStringArray(v["devDeps"])) return false;
  return true;
}

function isGraphEdge(v: unknown): v is GraphEdge {
  if (!isRecord(v)) return false;
  if (typeof v["from"] !== "string") return false;
  if (typeof v["to"] !== "string") return false;
  if (v["kind"] !== "dependency" && v["kind"] !== "devDependency") return false;
  return true;
}

function isSkippedRepo(v: unknown): v is SkippedRepo {
  if (!isRecord(v)) return false;
  return typeof v["repo"] === "string" && typeof v["reason"] === "string";
}

function isOpenedPr(v: unknown): v is OpenedPr {
  if (!isRecord(v)) return false;
  return typeof v["repo"] === "string" && typeof v["pr"] === "number";
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

function isPrState(v: unknown): v is PrState {
  return v === "ready" || v === "blocked" || v === "merged" || v === "failed";
}

function isPrResult(v: unknown): v is PrResult {
  if (!isRecord(v)) return false;
  if (typeof v["pkg"] !== "string") return false;
  if (typeof v["repo"] !== "string") return false;
  if (typeof v["pr"] !== "number") return false;
  if (!isPrState(v["state"])) return false;
  return true;
}

function isMergedStep(v: unknown): v is MergedStep {
  if (!isRecord(v)) return false;
  return typeof v["pkg"] === "string" && typeof v["repo"] === "string";
}

function isTrainOutcome(v: unknown): v is TrainOutcome {
  if (!isRecord(v)) return false;
  if (!Array.isArray(v["merged"]) || !v["merged"].every(isMergedStep)) return false;
  if (v["status"] === "success") return true;
  if (v["status"] === "stalled") {
    return (
      typeof v["pkg"] === "string" &&
      typeof v["repo"] === "string" &&
      typeof v["reason"] === "string"
    );
  }
  return false;
}

function extractErrorMessage(body: unknown): string | null {
  if (isRecord(body) && typeof body["error"] === "string" && body["error"].length > 0) {
    return body["error"];
  }
  return null;
}

// --- core request/validate plumbing --------------------------------------------

async function parseJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function request(
  fetchFn: typeof fetch,
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}${path}`, init);
  } catch (err) {
    // A network-level failure (server unreachable, DNS, CORS) must read as
    // loudly as a non-2xx response — status 0 marks it as never having
    // reached the server, but it is never swallowed into a default value.
    throw new ApiError(0, err instanceof Error ? err.message : `request to ${path} failed`);
  }
  const body = await parseJsonBody(res);
  if (!res.ok) {
    const message = extractErrorMessage(body) ?? `${path} failed with status ${res.status}`;
    // Only handlePrs's partial-failure response carries `opened`, but this
    // is checked generically — no other endpoint sends the field, so this
    // never fires for them.
    const opened =
      isRecord(body) && Array.isArray(body["opened"]) && body["opened"].every(isOpenedPr)
        ? (body["opened"] as OpenedPr[])
        : undefined;
    throw new ApiError(res.status, message, opened);
  }
  return body;
}

/** Validates `body` against `isValid` or throws — a 2xx response is not automatically a well-formed one. */
function validated<T>(path: string, body: unknown, isValid: (v: unknown) => v is T): T {
  if (!isValid(body)) {
    throw new Error(`${path}: response did not match the expected shape`);
  }
  return body;
}

const JSON_HEADERS = { "content-type": "application/json" };

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl ?? "";

  return {
    async getRepos() {
      const body = await request(fetchFn, baseUrl, "/api/repos", { method: "GET" });
      const parsed = validated(
        "GET /api/repos",
        body,
        (v): v is { repos: RepoStatus[] } =>
          isRecord(v) && Array.isArray(v["repos"]) && v["repos"].every(isRepoStatus),
      );
      return parsed.repos;
    },

    async getGraph() {
      const body = await request(fetchFn, baseUrl, "/api/graph", { method: "GET" });
      const parsed = validated(
        "GET /api/graph",
        body,
        (v): v is GraphResult =>
          isRecord(v) &&
          Array.isArray(v["nodes"]) &&
          v["nodes"].every(isRepoNode) &&
          Array.isArray(v["edges"]) &&
          v["edges"].every(isGraphEdge) &&
          Array.isArray(v["skipped"]) &&
          v["skipped"].every(isSkippedRepo),
      );
      return { nodes: parsed.nodes, edges: parsed.edges, skipped: parsed.skipped };
    },

    async postUpdate(pkg, mode) {
      const body = await request(fetchFn, baseUrl, "/api/update", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ pkg, mode }),
      });
      const parsed = validated(
        "POST /api/update",
        body,
        (v): v is { entries: ChangesetEntry[]; skipped: SkippedRepo[] } =>
          isRecord(v) &&
          Array.isArray(v["entries"]) &&
          v["entries"].every(isChangesetEntry) &&
          Array.isArray(v["skipped"]) &&
          v["skipped"].every(isSkippedRepo),
      );
      return { entries: parsed.entries, skipped: parsed.skipped };
    },

    async postPrs(entries) {
      const body = await request(fetchFn, baseUrl, "/api/prs", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ entries }),
      });
      const parsed = validated(
        "POST /api/prs",
        body,
        (v): v is { prs: PrResult[] } =>
          isRecord(v) && Array.isArray(v["prs"]) && v["prs"].every(isPrResult),
      );
      return new Map(parsed.prs.map((p) => [p.repo, p.pr]));
    },

    async postMerge(repo, pr) {
      const body = await request(fetchFn, baseUrl, "/api/merge", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ repo, pr }),
      });
      validated(
        "POST /api/merge",
        body,
        (v): v is { merged: true; repo: string; pr: number } =>
          isRecord(v) &&
          v["merged"] === true &&
          typeof v["repo"] === "string" &&
          typeof v["pr"] === "number",
      );
    },

    async postTrain(entries, prs) {
      const body = await request(fetchFn, baseUrl, "/api/train", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ entries, prs: Object.fromEntries(prs) }),
      });
      const parsed = validated(
        "POST /api/train",
        body,
        (v): v is { outcome: TrainOutcome } => isRecord(v) && isTrainOutcome(v["outcome"]),
      );
      return parsed.outcome;
    },

    async postPublished(entries) {
      const body = await request(fetchFn, baseUrl, "/api/published", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ entries }),
      });
      const parsed = validated(
        "POST /api/published",
        body,
        (v): v is { resolvable: string[] } => isRecord(v) && isStringArray(v["resolvable"]),
      );
      return new Set(parsed.resolvable);
    },
  };
}
