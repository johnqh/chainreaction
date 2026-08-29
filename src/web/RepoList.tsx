import { useState } from "react";
import type { RepoNode } from "../graph/types";
import { filterRepos } from "./graphModel";

export interface RepoListProps {
  /** Every repo the signed-in developer owns. */
  nodes: RepoNode[];
  /** Which repos are "prepared", keyed by pkg name. Missing key means not prepared. */
  prepared: Record<string, boolean>;
  /** Currently selected repo (by pkg), shared with the Graph view. */
  selected: string | null;
  /** Fires when a repo is picked here; the caller drives the shared selection state. */
  onSelect: (pkg: string) => void;
}

/**
 * Searchable list of every repo the developer owns, with a "prepared" badge.
 * Selection is fully controlled via `selected`/`onSelect` — this component
 * keeps no selection state of its own, so it can never disagree with Graph.
 */
export function RepoList({ nodes, prepared, selected, onSelect }: RepoListProps) {
  const [query, setQuery] = useState("");
  const filtered = filterRepos(nodes, query);

  return (
    <div data-testid="repo-list">
      <input
        type="text"
        aria-label="Search repos"
        placeholder="Search repos…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p data-testid="repo-count">
        {filtered.length} of {nodes.length} repos
      </p>
      <ul>
        {filtered.map((n) => {
          const isSelected = n.pkg === selected;
          const isPrepared = prepared[n.pkg] === true;
          return (
            <li key={n.pkg}>
              <button
                type="button"
                data-testid={`repo-item-${n.pkg}`}
                aria-pressed={isSelected}
                data-selected={isSelected}
                onClick={() => onSelect(n.pkg)}
              >
                <span>{n.pkg}</span>
                <span> · {n.repo}</span>
                {isPrepared && <span data-testid={`prepared-${n.pkg}`}> · prepared</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
