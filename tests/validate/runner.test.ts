import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runValidation, type RunnerIo } from "../../src/validate/runner";
import type { ValidationRequest } from "../../src/validate/types";
import type { ChangesetEntry } from "../../src/graph/types";

// A bearer credential that can push to every repo in the cascade. Every
// assertion below that mentions "leak" is checking this literal string never
// shows up somewhere it shouldn't.
const TOKEN = "ghs_super-secret-scoped-token";

const CHANGESET: ChangesetEntry[] = [
  { pkg: "@acme/base", dir: "/base", repo: "acme/base",
    fromVersion: "1.0.0", toVersion: "1.0.1", depBumps: {}, level: 0 },
  { pkg: "@acme/app", dir: "/app", repo: "acme/app",
    fromVersion: "2.0.0", toVersion: "2.0.1",
    depBumps: { "@acme/base": "^1.0.1" }, level: 1 },
];

function makeRequest(overrides: Partial<ValidationRequest> = {}): ValidationRequest {
  return {
    cascadeId: "cascade-1",
    changeset: CHANGESET,
    repos: ["acme/base", "acme/app"],
    ...overrides,
  };
}

type RunFn = RunnerIo["run"];

/**
 * `buildWorkspaceRoot` and `assertLinked` (reused from src/sandbox/workspace.ts,
 * already reviewed) do real, unmocked fs work against whatever `root` they are
 * given — exactly like tests/sandbox/workspace.test.ts, which is the accepted
 * precedent for testing them. So `root` here is a real disposable OS temp
 * directory. Everything the *runner* is actually responsible for — cloning,
 * reading/writing manifests, and running commands — is fully injected through
 * RunnerIo and never touches the network or spawns a real process: the default
 * fake `clone` below writes fixture files with plain node:fs calls instead of
 * shelling out to git, and `run` is a plain function the test controls.
 */
function makeIo(overrides: {
  manifests?: Record<string, unknown>;
  run?: RunFn;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "cr-runner-"));
  const cloneCalls: { repo: string; token: string; dest: string }[] = [];
  const runCalls: { cmd: string[]; cwd: string }[] = [];
  const manifests: Record<string, unknown> = overrides.manifests ?? {
    "acme/base": { name: "@acme/base", version: "1.0.0" },
    "acme/app": {
      name: "@acme/app", version: "2.0.0",
      dependencies: { "@acme/base": "^1.0.0" },
    },
  };

  const clone: RunnerIo["clone"] = async (repo, token, dest) => {
    cloneCalls.push({ repo, token, dest });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "package.json"), JSON.stringify(manifests[repo]));
  };

  const readFile: RunnerIo["readFile"] = async (path) => readFileSync(path, "utf8");
  const writeFile: RunnerIo["writeFile"] = async (path, contents) => {
    writeFileSync(path, contents);
  };

  const defaultRun: RunFn = async (cmd, cwd) => {
    runCalls.push({ cmd, cwd });
    return { code: 0, output: "ok" };
  };
  const run: RunFn = overrides.run
    ? (async (cmd, cwd) => {
        runCalls.push({ cmd, cwd });
        return overrides.run!(cmd, cwd);
      })
    : defaultRun;

  const io: RunnerIo = { root, clone, readFile, writeFile, run };
  return { io, root, cloneCalls, runCalls };
}

/** Real symlinks satisfying assertLinked for every in-subgraph edge in `entries`. */
function linkEverything(root: string, entries: ChangesetEntry[]): void {
  const byPkg = new Map(entries.map((e) => [e.pkg, e]));
  for (const entry of entries) {
    for (const dep of Object.keys(entry.depBumps)) {
      const depEntry = byPkg.get(dep);
      if (!depEntry) continue;
      const [scope, name] = dep.split("/");
      const nmScope = join(root, "repos", entry.repo.split("/")[1]!, "node_modules", scope!);
      mkdirSync(nmScope, { recursive: true });
      symlinkSync(join(root, "repos", depEntry.repo.split("/")[1]!), join(nmScope, name!), "dir");
    }
  }
}

test("clones every repo in the request", async () => {
  const { io, cloneCalls } = makeIo();
  linkEverything(io.root, CHANGESET);

  await runValidation(makeRequest(), TOKEN, io);

  expect(cloneCalls.map((c) => c.repo)).toEqual(["acme/base", "acme/app"]);
  expect(cloneCalls.every((c) => c.token === TOKEN)).toBe(true);
});

