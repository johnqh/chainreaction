import { Cascade } from "../supervisor/state";
import type { ChangesetEntry } from "../graph/types";

export interface ServerDeps {
  cascade: Cascade;
  entries: ChangesetEntry[];
  onApprove: () => void;
}

export function createServer(deps: ServerDeps, port = 3737) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/state") {
        const stream = new ReadableStream({
          start(controller) {
            const send = () =>
              controller.enqueue(
                `data: ${JSON.stringify(deps.cascade.snapshot())}\n\n`,
              );
            send();
            const timer = setInterval(send, 2000);
            req.signal.addEventListener("abort", () => clearInterval(timer));
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }

      if (url.pathname === "/api/approve" && req.method === "POST") {
        deps.onApprove();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(Bun.file("src/web/index.html"));
    },
  });
}
