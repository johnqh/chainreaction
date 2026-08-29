import { test, expect } from "bun:test";
import { createServer, type ServerDeps, type AuthConfig } from "../../src/server/index";

const CLIENT_SECRET = "the-client-secret-value";
const SESSION_SECRET = "the-session-secret-value";

interface MockUser {
  id: number;
  login: string;
}
interface MockInstallation {
  id: number;
  account: string;
}

function mockFetch(opts: { installations?: MockInstallation[]; user?: MockUser } = {}): typeof fetch {
  const installations = opts.installations ?? [{ id: 1, account: "acme" }];
  const user = opts.user ?? { id: 555, login: "octocat" };
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "user-access-token-xyz" }), { status: 200 });
    }
    if (url.startsWith("https://api.github.com/user/installations")) {
      return new Response(
        JSON.stringify({ installations: installations.map((i) => ({ id: i.id, account: { login: i.account } })) }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://api.github.com/user")) {
      return new Response(JSON.stringify(user), { status: 200 });
    }
    return new Response("unexpected request in test double: " + url, { status: 404 });
  }) as unknown as typeof fetch;
}

function baseAuth(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    clientId: "client-id-abc",
    clientSecret: CLIENT_SECRET,
    sessionSecret: SESSION_SECRET,
    callbackUrl: "https://app.example.test/auth/callback",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    auth: baseAuth(),
    fetchFn: mockFetch(),
    now: () => 1_000_000,
    ...overrides,
  };
}

/** Starts a server on an ephemeral port and runs `body`, always stopping the server afterwards. */
async function withServer(
  deps: ServerDeps,
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(deps, 0);
  try {
    await body(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
  }
}

function rawCookieHeaders(res: Response): string[] {
  return res.headers.getSetCookie();
}

/**
 * Finds a `Set-Cookie` header for `baseName`, under either its bare name or
 * its `__Host-`-prefixed form — whichever this server is actually using
 * (governed by whether `auth.callbackUrl` is https; see
 * `hostCookieName`/`secureCookies` in src/server/index.ts). Tests use this
 * instead of hardcoding one name so the same helper works for both the
 * (default, https) `__Host-` case and the plain-http dev-fallback case.
 */
function cookieNamed(res: Response, baseName: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const eq = header.indexOf("=");
    const name = header.slice(0, eq);
    if (name === baseName || name === `__Host-${baseName}`) {
      return header.slice(eq + 1).split(";")[0];
    }
  }
  return undefined;
}

/** The actual Set-Cookie name used for `baseName` on a server built with `auth`, without starting it. */
function actualCookieName(baseName: string, auth: AuthConfig): string {
  return new URL(auth.callbackUrl).protocol === "https:" ? `__Host-${baseName}` : baseName;
}

/** Whether a Set-Cookie for `baseName` (bare or `__Host-`-prefixed) is present at all. */
function cookiePresent(res: Response, baseName: string): boolean {
  return cookieNamed(res, baseName) !== undefined;
}

/** The raw Set-Cookie header text for `baseName` (bare or `__Host-`-prefixed), for asserting on its flags. */
function rawCookieHeaderNamed(res: Response, baseName: string): string | undefined {
  return res.headers.getSetCookie().find((h) => {
    const eq = h.indexOf("=");
    const name = h.slice(0, eq);
    return name === baseName || name === `__Host-${baseName}`;
  });
}

interface LoginAttempt {
  state: string;
  /** The state cookie value `/auth/login` set for this attempt (name may be bare or `__Host-`-prefixed). */
  stateCookie: string;
}

/** Starts a login: GETs /auth/login and returns the issued state and the double-submit cookie it set. */
async function login(baseUrl: string): Promise<LoginAttempt> {
  const loginRes = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
  const location = loginRes.headers.get("location")!;
  const state = new URL(location).searchParams.get("state")!;
  const stateCookie = cookieNamed(loginRes, "cr_oauth_state")!;
  return { state, stateCookie };
}

