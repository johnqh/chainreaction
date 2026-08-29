import { test, expect } from "bun:test";
import { InstallationPrApi, type PrApi } from "../../src/github/prApi";
import { GhClient, type Exec } from "../../src/github/client";

const token = async () => "tok";

function stub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// --- defaultBranchSha ---

test("defaultBranchSha resolves the tip sha of the given branch via the git refs endpoint", async () => {
  const { fn, calls } = stub(() => new Response(JSON.stringify({ object: { sha: "abc123" } })));
  const api = new InstallationPrApi(token, 1, fn);
  // Deliberately not "main": a hardcoded "main" fallback would still return
  // "abc123" here (this stub answers every URL the same way) but would
  // request the wrong ref, which the exact URL assertion below catches.
  expect(await api.defaultBranchSha("acme/lib", "trunk")).toBe("abc123");
  expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/lib/git/ref/heads/trunk");
});

test("defaultBranchSha rejects a response with no usable sha", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ object: {} })));
  const api = new InstallationPrApi(token, 1, fn);
  await expect(api.defaultBranchSha("acme/lib", "main")).rejects.toThrow(/sha/);
});

test("defaultBranchSha throws on a non-ok response instead of yielding an empty sha", async () => {
  const { fn } = stub(() => new Response("{}", { status: 500 }));
  const api = new InstallationPrApi(token, 1, fn);
  await expect(api.defaultBranchSha("acme/lib", "main")).rejects.toThrow(/500/);
});

// --- createBranch ---

test("createBranch POSTs a new ref pointing at fromSha", async () => {
  const { fn, calls } = stub(() => new Response(JSON.stringify({ ref: "refs/heads/cr/update" }), { status: 201 }));
  const api = new InstallationPrApi(token, 1, fn);
  await api.createBranch("acme/lib", "cr/update", "deadbeef");
  expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/lib/git/refs");
  expect(calls[0]!.init!.method).toBe("POST");
  const body = JSON.parse(String(calls[0]!.init!.body));
  expect(body).toEqual({ ref: "refs/heads/cr/update", sha: "deadbeef" });
});

test("createBranch surfaces a 422 (branch already exists) rather than swallowing it", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422 }));
  const api = new InstallationPrApi(token, 1, fn);
  await expect(api.createBranch("acme/lib", "cr/update", "deadbeef")).rejects.toThrow(/422/);
});

test("createBranch surfaces a 409 (conflicting update) rather than swallowing it", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ message: "conflict" }), { status: 409 }));
  const api = new InstallationPrApi(token, 1, fn);
  await expect(api.createBranch("acme/lib", "cr/update", "deadbeef")).rejects.toThrow(/409/);
});

// --- putFile: the trap ---

