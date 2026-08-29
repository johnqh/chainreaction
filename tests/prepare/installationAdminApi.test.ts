import { test, expect } from "bun:test";
import { InstallationRepoAdminApi } from "../../src/prepare/installationAdminApi";

const token = async () => "tok";

function stub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("getRepo maps the fields it needs and validates them", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({
    default_branch: "trunk", private: true, allow_auto_merge: true,
  })));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  expect(await api.getRepo("acme/lib")).toEqual({
    defaultBranch: "trunk", isPrivate: true, allowAutoMerge: true,
  });
});

test("getRepo rejects a response with no default_branch rather than yielding undefined", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ private: false })));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  await expect(api.getRepo("acme/lib")).rejects.toThrow(/default_branch/);
});

test("getRepo treats a missing allow_auto_merge as false, not undefined", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ default_branch: "main", private: false })));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  expect((await api.getRepo("acme/lib")).allowAutoMerge).toBe(false);
});

test("getProtection carries status, message and body — the 403 classification depends on them", async () => {
  const { fn } = stub(() => new Response(
    JSON.stringify({ message: "Upgrade to GitHub Pro or make this repository public." }),
    { status: 403 },
  ));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  const probe = await api.getProtection("acme/lib", "main");
  expect(probe.status).toBe(403);
  expect(probe.message).toMatch(/Upgrade to GitHub Pro/);
});

test("getProtection returns the body on 200 so requiresReviews can be derived", async () => {
  const { fn } = stub(() => new Response(
    JSON.stringify({ required_pull_request_reviews: { required_approving_review_count: 2 } }),
    { status: 200 },
  ));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  const probe = await api.getProtection("acme/lib", "main");
  expect(probe.status).toBe(200);
  expect(probe.body?.["required_pull_request_reviews"]).toBeDefined();
});

test("getProtection does not throw on 404 — an unprotected branch is normal", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ message: "Branch not protected" }), { status: 404 }));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  expect((await api.getProtection("acme/lib", "main")).status).toBe(404);
});

test("hasFile is true on 200, false on 404, and throws on anything else", async () => {
  const mk = (status: number) => new InstallationRepoAdminApi(token, 1, stub(() => new Response("{}", { status })).fn);
  expect(await mk(200).hasFile("acme/lib", "a.yml")).toBe(true);
  expect(await mk(404).hasFile("acme/lib", "a.yml")).toBe(false);
  // A 500 silently becoming "the file is absent" would block a ready repo for the wrong reason.
  await expect(mk(500).hasFile("acme/lib", "a.yml")).rejects.toThrow(/500/);
});

test("setProtection sends required status checks and no review requirement", async () => {
  const { fn, calls } = stub(() => new Response("{}", { status: 200 }));
  await new InstallationRepoAdminApi(token, 1, fn).setProtection("acme/lib", "main", ["ci"]);
  const body = JSON.parse(String(calls[0]!.init!.body));
  expect(calls[0]!.init!.method).toBe("PUT");
  expect(body.required_status_checks.contexts).toEqual(["ci"]);
  // An identity cannot approve its own PR, so requiring reviews would stall every cascade.
  expect(body.required_pull_request_reviews).toBeNull();
});

test("enableAutoMerge PATCHes the repo", async () => {
  const { fn, calls } = stub(() => new Response("{}", { status: 200 }));
  await new InstallationRepoAdminApi(token, 1, fn).enableAutoMerge("acme/lib");
  expect(calls[0]!.init!.method).toBe("PATCH");
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ allow_auto_merge: true });
});

test("mutating requests (PUT/PATCH) send an explicit JSON content-type header", async () => {
  const { fn, calls } = stub(() => new Response("{}", { status: 200 }));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  await api.setProtection("acme/lib", "main", ["ci"]);
  await api.enableAutoMerge("acme/lib");
  expect((calls[0]!.init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
  expect((calls[1]!.init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
});

test("a bodyless GET does not send a content-type header", async () => {
  const { fn, calls } = stub(() => new Response(
    JSON.stringify({ default_branch: "main", private: false }),
    { status: 200 },
  ));
  const api = new InstallationRepoAdminApi(token, 1, fn);
  await api.getRepo("acme/lib");
  expect((calls[0]!.init!.headers as Record<string, string>)["content-type"]).toBeUndefined();
});

test("no token reaches an error message from any throwing method", async () => {
  const secretToken = "super-secret-token";
  const mkApi = (status: number) =>
    new InstallationRepoAdminApi(
      async () => secretToken,
      1,
      stub(() => new Response(JSON.stringify({ message: "boom", token: secretToken }), { status })).fn,
    );

  // Every method in this class that can throw, exercised with a status that
  // makes it throw. Adding a sixth throwing method without extending this
  // list should be the obvious next step, not a silent gap.
  const attempts: Array<() => Promise<unknown>> = [
    () => mkApi(500).getRepo("acme/lib"),
    () => mkApi(500).hasFile("acme/lib", "a.yml"),
    () => mkApi(500).setProtection("acme/lib", "main", ["ci"]),
    () => mkApi(500).enableAutoMerge("acme/lib"),
  ];

  for (const attempt of attempts) {
    let msg = "";
    try {
      await attempt();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(secretToken);
  }
});