/**
 * GETs the callback with `code=abc`, the given `state` in the query, and the
 * given `cookieState` (or `undefined` to send no state cookie at all) as the
 * state cookie. `extraQuery` appends anything else (e.g.
 * `&installation_id=7`). `cookieName` defaults to the `__Host-`-prefixed
 * name (every test server here uses an https callback URL by default);
 * pass the bare name explicitly for a plain-http server.
 */
async function callback(
  baseUrl: string,
  state: string,
  cookieState: string | undefined,
  extraQuery = "",
  cookieName = "__Host-cr_oauth_state",
): Promise<Response> {
  return fetch(`${baseUrl}/auth/callback?code=abc&state=${state}${extraQuery}`, {
    redirect: "manual",
    headers: cookieState !== undefined ? { cookie: `${cookieName}=${cookieState}` } : {},
  });
}

/**
 * POSTs to /auth/choose with `installationId` as a form field and the given
 * pending-login cookie value. `/auth/choose` is a POST (not a GET with a
 * query param) specifically so a SameSite=Lax pending cookie never rides
 * along with a cross-site request — see the doc comment where the picker
 * page is rendered in src/server/index.ts. `cookieName` defaults to the
 * `__Host-`-prefixed name (every test server here uses an https callback
 * URL by default); pass the bare name explicitly for a plain-http server.
 */
async function chooseInstallation(
  baseUrl: string,
  installationId: number | string,
  pendingCookie: string | undefined,
  cookieName = "__Host-cr_pending",
): Promise<Response> {
  const body = new URLSearchParams({ installationId: String(installationId) });
  return fetch(`${baseUrl}/auth/choose`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(pendingCookie !== undefined ? { cookie: `${cookieName}=${pendingCookie}` } : {}),
    },
    body,
  });
}

// --- CSRF: state is per-request, checked, single-use, and bound to the browser --

test("GET /auth/login redirects to GitHub's authorize URL carrying a fresh state, and sets a matching state cookie", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id-abc");
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(cookieNamed(res, "cr_oauth_state")).toBe(state!);
  });
});

test("callback with a state that was never issued is rejected", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const res = await callback(baseUrl, "never-issued", "never-issued");
    expect(res.status).toBe(400);
    expect(cookiePresent(res, "cr_session")).toBe(false);
  });
});

test("a replayed state is rejected the second time, even though the first use was valid", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);

    const first = await callback(baseUrl, state, stateCookie);
    expect(first.status).toBe(302);

    // The victim's browser still holds the same state cookie the second
    // time (it isn't cleared client-side), but the store must refuse to
    // hand out the same state twice regardless.
    const second = await callback(baseUrl, state, stateCookie);
    expect(second.status).toBe(400);
  });
});

// This is the exact login-CSRF gap: single-use alone does not stop an
// attacker who completes their own OAuth flow, obtains a real unconsumed
// state+code pair for their own account, and induces a victim's browser to
// hit the callback with it. The victim's browser was never issued that
// state, so it has no cookie for it (or has its own, different one).
test("callback with a valid, issued, unconsumed state but no state cookie is rejected", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state } = await login(baseUrl);
    const res = await callback(baseUrl, state, undefined);
    expect(res.status).toBe(400);
    expect(cookiePresent(res, "cr_session")).toBe(false);
  });
});

test("callback whose state cookie holds a different valid issued state is rejected", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    // The attacker's own login attempt, whose state+code they hand to the victim.
    const attacker = await login(baseUrl);
    // The victim's browser has its own, independently issued state cookie
    // (e.g. from a login the victim started themselves, or simply a stale
    // one) — never the attacker's.
    const victim = await login(baseUrl);

    const res = await callback(baseUrl, attacker.state, victim.stateCookie);
    expect(res.status).toBe(400);
    expect(cookiePresent(res, "cr_session")).toBe(false);
  });
});

test("the state cookie is cleared after the callback, whether login succeeded or failed", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie);
    expect(res.status).toBe(302); // sanity: this is the success path
    const raw = rawCookieHeaderNamed(res, "cr_oauth_state")!;
    expect(raw).toBeTruthy();
    expect(raw).toMatch(/Max-Age=0/);
  });
});

