import { test, expect } from "bun:test";
import { realDeps } from "../../src/cli/deps";
import type { CliConfig } from "../../src/cli/config";

async function generatePem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

interface Call {
  method: string;
  url: string;
}

/**
 * A single fetch stub that plays every real GitHub endpoint this wiring can
 * reach: the App-installation token exchange, repository listing and
 * manifest reads (GitHubGraphSource), and the repo/protection/workflow
 * endpoints (assessRepo, prepareRepo). Every request — read or write — is
 * recorded in `calls`, which is the thing the plan-safety tests assert on.
 */
function stubFetch(opts: { repos: string[]; manifests: Record<string, string> }) {
  const calls: Call[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });

    if (method === "POST" && url.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: "test-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        { status: 201 },
      );
    }
    if (url.includes("/installation/repositories")) {
      return new Response(
        JSON.stringify({
          repositories: opts.repos.map((r) => ({ full_name: r, private: false, default_branch: "main" })),
        }),
        { status: 200 },
      );
    }
    const manifest = /\/repos\/([^/]+\/[^/]+)\/contents\/package\.json$/.exec(url);
    if (manifest) {
      const content = opts.manifests[manifest[1]!];
      return content === undefined ? new Response("", { status: 404 }) : new Response(content, { status: 200 });
    }
    if (/\/contents\/\.github\/workflows\//.test(url)) {
      return new Response("{}", { status: 200 }); // validation workflow present
    }
    if (/\/pulls\?/.test(url)) {
      // No PR on record -> probeRepo falls back to sampling the default
      // branch, which is where this stub's check-runs response lives.
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (/\/commits\/[^/]+\/check-runs/.test(url)) {
      // "ci" matches the requiredChecks every test in this file configures
      // below, so a repo probed here is observed as ready by default.
      return new Response(JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "ci" }] }), { status: 200 });
    }
    if (/\/commits\/[^/]+\/status$/.test(url)) {
      return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
    }
    if (/\/branches\/[^/]+\/protection$/.test(url)) {
      if (method === "GET") {
        return new Response(JSON.stringify({ message: "Branch not protected" }), { status: 404 });
      }
      if (method === "PUT") return new Response("{}", { status: 200 });
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      if (method === "GET") {
        return new Response(
          JSON.stringify({ default_branch: "main", private: false, allow_auto_merge: false }),
          { status: 200 },
        );
      }
      if (method === "PATCH") return new Response("{}", { status: 200 });
    }
    throw new Error(`stubFetch: unhandled request ${method} ${url}`);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function config(over: Partial<CliConfig> = {}): Promise<CliConfig> {
  return {
    appId: "1",
    privateKeyPem: await generatePem(),
    installationId: 99,
    scope: "@acme/",
    requiredChecks: ["ci"],
    ...over,
  };
}

test("deps.prepare(repo) reaches prepareRepo — mutations are permitted here", async () => {
  const { fetchFn, calls } = stubFetch({ repos: ["acme/lib"], manifests: {} });
  const deps = realDeps(await config(), fetchFn);

  const result = await deps.prepare("acme/lib");

  expect(result).toMatchObject({ repo: "acme/lib", ready: true, mechanism: "auto-merge" });
  expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/repos/acme/lib"))).toBe(true);
  expect(calls.some((c) => c.method === "PUT" && c.url.includes("/protection"))).toBe(true);
});

test("deps.plan(...) never calls enableAutoMerge or setProtection", async () => {
  const { fetchFn, calls } = stubFetch({
    repos: ["acme/lib"],
    manifests: { "acme/lib": JSON.stringify({ name: "@acme/lib", version: "1.0.0" }) },
  });
  const deps = realDeps(await config(), fetchFn);

  const plan = await deps.plan("@acme/lib", "all");
  expect(plan.affected).toEqual(["@acme/lib"]);

  // This is the test that holds decision 1. It must fail against a version
  // that wires prepareRepo (directly, or via a PreparedProvider that calls
  // it) into the plan path — deliberately asserting on the recorded HTTP
  // traffic, not the return value, because a plan that mutated repos behind
  // the scenes would still return a perfectly normal-looking CascadePlan.
  const mutations = calls.filter(
    (c) =>
      (c.method === "PUT" && c.url.includes("/protection")) ||
      (c.method === "PATCH" && /\/repos\/[^/]+\/[^/]+$/.test(c.url)),
  );
  expect(mutations).toEqual([]);
});

