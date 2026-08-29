import { parseNextLink } from "../github/installationApi";
import type { RepoRef } from "../graph/githubSource";

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
 * Thrown by `assertInstallationMembership` when membership could not be
 * checked at all (a network error, a non-2xx response, a malformed
 * response body from GitHub) — as opposed to a clean answer of "no". A
 * caller must not treat the two the same: the first is a transient failure
 * worth retrying, the second is a fixed, unappealable "you don't belong to
 * this installation". Neither message carries the underlying error's
 * detail — that detail can include GitHub API status text derived from the
 * request, and only this fixed string is ever safe to show a client.
 */
export const MEMBERSHIP_VERIFICATION_FAILED = "could not verify installation membership — try again";

/** The fixed, safe message for "membership was checked successfully and the answer is no". */
export const MEMBERSHIP_NOT_A_MEMBER = "installation is not accessible to this user";

/**
 * Verifies that `installationId` is one the token's owner actually belongs
 * to, by re-fetching membership fresh rather than trusting the id itself.
 * This is the guard every installation-scoped route must call before
 * accepting a client-supplied installation id.
 *
 * Throws `MEMBERSHIP_VERIFICATION_FAILED` if membership could not be
 * determined at all, and `MEMBERSHIP_NOT_A_MEMBER` if it was determined and
 * the answer is no — callers should map the two to different responses
 * (e.g. retryable vs. final) without ever surfacing anything more specific.
 */
export async function assertInstallationMembership(
  userToken: string,
  installationId: number,
  fetchFn: typeof fetch = fetch,
): Promise<InstallationRef> {
  let installations: InstallationRef[];
  try {
    installations = await listUserInstallations(userToken, fetchFn);
  } catch {
    // listUserInstallations' own message is safe (it never contains the
    // token), but it's still not the right thing to hand a caller here: it
    // describes *why the check failed*, not a membership decision, and a
    // route several layers up should not have to know GitHub's HTTP status
    // vocabulary to tell the two apart.
    throw new Error(MEMBERSHIP_VERIFICATION_FAILED);
  }
  const match = installations.find((i) => i.id === installationId);
  if (!match) {
    throw new Error(MEMBERSHIP_NOT_A_MEMBER);
  }
  return match;
}

interface RawUserRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
}

interface RawUserRepoListResponse {
  repositories: RawUserRepo[];
}

/**
 * Thrown when GitHub rejects the signed-in user's own access token outright
 * (401/403) while listing an installation's user-scoped repositories — i.e.
 * the token was revoked, expired, or is otherwise no longer good. Distinct
 * from every other failure (network error, malformed body, a transient
 * 5xx) so a caller can treat this one specifically as "this session is no
 * longer valid, sign in again" — never as a generic upstream failure, and
 * never as license to fall back to some broader, unauthorized repo list
 * just because this specific check failed.
 */
export class UserTokenRejectedError extends Error {
  constructor() {
    super("the signed-in user's GitHub token was rejected");
    this.name = "UserTokenRejectedError";
  }
}

/**
 * `GET /user/installations/{installationId}/repositories` — the
 * repositories of `installationId` that *this specific user* (identified by
 * `userToken`, a user-to-server OAuth token — never the App's own
 * installation token) can actually access.
 *
 * This is the only correct source of truth for "which repos may this
 * signed-in user act on". `GET /installation/repositories` (the App's own
 * reach, fetched with the App's installation token — see
 * `InstallationGitHubApi.listRepos`) answers a different question entirely:
 * it lists every repo the *App* can reach, which GitHub grants access to as
 * soon as *any* member of the installation's account can see *any* repo in
 * it. Gating a specific user's mutations against that list is the
 * confused-deputy bug this function exists to close — see `ownedRepos` in
 * `src/server/api.ts`.
 *
 * Paginated the same way `InstallationGitHubApi.listRepos` is: GitHub's
 * pagination is link-based, so `parseNextLink` (not `total_count`) is the
 * only correct way to know whether another page exists.
 */
