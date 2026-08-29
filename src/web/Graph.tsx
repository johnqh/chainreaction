import type { RepoNode } from "../graph/types";
import { computeLayout, NODE_HEIGHT, NODE_WIDTH } from "./graphModel";
import type { GraphEdge, LayoutNode } from "./graphModel";

export interface GraphProps {
  nodes: RepoNode[];
  /** Currently selected repo (by pkg), shared with RepoList. */
  selected: string | null;
  /** Fires when a node is clicked; the caller drives the shared selection state. */
  onSelect: (pkg: string) => void;
}

const MARGIN = 24;

// A `dependency` edge forces its target to republish; a `devDependency` edge never does.
// That distinction is the point of this view, so it gets both a different colour AND a
// different stroke pattern — colour alone isn't reliable signal for every viewer.
const EDGE_STYLE: Record<GraphEdge["kind"], { stroke: string; dash?: string; label: string }> = {
  dependency: { stroke: "#2b6cb0", label: "dependency" },
  devDependency: { stroke: "#c05621", dash: "6 4", label: "devDependency (does not force a republish)" },
};

function nodeCenter(n: LayoutNode): { cx: number; cy: number } {
  return { cx: n.x + NODE_WIDTH / 2 + MARGIN, cy: n.y + NODE_HEIGHT / 2 + MARGIN };
}

/**
 * Renders the dependency graph as inline SVG — no graph library. Nodes are laid
 * out in rows by dependency level (level 0 = leaves with no deps in the visible
 * set); edges are coloured and dashed by kind per EDGE_STYLE. Selection is fully
 * controlled via `selected`/`onSelect`, matching RepoList, so both views always
 * agree on which node is selected.
 */
export function Graph({ nodes, selected, onSelect }: GraphProps) {
  const layout = computeLayout(nodes);
  const byPkg = new Map(layout.nodes.map((n) => [n.pkg, n]));
  const width = layout.width + MARGIN * 2;
  const height = layout.height + MARGIN * 2;

  return (
    <div data-testid="graph">
      <svg
        role="img"
        aria-label="Repo dependency graph"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
      >
        <g data-testid="edges">
          {layout.edges.map((edge, i) => {
            const from = byPkg.get(edge.from);
            const to = byPkg.get(edge.to);
            if (!from || !to) return null;
            const a = nodeCenter(from);
            const b = nodeCenter(to);
            const style = EDGE_STYLE[edge.kind];
            return (
              <line
                key={`${edge.from}->${edge.to}-${i}`}
                data-testid={`edge-${edge.kind}`}
                data-kind={edge.kind}
                data-from={edge.from}
                data-to={edge.to}
                x1={a.cx}
                y1={a.cy}
                x2={b.cx}
                y2={b.cy}
                stroke={style.stroke}
                strokeWidth={2}
                strokeDasharray={style.dash}
              />
            );
          })}
        </g>

        <g data-testid="nodes">
          {layout.nodes.map((n) => {
            const isSelected = n.pkg === selected;
            return (
              <g
                key={n.pkg}
                data-testid={`node-${n.pkg}`}
                data-selected={isSelected}
                onClick={() => onSelect(n.pkg)}
                style={{ cursor: "pointer" }}
              >
                <rect
                  x={n.x + MARGIN}
                  y={n.y + MARGIN}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={6}
                  fill={isSelected ? "#2c7a7b" : "#2d3748"}
                  stroke={isSelected ? "#81e6d9" : "#4a5568"}
                  strokeWidth={isSelected ? 3 : 1}
                />
                <text
                  x={n.x + MARGIN + NODE_WIDTH / 2}
                  y={n.y + MARGIN + NODE_HEIGHT / 2}
                  fill="#eee"
                  fontSize={12}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {n.pkg}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <ul data-testid="legend" aria-label="Edge legend">
        {(Object.keys(EDGE_STYLE) as GraphEdge["kind"][]).map((kind) => {
          const style = EDGE_STYLE[kind];
          return (
            <li key={kind} data-testid={`legend-${kind}`}>
              <svg width={28} height={12} aria-hidden="true">
                <line
                  x1={0}
                  y1={6}
                  x2={28}
                  y2={6}
                  stroke={style.stroke}
                  strokeWidth={2}
                  strokeDasharray={style.dash}
                />
              </svg>
              <span>{kind}</span>
              <span> — {style.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