test("the state cookie carries HttpOnly, SameSite=Lax, and Secure when the callback URL is https", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "https://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
    const raw = rawCookieHeaderNamed(res, "cr_oauth_state")!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Secure/i);
  });
});

test("the state cookie omits Secure when the callback URL is plain http", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "http://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
    const raw = rawCookieHeaderNamed(res, "cr_oauth_state")!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).not.toMatch(/Secure/i);
  });
});

// --- Signed, expiring session cookie; tampering is rejected outright -----------

test("a successful callback (single installation, state and cookie agree) sets a session cookie scoped to the right installation", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const sessionCookie = cookieNamed(res, "cr_session");
    expect(sessionCookie).toBeTruthy();

    const whoami = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `__Host-cr_session=${sessionCookie}` } });
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toEqual({ userId: "555", installationId: 1 });
  });
});

test("/api/whoami with a valid session returns the session's userId and installationId", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    const sessionCookie = cookieNamed(callbackRes, "cr_session")!;

    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `__Host-cr_session=${sessionCookie}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "555", installationId: 1 });
  });
});

test("/api/whoami with no session cookie is unauthorized, not a default-scoped 200", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/whoami`);
    expect(res.status).toBe(401);
  });
});

// This is the test that discriminates "tampered cookies are actually rejected"
// from "an invalid cookie is silently treated as no-session-but-fine": a
// well-formed-looking but tampered cookie must fail exactly like a missing one
// (401), never fall through to some default installation.
test("/api/whoami with a tampered session cookie is rejected, not treated as logged-out-but-fine", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    const sessionCookie = cookieNamed(callbackRes, "cr_session")!;
    const [payload, sig] = sessionCookie.split(".");
    const tamperedSig = (sig![0] === "A" ? "B" : "A") + sig!.slice(1);
    const tampered = `${payload}.${tamperedSig}`;

    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `__Host-cr_session=${tampered}` } });
    expect(res.status).toBe(401);
  });
});

test("/api/whoami rejects a cookie signed under a different session secret", async () => {
  // Mint a real session cookie against a server configured with SESSION_SECRET...
  let sessionCookie = "";
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    sessionCookie = cookieNamed(callbackRes, "cr_session")!;
  });
  expect(sessionCookie).toBeTruthy();

  // ...then present it to a server configured with a different one. A signed
  // cookie must not validate against any secret other than the one it was
  // actually signed with.
  await withServer(makeDeps({ auth: baseAuth({ sessionSecret: "a-totally-different-secret" }) }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `__Host-cr_session=${sessionCookie}` } });
    expect(res.status).toBe(401);
  });
});

// --- Cookie flags (session cookie) ------------------------------------------

test("session cookie is HttpOnly, SameSite=Lax, and Secure when the callback URL is https", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "https://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie);
    const raw = rawCookieHeaderNamed(res, "cr_session")!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Secure/i);
  });
});

test("session cookie omits Secure when the callback URL is plain http", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "http://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    // This server uses the bare (unprefixed) state cookie name — see the
    // __Host- dev-fallback tests below — so the double-submit cookie must be
    // sent under that same bare name, not callback()'s __Host--prefixed default.
    const res = await callback(baseUrl, state, stateCookie, "", "cr_oauth_state");
    const raw = rawCookieHeaderNamed(res, "cr_session")!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).not.toMatch(/Secure/i);
  });
});

// --- Never trust a client-supplied installation id --------------------------

test("multiple installations: callback offers a choice, and choosing a real membership succeeds", async () => {
  const deps = makeDeps({
    fetchFn: mockFetch({ installations: [{ id: 1, account: "acme" }, { id: 2, account: "widgets-inc" }] }),
  });
  await withServer(deps, async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    expect(callbackRes.status).toBe(200); // a picker page, not an immediate session
    const pendingCookie = cookieNamed(callbackRes, "cr_pending")!;
    expect(pendingCookie).toBeTruthy();

    const chooseRes = await chooseInstallation(baseUrl, 2, pendingCookie);
    expect(chooseRes.status).toBe(302);
    const sessionCookie = cookieNamed(chooseRes, "cr_session")!;
    expect(sessionCookie).toBeTruthy();

    const whoami = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `__Host-cr_session=${sessionCookie}` } });
    expect(await whoami.json()).toEqual({ userId: "555", installationId: 2 });
  });
});

