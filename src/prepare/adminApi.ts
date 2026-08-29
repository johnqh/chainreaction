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
  /**
   * The head commit SHA of the most recently updated pull request against
   * `full` (open or closed, any base branch), or `null` if the repo has
   * never had one. Required status checks are evaluated against a pull
   * request's *head* commit, not the default branch tip — those two sets of
   * check-runs/statuses can be almost entirely disjoint (a
   * `workflow_dispatch` run, for instance, attaches its check-run to
   * whatever ref it was dispatched with, never to a PR head). This is the
   * closest available proxy for "a commit branch protection would actually
   * evaluate a required check against."
   */
  recentPrHeadSha(full: string): Promise<string | null>;
  /**
   * Distinct check names GitHub reports against `ref` — both check-runs
   * (`check_runs[].name`, the GitHub Checks API most modern CI uses) and
   * legacy commit statuses (`statuses[].context`, what CircleCI, Buildkite,
   * Jenkins and Travis report through). This is how Prepare tells a
   * required check that is merely misspelled or has never run apart from
   * one that genuinely runs on every PR — a typo here means branch
   * protection will require a check that never appears, silently making
   * every pull request to the repo unmergeable.
   */
  listCheckRuns(full: string, ref: string): Promise<string[]>;
  setProtection(full: string, branch: string, contexts: string[]): Promise<void>;
  enableAutoMerge(full: string): Promise<void>;
}
