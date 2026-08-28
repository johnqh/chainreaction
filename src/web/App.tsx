import { useEffect, useState } from "react";
import type { NodeState } from "../supervisor/state";

interface Snapshot {
  nodes: { pkg: string; repo: string; level: number; version: string; state: NodeState }[];
  edges: { from: string; to: string }[];
}

const COLOR: Record<NodeState, string> = {
  pending: "#3a3a3a", validated: "#4a5568", "pr-open": "#2b6cb0",
  "ci-running": "#b7791f", merged: "#2c7a7b", published: "#2f855a", stalled: "#c53030",
};

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [approved, setApproved] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let es: EventSource | undefined;
    let cancelled = false;
    fetch("/api/token")
      .then((r) => r.json())
      .then((data: { token: string }) => {
        if (cancelled) return;
        setToken(data.token);
        es = new EventSource(`/api/state?token=${encodeURIComponent(data.token)}`);
        es.onmessage = (e) => setSnap(JSON.parse(e.data));
      });
    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  if (!snap) return <div style={{ padding: 32, color: "#eee" }}>connecting…</div>;

  const levels = [...new Set(snap.nodes.map((n) => n.level))].sort((a, b) => a - b);
  const stalled = snap.nodes.filter((n) => n.state === "stalled");

  return (
    <div style={{ background: "#111", color: "#eee", minHeight: "100vh", padding: 32,
                  fontFamily: "ui-monospace, monospace" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>ChainReaction</h1>
      <p style={{ opacity: 0.6, marginBottom: 24 }}>
        {snap.nodes.length} packages · {snap.nodes.filter((n) => n.state === "published").length} published
        {stalled.length > 0 && ` · ${stalled.length} stalled`}
      </p>

      {!approved && (
        <button
          onClick={() => {
            if (!token) return;
            fetch("/api/approve", {
              method: "POST",
              headers: { "X-ChainReaction-Token": token },
            });
            setApproved(true);
          }}
          style={{ background: "#2f855a", color: "#fff", border: 0, padding: "12px 24px",
                   fontSize: 16, borderRadius: 6, cursor: "pointer", marginBottom: 32 }}
        >
          Approve changeset ({snap.nodes.length} repos)
        </button>
      )}

      {levels.map((level) => (
        <div key={level} style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
          <span style={{ opacity: 0.4, width: 32 }}>L{level}</span>
          {snap.nodes.filter((n) => n.level === level).map((n) => (
            <div key={n.pkg} title={`${n.repo} → ${n.version}`}
                 style={{ background: COLOR[n.state], padding: "8px 14px", borderRadius: 6,
                          fontSize: 13, transition: "background 400ms" }}>
              {n.pkg.replace("@sudobility/", "")}
              <span style={{ opacity: 0.65, marginLeft: 8 }}>{n.state}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
