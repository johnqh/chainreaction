export interface RepoMeta {
  defaultBranch: string;
  isPrivate: boolean;
  allowAutoMerge: boolean;
}

export interface RepoAdminApi {
  getRepo(full: string): Promise<RepoMeta>;
  /** HTTP status of GET /branches/{branch}/protection — 200, 404 and 403 are all meaningful. */
  getProtection(full: string, branch: string): Promise<number>;
  hasFile(full: string, path: string): Promise<boolean>;
  setProtection(full: string, branch: string, contexts: string[]): Promise<void>;
  enableAutoMerge(full: string): Promise<void>;
}
