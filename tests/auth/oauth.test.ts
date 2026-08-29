import { test, expect } from "bun:test";
import {
  authorizeUrl,
  exchangeCode,
  listUserInstallations,
  getAuthenticatedUser,
  assertInstallationMembership,
  OAuthStateStore,
  PendingLoginStore,
  timingSafeEqualStrings,
  MEMBERSHIP_VERIFICATION_FAILED,
  MEMBERSHIP_NOT_A_MEMBER,
  type OAuthCredentials,
} from "../../src/auth/oauth";

const CREDS: OAuthCredentials = { clientId: "client-123", clientSecret: "super-secret-value" };

test("authorizeUrl builds the GitHub authorize URL with client_id, redirect_uri, and state", () => {
  const url = authorizeUrl("client-123", "https://app.example.com/auth/callback", "state-abc");
  const parsed = new URL(url);
  expect(parsed.origin).toBe("https://github.com");
  expect(parsed.pathname).toBe("/login/oauth/authorize");
  expect(parsed.searchParams.get("client_id")).toBe("client-123");
  expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example.com/auth/callback");
  expect(parsed.searchParams.get("state")).toBe("state-abc");
});

test("exchangeCode returns the access token on success", async () => {
  let capturedBody = "";
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ access_token: "user-token-xyz", token_type: "bearer" }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const result = await exchangeCode("the-code", CREDS, fetchFn);
  expect(result).toEqual({ accessToken: "user-token-xyz" });
  expect(capturedBody).toContain("client_id=client-123");
  expect(capturedBody).toContain("code=the-code");
});

test("exchangeCode rejects a non-2xx response without leaking the client secret", async () => {
  const fetchFn = (async () =>
    new Response("client_secret=super-secret-value is invalid", { status: 401 })) as unknown as typeof fetch;
  let message = "";
  try {
    await exchangeCode("the-code", CREDS, fetchFn);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toMatch(/401/);
  expect(message).not.toContain(CREDS.clientSecret);
});

test("exchangeCode rejects a 2xx body carrying an OAuth error, without leaking the client secret", async () => {
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({
        error: "bad_verification_code",
        error_description: `client_secret ${CREDS.clientSecret} rejected`,
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  let message = "";
  try {
    await exchangeCode("the-code", CREDS, fetchFn);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toMatch(/bad_verification_code/);
  expect(message).not.toContain(CREDS.clientSecret);
});

test("exchangeCode rejects a 2xx body with no access_token", async () => {
  const fetchFn = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
  await expect(exchangeCode("the-code", CREDS, fetchFn)).rejects.toThrow(/access_token/);
});

test("listUserInstallations parses id and account login for each installation", async () => {
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({
        installations: [
          { id: 111, account: { login: "acme" } },
          { id: 222, account: { login: "someone" } },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const result = await listUserInstallations("user-token", fetchFn);
  expect(result).toEqual([
    { id: 111, account: "acme" },
    { id: 222, account: "someone" },
  ]);
});

test("listUserInstallations sends the user token as a bearer credential", async () => {
  let authHeader = "";
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    authHeader = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ installations: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  await listUserInstallations("user-token-abc", fetchFn);
  expect(authHeader).toBe("Bearer user-token-abc");
});

test("listUserInstallations rejects a non-2xx response, not leaking the token", async () => {
  const fetchFn = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  let message = "";
  try {
    await listUserInstallations("user-token-secret", fetchFn);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toMatch(/403/);
  expect(message).not.toContain("user-token-secret");
});

test("listUserInstallations rejects a response missing the installations array", async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ total_count: 0 }), { status: 200 })) as unknown as typeof fetch;
  await expect(listUserInstallations("t", fetchFn)).rejects.toThrow(/installations array/);
});

test("listUserInstallations rejects an installation with no account login", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ installations: [{ id: 1, account: {} }] }), { status: 200 })) as unknown as typeof fetch;
  await expect(listUserInstallations("t", fetchFn)).rejects.toThrow(/account login/);
});

test("getAuthenticatedUser parses id and login", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ id: 999, login: "octocat" }), { status: 200 })) as unknown as typeof fetch;
  const user = await getAuthenticatedUser("user-token", fetchFn);
  expect(user).toEqual({ id: 999, login: "octocat" });
});

test("getAuthenticatedUser rejects a non-2xx response without leaking the token", async () => {
  const fetchFn = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  let message = "";
  try {
    await getAuthenticatedUser("user-token-secret", fetchFn);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toMatch(/401/);
  expect(message).not.toContain("user-token-secret");
});

test("assertInstallationMembership resolves when the id is a real membership", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ installations: [{ id: 42, account: { login: "acme" } }] }), {
      status: 200,
    })) as unknown as typeof fetch;
  const ref = await assertInstallationMembership("user-token", 42, fetchFn);
  expect(ref).toEqual({ id: 42, account: "acme" });
});

