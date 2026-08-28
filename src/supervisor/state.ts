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
  private lastChange = new Map<string, number>();

  constructor(private entries: ChangesetEntry[], now = Date.now()) {
    for (const e of entries) {
      this.states.set(e.pkg, "pending");
      this.lastChange.set(e.pkg, now);
    }
  }

  set(pkg: string, state: NodeState, now = Date.now()): void {
    if (!this.states.has(pkg)) throw new Error(`unknown package: ${pkg}`);
    const prev = this.states.get(pkg);
    if (prev !== state) {
      this.states.set(pkg, state);
      this.lastChange.set(pkg, now);
    }
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

  getPackageNames(): string[] {
    return [...this.states.keys()];
  }

  getLastChangeTime(pkg: string): number {
    const t = this.lastChange.get(pkg);
    if (t === undefined) throw new Error(`unknown package: ${pkg}`);
    return t;
  }
}

export function detectStall(
  cascade: Cascade,
  now: number,
  timeoutMs: number,
): string[] {
  return cascade.getPackageNames()
    .filter((pkg) => {
      const state = cascade.get(pkg);
      return !TERMINAL.includes(state) && now - cascade.getLastChangeTime(pkg) > timeoutMs;
    });
}