function contentsStub(opts: { getSha: string | null; getStatus?: number; putStatus?: number }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const method = init?.method ?? "GET";
    if (method === "GET") {
      if (opts.getStatus && opts.getStatus !== 200) {
        return new Response(JSON.stringify({ message: "not found" }), { status: opts.getStatus });
      }
      return new Response(JSON.stringify({ sha: opts.getSha }));
    }
    return new Response(JSON.stringify({ content: { sha: "newsha" } }), { status: opts.putStatus ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("putFile reads the current blob sha immediately before writing, and sends exactly that sha", async () => {
  const { fn, calls } = contentsStub({ getSha: "current-sha-123" });
  const api = new InstallationPrApi(token, 1, fn);
  await api.putFile("acme/lib", "cr/update", "package.json", '{"version":"1.0.1"}', "chore: bump");

  expect(calls.length).toBe(2);
  expect(calls[0]!.init?.method ?? "GET").toBe("GET");
  expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/lib/contents/package.json?ref=cr%2Fupdate");

  expect(calls[1]!.init!.method).toBe("PUT");
  const body = JSON.parse(String(calls[1]!.init!.body));
  expect(body.sha).toBe("current-sha-123");
  expect(body.branch).toBe("cr/update");
  expect(body.message).toBe("chore: bump");
  expect(Buffer.from(body.content, "base64").toString("utf8")).toBe('{"version":"1.0.1"}');
});

test("putFile throws when the sha read fails, instead of writing without one", async () => {
  const { fn, calls } = contentsStub({ getSha: null, getStatus: 404 });
  const api = new InstallationPrApi(token, 1, fn);
  await expect(
    api.putFile("acme/lib", "cr/update", "package.json", "{}", "chore: bump"),
  ).rejects.toThrow(/404/);
  // Must never fall through to the write — that would be exactly the
  // "opens a PR whose branch carries no manifest change" failure.
  expect(calls.length).toBe(1);
});

test("putFile throws when the read succeeds but returns no usable sha", async () => {
  const { fn } = contentsStub({ getSha: null });
  const api = new InstallationPrApi(token, 1, fn);
  await expect(
    api.putFile("acme/lib", "cr/update", "package.json", "{}", "chore: bump"),
  ).rejects.toThrow(/sha/);
});

test("putFile throws when the write itself is rejected — a failed write must never be swallowed", async () => {
  const { fn } = contentsStub({ getSha: "current-sha-123", putStatus: 409 });
  const api = new InstallationPrApi(token, 1, fn);
  await expect(
    api.putFile("acme/lib", "cr/update", "package.json", "{}", "chore: bump"),
  ).rejects.toThrow(/409/);
});

// --- openPr ---

test("openPr POSTs title/head/base/body and returns the PR number", async () => {
  const { fn, calls } = stub(() => new Response(JSON.stringify({ number: 42 }), { status: 201 }));
  const api = new InstallationPrApi(token, 1, fn);
  // base is deliberately not "main": if the implementation ever regressed to
  // a hardcoded "--base main"-style default, this would still equal "main"
  // by coincidence and the bug would slip through.
  const pr = await api.openPr("acme/lib", "cr/update", "trunk", "chore: bump", "body text");
  expect(pr).toBe(42);
  expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/lib/pulls");
  const body = JSON.parse(String(calls[0]!.init!.body));
  expect(body).toEqual({ title: "chore: bump", head: "cr/update", base: "trunk", body: "body text" });
});

test("openPr throws when GitHub rejects opening the PR", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }));
  const api = new InstallationPrApi(token, 1, fn);
  await expect(api.openPr("acme/lib", "cr/update", "main", "t", "b")).rejects.toThrow(/422/);
});

test("openPr rejects a response with no usable PR number", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({}), { status: 201 }));
  const api = new InstallationPrApi(token, 1, fn);
  await expect(api.openPr("acme/lib", "cr/update", "main", "t", "b")).rejects.toThrow(/number/);
});

// --- mergePr ---

test("mergePr PUTs a squash merge", async () => {
  const { fn, calls } = stub(() => new Response(JSON.stringify({ merged: true, sha: "x" })));
  const api = new InstallationPrApi(token, 1, fn);
  await api.mergePr("acme/lib", 7);
  expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/lib/pulls/7/merge");
  expect(calls[0]!.init!.method).toBe("PUT");
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ merge_method: "squash" });
});

test("mergePr throws when GitHub reports merged:false despite a 200", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ merged: false, message: "Pull Request is not mergeable" })));
  const api = new InstallationPrApi(token, 1, fn);
  await expect(api.mergePr("acme/lib", 7)).rejects.toThrow(/merged/);
});

test("mergePr throws on a non-ok response instead of assuming success", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ message: "Method Not Allowed" }), { status: 405 }));
  const api = new InstallationPrApi(token, 1, fn);
  await expect(api.mergePr("acme/lib", 7)).rejects.toThrow(/405/);
});

// --- prState ---

test("prState maps merged:true to MERGED regardless of the raw state string", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ state: "closed", merged: true })));
  const api = new InstallationPrApi(token, 1, fn);
  expect(await api.prState("acme/lib", 7)).toBe("MERGED");
});

test("prState maps an unmerged closed PR to CLOSED", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ state: "closed", merged: false })));
  const api = new InstallationPrApi(token, 1, fn);
  expect(await api.prState("acme/lib", 7)).toBe("CLOSED");
});

test("prState maps an open PR to OPEN", async () => {
  const { fn } = stub(() => new Response(JSON.stringify({ state: "open", merged: false })));
  const api = new InstallationPrApi(token, 1, fn);
  expect(await api.prState("acme/lib", 7)).toBe("OPEN");
});

test("prState throws on a non-ok response", async () => {
  const { fn } = stub(() => new Response("{}", { status: 500 }));
  const api = new InstallationPrApi(token, 1, fn);
  await expect(api.prState("acme/lib", 7)).rejects.toThrow(/500/);
});

