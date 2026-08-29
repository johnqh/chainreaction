import index from "../web/index.html";
import { Cascade } from "../supervisor/state";
import type { ChangesetEntry } from "../graph/types";
import {
  authorizeUrl,
  exchangeCode,
  listUserInstallations,
  getAuthenticatedUser,
  assertInstallationMembership,
  OAuthStateStore,
  PendingLoginStore,
} from "../auth/oauth";
import { SessionStore, DEFAULT_SESSION_TTL_SECONDS } from "../auth/session";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  /** The full, absolute callback URL registered with the GitHub OAuth App, e.g. "https://app.example.com/auth/callback". */
  callbackUrl: string;
}

export interface ServerDeps {
  cascade: Cascade;
  entries: ChangesetEntry[];
  onApprove: () => void;
  auth: AuthConfig;
  /** Injected for GitHub API calls made during login. Never used for anything but those calls. */
  fetchFn?: typeof fetch;
  now?: () => number;
}

const TOKEN_HEADER = "x-chainreaction-token";
const SESSION_COOKIE = "cr_session";
const PENDING_COOKIE = "cr_pending";
const PENDING_COOKIE_MAX_AGE_SECONDS = 300;

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

function serializeCookie(
  name: string,
  value: string,
  opts: { secure: boolean; maxAgeSeconds?: number; clear?: boolean },
): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.secure) parts.push("Secure");
  if (opts.clear) {
    parts.push("Max-Age=0");
  } else if (opts.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  }
  return parts.join("; ");
}

