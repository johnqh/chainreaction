import { test, expect } from "bun:test";
import { GhClient } from "../../src/github/client";
import { openChangesetPrs, armAll } from "../../src/github/orchestrator";
import type { ChangesetEntry } from "../../src/graph/types";

const entries: ChangesetEntry[] = [
  { pkg: "@sudobility/design", dir: "/design_system", repo: "johnqh/design_system",
    fromVersion: "1.1.49", toVersion: "1.1.50", depBumps: {}, level: 0 },
  { pkg: "@sudobility/components", dir: "/mail_box_components", repo: "johnqh/mail_box_components",
    fromVersion: "5.3.13", toVersion: "5.3.14",
    depBumps: { "@sudobility/design": "^1.1.50" }, level: 1 },
];

function recorder() {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    if (args.includes("create")) return "https://github.com/johnqh/x/pull/42\n";
    return "";
  };
  return { calls, exec };
}

test("openChangesetPrs opens one PR per entry and returns the PR numbers", async () => {
  const { calls, exec } = recorder();
  const prs = await openChangesetPrs(entries, new GhClient(exec), "cr/design-1.1.50");
  expect(prs.get("johnqh/design_system")).toBe(42);
  expect(prs.get("johnqh/mail_box_components")).toBe(42);
  expect(calls.filter((c) => c.includes("create")).length).toBe(2);
});

test("PR body names the version bump and the upstream cause", async () => {
  const { calls, exec } = recorder();
  await openChangesetPrs(entries, new GhClient(exec), "cr/design-1.1.50");
  const body = calls.find((c) => c.includes("create") && c.join(" ").includes("mail_box_components"))!
    .join(" ");
  expect(body).toContain("5.3.13 -> 5.3.14");
  expect(body).toContain("@sudobility/design");

  // Verify root entry (empty depBumps) renders cascade root message
  const rootBody = calls.find((c) => c.includes("create") && c.join(" ").includes("design_system"))!
    .join(" ");
  expect(rootBody).toContain("This is the root of the cascade.");
});

test("armAll approves before arming auto-merge, for every PR", async () => {
  const { calls, exec } = recorder();
  const prs = new Map([["johnqh/design_system", 7], ["johnqh/mail_box_components", 8]]);
  await armAll(prs, entries, new GhClient(exec));

  const verbs = calls.filter((c) => c[0] === "pr").map((c) => `${c[1]}:${c[2] ?? ""}`);
  expect(verbs).toEqual(["review:--approve", "merge:--auto", "review:--approve", "merge:--auto"]);
});

test("prState parses the gh JSON response", async () => {
  const gh = new GhClient(async () => JSON.stringify({ state: "OPEN" }));
  expect(await gh.prState("johnqh/design_system", 7)).toBe("OPEN");
});

test("openPr throws when gh output contains no PR pattern", async () => {
  const gh = new GhClient(async () => "something went wrong\n");
  expect(async () => {
    await gh.openPr("johnqh/design_system", "test-branch", "title", "body");
  }).toThrow();
});

test("armAll throws when prs map is missing an entry's repo", async () => {
  const { exec } = recorder();
  const prs = new Map([["johnqh/design_system", 7]]);
  const gh = new GhClient(exec);
  expect(async () => {
    await armAll(prs, entries, gh);
  }).toThrow(/no PR found for johnqh\/mail_box_components/);
});
