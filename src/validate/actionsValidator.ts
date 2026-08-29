import type { ChangesetEntry } from "../graph/types";
import type { ValidationResult } from "../sandbox/workspace";

/** Resolves a fresh (or cached-but-valid) installation token. Matches TokenStore.get. */
export type TokenProvider = (installationId: number) => Promise<string>;

/** A validator runs the full changeset through a build+test workflow and
 *  reports one result per package. `ActionsValidator` is the customer-CI
 *  implementation; a local, Bun-workspace implementation is the other. */
export interface Validator {
  validate(changeset: ChangesetEntry[]): Promise<ValidationResult[]>;
}

export interface ActionsValidatorConfig {
  installationId: number;
  /** "owner/repo" of one repo in the installation that carries the workflow. */
  repo: string;
  /** The workflow's file name (e.g. "chainreaction-validate.yml") or numeric id. */
  workflowFile: string;
  /** Branch to dispatch against — the workflow's own default branch. */
  ref: string;
  /** Milliseconds between polls for the dispatched run. */
  pollIntervalMs?: number;
  /** Total time budget before giving up on the run ever appearing/completing. */
  timeoutMs?: number;
}

const API_ROOT = "https://api.github.com";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

interface WorkflowRun {
  id: number;
  name: string | null;
  display_title: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  event: string;
}

interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
}

/**
 * Dispatches `chainreaction-validate.yml` in one repo of the installation and
 * waits for its verdict.
 *
 * `workflow_dispatch` returns 204 with no run id — there is no direct handle
 * on the run it creates. This class instead records the dispatch time,
 * polls the runs list, and matches a candidate run on BOTH:
 *
 *   1. created strictly after the recorded dispatch time, and
 *   2. a display_title/name carrying this cascade's id.
 *
 * Neither check alone is safe. Timestamp-only would report the conclusion of
 * any unrelated run someone else triggers right after this one dispatches;
 * id-only would report a stale run's conclusion if a previous run happened
 * to reuse (or already carry) the same cascade id.
 */
export class ActionsValidator implements Validator {
  constructor(
    private getToken: TokenProvider,
    private config: ActionsValidatorConfig,
    private fetchFn: typeof fetch = fetch,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private genCascadeId: () => string = () => crypto.randomUUID(),
  ) {}

  async validate(changeset: ChangesetEntry[]): Promise<ValidationResult[]> {
    const cascadeId = this.genCascadeId();
    const dispatchedAtMs = this.now();

    await this.dispatch(cascadeId);
    const run = await this.awaitRun(cascadeId, dispatchedAtMs);

    const ok = run.conclusion === "success";
    const output = ok
      ? `validation passed: ${run.html_url}`
      : `validation failed (conclusion: ${run.conclusion ?? "unknown"}): ${run.html_url}`;
    return changeset.map((entry) => ({ pkg: entry.pkg, ok, output }));
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    const token = await this.getToken(this.config.installationId);
    return this.fetchFn(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  }

  private async dispatch(cascadeId: string): Promise<void> {
    const res = await this.request(
      `${API_ROOT}/repos/${this.config.repo}/actions/workflows/${this.config.workflowFile}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({ ref: this.config.ref, inputs: { cascade_id: cascadeId } }),
      },
    );
    if (!res.ok) {
      // Never include the response body: it can carry a token in the case
      // of a truly broken server, and never needs to for a normal rejection.
      throw new Error(
        `actions validator: dispatch for cascade ${cascadeId} was rejected: ${res.status}`,
      );
    }
  }

  private async awaitRun(cascadeId: string, dispatchedAtMs: number): Promise<WorkflowRun> {
    const pollIntervalMs = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = dispatchedAtMs + timeoutMs;

    let lastSeen: WorkflowRun | undefined;
    while (this.now() < deadline) {
      const found = await this.findRun(cascadeId, dispatchedAtMs);
      if (found) lastSeen = found;
      if (lastSeen && lastSeen.status === "completed") return lastSeen;
      await this.sleep(pollIntervalMs);
    }

    throw new Error(
      lastSeen
        ? `actions validator: timed out waiting for cascade ${cascadeId}'s run (${lastSeen.html_url}) to complete`
        : `actions validator: timed out waiting for a run matching cascade ${cascadeId} to appear`,
    );
  }

  private async findRun(cascadeId: string, dispatchedAtMs: number): Promise<WorkflowRun | undefined> {
    // GitHub's `created` filter accepts `>=ISO8601`. Applied both server-side
    // (as a query param) and again client-side below, so a server that
    // ignores or mis-parses the filter cannot smuggle a stale run past us.
    const createdFilter = encodeURIComponent(`>=${new Date(dispatchedAtMs).toISOString()}`);
    const res = await this.request(
      `${API_ROOT}/repos/${this.config.repo}/actions/runs?event=workflow_dispatch&created=${createdFilter}`,
    );
    if (!res.ok) {
      throw new Error(`actions validator: listing runs for cascade ${cascadeId} failed: ${res.status}`);
    }
    const body = (await res.json()) as Partial<WorkflowRunsResponse>;
    if (!Array.isArray(body.workflow_runs)) {
      throw new Error(
        `actions validator: run list response for cascade ${cascadeId} has no workflow_runs array`,
      );
    }
    return body.workflow_runs.find(
      (run) =>
        new Date(run.created_at).getTime() >= dispatchedAtMs &&
        (run.display_title.includes(cascadeId) || (run.name ?? "").includes(cascadeId)),
    );
  }
}
