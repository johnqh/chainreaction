import { useState } from "react";
import type { RepoNode } from "../graph/types";
import { Graph } from "./Graph";
import { RepoList } from "./RepoList";
import { Updates, type UpdatesProps } from "./Updates";

export interface AppProps {
  /** Every repo the signed-in developer owns, shared by RepoList and Graph. */
  nodes: RepoNode[];
  /** Which repos are "prepared", keyed by pkg name — see RepoListProps. */
  prepared: Record<string, boolean>;
  onPlanUpdate: UpdatesProps["onPlanUpdate"];
  onPlanUpdateChain: UpdatesProps["onPlanUpdateChain"];
  onOpenPrs: UpdatesProps["onOpenPrs"];
  onMerge: UpdatesProps["onMerge"];
  onAutoMerge: UpdatesProps["onAutoMerge"];
  onRefresh: UpdatesProps["onRefresh"];
}

/**
 * Top-level screen: RepoList and Graph share one `selected` package, and
 * Updates acts on whichever one is currently selected. All side effects
 * (planning, opening PRs, merging) are callback props supplied by the
 * caller — this component never calls `fetch` itself, so the real server
 * wiring can land as a separate, reviewable step.
 *
 * This replaces the previous SSE-driven supervisor screen; see the Task 7
 * report for why.
 */
export function App({
  nodes,
  prepared,
  onPlanUpdate,
  onPlanUpdateChain,
  onOpenPrs,
  onMerge,
  onAutoMerge,
  onRefresh,
}: AppProps) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div style={{ background: "#111", color: "#eee", minHeight: "100vh", padding: 32, fontFamily: "ui-monospace, monospace" }}>
      <h1 style={{ fontSize: 20, marginBottom: 24 }}>ChainReaction</h1>
      <div style={{ display: "flex", gap: 32, alignItems: "flex-start" }}>
        <div style={{ flex: "0 0 auto" }}>
          <RepoList nodes={nodes} prepared={prepared} selected={selected} onSelect={setSelected} />
        </div>
        <div style={{ flex: "0 0 auto" }}>
          <Graph nodes={nodes} selected={selected} onSelect={setSelected} />
        </div>
        <div style={{ flex: "1 1 auto" }}>
          <Updates
            selected={selected}
            onPlanUpdate={onPlanUpdate}
            onPlanUpdateChain={onPlanUpdateChain}
            onOpenPrs={onOpenPrs}
            onMerge={onMerge}
            onAutoMerge={onAutoMerge}
            onRefresh={onRefresh}
          />
        </div>
      </div>
    </div>
  );
}
