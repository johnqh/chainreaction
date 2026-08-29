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
  write("design_system", { name: "@acme/design", version: "1.1.49" });
  write("mail_box_components", {
    name: "@acme/components", version: "5.3.13",
    dependencies: { "@acme/design": "^1.1.49", react: "^18.0.0" },
  });
  write("di_web", {
    name: "@acme/di_web", version: "0.1.224",
    dependencies: { "@acme/components": "^5.3.13" },
  });
  write("acme", {
    name: "acme-landing", version: "1.0.96",
    dependencies: { "@acme/di_web": "^0.1.224", "@acme/design": "^1.1.49" },
  });
  write("unrelated", { name: "@acme/music_types", version: "1.0.0" });
  return root;
}

test("scanRepos maps package names to repo nodes and @acme deps only", () => {
  const g = scanRepos(fixture(), "@acme/", "acme");
  expect(g.size).toBe(5);
  const components = g.get("@acme/components")!;
  expect(components.dir!.endsWith("mail_box_components")).toBe(true);
  expect(components.repo).toBe("acme/mail_box_components");
  expect(components.version).toBe("5.3.13");
  expect(components.deps).toEqual(["@acme/design"]);
});

test("scanRepos resolves correctly under a different scope and org", () => {
  const root = mkdtempSync(join(tmpdir(), "cr-widgets-"));
  const write = (dir: string, pkg: object) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkg));
  };
  write("core", { name: "@widgets/core", version: "2.0.0" });
  write("ui", {
    name: "@widgets/ui", version: "3.1.0",
    // One in-scope dep (must be kept) and one out-of-scope dep (must be
    // dropped) — proves filtering, not just that something passed through.
    dependencies: { "@widgets/core": "^2.0.0", "@acme/design": "^1.1.49", react: "^18.0.0" },
  });

  const g = scanRepos(root, "@widgets/", "contoso");
  expect(g.size).toBe(2);
  const ui = g.get("@widgets/ui")!;
  expect(ui.repo).toBe("contoso/ui");
  expect(ui.deps).toEqual(["@widgets/core"]);
});

test("affectedSubgraph finds all transitive dependents, including the root", () => {
  const g = scanRepos(fixture(), "@acme/", "acme");
  const affected = affectedSubgraph(g, "@acme/design");
  expect([...affected].sort()).toEqual([
    "@acme/components",
    "@acme/design",
    "@acme/di_web",
    "acme-landing",
  ]);
});

test("topoLevels orders dependencies before dependents", () => {
  const g = scanRepos(fixture(), "@acme/", "acme");
  const levels = topoLevels(g, affectedSubgraph(g, "@acme/design"));
  expect(levels).toEqual([
    ["@acme/design"],
    ["@acme/components"],
    ["@acme/di_web"],
    ["acme-landing"],
  ]);
});

test("topoLevels throws on a dependency cycle", () => {
  const g = new Map([
    ["a", { pkg: "a", dir: "/a", repo: "acme/a", version: "1.0.0", deps: ["b"] }],
    ["b", { pkg: "b", dir: "/b", repo: "acme/b", version: "1.0.0", deps: ["a"] }],
  ]);
  expect(() => topoLevels(g, new Set(["a", "b"]))).toThrow(/cycle/i);
});

// --- peerDependencies / devDependencies edge-set pinning (Important E) --------
//
// `affectedSubgraph` answers "who must republish because this package
// changed" and must follow `deps` (which scanRepos already folds
// peerDependencies into) but never `devDeps` — a devDependency bump never
// forces a dependent to republish. Nothing before this fixture exercised
// either a `peerDependencies` or a `devDependencies` block, so none of these
// three regressions would have failed a single test: `affectedSubgraph` also
// following `devDeps`, `scanRepos` dropping `peerDependencies`, or
// `GitHubGraphSource` dropping `peerDependencies` (see githubSource.test.ts
// for that last one).
function peerAndDevFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cr-peerdev-"));
  const write = (dir: string, pkg: object) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkg));
  };
  write("design_system", { name: "@acme/design", version: "1.0.0" });
  // Its ONLY edge to @acme/design is a peerDependency — no `dependencies` entry.
  write("peer_consumer", {
    name: "@acme/peer-consumer", version: "1.0.0",
    peerDependencies: { "@acme/design": "^1.0.0" },
  });
  // Its ONLY edge to @acme/design is a devDependency — no `dependencies` or
  // `peerDependencies` entry.
  write("dev_consumer", {
    name: "@acme/dev-consumer", version: "1.0.0",
    devDependencies: { "@acme/design": "^1.0.0" },
  });
  return root;
}

test("scanRepos folds peerDependencies into deps, and keeps devDependencies out of deps", () => {
  const g = scanRepos(peerAndDevFixture(), "@acme/", "acme");
  // Catches "scanRepos dropping peerDependencies": without the merge, this
  // package's deps would be [] instead of naming its one real edge.
  expect(g.get("@acme/peer-consumer")!.deps).toEqual(["@acme/design"]);
  // A devDependency must never leak into `deps` — that would make a
  // devDependency-only edge look like a real publish dependency everywhere
  // `deps` is consulted (affectedSubgraph, topoLevels, classifyEdges).
  expect(g.get("@acme/dev-consumer")!.deps).toEqual([]);
  expect(g.get("@acme/dev-consumer")!.devDeps).toEqual(["@acme/design"]);
});

test("affectedSubgraph follows a peerDependency edge but not a devDependency edge", () => {
  const g = scanRepos(peerAndDevFixture(), "@acme/", "acme");
  const affected = affectedSubgraph(g, "@acme/design");
  // Catches "scanRepos dropping peerDependencies" (peer-consumer would drop
  // out) and "affectedSubgraph also following devDeps" (dev-consumer would
  // wrongly appear).
  expect(affected.has("@acme/peer-consumer")).toBe(true);
  expect(affected.has("@acme/dev-consumer")).toBe(false);
  expect([...affected].sort()).toEqual(["@acme/design", "@acme/peer-consumer"]);
});
