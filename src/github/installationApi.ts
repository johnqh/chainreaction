import type { GitHubApi, RepoRef } from "../graph/githubSource";

const API_ROOT = "https://api.github.com";

/** Resolves a fresh (or cached-but-valid) installation token. Matches TokenStore.get. */
export type TokenProvider = (installationId: number) => Promise<string>;

interface RawRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
}

interface RawListReposResponse {
  repositories: RawRepo[];
}

/**
 * Extracts the rel="next" URL from a GitHub `Link` response header, or
 * `null` when there isn't one (i.e. this is the last page).
 *
 * GitHub's pagination is link-based, not count-based: `total_count` on the
 * list-repositories response is not a reliable page count to compute from,
 * so the only correct way to know whether more pages exist is to check for
 * this header on every page, including the first.
 */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1]!;
  }
  return null;
}

/**
 * A `GitHubApi` implementation backed by the real GitHub REST API, scoped to
 * one installation. Callers supply a token provider (e.g. `TokenStore.get`)
 * so this class never mints or caches credentials itself.
 */
export class InstallationGitHubApi implements GitHubApi {
  constructor(
    private getToken: TokenProvider,
    private installationId: number,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async listRepos(): Promise<RepoRef[]> {
    const repos: RepoRef[] = [];
    let url: string | null = `${API_ROOT}/installation/repositories?per_page=100`;

    while (url) {
      const res: Response = await this.request(url);
      if (!res.ok) {
        throw new Error(`listRepos failed: ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as RawListReposResponse;
      for (const r of body.repositories) {
        repos.push({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch });
      }
      // Follow the Link header, never a count computed from total_count —
      // that is exactly the bug that silently truncates a large installation.
      url = parseNextLink(res.headers.get("link"));
    }
    return repos;
  }

  async getManifest(fullName: string): Promise<string | null> {
    const res = await this.request(`${API_ROOT}/repos/${fullName}/contents/package.json`, {
      accept: "application/vnd.github.raw+json",
    });
    if (res.status === 404) return null; // no manifest is normal, not an error
    if (!res.ok) {
      // A 403 or 500 must never be mistaken for "this repo has no
      // manifest" — that would silently drop a repo from the publish plan.
      throw new Error(`getManifest(${fullName}) failed: ${res.status} ${res.statusText}`);
    }
    // `application/vnd.github.raw+json` returns the file's raw bytes
    // directly, not the default base64-encoded JSON envelope.
    return res.text();
  }

  private async request(url: string, extraHeaders?: Record<string, string>): Promise<Response> {
    const token = await this.getToken(this.installationId);
    return this.fetchFn(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        ...extraHeaders,
      },
    });
  }
}