export async function listUserInstallationRepositories(
  userToken: string,
  installationId: number,
  fetchFn: typeof fetch = fetch,
): Promise<RepoRef[]> {
  const repos: RepoRef[] = [];
  let url: string | null = `${API_ROOT}/user/installations/${installationId}/repositories?per_page=100`;

  while (url) {
    const res: Response = await fetchFn(url, {
      headers: { authorization: `Bearer ${userToken}`, accept: "application/vnd.github+json" },
    });
    if (res.status === 401 || res.status === 403) {
      throw new UserTokenRejectedError();
    }
    if (!res.ok) {
      throw new Error(`listUserInstallationRepositories failed: ${res.status}`);
    }
    const body = (await res.json()) as Partial<RawUserRepoListResponse>;
    if (!Array.isArray(body.repositories)) {
      throw new Error("listUserInstallationRepositories response is missing a repositories array");
    }
    for (const r of body.repositories) {
      if (typeof r.full_name !== "string" || r.full_name.length === 0) {
        throw new Error("listUserInstallationRepositories response contains a repository with no full_name");
      }
      repos.push({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch });
    }
    url = parseNextLink(res.headers.get("link"));
  }
  return repos;
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

export const OAUTH_STATE_TTL_SECONDS = 600;

/**
 * Issues and validates the OAuth `state` parameter. Each state is generated
 * per login attempt and is single-use: `consume` deletes it whether or not
 * it was valid, so a replayed callback (the same `state` used twice) is
 * rejected the second time even if the first use was legitimate.
 *
 * Single-use alone is not the whole CSRF guard, though: it stops a `state`
 * from being replayed, but says nothing about *which browser* presents it.
 * An attacker can start their own login, obtain a real, unconsumed `state`
 * bound to their own GitHub account, and hand it to a victim's browser in a
 * link — the store alone would accept that callback. The caller (see
 * `src/server/index.ts`) closes that gap with a double-submit cookie: the
 * same `state` is also set as an `HttpOnly` cookie at issue time, and the
 * callback is only accepted when the query `state` matches *both* this
 * store's record *and* the cookie the requesting browser presents.
 */
export class OAuthStateStore {
  private issued = new Map<string, number>();

  constructor(private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  issue(): string {
    // `GET /auth/login` is unauthenticated and cheap — nothing here ever
    // deletes an entry except a matching `consume()`, so a login that is
    // never followed through to a callback would otherwise sit in this map
    // forever. Pruning on every insert bounds the map's size to roughly
    // "states issued in the last OAUTH_STATE_TTL_SECONDS", regardless of how
    // many logins are started and abandoned.
    this.prune();
    const state = crypto.randomUUID();
    this.issued.set(state, this.now() + OAUTH_STATE_TTL_SECONDS);
    return state;
  }

  /** Returns true iff `state` was issued, unexpired, and not already consumed. Always single-use. */
  consume(state: string): boolean {
    const expiry = this.issued.get(state);
    this.issued.delete(state);
    return expiry !== undefined && expiry > this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [state, expiry] of this.issued) {
      if (expiry <= now) this.issued.delete(state);
    }
  }

  /** Test-only visibility into how many entries are currently held, to prove pruning actually bounds growth. */
  get size(): number {
    return this.issued.size;
  }
}

/**
 * Constant-time string equality, for comparing two values neither of which
 * should leak how many leading characters an attacker's guess got right —
 * here, the query `state` against the double-submit cookie's value. Hashing
 * both to a fixed-length digest first means the comparison never leaks the
 * inputs' original lengths either. Uses `crypto.subtle.digest`, the same
 * Web Crypto surface `SessionStore` signs and verifies with.
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
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
    // Same unbounded-growth reasoning as `OAuthStateStore.issue` — a picker
    // page that's rendered but never followed through to `/auth/choose`
    // would otherwise hold its (login-bearing) entry forever.
    this.prune();
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

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiry <= now) this.pending.delete(id);
    }
  }

  /** Test-only visibility into how many entries are currently held, to prove pruning actually bounds growth. */
  get size(): number {
    return this.pending.size;
  }
}