// This is the test that discriminates the cross-tenant-leak bug directly: a
// client naming an installation id it does not belong to must be rejected,
// even though the id is well-formed and even though *some* installations
// exist for this user.
test("assertInstallationMembership rejects an id the user does not belong to", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ installations: [{ id: 42, account: { login: "acme" } }] }), {
      status: 200,
    })) as unknown as typeof fetch;
  await expect(assertInstallationMembership("user-token", 999, fetchFn)).rejects.toThrow(
    /not accessible/,
  );
});

test("assertInstallationMembership always calls listUserInstallations rather than trusting the id", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return new Response(JSON.stringify({ installations: [{ id: 7, account: { login: "acme" } }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  await assertInstallationMembership("user-token", 7, fetchFn);
  expect(calls).toBe(1);
});

// A clean "no" (membership was checked and this id isn't in it) must not read
// the same as "the check itself failed" — a caller mapping these to
// different HTTP statuses (e.g. 403 vs 502) needs the messages to differ.
test("assertInstallationMembership: a clean non-member rejection uses MEMBERSHIP_NOT_A_MEMBER, not the verification-failure message", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ installations: [{ id: 1, account: { login: "acme" } }] }), {
      status: 200,
    })) as unknown as typeof fetch;
  let message = "";
  try {
    await assertInstallationMembership("user-token", 999, fetchFn);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toBe(MEMBERSHIP_NOT_A_MEMBER);
  expect(message).not.toBe(MEMBERSHIP_VERIFICATION_FAILED);
});

test("assertInstallationMembership: an underlying listUserInstallations failure surfaces as MEMBERSHIP_VERIFICATION_FAILED, without the underlying detail", async () => {
  const fetchFn = (async () =>
    new Response("token abc123-user-secret was rejected", { status: 500 })) as unknown as typeof fetch;
  let message = "";
  try {
    await assertInstallationMembership("abc123-user-secret", 1, fetchFn);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toBe(MEMBERSHIP_VERIFICATION_FAILED);
  expect(message).not.toBe(MEMBERSHIP_NOT_A_MEMBER);
  expect(message).not.toContain("abc123-user-secret");
  expect(message).not.toMatch(/500/);
});

test("timingSafeEqualStrings: identical strings compare equal", async () => {
  expect(await timingSafeEqualStrings("same-value", "same-value")).toBe(true);
});

test("timingSafeEqualStrings: different strings of the same length compare unequal", async () => {
  expect(await timingSafeEqualStrings("state-aaaa", "state-bbbb")).toBe(false);
});

test("timingSafeEqualStrings: different strings of different lengths compare unequal", async () => {
  expect(await timingSafeEqualStrings("short", "a-much-longer-value")).toBe(false);
});

test("timingSafeEqualStrings: an empty string never matches a non-empty one", async () => {
  expect(await timingSafeEqualStrings("", "non-empty")).toBe(false);
});

test("OAuthStateStore: a freshly issued state is accepted exactly once", () => {
  const store = new OAuthStateStore(() => 1000);
  const state = store.issue();
  expect(store.consume(state)).toBe(true);
  // Replaying the same state a second time must fail — this is the CSRF guard.
  expect(store.consume(state)).toBe(false);
});

test("OAuthStateStore: an unknown state is rejected", () => {
  const store = new OAuthStateStore(() => 1000);
  expect(store.consume("never-issued")).toBe(false);
});

test("OAuthStateStore: an expired state is rejected even though it was issued", () => {
  let clock = 1000;
  const store = new OAuthStateStore(() => clock);
  const state = store.issue();
  clock += 601; // past the 600s TTL
  expect(store.consume(state)).toBe(false);
});

test("OAuthStateStore: two issued states are independent", () => {
  const store = new OAuthStateStore(() => 1000);
  const a = store.issue();
  const b = store.issue();
  expect(a).not.toBe(b);
  expect(store.consume(a)).toBe(true);
  expect(store.consume(b)).toBe(true);
});

test("PendingLoginStore: a pending login is consumable exactly once", () => {
  const store = new PendingLoginStore(() => 1000);
  const id = store.create({ userId: "1", userToken: "tok" });
  expect(store.consume(id)).toEqual({ userId: "1", userToken: "tok" });
  expect(store.consume(id)).toBeNull();
});

test("PendingLoginStore: an expired pending login is rejected", () => {
  let clock = 1000;
  const store = new PendingLoginStore(() => clock);
  const id = store.create({ userId: "1", userToken: "tok" });
  clock += 301; // past the 300s TTL
  expect(store.consume(id)).toBeNull();
});

test("PendingLoginStore: an unknown id is rejected", () => {
  const store = new PendingLoginStore(() => 1000);
  expect(store.consume("never-created")).toBeNull();
});
