import { TokenStore, type AppCredentials } from "../auth/appAuth";
import { InstallationGitHubApi } from "../github/installationApi";
import { InstallationRepoAdminApi } from "../prepare/installationAdminApi";
import { GitHubGraphSource } from "../graph/githubSource";
import { assessRepo, prepareRepo } from "../prepare/prepare";
import { planCascade, type PreparedProvider } from "../plan/planCascade";
import type { CliDeps } from "./main";
import type { CliConfig } from "./config";
import type { PrepareResult } from "../prepare/types";

/**
 * Builds the real `CliDeps` `bin.ts` runs against, wired to one GitHub App
 * installation.
 *
 * Structural, not incidental: this module imports `assessRepo` for the plan
 * path and never hands `prepareRepo` to `planCascade`'s `PreparedProvider`.
 * `prepareRepo` is used exactly once, in `prepare`, where mutation is the
 * point. `plan` must never write to a customer repository — see
 * `PreparedProvider`'s doc comment in `../plan/planCascade` for why a
 * provider exists at all.
 */
export function realDeps(config: CliConfig, fetchFn: typeof fetch = fetch): CliDeps {
  const creds: AppCredentials = { appId: config.appId, privateKeyPem: config.privateKeyPem };
  const tokens = new TokenStore(creds, fetchFn);
  const getToken = (installationId: number) => tokens.get(installationId);

  const githubApi = new InstallationGitHubApi(getToken, config.installationId, fetchFn);
  const adminApi = new InstallationRepoAdminApi(getToken, config.installationId, fetchFn);
  const source = new GitHubGraphSource(githubApi, config.scope);

  // Read-only by construction: assessRepo never calls enableAutoMerge or
  // setProtection. This is the only place planCascade learns anything about
  // repo readiness, so plan can never mutate through it.
  //
  // Sequential on purpose, not an oversight: assessRepo -> probeRepo issues
  // at least 6 requests per repo (getRepo, then recentPrHeadSha, then
  // getProtection + hasFile + listCheckRuns's 2+ requests, the last two in
  // parallel with getProtection/hasFile). GitHub's secondary rate limits
  // trigger on concurrency, not volume — a 60-package cascade run with
  // Promise.all here would fire hundreds of concurrent requests and get
  // 403'd. GitHubGraphSource.load() already takes one
  // manifest at a time for the same reason (see its doc comment). Bounded
  // concurrency would help throughput, but is only safe to add once
  // retry/backoff exists upstream of it — without that, a 403 from a burst of
  // concurrent requests is indistinguishable from a real failure and the
  // whole plan aborts. Until then: a plain, serial loop.
  const prepared: PreparedProvider = async (repos) => {
    const result = new Map<string, PrepareResult>();
    for (const repo of repos) {
      result.set(repo, await assessRepo(adminApi, repo, config.requiredChecks));
    }
    return result;
  };

  return {
    log: console.log,
    prepare: (repo) => prepareRepo(adminApi, repo, config.requiredChecks),
    plan: (changed, targets) => planCascade(source, changed, targets, prepared),
  };
}
