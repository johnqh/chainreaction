import type { TokenProvider } from "./installationApi";

const API_ROOT = "https://api.github.com";

/**
 * Everything that opens, updates or merges a pull request. Extracted as an
 * interface (rather than reusing `GhClient` directly) because `GhClient`
 * declares `private exec`, and TypeScript's structural typing treats two
 * classes with different private members as incompatible even when their
 * public shape matches exactly. An installation-backed implementation could
 * never be assigned to a `GhClient`-typed parameter without this interface.
 *
 * Both `GhClient` (the local `gh` CLI, for interactive/dev use) and
 * `InstallationPrApi` (the hosted GitHub App installation) implement this.
 */
export interface PrApi {
  defaultBranchSha(full: string, branch: string): Promise<string>;
  createBranch(full: string, branch: string, fromSha: string): Promise<void>;
  putFile(
    full: string,
    branch: string,
    path: string,
    content: string,
    message: string,
  ): Promise<void>;
  openPr(full: string, head: string, base: string, title: string, body: string): Promise<number>;
  mergePr(full: string, pr: number): Promise<void>;
  prState(full: string, pr: number): Promise<string>;
}

/**
 * A `PrApi` implementation backed by the real GitHub REST API, scoped to one
 * installation. Callers supply a token provider (e.g. `TokenStore.get`) so
 * this class never mints or caches credentials itself — matches
 * `InstallationGitHubApi` and `InstallationRepoAdminApi`.
 */
export class InstallationPrApi implements PrApi {
  constructor(
    private getToken: TokenProvider,
    private installationId: number,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async request(url: string, init?: RequestInit): Promise<Response> {
    const token = await this.getToken(this.installationId);
    return this.fetchFn(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        // A plain-string body defaults to text/plain per the fetch spec, but
        // GitHub documents application/json for these mutating endpoints.
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  }

  async defaultBranchSha(full: string, branch: string): Promise<string> {
    const res = await this.request(`${API_ROOT}/repos/${full}/git/ref/heads/${branch}`);
    // Never interpolate the response into the message — it can carry credentials.
    if (!res.ok) throw new Error(`defaultBranchSha ${full}@${branch} failed: ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const object = body["object"] as Record<string, unknown> | undefined;
    const sha = object?.["sha"];
    if (typeof sha !== "string" || sha.length === 0) {
      throw new Error(`defaultBranchSha ${full}@${branch}: response has no usable sha`);
    }
    return sha;
  }

  async createBranch(full: string, branch: string, fromSha: string): Promise<void> {
    const res = await this.request(`${API_ROOT}/repos/${full}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
    });
    // A 409/422 here means the branch already exists (or fromSha is stale).
    // Both must be surfaced to the caller, never swallowed as success — a
    // caller that treats this as "done" would open a PR against a branch
    // that was never actually created or updated from this sha.
    if (!res.ok) throw new Error(`createBranch ${full}:${branch} failed: ${res.status}`);
  }

  /**
   * Replaces the contents of `path` on `branch`. The Contents API rejects a
   * write to an existing file unless the request carries that file's
   * *current* blob sha, so it is read here, immediately before the write,
   * every time — never cached, never inferred. Skipping this (or silently
   * tolerating a failed read) is the trap this method exists to avoid: the
   * write would either be rejected outright, or — if a caller swallowed
   * that rejection — leave the branch with no manifest change at all, so
   * the PR opens, CI passes against the OLD file, and it merges green
   * having changed nothing.
   */
  async putFile(
    full: string,
    branch: string,
    path: string,
    content: string,
    message: string,
  ): Promise<void> {
    const getRes = await this.request(
      `${API_ROOT}/repos/${full}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    );
    if (!getRes.ok) {
      throw new Error(
        `putFile ${full}:${path}: reading current sha on ${branch} failed: ${getRes.status}`,
      );
    }
    const getBody = (await getRes.json()) as Record<string, unknown>;
    const sha = getBody["sha"];
    if (typeof sha !== "string" || sha.length === 0) {
      throw new Error(`putFile ${full}:${path}: existing file has no usable sha`);
    }

    const res = await this.request(`${API_ROOT}/repos/${full}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch,
        sha,
      }),
    });
    // A failed write must never be swallowed: doing so is indistinguishable
    // from a successful no-op write, and this method exists precisely to
    // prevent that outcome.
    if (!res.ok) throw new Error(`putFile ${full}:${path} failed: ${res.status}`);
  }

  async openPr(
    full: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<number> {
    const res = await this.request(`${API_ROOT}/repos/${full}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, head, base, body }),
    });
    if (!res.ok) throw new Error(`openPr ${full} ${head}->${base} failed: ${res.status}`);
    const responseBody = (await res.json()) as Record<string, unknown>;
    const number = responseBody["number"];
    if (typeof number !== "number") {
      throw new Error(`openPr ${full}: response has no usable number`);
    }
    return number;
  }

  async mergePr(full: string, pr: number): Promise<void> {
    const res = await this.request(`${API_ROOT}/repos/${full}/pulls/${pr}/merge`, {
      method: "PUT",
      body: JSON.stringify({ merge_method: "squash" }),
    });
    if (!res.ok) throw new Error(`mergePr ${full}#${pr} failed: ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    // GitHub can answer 200 with `merged: false` (e.g. a race against a
    // required check) — that must fail loudly too, not read as success.
    if (body["merged"] !== true) {
      throw new Error(`mergePr ${full}#${pr}: GitHub reported merged=false`);
    }
  }

  async prState(full: string, pr: number): Promise<string> {
    const res = await this.request(`${API_ROOT}/repos/${full}/pulls/${pr}`);
    if (!res.ok) throw new Error(`prState ${full}#${pr} failed: ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const state = body["state"];
    if (typeof state !== "string" || state.length === 0) {
      throw new Error(`prState ${full}#${pr}: response has no usable state`);
    }
    // The REST API reports `state: "open" | "closed"` plus a separate
    // `merged` boolean — never a "merged" state string. Normalise to the
    // same MERGED/CLOSED/OPEN vocabulary `gh pr view --json state` (and
    // therefore GhClient, and the poller) already use.
    if (body["merged"] === true) return "MERGED";
    return state.toUpperCase();
  }
}
