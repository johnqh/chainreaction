export interface RepoNode {
  pkg: string;
  dir?: string;
  repo: string;
  version: string;
  deps: string[];
  /** devDependencies within scope. Not part of the publish graph — see src/graph/closure.ts. */
  devDeps?: string[];
}

export interface ChangesetEntry {
  pkg: string;
  dir?: string;
  repo: string;
  fromVersion: string;
  toVersion: string;
  depBumps: Record<string, string>;
  level: number;
}
