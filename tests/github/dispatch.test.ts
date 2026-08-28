import { test, expect } from "bun:test";
import { dependentsOf } from "../../src/github/dispatch";
import type { ChangesetEntry } from "../../src/graph/types";

const entries: ChangesetEntry[] = [
  { pkg: "@sudobility/design", dir: "/d", repo: "johnqh/design_system",
    fromVersion: "1.1.49", toVersion: "1.1.50", depBumps: {}, level: 0 },
  { pkg: "@sudobility/components", dir: "/c", repo: "johnqh/mail_box_components",
    fromVersion: "5.3.13", toVersion: "5.3.14",
    depBumps: { "@sudobility/design": "^1.1.50" }, level: 1 },
  { pkg: "@sudobility/di_web", dir: "/w", repo: "johnqh/di_web",
    fromVersion: "0.1.224", toVersion: "0.1.225",
    depBumps: { "@sudobility/components": "^5.3.14" }, level: 2 },
];

test("dependentsOf returns only direct dependents", () => {
  expect(dependentsOf(entries, "@sudobility/design").map((e) => e.repo))
    .toEqual(["johnqh/mail_box_components"]);
});

test("dependentsOf returns empty for a leaf", () => {
  expect(dependentsOf(entries, "@sudobility/di_web")).toEqual([]);
});