test("prState throws when the response has no usable state, instead of yielding undefined", async () => {
  // A response missing `state` must never resolve to `undefined` — the
  // poller's ternary would otherwise treat that as neither MERGED nor
  // CLOSED and quietly report "ci-running" forever.
  const { fn } = stub(() => new Response(JSON.stringify({ merged: false })));
  const api = new InstallationPrApi(token, 1, fn);
  await expect(api.prState("acme/lib", 7)).rejects.toThrow(/state/);
});

// --- no token leaks ---

test("no token reaches an error message from any throwing InstallationPrApi method", async () => {
  const secretToken = "super-secret-installation-token";
  const failing = (status: number) =>
    (async () => new Response(JSON.stringify({ message: "boom", token: secretToken }), { status })) as unknown as typeof fetch;

  const attempts: Array<() => Promise<unknown>> = [
    () => new InstallationPrApi(async () => secretToken, 1, failing(500)).defaultBranchSha("acme/lib", "main"),
    () => new InstallationPrApi(async () => secretToken, 1, failing(422)).createBranch("acme/lib", "b", "s"),
    () => new InstallationPrApi(async () => secretToken, 1, failing(404)).putFile("acme/lib", "b", "p", "c", "m"),
    () => new InstallationPrApi(async () => secretToken, 1, failing(422)).openPr("acme/lib", "h", "b", "t", "body"),
    () => new InstallationPrApi(async () => secretToken, 1, failing(405)).mergePr("acme/lib", 7),
    () => new InstallationPrApi(async () => secretToken, 1, failing(500)).prState("acme/lib", 7),
  ];

  for (const attempt of attempts) {
    let msg = "";
    try {
      await attempt();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain(secretToken);
  }
});

// --- GhClient still satisfies PrApi ---

function recorder() {
  const calls: string[][] = [];
  const exec: Exec = async (args: string[]) => {
    calls.push(args);
    if (args.includes("create")) return "https://github.com/acme/lib/pull/9\n";
    if (args[0] === "api" && args[2] === "-X" && args[3] === "GET") return "";
    if (args[0] === "api" && !args.includes("-X")) return "existing-blob-sha\n";
    if (args[0] === "api" && args.includes("git/ref/heads/main")) return "tip-sha\n";
    return "";
  };
  return { calls, exec };
}

// Compile-time assertion: a GhClient must be structurally assignable to PrApi.
// (If this stops compiling, GhClient has drifted from the PrApi contract.)
const _ghClientIsPrApi: PrApi = new GhClient(async () => "");
void _ghClientIsPrApi;

test("GhClient.openPr passes the explicit base through to gh, instead of a hardcoded one", async () => {
  const { calls, exec } = recorder();
  const gh: PrApi = new GhClient(exec);
  const pr = await gh.openPr("acme/lib", "cr/update", "develop", "title", "body");
  expect(pr).toBe(9);
  const createCall = calls.find((c) => c.includes("create"))!;
  const baseIdx = createCall.indexOf("--base");
  expect(baseIdx).toBeGreaterThan(-1);
  expect(createCall[baseIdx + 1]).toBe("develop");
});

test("GhClient.mergePr issues a real (non-auto) squash merge", async () => {
  const { calls, exec } = recorder();
  const gh: PrApi = new GhClient(exec);
  await gh.mergePr("acme/lib", 9);
  const mergeCall = calls.find((c) => c[0] === "pr" && c[1] === "merge")!;
  expect(mergeCall).toContain("--squash");
  expect(mergeCall).not.toContain("--auto");
});

test("GhClient.defaultBranchSha reads the tip sha of the given branch via gh api", async () => {
  // Deliberately not "main": a hardcoded "main" fallback would build the
  // exact same args array as long as the caller happened to also ask for
  // main, which is precisely the shape of bug this test exists to catch.
  const exec: Exec = async (args) => {
    expect(args).toEqual(["api", "repos/acme/lib/git/ref/heads/trunk", "--jq", ".object.sha"]);
    return "tip-sha\n";
  };
  const gh: PrApi = new GhClient(exec);
  expect(await gh.defaultBranchSha("acme/lib", "trunk")).toBe("tip-sha");
});

test("GhClient.createBranch POSTs a new ref via gh api", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    return "";
  };
  const gh: PrApi = new GhClient(exec);
  await gh.createBranch("acme/lib", "cr/update", "deadbeef");
  expect(calls[0]).toEqual([
    "api", "repos/acme/lib/git/refs", "-X", "POST",
    "-f", "ref=refs/heads/cr/update",
    "-f", "sha=deadbeef",
  ]);
});

