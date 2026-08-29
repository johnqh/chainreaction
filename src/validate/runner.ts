import { join } from "node:path";
import type { ChangesetEntry } from "../graph/types";
import type { ValidationRequest, ValidationOutcome } from "./types";
import { buildWorkspaceRoot, applyEntry, assertLinked, type Runner, type ValidationResult } from "../sandbox/workspace";

/**
 * Clones one repo at its default branch into `dest`, authenticated with the
 * scoped installation token.
 *
 * This is a dedicated method rather than another call through `run` on
 * purpose. `token` is a bearer credential that can push to every repo in the
 * cascade, and the classic way to leak one is embedding it in a git URL that
 * ends up as a command line — which `run`'s `cmd: string[]` shape invites
 * (a CI runner echoes every command it executes) and which anything that
 * records commands (a log, a test spy) would then capture verbatim. Routing
 * cloning through its own method means `runValidation` never builds that
 * string at all: it hands `token` to `clone` opaquely and never touches it
 * again. How the concrete implementation authenticates the checkout (a
 * credential helper, an extra HTTP header, a token-scoped tarball fetch) is
 * its concern, not this file's.
 */
export type Cloner = (repo: string, token: string, dest: string) => Promise<void>;

export type FileReader = (path: string) => Promise<string>;
export type FileWriter = (path: string, contents: string) => Promise<void>;

/**
 * Everything `runValidation` needs to do its work without ever touching a
 * real network or a real filesystem in a test: `root` is where the workspace
 * gets assembled, `clone` fetches one repo into it, `readFile`/`writeFile`
 * round-trip each repo's manifest, and `run` executes `bun install`/`build`/
 * `test`. `run` shares its shape with `Runner` from `src/sandbox/workspace.ts`
 * so the same fake can drive both.
 */
export interface RunnerIo {
  root: string;
  clone: Cloner;
  readFile: FileReader;
  writeFile: FileWriter;
  run: Runner;
}

/**
 * Matches the directory scheme `src/sandbox/workspace.ts` uses internally
 * (`memberDir`, not exported) so paths this file constructs line up with the
 * ones `buildWorkspaceRoot` and `assertLinked` compute for the same repo.
 */
const memberDirFor = (repo: string): string => `repos/${repo.split("/")[1]}`;

/**
 * Strips the scoped token out of arbitrary text before it can end up in a
 * `ValidationResult.output` or a thrown error. `run` executes the
 * customer's own build and test commands — their output is arbitrary and
 * not under this file's control, and a verbose failure (a stack trace that
 * dumps `process.env`, a tool that echoes the command it ran) could echo the
 * token even though `runValidation` itself never constructs a string
 * containing it. This is the last line of defence, not the only one.
 */
function redact(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("[redacted]") : text;
}

/**
 * What runs inside the customer's CI: clone every repo the claim authorised,
 * apply the changeset so the declared ranges are satisfiable, assemble one
 * Bun workspace, install, and — before anything builds or tests —
 * `assertLinked`.
 *
 * `assertLinked` is not a formality. Measured on a real five-repo chain: Bun
 * links a workspace member by name only when the declared range is satisfied
 * by the local version; when it is not, the install still succeeds and Bun
 * silently substitutes the **registry** copy instead. Skipping the check
 * would let a build-and-test pass here mean nothing — a confident false PASS
 * on published code instead of the changeset, which is worse than not
 * validating at all because a cascade would proceed on it.
 *
 * Build and test run in dependency order and stop at the first failure:
 * a package downstream of one that is already known broken has nothing
 * meaningful to report, and burning CI minutes on it buys nothing.
 */
export async function runValidation(
  request: ValidationRequest,
  token: string,
  io: RunnerIo,
): Promise<ValidationOutcome> {
  const { root } = io;

  for (const repo of request.repos) {
    try {
      await io.clone(repo, token, join(root, memberDirFor(repo)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`clone failed for ${repo}: ${redact(message, token)}`);
    }
  }

  for (const entry of request.changeset) {
    const manifestPath = manifestPathFor(root, entry);
    const manifest = JSON.parse(await io.readFile(manifestPath));
    const next = applyEntry(entry, manifest);
    await io.writeFile(manifestPath, JSON.stringify(next, null, 2));
  }

  buildWorkspaceRoot(request.changeset, root);

  const install = await io.run(["bun", "install"], root);
  if (install.code !== 0) {
    throw new Error(`workspace install failed: ${redact(install.output, token)}`);
  }

  // The false-PASS guard — before any build or test runs, not after.
  assertLinked(root, request.changeset);

  const results: ValidationResult[] = [];
  for (const entry of request.changeset) {
    const cwd = join(root, memberDirFor(entry.repo));
    const built = await io.run(["bun", "run", "build"], cwd);
    const tested = built.code === 0 ? await io.run(["bun", "test"], cwd) : built;
    const ok = tested.code === 0;
    results.push({ pkg: entry.pkg, ok, output: redact(tested.output, token) });
    if (!ok) break;
  }

  return {
    cascadeId: request.cascadeId,
    ok: results.every((r) => r.ok),
    results,
  };
}

function manifestPathFor(root: string, entry: ChangesetEntry): string {
  return join(root, memberDirFor(entry.repo), "package.json");
}
