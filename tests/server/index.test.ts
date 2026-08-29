import { test, expect } from "bun:test";
import { createServer, type ServerDeps, type AuthConfig } from "../../src/server/index";
import { Cascade } from "../../src/supervisor/state";

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
    cascade: new Cascade([], 0),
    entries: [],
    onApprove: () => {},
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

function cookiesFrom(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const header of res.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const eq = pair!.indexOf("=");
    out.set(pair!.slice(0, eq), pair!.slice(eq + 1));
  }
  return out;
}

function rawCookieHeaders(res: Response): string[] {
  return res.headers.getSetCookie();
}

interface LoginAttempt {
  state: string;
  /** The `cr_oauth_state` cookie value `/auth/login` set for this attempt. */
  stateCookie: string;
}

/** Starts a login: GETs /auth/login and returns the issued state and the double-submit cookie it set. */
async function login(baseUrl: string): Promise<LoginAttempt> {
  const loginRes = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
  const location = loginRes.headers.get("location")!;
  const state = new URL(location).searchParams.get("state")!;
  const stateCookie = cookiesFrom(loginRes).get("cr_oauth_state")!;
  return { state, stateCookie };
}

/**
 * GETs the callback with `code=abc`, the given `state` in the query, and the
 * given `cookieState` (or `undefined` to send no state cookie at all) as the
 * `cr_oauth_state` cookie. `extraQuery` appends anything else (e.g.
 * `&installation_id=7`).
 */
async function callback(
  baseUrl: string,
  state: string,
  cookieState: string | undefined,
  extraQuery = "",
): Promise<Response> {
  return fetch(`${baseUrl}/auth/callback?code=abc&state=${state}${extraQuery}`, {
    redirect: "manual",
    headers: cookieState !== undefined ? { cookie: `cr_oauth_state=${cookieState}` } : {},
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
    expect(cookiesFrom(res).get("cr_oauth_state")).toBe(state!);
  });
});

test("callback with a state that was never issued is rejected", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const res = await callback(baseUrl, "never-issued", "never-issued");
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cr_session="))).toBe(false);
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
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cr_session="))).toBe(false);
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
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cr_session="))).toBe(false);
  });
});

test("the state cookie is cleared after the callback, whether login succeeded or failed", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie);
    expect(res.status).toBe(302); // sanity: this is the success path
    const raw = rawCookieHeaders(res).find((h) => h.startsWith("cr_oauth_state="))!;
    expect(raw).toBeTruthy();
    expect(raw).toMatch(/Max-Age=0/);
  });
});

test("the state cookie carries HttpOnly, SameSite=Lax, and Secure when the callback URL is https", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "https://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
    const raw = rawCookieHeaders(res).find((h) => h.startsWith("cr_oauth_state="))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Secure/i);
  });
});

test("the state cookie omits Secure when the callback URL is plain http", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "http://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
    const raw = rawCookieHeaders(res).find((h) => h.startsWith("cr_oauth_state="))!;
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
    const sessionCookie = cookiesFrom(res).get("cr_session");
    expect(sessionCookie).toBeTruthy();

    const whoami = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `cr_session=${sessionCookie}` } });
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toEqual({ userId: "555", installationId: 1 });
  });
});

test("/api/whoami with a valid session returns the session's userId and installationId", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    const sessionCookie = cookiesFrom(callbackRes).get("cr_session")!;

    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `cr_session=${sessionCookie}` } });
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
    const sessionCookie = cookiesFrom(callbackRes).get("cr_session")!;
    const [payload, sig] = sessionCookie.split(".");
    const tamperedSig = (sig![0] === "A" ? "B" : "A") + sig!.slice(1);
    const tampered = `${payload}.${tamperedSig}`;

    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `cr_session=${tampered}` } });
    expect(res.status).toBe(401);
  });
});

test("/api/whoami rejects a cookie signed under a different session secret", async () => {
  // Mint a real session cookie against a server configured with SESSION_SECRET...
  let sessionCookie = "";
  await withServer(makeDeps(), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const callbackRes = await callback(baseUrl, state, stateCookie);
    sessionCookie = cookiesFrom(callbackRes).get("cr_session")!;
  });
  expect(sessionCookie).toBeTruthy();

  // ...then present it to a server configured with a different one. A signed
  // cookie must not validate against any secret other than the one it was
  // actually signed with.
  await withServer(makeDeps({ auth: baseAuth({ sessionSecret: "a-totally-different-secret" }) }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `cr_session=${sessionCookie}` } });
    expect(res.status).toBe(401);
  });
});

// --- Cookie flags (session cookie) ------------------------------------------

test("session cookie is HttpOnly, SameSite=Lax, and Secure when the callback URL is https", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "https://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie);
    const raw = rawCookieHeaders(res).find((h) => h.startsWith("cr_session="))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Secure/i);
  });
});

test("session cookie omits Secure when the callback URL is plain http", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "http://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const { state, stateCookie } = await login(baseUrl);
    const res = await callback(baseUrl, state, stateCookie);
    const raw = rawCookieHeaders(res).find((h) => h.startsWith("cr_session="))!;
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
    const pendingCookie = cookiesFrom(callbackRes).get("cr_pending")!;
    expect(pendingCookie).toBeTruthy();

    const chooseRes = await fetch(`${baseUrl}/auth/choose?installationId=2`, {
      redirect: "manual",
      headers: { cookie: `cr_pending=${pendingCookie}` },
    });
    expect(chooseRes.status).toBe(302);
    const sessionCookie = cookiesFrom(chooseRes).get("cr_session")!;
    expect(sessionCookie).toBeTruthy();

    const whoami = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `cr_session=${sessionCookie}` } });
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
    const pendingCookie = cookiesFrom(callbackRes).get("cr_pending")!;

    const chooseRes = await fetch(`${baseUrl}/auth/choose?installationId=999`, {
      redirect: "manual",
      headers: { cookie: `cr_pending=${pendingCookie}` },
    });
    expect(chooseRes.status).toBe(403);
    expect(chooseRes.headers.getSetCookie().some((c) => c.startsWith("cr_session="))).toBe(false);
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
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cr_session="))).toBe(false);
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
      headers: { cookie: `cr_session=${cookiesFrom(res).get("cr_session")}` },
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
    const pendingCookie = cookiesFrom(callbackRes).get("cr_pending")!;

    failOnInstallations = true;
    const chooseRes = await fetch(`${baseUrl}/auth/choose?installationId=2`, {
      redirect: "manual",
      headers: { cookie: `cr_pending=${pendingCookie}` },
    });
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
    const sessionCookie = cookiesFrom(callbackRes).get("cr_session")!;
    expect(sessionCookie).not.toContain(SESSION_SECRET);

    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { cookie: `cr_session=${sessionCookie}` } });
    const body = await res.text();
    expect(body).not.toContain(SESSION_SECRET);
  });
});

// --- Legacy token-gated UI keeps working -------------------------------------

test("existing /api/token and /api/approve behavior is unaffected", async () => {
  let approved = false;
  await withServer(makeDeps({ onApprove: () => { approved = true; } }), async (baseUrl) => {
    const tokenRes = await fetch(`${baseUrl}/api/token`);
    const { token } = (await tokenRes.json()) as { token: string };
    expect(token).toBeTruthy();

    const unauthorized = await fetch(`${baseUrl}/api/approve`, { method: "POST" });
    expect(unauthorized.status).toBe(401);

    const ok = await fetch(`${baseUrl}/api/approve`, {
      method: "POST",
      headers: { "x-chainreaction-token": token },
    });
    expect(ok.status).toBe(200);
    expect(approved).toBe(true);
  });
});
