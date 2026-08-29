import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { DEFAULT_WORKFLOW_PATH } from "../../src/prepare/probe";

/**
 * The job name in this template is NOT load-bearing: `ActionsValidator`
 * finds the workflow to dispatch by file path, and matches the run it
 * dispatched by cascade id embedded in the run's display title — never by
 * job name. What actually matters, and what this file asserts, is that the
 * template keeps triggering on `workflow_dispatch` with the `cascade_id`
 * input the dispatcher supplies, keeps requesting exactly the permissions it
 * needs (`id-token: write` to mint the OIDC token, `contents: read` and
 * nothing more), and never leaks the claimed token into a log or output.
 */

const TEMPLATE_PATH = join(import.meta.dir, "../../docs/chainreaction-validate.yml");
const raw = readFileSync(TEMPLATE_PATH, "utf8");
const doc = YAML.parse(raw) as {
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, { name?: string; steps?: Array<Record<string, unknown>> }>;
};

function theJob() {
  const jobs = doc.jobs ?? {};
  const keys = Object.keys(jobs);
  expect(keys).toHaveLength(1);
  const key = keys[0];
  if (key === undefined) throw new Error("unreachable: length checked above");
  const job = jobs[key];
  if (job === undefined) throw new Error("unreachable: key came from Object.keys(jobs)");
  return { key, job };
}

/**
 * Every double-quoted argument passed to `echo` in the raw template text.
 * Line-level "does this line contain both /echo/ and /$token/" heuristics
 * false-positive on lines like `[ -n "$token" ] || { echo "no token"; }`,
 * where the two just happen to share a line without the echo ever touching
 * the credential. Extracting the actual echoed string is precise instead.
 */
function echoedStrings(text: string): string[] {
  return [...text.matchAll(/\becho\s+"([^"]*)"/g)].map((m) => m[1]!);
}

/** Echoed strings that reference the claimed token or the OIDC token — a
 *  live, cascade-claimable credential for the run's remaining lifetime —
 *  other than the one line that's supposed to (the `::add-mask::` line). */
