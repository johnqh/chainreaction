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

/** A repo dropped from the graph, and why — so a partial graph never looks complete. */
export interface SkippedRepo {
  repo: string;
  reason: string;
}

export class GitHubGraphSource implements GraphSource {
  readonly skipped: SkippedRepo[] = [];

  constructor(private api: GitHubApi, private scope: string) {}

  async load(): Promise<Map<string, RepoNode>> {
    const repos = await this.api.listRepos();
    const graph = new Map<string, RepoNode>();
    this.skipped.length = 0;

    for (const repo of repos) {
      const raw = await this.api.getManifest(repo.fullName);
      if (raw === null) continue; // no manifest is normal, not an error

      let pkg: { name?: string; version?: string;
                 dependencies?: Record<string, string>;
                 peerDependencies?: Record<string, string>;
                 devDependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(raw);
      } catch (err) {
        // A repo silently vanishing from a publish plan is the wrong failure mode.
        const reason = `unparseable manifest: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`GitHubGraphSource: skipping ${repo.fullName}: ${reason}`);
        this.skipped.push({ repo: repo.fullName, reason });
        continue;
      }
      if (!pkg.name) {
        this.skipped.push({ repo: repo.fullName, reason: "manifest has no name field" });
        continue;
      }

      const existing = graph.get(pkg.name);
      if (existing) {
        throw new Error(
          `two repos declare the package ${pkg.name}: ${existing.repo} and ${repo.fullName}. ` +
            `Refusing to plan a cascade against an ambiguous graph.`,
        );
      }

      const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })
        .filter((d) => d.startsWith(this.scope))
        .sort();

      const devDeps = Object.keys(pkg.devDependencies ?? {})
        .filter((d) => d.startsWith(this.scope))
        .sort();

      graph.set(pkg.name, {
        pkg: pkg.name,
        repo: repo.fullName,
        version: pkg.version ?? "0.0.0",
        deps,
        devDeps,
      });
    }
    return graph;
  }
}
