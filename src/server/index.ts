import index from "../web/index.html";
import {
  authorizeUrl,
  exchangeCode,
  listUserInstallations,
  getAuthenticatedUser,
  assertInstallationMembership,
  OAuthStateStore,
  PendingLoginStore,
  OAUTH_STATE_TTL_SECONDS,
  timingSafeEqualStrings,
  MEMBERSHIP_VERIFICATION_FAILED,
} from "../auth/oauth";
import { SessionStore, DEFAULT_SESSION_TTL_SECONDS } from "../auth/session";
import { handleApiRequest, type ApiDeps } from "./api";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  /** The full, absolute callback URL registered with the GitHub OAuth App, e.g. "https://app.example.com/auth/callback". */
  callbackUrl: string;
}

export interface ServerDeps {
  auth: AuthConfig;
  /** Injected for GitHub API calls made during login. Never used for anything but those calls. */
  fetchFn?: typeof fetch;
  now?: () => number;
  /**
   * The hosted repos/graph/update/prs/merge/train surface (see
   * `src/server/api.ts`). Optional so existing deployments/tests that only
   * exercise login and the legacy token-gated UI don't need to supply GitHub
   * App credentials. When absent, the hosted API paths simply 404.
   */
  api?: ApiDeps;
}

const SESSION_COOKIE_BASE = "cr_session";
const PENDING_COOKIE_BASE = "cr_pending";
const PENDING_COOKIE_MAX_AGE_SECONDS = 300;
const STATE_COOKIE_BASE = "cr_oauth_state";

/**
 * The `__Host-` prefix is what actually stops the cookie-tossing attack the
 * bare names were vulnerable to: a browser refuses to store a `__Host-`
 * cookie at all unless it carries `Secure`, `Path=/`, and no `Domain`
 * attribute — which means a sibling subdomain can never set one for this
 * origin to toss into a request here (an attacker-controlled `Domain=
 * .example.com` cookie cannot satisfy "no Domain attribute"). `parseCookies`
 * below adds a second, cheaper layer (rejecting any duplicate cookie name
 * outright) as defence in depth, but the prefix is the real fix.
 *
 * `__Host-` requires `Secure`, and `Secure` cookies are never sent back over
 * a plain `http://` connection — which is exactly how local development
 * (`http://127.0.0.1`) runs. Falling back to the bare, unprefixed name
 * whenever the callback URL isn't `https:` (the same `secureCookies` signal
 * that already governs the `Secure` flag itself) keeps `bun run` on
 * localhost working. This is a deliberate, documented dev-only fallback —
 * production deployments register an `https://` callback URL and always get
 * the `__Host-` prefix; nothing here silently drops it when running behind
 * TLS.
 */
function hostCookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}

/** Maps an `assertInstallationMembership` failure to a status: a verification failure is retryable, a clean "no" is final. */
function membershipFailureStatus(err: unknown): number {
  return err instanceof Error && err.message === MEMBERSHIP_VERIFICATION_FAILED ? 502 : 403;
}

/**
 * A well-behaved single-origin browser's cookie jar never sends the same
 * cookie name twice in one `Cookie` header — it dedupes by (domain, path,
 * name) before sending. Seeing a duplicate name here means either a
 * cookie-tossing attacker (a sibling subdomain set a second cookie of the
 * same name that rode along) or a malformed client; in neither case is
 * "silently pick one" (previously last-wins) the right call, since guessing
 * wrong is exactly how the state-cookie CSRF this task closes would have
 * worked. Every occurrence of a duplicated name is dropped entirely — the
 * cookie reads as simply absent to every caller — rather than trusting
 * whichever value happened to parse first or last.
 */