function leakyEchoes(text: string): string[] {
  return echoedStrings(text).filter(
    (s) => /\$\{?(token|oidc)\b/.test(s) && !s.startsWith("::add-mask::"),
  );
}

test("the template parses as YAML", () => {
  expect(doc.jobs).toBeDefined();
});

test("still triggers on workflow_dispatch with a required cascade_id string input, requests only " +
  "id-token: write plus contents: read, and never echoes the claim response — the properties " +
  "ActionsValidator and the claim step actually depend on, unlike the job name", () => {
  const dispatch = doc.on?.["workflow_dispatch"] as
    | { inputs?: Record<string, { required?: boolean; type?: string }> }
    | undefined;
  expect(dispatch?.inputs?.["cascade_id"]?.required).toBe(true);
  expect(dispatch?.inputs?.["cascade_id"]?.type).toBe("string");

  expect(doc.permissions).toEqual({ "id-token": "write", contents: "read" });

  expect(raw).not.toMatch(/GITHUB_OUTPUT/);
  expect(raw).not.toMatch(/::set-output::/);
  expect(leakyEchoes(raw)).toEqual([]);
});

test("DEFAULT_WORKFLOW_PATH still points at .github/workflows/<this file's name>", () => {
  // Not a claim about where docs/chainreaction-validate.yml lives — customers
  // copy it — but the filename the constant expects must match the filename
  // this template ships as, or Prepare's hasFile check looks for a file that
  // was never copied under that name.
  expect(DEFAULT_WORKFLOW_PATH).toBe(".github/workflows/chainreaction-validate.yml");
});

test("requests id-token and contents:read, nothing more", () => {
  expect(doc.permissions).toEqual({ "id-token": "write", contents: "read" });
});

test("is dispatched with a required cascade_id input", () => {
  const dispatch = doc.on?.["workflow_dispatch"] as
    | { inputs?: Record<string, { required?: boolean; type?: string }> }
    | undefined;
  expect(dispatch?.inputs?.["cascade_id"]?.required).toBe(true);
  expect(dispatch?.inputs?.["cascade_id"]?.type).toBe("string");
});

test("holds no secret: never references the secrets context", () => {
  expect(raw).not.toMatch(/secrets\./);
});

test("masks the claimed token as soon as it is read, before any later step", () => {
  expect(raw).toContain("::add-mask::$token");
});

test("the claim POST checks its own status — --fail-with-body, not a silent -o on a 4xx/5xx", () => {
  // `curl -o file` alone exits 0 even on a 403/500: the error body lands in
  // the file exactly like a real claim, `jq -r .token` on it yields "null",
  // and the run limps on to fail confusingly deep inside the validator
  // instead of failing here with the actual cause.
  expect(raw).toMatch(/curl\s[^\n]*--fail-with-body[^\n]*\/api\/ci\/claim/);
});

test("guards against masking a literal \"null\" when the claim carries no token", () => {
  // `jq -r .token` on a body with no `token` field yields the 4-character
  // string "null", and `::add-mask::null` would tell the runner to redact
  // every occurrence of that word for the rest of the log — stack traces
  // and JSON dumps included. `// empty` plus a non-empty check keeps a
  // missing token from ever reaching `::add-mask::`.
  expect(raw).toMatch(/jq\s+-r\s+'\.token\s*\/\/\s*empty'/);
  expect(raw).toMatch(/\[\s*-n\s*"\$token"\s*\]/);
});

test("pins setup-bun to a full commit SHA, not a mutable tag", () => {
  // This step runs before the claim, in a job that goes on to hold a
  // cascade-scoped token — a mutable tag (even `@v2`) is something the
  // action's own maintainer account could repoint to shim `bunx` itself.
  expect(raw).toMatch(/uses:\s*oven-sh\/setup-bun@[0-9a-f]{40}\s*#/);
  expect(raw).not.toMatch(/uses:\s*oven-sh\/setup-bun@v\d/);
});

test("never enables shell tracing anywhere — set -x, set -o xtrace, bash -x, or a -x shebang would " +
  "all echo the exchange commands, token included, live to the log", () => {
  expect(raw).not.toMatch(/\bset\s+-[a-z-]*x[a-z-]*\b/i); // set -x, set -ex, set -xeuo pipefail, ...
  expect(raw).not.toMatch(/\bset\s+-o\s+xtrace\b/i); // the long form of the same flag
  expect(raw).not.toMatch(/\bbash\s+-[a-z-]*x[a-z-]*\b/i); // an explicit `bash -x script.sh` invocation
  expect(raw).not.toMatch(/^#!.*-[a-z-]*x[a-z-]*\b/im); // a shebang requesting tracing
  expect(raw).not.toMatch(/shell:\s*["']?[^\n]*-[a-z-]*x[a-z-]*[^\n]*\{0\}/i); // a traced custom `shell:`
});

test("no run: block interpolates a workflow expression — an input must travel through env:, never be " +
  "spliced into shell text", () => {
  // `${{ }}` is substituted by the runner before bash ever sees the script,
  // so any occurrence inside a `run:` block turns whatever it expands to
  // into code executed in this job — which holds `id-token: write` and,
  // moments later, a cascade-scoped token spanning the whole cascade.
  // `cascade_id` (an attacker-controlled workflow_dispatch input) and
  // anything else the runner substitutes must reach the script only via a
  // step's `env:`, never a direct splice into `run:`.
  const jobs = doc.jobs ?? {};
  const runBlocks = Object.values(jobs).flatMap((job) =>
    (job.steps ?? []).map((s) => s["run"]).filter((r): r is string => typeof r === "string"),
  );
  expect(runBlocks.length).toBeGreaterThan(0); // sanity: this template does have run: steps
  for (const run of runBlocks) {
    expect(run).not.toContain("${{");
  }
});

test("never pipes the claim response through jq into a visible step output", () => {
  // The classic leak this brief warns against: `curl ... | jq -r .token` fed
  // straight into a `>> $GITHUB_OUTPUT` (or the old `::set-output::`) line
  // puts the token in the run's outputs and, for `::set-output::`, directly
  // in the log. This template must never do either — the token stays inside
  // the claim file on disk and is only ever read back into a local shell
  // variable within the same step that masks it.
  expect(raw).not.toMatch(/GITHUB_OUTPUT/);
  expect(raw).not.toMatch(/::set-output::/);
});

test("never echoes or cats the claim response or the OIDC token, other than the add-mask line", () => {
  // Any line that mentions a credential (the claimed token, or the OIDC
  // token traded for it — itself live and cascade-claimable) AND `echo`
  // must be the masking line itself — an `echo "$token"`, `echo "$oidc"`
  // (or similar) anywhere else would print it to the log in plain sight.
  expect(leakyEchoes(raw)).toEqual([]);
  expect(raw).not.toMatch(/\bcat\b[^\n]*chainreaction-claim\.json/);
});

test("the job has exactly the claim step and the validate step, in that order", () => {
  const { job } = theJob();
  const names = (job.steps ?? []).map((s) => s["name"]).filter((n): n is string => typeof n === "string");
  expect(names).toEqual(["Claim this cascade", "Assemble the workspace and validate"]);
});

test("stays short enough to read and audit in full", () => {
  const lines = raw.split("\n").length;
  expect(lines).toBeLessThan(100);
});