// This is the test that discriminates the cross-tenant leak the whole task
// exists to prevent: a client naming an installation id it does not belong to
// — even though it is a syntactically valid, positive integer — must be
// refused, not silently accepted and written into the session.
test("multiple installations: choosing an installation id the user does not belong to is rejected", async () => {
  const deps = makeDeps({
    fetchFn: mockFetch({ installations: [{ id: 1, account: "acme" }, { id: 2, account: "widgets-inc" }] }),
  });
  await withServer(deps, async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    const pendingCookie = cookieNamed(callbackRes, "cr_pending")!;

    const chooseRes = await chooseInstallation(baseUrl, 999, pendingCookie);
    expect(chooseRes.status).toBe(403);
    expect(cookiePresent(chooseRes, "cr_session")).toBe(false);
  });
});

// /auth/choose is a POST, not a GET-with-query-param, precisely so a
// SameSite=Lax pending cookie never rides along with a cross-site
// *navigation* (a plain link click) the way a GET would let it. Confirming
// GET is simply unhandled (falls through to the generic 404, exactly like
// hitting any other path with the wrong method) is the regression this
// guards: a route that matched both methods would silently reopen the gap.
test("GET /auth/choose (the old GET-based flow) is no longer handled", async () => {
  const deps = makeDeps({
    fetchFn: mockFetch({ installations: [{ id: 1, account: "acme" }, { id: 2, account: "widgets-inc" }] }),
  });
  await withServer(deps, async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    const pendingCookie = cookieNamed(callbackRes, "cr_pending")!;

    const res = await fetch(`${baseUrl}/auth/choose?installationId=2`, {
      redirect: "manual",
      headers: { cookie: `__Host-cr_pending=${pendingCookie}` },
    });
    expect(res.status).toBe(404);
  });
});

test("callback with an installation_id hint the user does not belong to is rejected, not trusted", async () => {
  const deps = makeDeps({
    fetchFn: mockFetch({ installations: [{ id: 1, account: "acme" }] }),
  });
  await withServer(deps, async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie, "&installation_id=42");
    expect(res.status).toBe(403);
    expect(cookiePresent(res, "cr_session")).toBe(false);
  });
});

test("callback with an installation_id hint the user does belong to succeeds", async () => {
  const deps = makeDeps({
    fetchFn: mockFetch({ installations: [{ id: 1, account: "acme" }, { id: 7, account: "other" }] }),
  });
  await withServer(deps, async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie, "&installation_id=7");
    expect(res.status).toBe(302);
    const whoami = await fetch(`${baseUrl}/api/whoami`, {
      headers: { cookie: `__Host-cr_session=${cookieNamed(res, "cr_session")}` },
    });
    expect(await whoami.json()).toEqual({ userId: "555", installationId: 7 });
  });
});

// --- Membership check failure vs. a clean "no" are distinguished -----------

test("/auth/choose: a verification failure (not a clean membership answer) is a 502, distinct from a 403 non-member", async () => {
  // A single server whose fetchFn answers GET /user/installations normally
  // during the callback (so the picker page renders) but starts failing —
  // simulating a revoked token or a GitHub outage — by the time /auth/choose
  // re-checks membership. This must read as "we couldn't check", never as
  // "you're not a member" (which would be a false, and misleading, denial).
  let failOnInstallations = false;
  const flakyFetchFn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "user-access-token-xyz" }), { status: 200 });
    }
    if (url.startsWith("https://api.github.com/user/installations")) {
      if (failOnInstallations) {
        return new Response("server error, token super-secret-user-token rejected", { status: 500 });
      }
      return new Response(
        JSON.stringify({ installations: [{ id: 1, account: { login: "acme" } }, { id: 2, account: { login: "widgets" } }] }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://api.github.com/user")) {
      return new Response(JSON.stringify({ id: 555, login: "octocat" }), { status: 200 });
    }
    return new Response("unreachable", { status: 404 });
  }) as unknown as typeof fetch;

  await withServer(makeDeps({ fetchFn: flakyFetchFn }), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    const pendingCookie = cookieNamed(callbackRes, "cr_pending")!;

    failOnInstallations = true;
    const chooseRes = await chooseInstallation(baseUrl, 2, pendingCookie);
    const body = await chooseRes.text();
    expect(chooseRes.status).toBe(502);
    expect(body).not.toContain("super-secret-user-token");
    expect(body).not.toContain("installation is not accessible"); // must not read like a clean "no"
  });
});

