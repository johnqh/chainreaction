import type { PrApi } from "./prApi";

export type Exec = (args: string[]) => Promise<string>;

export const realExec: Exec = async (args) => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${err}`);
  }
  return out;
};

/**
 * Opens, approves and merges pull requests by shelling out to the local
 * `gh` CLI — i.e. as whatever identity is already logged into `gh` on this
 * machine. Implements `PrApi` so it is interchangeable with
 * `InstallationPrApi` (which does the same thing as a GitHub App
 * installation) everywhere a caller only needs the shared surface.
 */
export class GhClient implements PrApi {
  constructor(private exec: Exec) {}

  async defaultBranchSha(repo: string, branch: string): Promise<string> {
    const out = await this.exec(["api", `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.sha"]);
    const sha = out.trim();
    if (!sha) throw new Error(`defaultBranchSha ${repo}@${branch}: gh returned no sha`);
    return sha;
  }

  async createBranch(repo: string, branch: string, fromSha: string): Promise<void> {
    // A branch that already exists (or a stale fromSha) makes `gh api`
    // exit non-zero, and realExec turns that into a thrown Error — this
    // method does not catch it, so it is surfaced, never swallowed.
    await this.exec([
      "api", `repos/${repo}/git/refs`, "-X", "POST",
      "-f", `ref=refs/heads/${branch}`,
      "-f", `sha=${fromSha}`,
    ]);
  }

  /**
   * See `InstallationPrApi.putFile` for why the current blob sha must be
   * read immediately before every write: skip it, or tolerate the read
   * failing, and the write either gets rejected or — worse — silently
   * no-ops, leaving the branch with no manifest change at all.
   */
  async putFile(repo: string, branch: string, path: string, content: string, message: string): Promise<void> {
    const shaOut = await this.exec([
      "api", `repos/${repo}/contents/${path}`, "-X", "GET",
      "-f", `ref=${branch}`, "--jq", ".sha",
    ]);
    const sha = shaOut.trim();
    if (!sha) {
      throw new Error(`putFile ${repo}:${path}: could not read current blob sha on ${branch}`);
    }
    // A failed write throws via realExec, exactly like a failed read above —
    // never swallowed.
    await this.exec([
      "api", `repos/${repo}/contents/${path}`, "-X", "PUT",
      "-f", `message=${message}`,
      "-f", `content=${Buffer.from(content, "utf8").toString("base64")}`,
      "-f", `branch=${branch}`,
      "-f", `sha=${sha}`,
    ]);
  }

  async openPr(repo: string, head: string, base: string, title: string, body: string): Promise<number> {
    const out = await this.exec([
      "pr", "create", "-R", repo, "--head", head, "--base", base,
      "--title", title, "--body", body,
    ]);
    const m = /\/pull\/(\d+)/.exec(out);
    if (!m) throw new Error(`could not parse PR number from: ${out}`);
    return Number(m[1]);
  }

  /** Merges immediately — distinct from `armAutoMerge`, which only arms GitHub's auto-merge. */
  async mergePr(repo: string, pr: number): Promise<void> {
    await this.exec(["pr", "merge", "--squash", "-R", repo, String(pr)]);
  }

  async approve(repo: string, pr: number): Promise<void> {
    await this.exec(["pr", "review", "--approve", "-R", repo, String(pr)]);
  }

  async armAutoMerge(repo: string, pr: number): Promise<void> {
    await this.exec(["pr", "merge", "--auto", "--squash", "-R", repo, String(pr)]);
  }

  async prState(repo: string, pr: number): Promise<string> {
    const out = await this.exec([
      "pr", "view", String(pr), "-R", repo, "--json", "state",
    ]);
    return JSON.parse(out).state;
  }
}
