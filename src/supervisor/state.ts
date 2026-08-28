import type { ChangesetEntry } from "../graph/types";

export type NodeState =
  | "pending" | "validated" | "pr-open" | "ci-running"
  | "merged" | "published" | "stalled";

const TERMINAL: NodeState[] = ["published", "stalled"];

export interface CascadeSnapshot {
  nodes: { pkg: string; repo: string; level: number; version: string; state: NodeState }[];
  edges: { from: string; to: string }[];
}

export class Cascade {
  private states = new Map<string, NodeState>();

  constructor(private entries: ChangesetEntry[]) {
    for (const e of entries) this.states.set(e.pkg, "pending");
  }

  set(pkg: string, state: NodeState): void {
    if (!this.states.has(pkg)) throw new Error(`unknown package: ${pkg}`);
    this.states.set(pkg, state);
  }

  get(pkg: string): NodeState {
    const s = this.states.get(pkg);
    if (!s) throw new Error(`unknown package: ${pkg}`);
    return s;
  }

  stalled(): string[] {
    return [...this.states.entries()]
      .filter(([, s]) => s === "stalled")
      .map(([pkg]) => pkg);
  }

  isComplete(): boolean {
    return [...this.states.values()].every((s) => s === "published");
  }

  snapshot(): CascadeSnapshot {
    const nodes = this.entries.map((e) => ({
      pkg: e.pkg, repo: e.repo, level: e.level,
      version: e.toVersion, state: this.get(e.pkg),
    }));
    const edges = this.entries.flatMap((e) =>
      Object.keys(e.depBumps).map((from) => ({ from, to: e.pkg })),
    );
    return { nodes, edges };
  }
}

export function detectStall(
  cascade: Cascade,
  now: number,
  lastChange: Map<string, number>,
  timeoutMs: number,
): string[] {
  return [...lastChange.entries()]
    .filter(([pkg, at]) => {
      const state = cascade.get(pkg);
      return !TERMINAL.includes(state) && now - at > timeoutMs;
    })
    .map(([pkg]) => pkg);
}
