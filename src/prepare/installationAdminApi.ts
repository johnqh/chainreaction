import type { RepoAdminApi, RepoMeta, ProtectionProbe } from "./adminApi";
import type { TokenProvider } from "../github/installationApi";

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