test("callback's installation_id branch: a verification failure is a 502, not a 403", async () => {
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "user-access-token-xyz" }), { status: 200 });
    }
    if (url.startsWith("https://api.github.com/user/installations")) {
      return new Response("server error, token super-secret-user-token rejected", { status: 500 });
    }
    if (url.startsWith("https://api.github.com/user")) {
      return new Response(JSON.stringify({ id: 555, login: "octocat" }), { status: 200 });
    }
    return new Response("unreachable", { status: 404 });
  }) as unknown as typeof fetch;

  await withServer(makeDeps({ fetchFn }), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie, "&installation_id=2");
    const body = await res.text();
    expect(res.status).toBe(502);
    expect(body).not.toContain("super-secret-user-token");
    expect(body).not.toContain("installation is not accessible");
  });
});

// --- No secret ever appears in a response body ------------------------------

test("a failed code exchange never echoes the client secret into the response body", async () => {
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      // Simulate a hostile/buggy upstream that echoes request parameters back.
      return new Response(`invalid request: client_secret=${CLIENT_SECRET} was malformed`, { status: 401 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  await withServer(makeDeps({ fetchFn }), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie);
    const body = await res.text();
    expect(res.status).toBe(502);
    expect(body).not.toContain(CLIENT_SECRET);
  });
});

test("a failed listUserInstallations call never echoes the user access token into the response body", async () => {
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "super-secret-user-token" }), { status: 200 });
    }
    if (url.startsWith("https://api.github.com/user") && !url.includes("/installations")) {
      return new Response(JSON.stringify({ id: 1, login: "octocat" }), { status: 200 });
    }
    // Simulate an upstream that echoes the Authorization header back on error.
    return new Response("denied for token super-secret-user-token", { status: 403 });
  }) as unknown as typeof fetch;

  await withServer(makeDeps({ fetchFn }), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie);
    const body = await res.text();
    expect(body).not.toContain("super-secret-user-token");
  });
});

test("the rendered installation-choice page never contains the user access token", async () => {
  const deps = makeDeps({
    fetchFn: mockFetch({ installations: [{ id: 1, account: "acme" }, { id: 2, account: "widgets" }] }),
  });
  await withServer(deps, async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie);
    const body = await res.text();
    expect(body).not.toContain("user-access-token-xyz");
  });
});

test("session secret never appears in a session cookie or the whoami response", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    const sessionCookie = cookieNamed(callbackRes, "cr_session")!;
    expect(sessionCookie).not.toContain(SESSION_SECRET);

    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `__Host-cr_session=${sessionCookie}` } });
    const body = await res.text();
    expect(body).not.toContain(SESSION_SECRET);
  });
});

// --- Legacy token-gated UI keeps working -------------------------------------

// --- Hosted API wiring: cookie -> session -> src/server/api.ts -------------

