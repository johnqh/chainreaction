import type { ChangesetEntry } from "../graph/types";
import type { GhClient } from "./client";
import type { PrApi } from "./prApi";

function prBody(entry: ChangesetEntry): string {
  const causes = Object.entries(entry.depBumps)
    .map(([dep, range]) => `- \`${dep}\` -> \`${range}\``)
    .join("\n");
  return [
    `Automated by ChainReaction.`,
    ``,
    `**Version:** ${entry.fromVersion} -> ${entry.toVersion}`,
    `**Cascade level:** ${entry.level}`,
    causes ? `\n**Upstream bumps:**\n${causes}` : `\nThis is the root of the cascade.`,
    ``,
    `Validated against the full affected subgraph in a Bun workspace before this PR was opened.`,
  ].join("\n");
}

export async function openChangesetPrs(
  entries: ChangesetEntry[],
  gh: PrApi,
  branch: string,
  base = "main",
): Promise<Map<string, number>> {
  const prs = new Map<string, number>();
  for (const entry of entries) {
    const title = `chore: ${entry.pkg}@${entry.toVersion}`;
    prs.set(entry.repo, await gh.openPr(entry.repo, branch, base, title, prBody(entry)));
  }
  return prs;
}

export async function armAll(
  prs: Map<string, number>,
  entries: ChangesetEntry[],
  gh: GhClient,
): Promise<void> {
  for (const entry of entries) {
    const pr = prs.get(entry.repo);
    if (pr === undefined) {
      throw new Error(`no PR found for ${entry.repo}, cannot arm cascade`);
    }
    await gh.armAutoMerge(entry.repo, pr);
  }
}
