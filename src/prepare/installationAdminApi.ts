import type { RepoAdminApi, RepoMeta, ProtectionProbe } from "./adminApi";
import { parseNextLink, type TokenProvider } from "../github/installationApi";

const API_ROOT = "https://api.github.com";

export class InstallationRepoAdminApi implements RepoAdminApi {
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

  async getRepo(full: string): Promise<RepoMeta> {
    const res = await this.request(`${API_ROOT}/repos/${full}`);
    // Never interpolate the response into the message — it can carry credentials.
    if (!res.ok) throw new Error(`getRepo ${full} failed: ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const defaultBranch = body["default_branch"];
    if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
      throw new Error(`getRepo ${full}: response has no usable default_branch`);
    }
    return {
      defaultBranch,
      isPrivate: body["private"] === true,
      allowAutoMerge: body["allow_auto_merge"] === true,
    };
  }

  async getProtection(full: string, branch: string): Promise<ProtectionProbe> {
    const res = await this.request(
      `${API_ROOT}/repos/${full}/branches/${branch}/protection`,
    );
    // 200, 404 and 403 are all meaningful to classify(); it needs the message and
    // body to tell a free-tier 403 from a scope or rate-limit 403.
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
    const message = typeof parsed?.["message"] === "string" ? (parsed["message"] as string) : undefined;
    return { status: res.status, message, body: parsed };
  }

  async hasFile(full: string, path: string): Promise<boolean> {
    const res = await this.request(`${API_ROOT}/repos/${full}/contents/${path}`);
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    // A 500 quietly becoming "absent" would block a ready repo for the wrong reason.
    throw new Error(`hasFile ${full}:${path} failed: ${res.status}`);
  }

  /**
   * The head commit SHA of the most recently updated pull request, or
   * `null` if the repo has none. `state=all` so a repo whose only PRs are
   * already merged or closed still yields one — those still had their CI
   * run against a real PR head, which is exactly the surface being sampled.
   */
  async recentPrHeadSha(full: string): Promise<string | null> {
    const res = await this.request(
      `${API_ROOT}/repos/${full}/pulls?state=all&sort=updated&direction=desc&per_page=1`,
    );
    if (!res.ok) throw new Error(`recentPrHeadSha ${full} failed: ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new Error(`recentPrHeadSha ${full}: response is not an array`);
    }
    if (body.length === 0) return null;
    const first = body[0] as Record<string, unknown> | null;
    const head = (first?.["head"] ?? undefined) as Record<string, unknown> | undefined;
    const sha = head?.["sha"];
    if (typeof sha !== "string" || sha.length === 0) {
      throw new Error(`recentPrHeadSha ${full}: response has no usable head.sha`);
    }
    return sha;
  }

  /**
   * Walks every page of GET /repos/{full}/commits/{ref}/check-runs, then
   * folds in GET /repos/{full}/commits/{ref}/status, and returns the union
   * of distinct names seen. Two APIs because required-check contexts come
   * from either: the Checks API (`check_runs[].name`, most modern CI) or
   * the legacy Statuses API (`statuses[].context` — CircleCI, Buildkite,
   * Jenkins and Travis all report through the latter, never the former, so
   * skipping it would make Prepare reject every one of those contexts as
   * "never observed" even though it is exactly what branch protection
   * requires. The combined-status endpoint already folds in every status
   * ever posted for the ref, so this is one extra request, not another
   * paginated walk. Check-run pagination follows the `Link` header (via
   * `parseNextLink`, the same helper `InstallationGitHubApi.listRepos` and
   * `ActionsValidator.findRun` use) rather than trusting `total_count`, for
   * the same reason those callers do: a busy ref can have far more than one
   * page of check-runs.
   */
  async listCheckRuns(full: string, ref: string): Promise<string[]> {
    const names = new Set<string>();
    let url: string | null = `${API_ROOT}/repos/${full}/commits/${ref}/check-runs?per_page=100`;

    while (url) {
      const res: Response = await this.request(url);
      if (!res.ok) throw new Error(`listCheckRuns ${full}@${ref} failed: ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      const checkRuns = body["check_runs"];
      if (!Array.isArray(checkRuns)) {
        throw new Error(`listCheckRuns ${full}@${ref}: response has no check_runs array`);
      }
      for (const raw of checkRuns) {
        const name = (raw as Record<string, unknown> | null)?.["name"];
        if (typeof name !== "string" || name.length === 0) {
          throw new Error(`listCheckRuns ${full}@${ref}: a check run has no usable name`);
        }
        names.add(name);
      }
      url = parseNextLink(res.headers.get("link"));
    }

    const statusRes = await this.request(`${API_ROOT}/repos/${full}/commits/${ref}/status`);
    if (!statusRes.ok) {
      throw new Error(`listCheckRuns ${full}@${ref}: status lookup failed: ${statusRes.status}`);
    }
    const statusBody = (await statusRes.json()) as Record<string, unknown>;
    const statuses = statusBody["statuses"];
    if (!Array.isArray(statuses)) {
      throw new Error(`listCheckRuns ${full}@${ref}: response has no statuses array`);
    }
    for (const raw of statuses) {
      const context = (raw as Record<string, unknown> | null)?.["context"];
      if (typeof context !== "string" || context.length === 0) {
        throw new Error(`listCheckRuns ${full}@${ref}: a status has no usable context`);
      }
      names.add(context);
    }

    return [...names];
  }

  async setProtection(full: string, branch: string, contexts: string[]): Promise<void> {
    const res = await this.request(
      `${API_ROOT}/repos/${full}/branches/${branch}/protection`,
      {
        method: "PUT",
        body: JSON.stringify({
          required_status_checks: { strict: false, contexts },
          enforce_admins: false,
          // Explicitly null: an identity cannot approve its own pull request, so a
          // review requirement would stall every cascade at level 0.
          required_pull_request_reviews: null,
          restrictions: null,
        }),
      },
    );
    if (!res.ok) throw new Error(`setProtection ${full} failed: ${res.status}`);
  }

  async enableAutoMerge(full: string): Promise<void> {
    const res = await this.request(`${API_ROOT}/repos/${full}`, {
      method: "PATCH",
      body: JSON.stringify({ allow_auto_merge: true }),
    });
    if (!res.ok) throw new Error(`enableAutoMerge ${full} failed: ${res.status}`);
  }
}
