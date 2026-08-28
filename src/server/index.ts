import index from "../web/index.html";
import { Cascade } from "../supervisor/state";
import type { ChangesetEntry } from "../graph/types";

export interface ServerDeps {
  cascade: Cascade;
  entries: ChangesetEntry[];
  onApprove: () => void;
}

const TOKEN_HEADER = "x-chainreaction-token";

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export function createServer(deps: ServerDeps, port = 3737) {
  const token = process.env.CR_UI_TOKEN ?? randomToken();
  if (!process.env.CR_UI_TOKEN) {
    console.warn(
      `CR_UI_TOKEN not set; generated a random token for this run (set CR_UI_TOKEN to pin it): ${token}`,
    );
  }

  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    routes: { "/": index },
    async fetch(req) {
      const url = new URL(req.url);

      // Bootstrap endpoint: hands the token to the page that was just served from
      // this same origin. A cross-origin page can trigger the request but, absent
      // CORS headers here, cannot read the response body — so it cannot recover
      // the token this way.
      if (url.pathname === "/api/token") {
        return new Response(JSON.stringify({ token }), {
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname === "/api/state") {
        if (url.searchParams.get("token") !== token) {
          return new Response("unauthorized", { status: 401 });
        }

        let timer: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream({
          start(controller) {
            const send = () => {
              try {
                controller.enqueue(
                  `data: ${JSON.stringify(deps.cascade.snapshot())}\n\n`,
                );
              } catch {
                // Stream is no longer writable (client gone). Stop ticking rather
                // than letting the next enqueue throw again inside setInterval.
                if (timer) clearInterval(timer);
              }
            };
            send();
            timer = setInterval(send, 2000);
            req.signal.addEventListener("abort", () => {
              if (timer) clearInterval(timer);
            });
          },
          cancel() {
            // Independent cleanup path: fires if the consumer cancels the stream
            // even when 'abort' on the request signal doesn't (or hasn't yet).
            if (timer) clearInterval(timer);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }

      if (url.pathname === "/api/approve" && req.method === "POST") {
        if (req.headers.get(TOKEN_HEADER) !== token) {
          return new Response("unauthorized", { status: 401 });
        }
        deps.onApprove();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
}
