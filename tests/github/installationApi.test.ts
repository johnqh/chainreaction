import { test, expect } from "bun:test";
import { InstallationGitHubApi } from "../../src/github/installationApi";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("listRepos follows the Link header's rel=\"next\" until it is absent, yielding the union of both pages", async () => {
  const page1Url = "https://api.github.com/installation/repositories?per_page=100";
  const page2Url = "https://api.github.com/installation/repositories?per_page=100&page=2";
  const calledUrls: string[] = [];

  const fetchFn = (async (url: string | URL) => {
    calledUrls.push(String(url));
    if (String(url) === page1Url) {
      return jsonResponse(
        {
          total_count: 2,
          repositories: [{ full_name: "acme/repo-1", private: false, default_branch: "main" }],
        },
        { headers: { link: `<${page2Url}>; rel="next"` } },
      );
    }
    if (String(url) === page2Url) {
      // Final page: no Link header at all.
      return jsonResponse({
        total_count: 2,
        repositories: [{ full_name: "acme/repo-2", private: true, default_branch: "main" }],
      });
    }
    throw new Error(`unexpected url: ${url}`);
  }) as unknown as typeof fetch;

  const api = new InstallationGitHubApi(async () => "token-123", 42, fetchFn);
  const repos = await api.listRepos();

  // The load-bearing assertion: a single-request implementation only ever
  // sees page 1 and returns just repo-1. Following the Link header is the
  // only way both repos show up.
  expect(repos.map((r) => r.fullName).sort()).toEqual(["acme/repo-1", "acme/repo-2"]);
  expect(calledUrls.length).toBe(2);
  expect(calledUrls[0]).toContain("per_page=100");
});

test("listRepos with a single page (no Link header) returns just that page", async () => {
  const fetchFn = (async () =>
    jsonResponse({
      total_count: 1,
      repositories: [{ full_name: "acme/only-repo", private: false, default_branch: "main" }],
    })) as unknown as typeof fetch;

  const api = new InstallationGitHubApi(async () => "token-123", 42, fetchFn);
  const repos = await api.listRepos();
  expect(repos.map((r) => r.fullName)).toEqual(["acme/only-repo"]);
});

test("listRepos throws on a non-OK response", async () => {
  const fetchFn = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const api = new InstallationGitHubApi(async () => "token-123", 42, fetchFn);
  await expect(api.listRepos()).rejects.toThrow(/500/);
});

test("getManifest returns null on 404", async () => {
  const fetchFn = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
  const api = new InstallationGitHubApi(async () => "token-123", 42, fetchFn);
  expect(await api.getManifest("acme/no-manifest")).toBeNull();
});

test("getManifest throws on a non-404 non-OK response, instead of treating it as no manifest", async () => {
  const fetchFn = (async () => new Response("server error", { status: 500 })) as unknown as typeof fetch;
  const api = new InstallationGitHubApi(async () => "token-123", 42, fetchFn);
  await expect(api.getManifest("acme/whoops")).rejects.toThrow(/500/);
});

test("getManifest sends the raw accept header and returns raw JSON text, not base64", async () => {
  let capturedHeaders: Headers | undefined;
  const raw = JSON.stringify({ name: "@acme/thing", version: "1.0.0" });
  const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers);
    return new Response(raw, { status: 200 });
  }) as unknown as typeof fetch;

  const api = new InstallationGitHubApi(async () => "token-123", 42, fetchFn);
  const manifest = await api.getManifest("acme/thing");

  expect(capturedHeaders?.get("accept")).toBe("application/vnd.github.raw+json");
  expect(manifest).toBe(raw);
  expect(() => JSON.parse(manifest!)).not.toThrow();
});

test("never logs the token", async () => {
  const warnings: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const fetchFn = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const api = new InstallationGitHubApi(async () => "super-secret-token", 42, fetchFn);
    await expect(api.listRepos()).rejects.toThrow();
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  expect(warnings.some((w) => w.includes("super-secret-token"))).toBe(false);
});