test("a hosted API route 404s when no ApiDeps is configured (no GitHub App wired up)", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/repos`);
    expect(res.status).toBe(404);
  });
});

test("a hosted API route is scoped to the signed-in session's installation, end to end", async () => {
  const { factory, calls } = (() => {
    const seen: number[] = [];
    return {
      factory: (installationId: number) => {
        seen.push(installationId);
        return {
          githubApi: { listRepos: async () => [], getManifest: async () => null },
          adminApi: {
            getRepo: async () => ({ defaultBranch: "main", isPrivate: false, allowAutoMerge: false }),
            getProtection: async () => ({ status: 404 }),
            hasFile: async () => true,
            recentPrHeadSha: async () => null,
            listCheckRuns: async () => [],
            setProtection: async () => {},
            enableAutoMerge: async () => {},
          },
          prApi: {
            defaultBranchSha: async () => "sha",
            createBranch: async () => {},
            putFile: async () => {},
            openPr: async () => 1,
            mergePr: async () => {},
            prState: async () => "OPEN",
          },
        };
      },
      calls: seen,
    };
  })();

  const deps = makeDeps({
    api: { apisFor: factory, scopeFor: () => "@acme/", requiredChecksFor: () => [] },
  });

  await withServer(deps, async (baseUrl) => {
    const unauth = await fetch(`${baseUrl}/api/repos`);
    expect(unauth.status).toBe(401);

    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    const sessionCookie = cookieNamed(callbackRes, "cr_session")!;

    const res = await fetch(`${baseUrl}/api/repos`, { headers: { cookie: `__Host-cr_session=${sessionCookie}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [] });
  });

  // The default session installation in mockFetch() is 1 — this proves the
  // hosted route was scoped to the real session, not left unauthenticated
  // or defaulted to some other value.
  expect(calls).toEqual([1]);
});

// The SSE-driven supervisor screen these three routes served is gone from
// src/ (no EventSource, no client that ever called them) and src/cli/deps.ts
// only ever wired them to an inert `new Cascade([], 0)` and a no-op
// `onApprove`. `/api/token` handed out a bearer token with no
// authentication at all; that was harmless only because of the inert
// wiring behind it, and removal (not repurposing) was the security review's
// call — `/api/token`'s shared-secret model doesn't fit the session model
// that replaced it. All three routes must now read as plain 404s, same as
// any other unmounted path.
test("the removed supervisor routes (/api/token, /api/state, /api/approve) are gone: they 404 like any other unmounted path", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const token = await fetch(`${baseUrl}/api/token`);
    expect(token.status).toBe(404);

    const state = await fetch(`${baseUrl}/api/state?token=anything`);
    expect(state.status).toBe(404);

    const approve = await fetch(`${baseUrl}/api/approve`, {
      method: "POST",
      headers: { "x-chainreaction-token": "anything" },
    });
    expect(approve.status).toBe(404);
  });
});

// --- Important F: __Host- prefix (the actual cookie-tossing fix), plus the --
// parseCookies duplicate-rejection layer behind it -----------------------

test("the state cookie's actual Set-Cookie name is __Host--prefixed when the callback URL is https", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "https://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
    const names = res.headers.getSetCookie().map((h) => h.slice(0, h.indexOf("=")));
    expect(names).toContain("__Host-cr_oauth_state");
    expect(names).not.toContain("cr_oauth_state");
  });
});

test("the state cookie's actual Set-Cookie name is the bare (unprefixed) name when the callback URL is plain http — the documented dev-only fallback", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "http://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
    const names = res.headers.getSetCookie().map((h) => h.slice(0, h.indexOf("=")));
    expect(names).toContain("cr_oauth_state");
    expect(names).not.toContain("__Host-cr_oauth_state");
  });
});

test("the session cookie's actual Set-Cookie name is __Host--prefixed when the callback URL is https, and bare over plain http", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "https://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie);
    const names = res.headers.getSetCookie().map((h) => h.slice(0, h.indexOf("=")));
    expect(names).toContain("__Host-cr_session");
  });

  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "http://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const loginRes = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
    const location = loginRes.headers.get("location")!;
    const state = new URL(location).searchParams.get("state")!;
    const stateCookie = cookieNamed(loginRes, "cr_oauth_state")!;
    const res = await callback(baseUrl, state, stateCookie, "", "cr_oauth_state");
    const names = res.headers.getSetCookie().map((h) => h.slice(0, h.indexOf("=")));
    expect(names).toContain("cr_session");
    expect(names).not.toContain("__Host-cr_session");
  });
});

