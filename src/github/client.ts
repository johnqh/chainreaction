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

export class GhClient {
  constructor(private exec: Exec) {}

  async openPr(repo: string, branch: string, title: string, body: string): Promise<number> {
    const out = await this.exec([
      "pr", "create", "-R", repo, "--head", branch, "--base", "main",
      "--title", title, "--body", body,
    ]);
    const m = /\/pull\/(\d+)/.exec(out);
    if (!m) throw new Error(`could not parse PR number from: ${out}`);
    return Number(m[1]);
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