test("applies each changeset entry to its manifest before installing", async () => {
  const { io } = makeIo();
  linkEverything(io.root, CHANGESET);

  await runValidation(makeRequest(), TOKEN, io);

  const base = JSON.parse(readFileSync(join(io.root, "repos", "base", "package.json"), "utf8"));
  const app = JSON.parse(readFileSync(join(io.root, "repos", "app", "package.json"), "utf8"));
  expect(base.version).toBe("1.0.1");
  expect(app.version).toBe("2.0.1");
  // The whole point of applying the entry: the dep range now matches what
  // Bun actually linked, instead of the pre-changeset range that would have
  // sent it to the registry.
  expect(app.dependencies["@acme/base"]).toBe("^1.0.1");
});

test("fails loudly when assertLinked reports an unlinked edge", async () => {
  // Deliberately no linkEverything(): nothing is symlinked, so bun would
  // (per the measured behaviour this whole task exists to guard against)
  // have silently resolved @acme/base from the registry instead of the
  // workspace. This must throw, not report a pass.
  const { io } = makeIo();

  await expect(runValidation(makeRequest(), TOKEN, io)).rejects.toThrow(
    /validation would be a lie/i,
  );
});

test("returns a per-package outcome in dependency order", async () => {
  const { io } = makeIo();
  linkEverything(io.root, CHANGESET);

  const outcome = await runValidation(makeRequest(), TOKEN, io);

  expect(outcome.cascadeId).toBe("cascade-1");
  expect(outcome.ok).toBe(true);
  expect(outcome.results.map((r) => [r.pkg, r.ok])).toEqual([
    ["@acme/base", true],
    ["@acme/app", true],
  ]);
});

test("a failing build stops the run and names the package", async () => {
  const { io, runCalls } = makeIo({
    run: async (cmd, cwd) => {
      if (cmd[0] === "bun" && cmd[1] === "run" && cwd.endsWith(join("repos", "base"))) {
        return { code: 1, output: "TypeError: something broke in base" };
      }
      return { code: 0, output: "ok" };
    },
  });
  linkEverything(io.root, CHANGESET);

  const outcome = await runValidation(makeRequest(), TOKEN, io);

  expect(outcome.ok).toBe(false);
  expect(outcome.results).toEqual([
    { pkg: "@acme/base", ok: false, output: "TypeError: something broke in base" },
  ]);
  // The downstream package that depends on the broken one was never built or
  // tested — burning CI minutes on it would be pointless and its result
  // would be meaningless anyway.
  const appCalls = runCalls.filter((c) => c.cwd.endsWith(join("repos", "app")));
  expect(appCalls).toEqual([]);
});

test("the scoped token never appears in an outcome or an error", async () => {
  // Case 1: a build failure surfaces in the outcome — the token must not be
  // anywhere inside it, however the underlying tool's output is worded.
  {
    const { io, runCalls } = makeIo({
      run: async (cmd, cwd) => {
        if (cmd[0] === "bun" && cmd[1] === "run") {
          return { code: 1, output: `build failed while installing with ${TOKEN} in env` };
        }
        return { code: 0, output: "ok" };
      },
    });
    linkEverything(io.root, CHANGESET);

    const outcome = await runValidation(makeRequest(), TOKEN, io);

    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    // The runner itself must never hand the token to the generic command
    // runner — cloning is a separate, dedicated io method precisely so a
    // git URL or command line embedding the token is never constructed,
    // logged, or echoed by whatever executes `run`.
    expect(runCalls.some((c) => c.cmd.some((part) => part.includes(TOKEN)))).toBe(false);
  }

  // Case 2: the install step itself fails and runValidation throws — the
  // thrown error must not embed the token either.
  {
    const { io } = makeIo({
      run: async (cmd) => {
        if (cmd[0] === "bun" && cmd[1] === "install") {
          return { code: 1, output: "lockfile conflict" };
        }
        return { code: 0, output: "ok" };
      },
    });
    linkEverything(io.root, CHANGESET);

    let message = "";
    try {
      await runValidation(makeRequest(), TOKEN, io);
      throw new Error("expected runValidation to reject");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(TOKEN);
  }
});