// cr_pending was skipped by an earlier round's __Host- pass because it
// wasn't named in that task's scope — but it carries the pending-login id
// /auth/choose reads, is SameSite=Lax like the other two, and is exactly as
// exposed to cookie tossing from a sibling subdomain. It gets the identical
// treatment: __Host--prefixed over https, bare over plain http.
test("the pending-login cookie's actual Set-Cookie name is __Host--prefixed when the callback URL is https, and bare over plain http", async () => {
  await withServer(
    makeDeps({
      auth: baseAuth({ callbackUrl: "https://app.example.test/auth/callback" }),
      fetchFn: mockFetch({ installations: [{ id: 1, account: "acme" }, { id: 2, account: "widgets" }] }),
    }),
    async (baseUrl) => {
      const { state, stateCookie } = await login(baseUrl);
      const res = await callback(baseUrl, state, stateCookie);
      const names = res.headers.getSetCookie().map((h) => h.slice(0, h.indexOf("=")));
      expect(names).toContain("__Host-cr_pending");
      expect(names).not.toContain("cr_pending");
    },
  );

  await withServer(
    makeDeps({
      auth: baseAuth({ callbackUrl: "http://app.example.test/auth/callback" }),
      fetchFn: mockFetch({ installations: [{ id: 1, account: "acme" }, { id: 2, account: "widgets" }] }),
    }),
    async (baseUrl) => {
      const loginRes = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
      const location = loginRes.headers.get("location")!;
      const state = new URL(location).searchParams.get("state")!;
      const stateCookie = cookieNamed(loginRes, "cr_oauth_state")!;
      const res = await callback(baseUrl, state, stateCookie, "", "cr_oauth_state");
      const names = res.headers.getSetCookie().map((h) => h.slice(0, h.indexOf("=")));
      expect(names).toContain("cr_pending");
      expect(names).not.toContain("__Host-cr_pending");
    },
  );
});

test("the pending-login cookie carries HttpOnly and SameSite=Lax, and Secure only when the callback URL is https", async () => {
  const installations = [{ id: 1, account: "acme" }, { id: 2, account: "widgets" }];

  await withServer(
    makeDeps({ auth: baseAuth({ callbackUrl: "https://app.example.test/auth/callback" }), fetchFn: mockFetch({ installations }) }),
    async (baseUrl) => {
      const { state, stateCookie } = await login(baseUrl);
      const res = await callback(baseUrl, state, stateCookie);
      const raw = rawCookieHeaderNamed(res, "cr_pending")!;
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Lax/i);
      expect(raw).toMatch(/Secure/i);
    },
  );

  await withServer(
    makeDeps({ auth: baseAuth({ callbackUrl: "http://app.example.test/auth/callback" }), fetchFn: mockFetch({ installations }) }),
    async (baseUrl) => {
      const loginRes = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
      const location = loginRes.headers.get("location")!;
      const state = new URL(location).searchParams.get("state")!;
      const stateCookie = cookieNamed(loginRes, "cr_oauth_state")!;
      const res = await callback(baseUrl, state, stateCookie, "", "cr_oauth_state");
      const raw = rawCookieHeaderNamed(res, "cr_pending")!;
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Lax/i);
      expect(raw).not.toMatch(/Secure/i);
    },
  );
});

// Same attack as the state/session cookie-tossing tests below, reproduced
// against cr_pending: a raw Cookie header carrying two values for its name
// must be rejected outright (read as absent), never last-wins-accepted.
test("a Cookie header carrying two values for the pending-login cookie name is treated as no pending login at all, not one of the two", async () => {
  await withServer(
    makeDeps({ fetchFn: mockFetch({ installations: [{ id: 1, account: "acme" }, { id: 2, account: "widgets" }] }) }),
    async (baseUrl) => {
      const { state, stateCookie } = await login(baseUrl);
      const callbackRes = await callback(baseUrl, state, stateCookie);
      const realPendingCookie = cookieNamed(callbackRes, "cr_pending")!;

      const res = await fetch(`${baseUrl}/auth/choose`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `__Host-cr_pending=attacker-garbage; __Host-cr_pending=${realPendingCookie}`,
        },
        body: new URLSearchParams({ installationId: "2" }),
      });
      expect(res.status).toBe(400);
    },
  );
});

