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

  expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/repos/acme/lib"))).toBe(true);
});