/** A minimal, dependency-free HTML escaper — the only untrusted strings rendered here are GitHub account logins. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createServer(deps: ServerDeps, port = 3737) {
  const token = process.env.CR_UI_TOKEN ?? randomToken();
  if (!process.env.CR_UI_TOKEN) {
    console.warn(
      `CR_UI_TOKEN not set; generated a random token for this run (set CR_UI_TOKEN to pin it): ${token}`,
    );
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const secureCookies = new URL(deps.auth.callbackUrl).protocol === "https:";
  const callbackPath = new URL(deps.auth.callbackUrl).pathname;

  const sessions = new SessionStore(deps.auth.sessionSecret, now);
  const states = new OAuthStateStore(now);
  const pendingLogins = new PendingLoginStore(now);

  // Never let an unhandled rejection anywhere in the login flow surface the
  // underlying error's message verbatim to the client: GitHub API helpers in
  // ../auth/oauth already scrub secrets from their own thrown messages, but
  // this is the backstop for anything else (e.g. a network-level exception)
  // that might not be.
  function loginFailure(err: unknown, status = 502): Response {
    const message = err instanceof Error ? err.message : "login failed";
    return new Response(message, { status });
  }

  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    routes: { "/": index },
    async fetch(req) {
      const url = new URL(req.url);
      const cookies = parseCookies(req.headers.get("cookie"));

      // --- Sign in with GitHub -------------------------------------------------

      if (url.pathname === "/auth/login" && req.method === "GET") {
        const state = states.issue();
        return new Response(null, {
          status: 302,
          headers: { location: authorizeUrl(deps.auth.clientId, deps.auth.callbackUrl, state) },
        });
      }

      if (url.pathname === callbackPath && req.method === "GET") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          return new Response("missing code or state", { status: 400 });
        }
        // Single-use and compared server-side: a callback whose state does not
        // match anything issued (wrong, forged, or already consumed once
        // before) is rejected outright. This is the CSRF guard.
        if (!states.consume(state)) {
          return new Response("invalid or expired state", { status: 400 });
        }

        let accessToken: string;
        try {
          ({ accessToken } = await exchangeCode(
            code,
            { clientId: deps.auth.clientId, clientSecret: deps.auth.clientSecret },
            fetchFn,
          ));
        } catch (err) {
          return loginFailure(err);
        }

        let user: { id: number; login: string };
        try {
          user = await getAuthenticatedUser(accessToken, fetchFn);
        } catch (err) {
          return loginFailure(err);
        }

        const installationIdParam = url.searchParams.get("installation_id");
        if (installationIdParam !== null) {
          const requested = Number(installationIdParam);
          if (!Number.isInteger(requested)) {
            return new Response("invalid installation_id", { status: 400 });
          }
          // GitHub can hand us this id directly (e.g. it was attached during
          // an "Install & Authorize" flow), but it arrives the same way any
          // other client-supplied value would: never trusted on its own,
          // always checked fresh against this user's real memberships.
          let membership: { id: number };
          try {
            membership = await assertInstallationMembership(accessToken, requested, fetchFn);
          } catch {
            return new Response("installation is not accessible to this user", { status: 403 });
          }
          const cookie = await sessions.createSession(String(user.id), membership.id);
          return new Response(null, {
            status: 302,
            headers: {
              location: "/",
              "set-cookie": serializeCookie(SESSION_COOKIE, cookie, {
                secure: secureCookies,
                maxAgeSeconds: DEFAULT_SESSION_TTL_SECONDS,
              }),
            },
          });
        }

        let installations;
        try {
          installations = await listUserInstallations(accessToken, fetchFn);
        } catch (err) {
          return loginFailure(err);
        }

        if (installations.length === 0) {
          return new Response("this GitHub account has no accessible installations", { status: 403 });
        }

        if (installations.length === 1) {
          const cookie = await sessions.createSession(String(user.id), installations[0]!.id);
          return new Response(null, {
            status: 302,
            headers: {
              location: "/",
              "set-cookie": serializeCookie(SESSION_COOKIE, cookie, {
                secure: secureCookies,
                maxAgeSeconds: DEFAULT_SESSION_TTL_SECONDS,
              }),
            },
          });
        }

        // Multiple installations and no hint from GitHub about which one:
        // stash the access token server-side (never in the URL, the page, or
        // a client-readable cookie value) and let the user pick. `/auth/choose`
        // re-verifies whatever they pick against a fresh membership check.
        const pendingId = pendingLogins.create({ userId: String(user.id), userToken: accessToken });
        const options = installations
          .map((i) => `<li><a href="/auth/choose?installationId=${i.id}">${escapeHtml(i.account)}</a></li>`)
          .join("");
        return new Response(
          `<!doctype html><html><body><h1>Choose an installation</h1><ul>${options}</ul></body></html>`,
          {
            status: 200,
            headers: {
              "content-type": "text/html",
              "set-cookie": serializeCookie(PENDING_COOKIE, pendingId, {
                secure: secureCookies,
                maxAgeSeconds: PENDING_COOKIE_MAX_AGE_SECONDS,
              }),
            },
          },
        );
      }

      if (url.pathname === "/auth/choose" && req.method === "GET") {
        const pendingId = cookies[PENDING_COOKIE];
        const login = pendingId ? pendingLogins.consume(pendingId) : null;
        if (!login) {
          return new Response("login session expired or already used — sign in again", { status: 400 });
        }
        const installationIdParam = url.searchParams.get("installationId");
        const requested = installationIdParam === null ? NaN : Number(installationIdParam);
        if (!Number.isInteger(requested)) {
          return new Response("invalid installationId", { status: 400 });
        }
        let membership: { id: number };
        try {
          membership = await assertInstallationMembership(login.userToken, requested, fetchFn);
        } catch {
          return new Response("installation is not accessible to this user", { status: 403 });
        }
        const cookie = await sessions.createSession(login.userId, membership.id);
        const headers = new Headers({ location: "/" });
        headers.append(
          "set-cookie",
          serializeCookie(SESSION_COOKIE, cookie, {
            secure: secureCookies,
            maxAgeSeconds: DEFAULT_SESSION_TTL_SECONDS,
          }),
        );
        // The pending login was already consumed server-side above (single-use),
        // so this is cleanup, not a security boundary — but leaving a stale
        // pending cookie around after it can no longer resolve to anything is
        // needless clutter in the browser.
        headers.append(
          "set-cookie",
          serializeCookie(PENDING_COOKIE, "", { secure: secureCookies, clear: true }),
        );
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === "/api/whoami" && req.method === "GET") {
        const session = await sessions.readSession(cookies[SESSION_COOKIE]);
        // A missing, malformed, tampered, or expired session is always a flat
        // 401 — never a fall-through to some default installation. Falling
        // through here is exactly the cross-tenant leak this task exists to
        // prevent: it would mean an invalid cookie is indistinguishable from
        // "no session yet, serve the operator's own data".
        if (!session) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(
          JSON.stringify({ userId: session.userId, installationId: session.installationId }),
          { headers: { "content-type": "application/json" } },
        );
      }

      // --- Existing token-gated supervisor UI -----------------------------------

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
