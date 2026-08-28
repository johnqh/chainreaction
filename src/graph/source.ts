import type { RepoNode } from "./types";

export interface GraphSource {
  load(): Promise<Map<string, RepoNode>>;
}
