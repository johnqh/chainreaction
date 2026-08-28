import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanRepos, affectedSubgraph, topoLevels } from "../../src/graph/resolver";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cr-"));
  const write = (dir: string, pkg: object) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkg));
  };
  write("design_system", { name: "@sudobility/design", version: "1.1.49" });
  write("mail_box_components", {
    name: "@sudobility/components", version: "5.3.13",
    dependencies: { "@sudobility/design": "^1.1.49", react: "^18.0.0" },
  });
  write("di_web", {
    name: "@sudobility/di_web", version: "0.1.224",
    dependencies: { "@sudobility/components": "^5.3.13" },
  });
  write("sudobility", {
    name: "sudobility-landing", version: "1.0.96",
    dependencies: { "@sudobility/di_web": "^0.1.224", "@sudobility/design": "^1.1.49" },
  });
  write("unrelated", { name: "@sudobility/music_types", version: "1.0.0" });
  return root;
}

test("scanRepos maps package names to repo nodes and @sudobility deps only", () => {
  const g = scanRepos(fixture());
  expect(g.size).toBe(5);
  const components = g.get("@sudobility/components")!;
  expect(components.dir!.endsWith("mail_box_components")).toBe(true);
  expect(components.repo).toBe("johnqh/mail_box_components");
  expect(components.version).toBe("5.3.13");
  expect(components.deps).toEqual(["@sudobility/design"]);
});

test("affectedSubgraph finds all transitive dependents, including the root", () => {
  const g = scanRepos(fixture());
  const affected = affectedSubgraph(g, "@sudobility/design");
  expect([...affected].sort()).toEqual([
    "@sudobility/components",
    "@sudobility/design",
    "@sudobility/di_web",
    "sudobility-landing",
  ]);
});

test("topoLevels orders dependencies before dependents", () => {
  const g = scanRepos(fixture());
  const levels = topoLevels(g, affectedSubgraph(g, "@sudobility/design"));
  expect(levels).toEqual([
    ["@sudobility/design"],
    ["@sudobility/components"],
    ["@sudobility/di_web"],
    ["sudobility-landing"],
  ]);
});

test("topoLevels throws on a dependency cycle", () => {
  const g = new Map([
    ["a", { pkg: "a", dir: "/a", repo: "johnqh/a", version: "1.0.0", deps: ["b"] }],
    ["b", { pkg: "b", dir: "/b", repo: "johnqh/b", version: "1.0.0", deps: ["a"] }],
  ]);
  expect(() => topoLevels(g, new Set(["a", "b"]))).toThrow(/cycle/i);
});
