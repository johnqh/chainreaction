export interface RepoMeta {
  defaultBranch: string;
  isPrivate: boolean;
  allowAutoMerge: boolean;
}

export interface ProtectionProbe {
  status: number;
  /** GitHub's error `message` body field, when present. Only meaningful on non-2xx statuses. */
  message?: string;
  /**
   * The parsed JSON body of a 200 response. `setProtection` is a whole-object
   * PUT replace, so callers must inspect this — never assume the only thing
   * present is required status checks — before deciding whether it is safe
   * to overwrite.
   */
  body?: Record<string, unknown>;
}

export interface RepoAdminApi {
  getRepo(full: string): Promise<RepoMeta>;
  /**
   * Result of GET /branches/{branch}/protection — 200, 404 and 403 are all
   * meaningful. GitHub returns 403 on this endpoint for several unrelated
   * reasons (free-tier plan limit, missing Administration permission,
   * secondary rate limits, SAML/SSO enforcement), distinguishable only by
   * the `message` field — the status code alone is not enough to classify.
   */
  getProtection(full: string, branch: string): Promise<ProtectionProbe>;
  hasFile(full: string, path: string): Promise<boolean>;
  setProtection(full: string, branch: string, contexts: string[]): Promise<void>;
  enableAutoMerge(full: string): Promise<void>;
}