// This is the actual cookie-tossing attack, reproduced directly: a sibling
// subdomain cannot literally set a `__Host-` cookie in a test double (that
// enforcement lives in the browser), but a browser under attack sends
// whatever cookies it holds for this name — including a tossed second one —
// in a single `Cookie` header. Simulating that raw header (two values for
// the same name) is exactly what `parseCookies`'s duplicate-rejection layer
// exists for: a mutation that reverted it to "last wins" would let the
// second (attacker's) state cookie value win here and let this callback
// through if it happened to match a real, unconsumed state of the
// attacker's own — this test only needs the safe behavior (rejection),
// which holds regardless of which of the two values `parseCookies` would
// otherwise have picked.
test("a Cookie header carrying two values for the state cookie name (simulated cookie tossing) is rejected, not last-wins-accepted", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const tossedCookieHeader = `__Host-cr_oauth_state=attacker-value; __Host-cr_oauth_state=${stateCookie}`;
    const res = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, {
      redirect: "manual",
      headers: { cookie: tossedCookieHeader },
    });
    // Whichever order parseCookies would have picked under old last-wins
    // semantics, one of those two values is the real, legitimate stateCookie
    // — so a broken (non-rejecting) implementation would have a real chance
    // of accepting this. The fix must reject it outright instead.
    expect(res.status).toBe(400);
    expect(cookiePresent(res, "cr_session")).toBe(false);
  });
});

test("a Cookie header carrying two values for the session cookie name is treated as no session at all, not one of the two", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    const realSessionCookie = cookieNamed(callbackRes, "cr_session")!;

    const res = await fetch(`${baseUrl}/api/whoami`, {
      headers: { cookie: `__Host-cr_session=attacker-garbage; __Host-cr_session=${realSessionCookie}` },
    });
    // A well-behaved single request never has two values for the same cookie
    // name — parseCookies drops the name entirely rather than guessing which
    // of the two to trust, so this reads as "no session cookie at all" (401),
    // not as either value being honored.
    expect(res.status).toBe(401);
  });
});

// --- Important H: logout, and the shortened session TTL --------------------

test("POST /auth/logout clears the session cookie: a session cookie presented afterwards to a fresh request is unaffected by the logout call itself, but the logout response clears both cookies it's responsible for", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    const sessionCookie = cookieNamed(callbackRes, "cr_session")!;

    // Sanity: the session is good before logout.
    const before = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `__Host-cr_session=${sessionCookie}` } });
    expect(before.status).toBe(200);

    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie: `__Host-cr_session=${sessionCookie}` },
    });
    expect(logoutRes.status).toBe(200);
    const sessionClear = rawCookieHeaderNamed(logoutRes, "cr_session")!;
    expect(sessionClear).toMatch(/Max-Age=0/);
    const stateClear = rawCookieHeaderNamed(logoutRes, "cr_oauth_state")!;
    expect(stateClear).toMatch(/Max-Age=0/);
  });
});

test("GET /auth/logout (wrong method) is not handled as logout", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/logout`, { redirect: "manual" });
    expect(res.status).not.toBe(200);
  });
});

test("the session TTL is shorter than the old 7-day default (a token-bearing cookie must not live that long)", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie);
    const raw = rawCookieHeaderNamed(res, "cr_session")!;
    const maxAgeMatch = /Max-Age=(\d+)/.exec(raw);
    expect(maxAgeMatch).toBeTruthy();
    const maxAge = Number(maxAgeMatch![1]);
    expect(maxAge).toBeLessThan(60 * 60 * 24 * 7);
    expect(maxAge).toBe(60 * 60 * 8); // the chosen 8-hour TTL — see DEFAULT_SESSION_TTL_SECONDS
  });
});
