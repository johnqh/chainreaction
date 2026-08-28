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