test("GhClient.createBranch surfaces a failure (branch exists) rather than swallowing it", async () => {
  const exec: Exec = async () => {
    throw new Error("gh api repos/acme/lib/git/refs failed: HTTP 422: Reference already exists");
  };
  const gh: PrApi = new GhClient(exec);
  await expect(gh.createBranch("acme/lib", "cr/update", "deadbeef")).rejects.toThrow(/422/);
});

test("GhClient.putFile reads the current blob sha immediately before writing, and sends it", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    if (args.includes("-X") && args[args.indexOf("-X") + 1] === "GET") return "current-sha-123\n";
    return "";
  };
  const gh: PrApi = new GhClient(exec);
  // branch is "cr/update", not "main" — pinned exactly below so a
  // regression that reads the sha from a hardcoded branch (e.g. "main")
  // instead of the actual target branch is caught, rather than merely
  // asserting "some -f flag was passed", which is true of both.
  await gh.putFile("acme/lib", "cr/update", "package.json", '{"v":1}', "chore: bump");

  expect(calls.length).toBe(2);
  const getCall = calls[0]!;
  expect(getCall).toEqual([
    "api", "repos/acme/lib/contents/package.json", "-X", "GET",
    "-f", "ref=cr/update", "--jq", ".sha",
  ]);

  const putCall = calls[1]!;
  expect(putCall).toContain("-X");
  expect(putCall[putCall.indexOf("-X") + 1]).toBe("PUT");
  const shaFlagIdx = putCall.findIndex((a) => a.startsWith("sha="));
  expect(shaFlagIdx).toBeGreaterThan(-1);
  expect(putCall[shaFlagIdx]).toBe("sha=current-sha-123");
  const contentFlagIdx = putCall.findIndex((a) => a.startsWith("content="));
  const encoded = putCall[contentFlagIdx]!.slice("content=".length);
  expect(Buffer.from(encoded, "base64").toString("utf8")).toBe('{"v":1}');
});

test("GhClient.putFile throws when the sha read fails, instead of writing without one", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    if (args.includes("-X") && args[args.indexOf("-X") + 1] === "GET") {
      throw new Error("gh api repos/acme/lib/contents/package.json failed: HTTP 404: Not Found");
    }
    return "";
  };
  const gh: PrApi = new GhClient(exec);
  await expect(
    gh.putFile("acme/lib", "cr/update", "package.json", "{}", "chore: bump"),
  ).rejects.toThrow(/404/);
  expect(calls.length).toBe(1); // must never fall through to the write
});

test("GhClient.putFile throws when the write itself fails, rather than swallowing it", async () => {
  const exec: Exec = async (args) => {
    if (args.includes("-X") && args[args.indexOf("-X") + 1] === "GET") return "current-sha-123\n";
    throw new Error("gh api repos/acme/lib/contents/package.json failed: HTTP 409: Conflict");
  };
  const gh: PrApi = new GhClient(exec);
  await expect(
    gh.putFile("acme/lib", "cr/update", "package.json", "{}", "chore: bump"),
  ).rejects.toThrow(/409/);
});

// GhClient never receives a token as a parameter at all — it delegates to
// whatever credentials the `gh` CLI itself holds, via the caller-supplied
// `exec`. There is no token variable in this class's own scope that could
// leak into a message it constructs, so the "no token in errors" guarantee
// is exercised on InstallationPrApi above, which is the class that actually
// carries one (via `TokenProvider`).

test("GhClient.prState throws when the gh response has no usable state, instead of returning undefined", async () => {
  // Same regression as InstallationPrApi above: pollOnce's ternary would
  // otherwise treat an undefined state as neither MERGED nor CLOSED and
  // silently report a broken poll as "ci-running" forever.
  const exec: Exec = async () => JSON.stringify({ url: "https://github.com/acme/lib/pull/7" });
  const gh: PrApi = new GhClient(exec);
  await expect(gh.prState("acme/lib", 7)).rejects.toThrow(/state/);
});
