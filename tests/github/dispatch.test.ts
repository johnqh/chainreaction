import { test, expect } from "bun:test";
import { dependentsOf } from "../../src/github/dispatch";
import type { ChangesetEntry } from "../../src/graph/types";

const entries: ChangesetEntry[] = [
  { pkg: "@acme/design", dir: "/d", repo: "acme/design_system",
    fromVersion: "1.1.49", toVersion: "1.1.50", depBumps: {}, level: 0 },
  { pkg: "@acme/components", dir: "/c", repo: "acme/mail_box_components",
    fromVersion: "5.3.13", toVersion: "5.3.14",
    depBumps: { "@acme/design": "^1.1.50" }, level: 1 },
  { pkg: "@acme/di_web", dir: "/w", repo: "acme/di_web",
    fromVersion: "0.1.224", toVersion: "0.1.225",
    depBumps: { "@acme/components": "^5.3.14" }, level: 2 },
];

test("dependentsOf returns only direct dependents", () => {
  expect(dependentsOf(entries, "@acme/design").map((e) => e.repo))
    .toEqual(["acme/mail_box_components"]);
});

test("dependentsOf returns empty for a leaf", () => {
  expect(dependentsOf(entries, "@acme/di_web")).toEqual([]);
});