function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const poisoned = new Set<string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || poisoned.has(name)) continue;
    if (name in out) {
      delete out[name];
      poisoned.add(name);
      continue;
    }
    out[name] = value;
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
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const secureCookies = new URL(deps.auth.callbackUrl).protocol === "https:";
  const callbackPath = new URL(deps.auth.callbackUrl).pathname;
  const SESSION_COOKIE = hostCookieName(SESSION_COOKIE_BASE, secureCookies);
  const STATE_COOKIE = hostCookieName(STATE_COOKIE_BASE, secureCookies);
  const PENDING_COOKIE = hostCookieName(PENDING_COOKIE_BASE, secureCookies);

  const sessions = new SessionStore(deps.auth.sessionSecret, now);
  const states = new OAuthStateStore(now);
  const pendingLogins = new PendingLoginStore(now);

  // Never let an unhandled rejection anywhere in the login flow surface the
  // underlying error's message verbatim to the client: GitHub API helpers in
  // ../auth/oauth already scrub secrets from their own thrown messages, but
  // this is the backstop for anything else (e.g. a network-level exception)
  // that might not be.
  function loginFailure(err: unknown, status = 502, setCookie?: string): Response {
    const message = err instanceof Error ? err.message : "login failed";
    return new Response(message, { status, headers: setCookie ? { "set-cookie": setCookie } : undefined });
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
        const headers = new Headers({
          location: authorizeUrl(deps.auth.clientId, deps.auth.callbackUrl, state),
        });
        // Double-submit cookie: `state` alone being single-use only stops a
        // *replay* of the same callback. It does nothing to stop an attacker
        // completing their own login, obtaining a real unconsumed `state`
        // for *their own* GitHub account, and inducing the victim's browser
        // to hit the callback with it — the victim would end up signed into
        // the attacker's account. Binding `state` to this cookie means the
        // callback only succeeds in the same browser that started the flow.
        headers.append(
          "set-cookie",
          serializeCookie(STATE_COOKIE, state, {
            secure: secureCookies,
            maxAgeSeconds: OAUTH_STATE_TTL_SECONDS,
          }),
        );
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === callbackPath && req.method === "GET") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const stateCookie = cookies[STATE_COOKIE];
        // The state cookie is single-use exactly like the state itself: it is
        // cleared here so it always leaves with this response, whether the
        // login below succeeds or fails.
        const clearStateCookie = serializeCookie(STATE_COOKIE, "", { secure: secureCookies, clear: true });

        if (!code || !state) {
          return new Response("missing code or state", { status: 400, headers: { "set-cookie": clearStateCookie } });
        }

        // Single-use, checked server-side (stops replay of the same
        // callback) AND bound to the cookie set at /auth/login (stops an
        // attacker's own valid, unconsumed state+code pair from being handed
        // to a victim's browser — see OAuthStateStore's doc comment). Both
        // checks run unconditionally so the state is always consumed exactly
        // once per callback, regardless of which one fails.
        const stateWasIssued = states.consume(state);
        const stateBoundToThisBrowser =
          stateCookie !== undefined && stateCookie.length > 0 && (await timingSafeEqualStrings(stateCookie, state));
        if (!stateWasIssued || !stateBoundToThisBrowser) {
          return new Response("invalid or expired state", { status: 400, headers: { "set-cookie": clearStateCookie } });
        }

        // From here on, the state cookie has done its job (verified above)
        // and every exit from this handler clears it — success or failure.
        let accessToken: string;
        try {
          ({ accessToken } = await exchangeCode(
            code,
            { clientId: deps.auth.clientId, clientSecret: deps.auth.clientSecret },
            fetchFn,
          ));
        } catch (err) {
          return loginFailure(err, 502, clearStateCookie);
        }

        let user: { id: number; login: string };
        try {
          user = await getAuthenticatedUser(accessToken, fetchFn);
        } catch (err) {
          return loginFailure(err, 502, clearStateCookie);
        }

        const installationIdParam = url.searchParams.get("installation_id");
        if (installationIdParam !== null) {
          const requested = Number(installationIdParam);
          if (!Number.isInteger(requested)) {
            return new Response("invalid installation_id", { status: 400, headers: { "set-cookie": clearStateCookie } });
          }
          // GitHub can hand us this id directly (e.g. it was attached during
          // an "Install & Authorize" flow), but it arrives the same way any
          // other client-supplied value would: never trusted on its own,
          // always checked fresh against this user's real memberships.
          let membership: { id: number };
          try {
            membership = await assertInstallationMembership(accessToken, requested, fetchFn);
          } catch (err) {
            const message = err instanceof Error ? err.message : MEMBERSHIP_VERIFICATION_FAILED;
            return new Response(message, {
              status: membershipFailureStatus(err),
              headers: { "set-cookie": clearStateCookie },
            });
          }
          const cookie = await sessions.createSession(String(user.id), membership.id, accessToken);
          const headers = new Headers({ location: "/" });
          headers.append(
            "set-cookie",
            serializeCookie(SESSION_COOKIE, cookie, { secure: secureCookies, maxAgeSeconds: DEFAULT_SESSION_TTL_SECONDS }),
          );
          headers.append("set-cookie", clearStateCookie);
          return new Response(null, { status: 302, headers });
        }

        let installations;
        try {
          installations = await listUserInstallations(accessToken, fetchFn);
        } catch (err) {
          return loginFailure(err, 502, clearStateCookie);
        }

        if (installations.length === 0) {
          return new Response("this GitHub account has no accessible installations", {
            status: 403,
            headers: { "set-cookie": clearStateCookie },
          });
        }

        if (installations.length === 1) {
          const cookie = await sessions.createSession(String(user.id), installations[0]!.id, accessToken);
          const headers = new Headers({ location: "/" });
          headers.append(
            "set-cookie",
            serializeCookie(SESSION_COOKIE, cookie, { secure: secureCookies, maxAgeSeconds: DEFAULT_SESSION_TTL_SECONDS }),
          );
          headers.append("set-cookie", clearStateCookie);
          return new Response(null, { status: 302, headers });
        }

        // Multiple installations and no hint from GitHub about which one:
        // stash the access token server-side (never in the URL, the page, or
        // a client-readable cookie value) and let the user pick. `/auth/choose`
        // re-verifies whatever they pick against a fresh membership check.
        const pendingId = pendingLogins.create({ userId: String(user.id), userToken: accessToken });
        // Rendered as a per-installation POST form, not a GET link: a GET
        // would be exactly the SameSite=Lax gap the __Host- prefix above
        // does not close on its own — Lax cookies still ride along on a
        // cross-site top-level *navigation* (a plain link click), so an
        // attacker could hand a mid-login victim a link naming an
        // installationId of the attacker's choosing (assertInstallationMembership
        // below still stops them from naming one the victim doesn't belong
        // to, but not from steering the victim onto the wrong one they do
        // belong to). A cross-site POST does not carry a SameSite=Lax
        // cookie at all, so an attacker-hosted auto-submitting form gets no
        // pending cookie to ride along with.
        const options = installations
          .map(
            (i) =>
              `<li><form method="post" action="/auth/choose"><input type="hidden" name="installationId" value="${i.id}"><button type="submit">${escapeHtml(i.account)}</button></form></li>`,
          )
          .join("");
        const pickerHeaders = new Headers({ "content-type": "text/html" });
        pickerHeaders.append(
          "set-cookie",
          serializeCookie(PENDING_COOKIE, pendingId, { secure: secureCookies, maxAgeSeconds: PENDING_COOKIE_MAX_AGE_SECONDS }),
        );
        pickerHeaders.append("set-cookie", clearStateCookie);
        return new Response(
          `<!doctype html><html><body><h1>Choose an installation</h1><ul>${options}</ul></body></html>`,
          { status: 200, headers: pickerHeaders },
        );
      }

      if (url.pathname === "/auth/choose" && req.method === "POST") {
        const pendingId = cookies[PENDING_COOKIE];
        const login = pendingId ? pendingLogins.consume(pendingId) : null;
        if (!login) {
          return new Response("login session expired or already used — sign in again", { status: 400 });
        }
        // Form-encoded body, not a query param: see the doc comment where
        // this picker page is rendered above for why this is a POST at all.
        let installationIdParam: FormDataEntryValue | null;
        try {
          const form = await req.formData();
          installationIdParam = form.get("installationId");
        } catch {
          return new Response("invalid form body", { status: 400 });
        }
        const requested =
          installationIdParam === null || typeof installationIdParam !== "string" ? NaN : Number(installationIdParam);
        if (!Number.isInteger(requested)) {
          return new Response("invalid installationId", { status: 400 });
        }
        let membership: { id: number };
        try {
          membership = await assertInstallationMembership(login.userToken, requested, fetchFn);
        } catch (err) {
          const message = err instanceof Error ? err.message : MEMBERSHIP_VERIFICATION_FAILED;
          return new Response(message, { status: membershipFailureStatus(err) });
        }
        const cookie = await sessions.createSession(login.userId, membership.id, login.userToken);
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

      // A session cookie's own TTL is the only thing that ever ended a
      // session before this route existed — up to DEFAULT_SESSION_TTL_SECONDS
      // of continued open-PR/merge capability for a stolen cookie, a removed
      // collaborator, or a revoked installation, with no way for the user
      // themselves to cut that short. Clearing both the session and the
      // (already single-use, but stale-if-abandoned) state cookie here gives
      // an explicit, immediate way out.
      if (url.pathname === "/auth/logout" && req.method === "POST") {
        const headers = new Headers({ "content-type": "application/json" });
        headers.append("set-cookie", serializeCookie(SESSION_COOKIE, "", { secure: secureCookies, clear: true }));
        headers.append("set-cookie", serializeCookie(STATE_COOKIE, "", { secure: secureCookies, clear: true }));
        return new Response(JSON.stringify({ ok: true }), { headers });
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

      // --- Hosted repos/graph/update/prs/merge/train surface --------------------

      if (deps.api) {
        const session = await sessions.readSession(cookies[SESSION_COOKIE]);
        const apiRes = await handleApiRequest(req, url, session, deps.api);
        if (apiRes) return apiRes;
      }

      return new Response("not found", { status: 404 });
    },
  });
}
