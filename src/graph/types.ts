export interface RepoNode {
  pkg: string;
  dir?: string;
  repo: string;
  version: string;
  deps: string[];
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
