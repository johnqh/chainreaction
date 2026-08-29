import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { DEFAULT_REQUIRED_CHECK, DEFAULT_WORKFLOW_PATH } from "../../src/prepare/probe";

/**
 * `DEFAULT_REQUIRED_CHECK` is set as a *required* status check on the
 * customer's default branch by Prepare. If this template's job name ever
 * drifts from that constant, the check GitHub reports never matches the one
 * branch protection is waiting on, and every PR to that repo — the
 * customer's as much as ChainReaction's — becomes permanently unmergeable.
 * A comment saying "keep these in sync" is not a mechanism; parsing the
 * template and asserting against the constant is the only thing that
 * actually holds them together.
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

test("the template parses as YAML", () => {
  expect(doc.jobs).toBeDefined();
});

test("the job's id equals DEFAULT_REQUIRED_CHECK", () => {
  const { key } = theJob();
  expect(key).toBe(DEFAULT_REQUIRED_CHECK);
});

test("the job's display name equals DEFAULT_REQUIRED_CHECK", () => {
  // The name customers see as the check on their PRs is the job's `name:`
  // field when present (falling back to the job id otherwise) — GitHub does
  // not prefix it with the workflow's own top-level `name:`. Asserting this
  // explicitly, rather than trusting the job id alone, is what would catch
  // someone adding a `name:` override later that disagrees with the id.
  const { key, job } = theJob();
  expect(job.name ?? key).toBe(DEFAULT_REQUIRED_CHECK);
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

test("never runs with -x (would echo the exchange commands, token included, live to the log)", () => {
  expect(raw).not.toMatch(/set\s+[a-z-]*x[a-z-]*\b/);
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

test("never echoes or cats the claim response, other than the add-mask line", () => {
  // Any line that mentions the token AND `echo` must be the masking line
  // itself — an `echo "$token"` (or similar) anywhere else would print the
  // token to the log in plain sight.
  const echoLinesWithToken = raw
    .split("\n")
    .filter((line) => /\becho\b/.test(line) && /\$\{?token\b/.test(line));
  for (const line of echoLinesWithToken) {
    expect(line).toContain("::add-mask::");
  }
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
