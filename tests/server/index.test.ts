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

async function login(baseUrl: string): Promise<string> {
  const loginRes = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
  const location = loginRes.headers.get("location")!;
  const state = new URL(location).searchParams.get("state")!;
  return state;
}

// --- CSRF: state is per-request, checked, and single-use -----------------------

test("GET /auth/login redirects to GitHub's authorize URL carrying a fresh state", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id-abc");
    expect(location.searchParams.get("state")).toBeTruthy();
  });
});

test("callback with a state that was never issued is rejected", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/callback?code=abc&state=never-issued`, {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().length).toBe(0);
  });
});

test("a replayed state is rejected the second time, even though the first use was valid", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const state = await login(baseUrl);

    const first = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, { redirect: "manual" });
    expect(first.status).toBe(302);

    const second = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, { redirect: "manual" });
    expect(second.status).toBe(400);
  });
});

// --- Signed, expiring session cookie; tampering is rejected outright -----------

test("a successful callback (single installation) sets a session cookie and redirects home", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const state = await login(baseUrl);
    const res = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookies = cookiesFrom(res);
    expect(cookies.has("cr_session")).toBe(true);
  });
});

test("/api/whoami with a valid session returns the session's userId and installationId", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const state = await login(baseUrl);
    const callbackRes = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, {
      redirect: "manual",
    });
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
    const state = await login(baseUrl);
    const callbackRes = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, {
      redirect: "manual",
    });
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
    const state = await login(baseUrl);
    const callbackRes = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, {
      redirect: "manual",
    });
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

// --- Cookie flags ----------------------------------------------------------

test("session cookie is HttpOnly, SameSite=Lax, and Secure when the callback URL is https", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "https://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const state = await login(baseUrl);
    const res = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, { redirect: "manual" });
    const raw = rawCookieHeaders(res).find((h) => h.startsWith("cr_session="))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Secure/i);
  });
});

test("session cookie omits Secure when the callback URL is plain http", async () => {
  await withServer(makeDeps({ auth: baseAuth({ callbackUrl: "http://app.example.test/auth/callback" }) }), async (baseUrl) => {
    const state = await login(baseUrl);
    const res = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, { redirect: "manual" });
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
    const state = await login(baseUrl);
    const callbackRes = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, { redirect: "manual" });
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
    const state = await login(baseUrl);
    const callbackRes = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, { redirect: "manual" });
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
    const state = await login(baseUrl);
    const res = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}&installation_id=42`, {
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cr_session="))).toBe(false);
  });
});

test("callback with an installation_id hint the user does belong to succeeds", async () => {
  const deps = makeDeps({
    fetchFn: mockFetch({ installations: [{ id: 1, account: "acme" }, { id: 7, account: "other" }] }),
  });
  await withServer(deps, async (baseUrl) => {
    const state = await login(baseUrl);
    const res = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}&installation_id=7`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const whoami = await fetch(`${baseUrl}/api/whoami`, {
      headers: { cookie: `cr_session=${cookiesFrom(res).get("cr_session")}` },
    });
    expect(await whoami.json()).toEqual({ userId: "555", installationId: 7 });
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
    const state = await login(baseUrl);
    const res = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, { redirect: "manual" });
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
    const state = await login(baseUrl);
    const res = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, { redirect: "manual" });
    const body = await res.text();
    expect(body).not.toContain("super-secret-user-token");
  });
});

test("the rendered installation-choice page never contains the user access token", async () => {
  const deps = makeDeps({
    fetchFn: mockFetch({ installations: [{ id: 1, account: "acme" }, { id: 2, account: "widgets" }] }),
  });
  await withServer(deps, async (baseUrl) => {
    const state = await login(baseUrl);
    const res = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, { redirect: "manual" });
    const body = await res.text();
    expect(body).not.toContain("user-access-token-xyz");
  });
});

test("session secret never appears in a session cookie or the whoami response", async () => {
  await withServer(makeDeps(), async (baseUrl) => {
    const state = await login(baseUrl);
    const callbackRes = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, { redirect: "manual" });
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