test("the PreparedProvider probes repos sequentially, never more than one in flight", async () => {
  // FIX 1: assessRepo -> probeRepo fires 4 requests per repo (getRepo, then
  // getProtection + hasFile + listCheckRuns in parallel). A provider that
  // maps repos through Promise.all therefore fires 4N concurrent requests,
  // which is exactly the shape GitHub's secondary rate limits key on. This
  // test proves the provider processes one repo's assessRepo to completion
  // before starting the next.
  //
  // It tracks concurrency only on the bare "GET /repos/{owner}/{repo}" call
  // (probeRepo's first call, getRepo) rather than every fetch. getProtection,
  // hasFile and listCheckRuns are *deliberately* concurrent within a single
  // repo's probe (probe.ts's own Promise.all, untouched by this fix) —
  // tracking every fetch would show a max of 3 even against a correctly
  // sequential provider, a false failure unrelated to what this fix changes. The
  // getRepo call is the one request that only overlaps across repos, so it
  // isolates cross-repo concurrency specifically.
  //
  // A synthetic delay is required on that endpoint: a fetch stub with no
  // internal `await` runs its entire body synchronously once invoked, so
  // even `Promise.all([a(), b()])` could never show visible overlap without
  // a real suspension point — exactly like the earlier stubs in this file.
  // The delay makes concurrent invocations genuinely interleave, the way
  // real network latency would, which is what makes this test able to fail
  // against the parallel (`Promise.all(repos.map(...))`) implementation:
  // there, all three repos' getRepo calls fire before any of the three
  // 5ms delays resolve, so all three are in flight at once and
  // maxInFlight reaches 3 instead of 1.
  let inFlight = 0;
  let maxInFlight = 0;
  const bareRepoGet = /\/repos\/[^/]+\/[^/]+$/;

  const manifests: Record<string, string> = {
    "acme/a": JSON.stringify({ name: "@acme/a", version: "1.0.0" }),
    "acme/b": JSON.stringify({ name: "@acme/b", version: "1.0.0", dependencies: { "@acme/a": "^1.0.0" } }),
    "acme/c": JSON.stringify({ name: "@acme/c", version: "1.0.0", dependencies: { "@acme/a": "^1.0.0" } }),
  };

  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "POST" && url.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: "test-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        { status: 201 },
      );
    }
    if (url.includes("/installation/repositories")) {
      return new Response(
        JSON.stringify({
          repositories: Object.keys(manifests).map((r) => ({ full_name: r, private: false, default_branch: "main" })),
        }),
        { status: 200 },
      );
    }
    const manifestMatch = /\/repos\/([^/]+\/[^/]+)\/contents\/package\.json$/.exec(url);
    if (manifestMatch) {
      return new Response(manifests[manifestMatch[1]!]!, { status: 200 });
    }
    if (/\/contents\/\.github\/workflows\//.test(url)) {
      return new Response("{}", { status: 200 }); // validation workflow present
    }
    if (/\/pulls\?/.test(url)) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (/\/commits\/[^/]+\/check-runs/.test(url)) {
      return new Response(JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "ci" }] }), { status: 200 });
    }
    if (/\/commits\/[^/]+\/status$/.test(url)) {
      return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
    }
    if (/\/branches\/[^/]+\/protection$/.test(url) && method === "GET") {
      return new Response(JSON.stringify({ message: "Branch not protected" }), { status: 404 });
    }
    if (bareRepoGet.test(url) && method === "GET") {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Real suspension point — see comment above.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(
        JSON.stringify({ default_branch: "main", private: false, allow_auto_merge: false }),
        { status: 200 },
      );
    }
    throw new Error(`stubFetch: unhandled request ${method} ${url}`);
  }) as unknown as typeof fetch;

  const deps = realDeps(await config(), fetchFn);
  const plan = await deps.plan("@acme/a", "all");

  expect([...plan.affected].sort()).toEqual(["@acme/a", "@acme/b", "@acme/c"]);
  expect(maxInFlight).toBe(1);
});

test("the PreparedProvider handed to planCascade is called with exactly the repo set planCascade computed", async () => {
  const { fetchFn, calls } = stubFetch({
    repos: ["acme/lib", "acme/other"],
    manifests: {
      "acme/lib": JSON.stringify({ name: "@acme/lib", version: "1.0.0" }),
      "acme/other": JSON.stringify({ name: "@acme/other", version: "1.0.0" }),
    },
  });
  const deps = realDeps(await config(), fetchFn);

  await deps.plan("@acme/lib", "all");

  // @acme/other has no dependency relationship with @acme/lib, so it is not in
  // the affected set planCascade computed. Its manifest is fetched while
  // GitHubGraphSource builds the whole-installation graph, but it must never
  // be probed via getRepo/getProtection/hasFile — those calls prove the
  // provider was asked about a wider set than it should have been.
  expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/repos/acme/other"))).toBe(false);
  expect(calls.some((c) => c.url.includes("acme/other/branches"))).toBe(false);
  expect(calls.some((c) => c.url.includes("acme/other/contents/.github"))).toBe(false);
  expect(calls.some((c) => c.url.includes("acme/other/commits"))).toBe(false);
  expect(calls.some((c) => c.url.includes("acme/other/pulls"))).toBe(false);

  expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/repos/acme/lib"))).toBe(true);
});
