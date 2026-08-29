const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_ROOT = "https://api.github.com";

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface InstallationRef {
  id: number;
  account: string;
}

export interface AuthenticatedUser {
  id: number;
  login: string;
}

/** Builds the GitHub "authorize" URL a login link redirects to. `state` must be single-use — see `OAuthStateStore`. */
export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Exchanges a one-time OAuth `code` for a user-to-server access token.
 * Never interpolates the raw response body into a thrown message: GitHub's
 * error payload for this endpoint can echo request parameters back, and the
 * client secret must never appear in a log line or thrown error.
 */
export async function exchangeCode(
  code: string,
  creds: OAuthCredentials,
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string }> {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`code exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: unknown; error?: unknown };
  if (typeof body.error === "string" && body.error.length > 0) {
    // The error *code* (e.g. "bad_verification_code") is a fixed enum value
    // from GitHub, safe to surface. error_description/error_uri are not —
    // they are not validated here and are never included.
    throw new Error(`code exchange failed: ${body.error}`);
  }
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("code exchange returned no access_token");
  }
  return { accessToken: body.access_token };
}

interface RawInstallationAccount {
  login?: unknown;
}

interface RawInstallation {
  id?: unknown;
  account?: RawInstallationAccount | null;
}

interface RawListInstallationsResponse {
  installations?: RawInstallation[];
}

/**
 * `GET /user/installations` — every installation the authenticated user
 * belongs to. This is the *only* source of truth for installation
 * membership: a client-supplied installation id is never trusted on its
 * own, it is always checked against a fresh call to this function.
 */
export async function listUserInstallations(
  userToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<InstallationRef[]> {
  const res = await fetchFn(`${API_ROOT}/user/installations?per_page=100`, {
    headers: { authorization: `Bearer ${userToken}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`listUserInstallations failed: ${res.status}`);
  }
  const body = (await res.json()) as Partial<RawListInstallationsResponse>;
  if (!Array.isArray(body.installations)) {
    throw new Error("listUserInstallations response is missing an installations array");
  }
  const result: InstallationRef[] = [];
  for (const inst of body.installations) {
    if (typeof inst.id !== "number") {
      throw new Error("listUserInstallations response contains an installation with no id");
    }
    const login = inst.account?.login;
    if (typeof login !== "string" || login.length === 0) {
      throw new Error("listUserInstallations response contains an installation with no account login");
    }
    result.push({ id: inst.id, account: login });
  }
  return result;
}

/**
 * Verifies that `installationId` is one the token's owner actually belongs
 * to, by re-fetching membership fresh rather than trusting the id itself.
 * This is the guard every installation-scoped route must call before
 * accepting a client-supplied installation id.
 */
export async function assertInstallationMembership(
  userToken: string,
  installationId: number,
  fetchFn: typeof fetch = fetch,
): Promise<InstallationRef> {
  const installations = await listUserInstallations(userToken, fetchFn);
  const match = installations.find((i) => i.id === installationId);
  if (!match) {
    throw new Error("installation is not accessible to this user");
  }
  return match;
}

/** `GET /user` — who the access token belongs to. */
export async function getAuthenticatedUser(
  userToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthenticatedUser> {
  const res = await fetchFn(`${API_ROOT}/user`, {
    headers: { authorization: `Bearer ${userToken}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`fetching authenticated user failed: ${res.status}`);
  }
  const body = (await res.json()) as { id?: unknown; login?: unknown };
  if (typeof body.id !== "number") {
    throw new Error("authenticated user response has no id");
  }
  if (typeof body.login !== "string" || body.login.length === 0) {
    throw new Error("authenticated user response has no login");
  }
  return { id: body.id, login: body.login };
}

const STATE_TTL_SECONDS = 600;

/**
 * Issues and validates the OAuth `state` parameter. Each state is generated
 * per login attempt and is single-use: `consume` deletes it whether or not
 * it was valid, so a replayed callback (the same `state` used twice) is
 * rejected the second time even if the first use was legitimate. Without
 * this, the login flow is open to CSRF — an attacker could complete their
 * own OAuth flow and trick a victim's browser into loading the callback with
 * the attacker's `code`, binding the victim's session to the attacker's
 * GitHub account.
 */
export class OAuthStateStore {
  private issued = new Map<string, number>();

  constructor(private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  issue(): string {
    const state = crypto.randomUUID();
    this.issued.set(state, this.now() + STATE_TTL_SECONDS);
    return state;
  }

  /** Returns true iff `state` was issued, unexpired, and not already consumed. Always single-use. */
  consume(state: string): boolean {
    const expiry = this.issued.get(state);
    this.issued.delete(state);
    return expiry !== undefined && expiry > this.now();
  }
}

const PENDING_LOGIN_TTL_SECONDS = 300;

export interface PendingLogin {
  userId: string;
  userToken: string;
}

/**
 * Holds a just-exchanged user token server-side, for the brief window
 * between "we know who this user is and which installations they can pick
 * from" and "they picked one" — e.g. rendering an installation picker. The
 * user token is looked up by an opaque id kept in an HttpOnly cookie; it
 * never appears in a URL, a rendered page, or the client-visible cookie
 * value itself. Single-use, like `OAuthStateStore`.
 */
export class PendingLoginStore {
  private pending = new Map<string, { login: PendingLogin; expiry: number }>();

  constructor(private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  create(login: PendingLogin): string {
    const id = crypto.randomUUID();
    this.pending.set(id, { login, expiry: this.now() + PENDING_LOGIN_TTL_SECONDS });
    return id;
  }

  /** Returns the pending login iff `id` is known and unexpired. Always single-use. */
  consume(id: string): PendingLogin | null {
    const entry = this.pending.get(id);
    this.pending.delete(id);
    if (!entry || entry.expiry <= this.now()) return null;
    return entry.login;
  }
}
