import { test, expect } from "bun:test";
import { ActionsValidator } from "../../src/validate/actionsValidator";
import type { ChangesetEntry } from "../../src/graph/types";

const changeset: ChangesetEntry[] = [
  { pkg: "@acme/design", repo: "acme/design_system", fromVersion: "1.0.0", toVersion: "1.0.1", depBumps: {}, level: 0 },
  { pkg: "@acme/components", repo: "acme/components", fromVersion: "2.0.0", toVersion: "2.0.1", depBumps: { "@acme/design": "^1.0.1" }, level: 1 },
];

const token = async () => "installation-tok";

/** A fake clock whose `sleep` advances the same mutable time `now()` reads,
 *  so poll-loop tests run in zero wall-clock time and remain deterministic. */
function makeClock(startMs: number) {
  let time = startMs;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

interface Call {
  url: string;
  init?: RequestInit;
}

/** Routes a fake fetch to per-endpoint handlers and records every call. */
function stubFetch(handlers: {
  dispatch?: (call: Call) => Response;
  runs?: (call: Call, callIndex: number) => Response;
}) {
  const calls: Call[] = [];
  let runsCallCount = 0;
  const fn = (async (url: unknown, init?: RequestInit) => {
    const call: Call = { url: String(url), init };
    calls.push(call);
    if (String(url).includes("/dispatches")) {
      if (!handlers.dispatch) throw new Error("unexpected dispatch call");
      return handlers.dispatch(call);
    }
    if (String(url).includes("/actions/runs")) {
      if (!handlers.runs) throw new Error("unexpected runs list call");
      return handlers.runs(call, runsCallCount++);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function runsResponse(runs: unknown[]): Response {
  return new Response(JSON.stringify({ workflow_runs: runs }));
}

const baseConfig = {
  installationId: 1,
  repo: "acme/infra",
  workflowFile: "chainreaction-validate.yml",
  ref: "main",
};

test("dispatches with the cascade id as an input", async () => {
  const { fn, calls } = stubFetch({
    dispatch: () => new Response(null, { status: 204 }),
    runs: () =>
      runsResponse([
        {
          id: 1,
          name: "chainreaction-validate",
          display_title: "cascade cid-fixed-1",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/acme/infra/actions/runs/1",
          created_at: new Date(1_000).toISOString(),
          event: "workflow_dispatch",
        },
      ]),
  });
  const clock = makeClock(0);
  const validator = new ActionsValidator(token, baseConfig, fn, clock.now, clock.sleep, () => "cid-fixed-1");

  await validator.validate(changeset);

  const dispatchCall = calls.find((c) => c.url.includes("/dispatches"));
  expect(dispatchCall).toBeDefined();
  expect(dispatchCall!.init?.method).toBe("POST");
  const body = JSON.parse(String(dispatchCall!.init?.body));
  expect(body).toEqual({ ref: "main", inputs: { cascade_id: "cid-fixed-1" } });
});

test("polls until the run completes and maps success to a passing result", async () => {
  const { fn, calls } = stubFetch({
    dispatch: () => new Response(null, { status: 204 }),
    runs: (_call, i) =>
      i === 0
        ? runsResponse([
            {
              id: 1, name: "chainreaction-validate", display_title: "cascade cid-poll",
              status: "in_progress", conclusion: null,
              html_url: "https://github.com/acme/infra/actions/runs/1",
              created_at: new Date(1_000).toISOString(), event: "workflow_dispatch",
            },
          ])
        : runsResponse([
            {
              id: 1, name: "chainreaction-validate", display_title: "cascade cid-poll",
              status: "completed", conclusion: "success",
              html_url: "https://github.com/acme/infra/actions/runs/1",
              created_at: new Date(1_000).toISOString(), event: "workflow_dispatch",
            },
          ]),
  });
  const clock = makeClock(0);
  const validator = new ActionsValidator(token, baseConfig, fn, clock.now, clock.sleep, () => "cid-poll");

  const results = await validator.validate(changeset);

  expect(results).toEqual([
    { pkg: "@acme/design", ok: true, output: expect.stringContaining("https://github.com/acme/infra/actions/runs/1") },
    { pkg: "@acme/components", ok: true, output: expect.stringContaining("https://github.com/acme/infra/actions/runs/1") },
  ]);
  const runsCalls = calls.filter((c) => c.url.includes("/actions/runs"));
  expect(runsCalls.length).toBeGreaterThanOrEqual(2);
});

test("maps a failed run to a failing result carrying the run url", async () => {
  const runUrl = "https://github.com/acme/infra/actions/runs/99";
  const { fn } = stubFetch({
    dispatch: () => new Response(null, { status: 204 }),
    runs: () =>
      runsResponse([
        {
          id: 99, name: "chainreaction-validate", display_title: "cascade cid-fail",
          status: "completed", conclusion: "failure",
          html_url: runUrl,
          created_at: new Date(1_000).toISOString(), event: "workflow_dispatch",
        },
      ]),
  });
  const clock = makeClock(0);
  const validator = new ActionsValidator(token, baseConfig, fn, clock.now, clock.sleep, () => "cid-fail");

  const results = await validator.validate(changeset);

  expect(results.every((r) => r.ok === false)).toBe(true);
  expect(results.every((r) => r.output.includes(runUrl))).toBe(true);
});

test("does not match a run created before the dispatch", async () => {
  // The race: a stale run happens to carry the same cascade id (e.g. a
  // previous, already-concluded run) but was created before this dispatch.
  // If the timestamp filter were missing, its (wrong) conclusion would be
  // returned immediately -- even though the id filter alone cannot catch
  // this, since the id genuinely matches.
  const dispatchedAtMs = 10_000;
  const { fn } = stubFetch({
    dispatch: () => new Response(null, { status: 204 }),
    runs: (_call, i) =>
      i === 0
        ? runsResponse([
            {
              id: 1, name: "chainreaction-validate", display_title: "cascade cid-race",
              status: "completed", conclusion: "success", // wrong verdict if matched
              html_url: "https://github.com/acme/infra/actions/runs/1",
              created_at: new Date(dispatchedAtMs - 5_000).toISOString(), // before dispatch
              event: "workflow_dispatch",
            },
          ])
        : runsResponse([
            {
              id: 1, name: "chainreaction-validate", display_title: "cascade cid-race",
              status: "completed", conclusion: "success",
              html_url: "https://github.com/acme/infra/actions/runs/1",
              created_at: new Date(dispatchedAtMs - 5_000).toISOString(),
              event: "workflow_dispatch",
            },
            {
              id: 2, name: "chainreaction-validate", display_title: "cascade cid-race",
              status: "completed", conclusion: "failure", // the genuine run
              html_url: "https://github.com/acme/infra/actions/runs/2",
              created_at: new Date(dispatchedAtMs + 1_000).toISOString(), // after dispatch
              event: "workflow_dispatch",
            },
          ]),
  });
  const clock = makeClock(dispatchedAtMs);
  const validator = new ActionsValidator(token, baseConfig, fn, clock.now, clock.sleep, () => "cid-race");

  const results = await validator.validate(changeset);

  // The genuine (post-dispatch) run failed; the stale pre-dispatch run
  // (which "succeeded") must never have been the source of this result.
  expect(results.every((r) => r.ok === false)).toBe(true);
  expect(results.every((r) => r.output.includes("runs/2"))).toBe(true);
});

test("does not match a run with a different cascade id even though it was created after the dispatch", async () => {
  // Isolates the id filter: both runs pass the timestamp check (both created
  // after dispatch), so only the id match can save this test. The unrelated
  // run is listed first (as the newest run would be, from a concurrent
  // dispatch of the same workflow) and already succeeded.
  const dispatchedAtMs = 0;
  const { fn } = stubFetch({
    dispatch: () => new Response(null, { status: 204 }),
    runs: () =>
      runsResponse([
        {
          id: 5, name: "chainreaction-validate", display_title: "cascade cid-other-cascade",
          status: "completed", conclusion: "success",
          html_url: "https://github.com/acme/infra/actions/runs/5",
          created_at: new Date(dispatchedAtMs + 500).toISOString(),
          event: "workflow_dispatch",
        },
        {
          id: 6, name: "chainreaction-validate", display_title: "cascade cid-mine",
          status: "completed", conclusion: "failure",
          html_url: "https://github.com/acme/infra/actions/runs/6",
          created_at: new Date(dispatchedAtMs + 200).toISOString(),
          event: "workflow_dispatch",
        },
      ]),
  });
  const clock = makeClock(dispatchedAtMs);
  const validator = new ActionsValidator(token, baseConfig, fn, clock.now, clock.sleep, () => "cid-mine");

  const results = await validator.validate(changeset);

  expect(results.every((r) => r.ok === false)).toBe(true);
  expect(results.every((r) => r.output.includes("runs/6"))).toBe(true);
});

test("times out with a clear message rather than polling forever", async () => {
  const { fn, calls } = stubFetch({
    dispatch: () => new Response(null, { status: 204 }),
    runs: () => runsResponse([]), // never appears
  });
  const clock = makeClock(0);
  const validator = new ActionsValidator(
    token,
    { ...baseConfig, pollIntervalMs: 1_000, timeoutMs: 3_000 },
    fn,
    clock.now,
    clock.sleep,
    () => "cid-timeout",
  );

  await expect(validator.validate(changeset)).rejects.toThrow(/cid-timeout/);
  await expect(validator.validate(changeset)).rejects.toThrow(/timed out/i);
  // Bounded: the fake clock advances by pollIntervalMs per iteration, so a
  // 3s budget over a 1s interval must stop polling, not loop forever.
  const runsCalls = calls.filter((c) => c.url.includes("/actions/runs"));
  expect(runsCalls.length).toBeLessThan(20);
});

test("surfaces a dispatch rejection rather than waiting for a run that will never exist", async () => {
  const { fn, calls } = stubFetch({
    dispatch: () => new Response(JSON.stringify({ message: "Unprocessable" }), { status: 422 }),
    runs: () => {
      throw new Error("must not poll after a rejected dispatch");
    },
  });
  const clock = makeClock(0);
  const validator = new ActionsValidator(token, baseConfig, fn, clock.now, clock.sleep, () => "cid-rejected");

  await expect(validator.validate(changeset)).rejects.toThrow(/422/);
  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toContain("/dispatches");
});

test("no installation token appears in a thrown error", async () => {
  const { fn } = stubFetch({
    dispatch: () => new Response("super-secret-installation-tok", { status: 500 }),
    runs: () => runsResponse([]),
  });
  const clock = makeClock(0);
  const validator = new ActionsValidator(token, baseConfig, fn, clock.now, clock.sleep, () => "cid-secret");

  let message = "";
  try {
    await validator.validate(changeset);
    throw new Error("expected validate() to reject");
  } catch (err) {
    message = String(err);
  }
  expect(message).not.toContain("super-secret-installation-tok");
  expect(message).not.toContain("installation-tok");
});

const API_ROOT = "https://api.github.com";

test("follows pagination to find a match on page 2 — a single-request implementation would time out here", async () => {
  const nextUrl = `${API_ROOT}/repos/acme/infra/actions/runs?event=workflow_dispatch&per_page=100&page=2`;
  const { fn, calls } = stubFetch({
    dispatch: () => new Response(null, { status: 204 }),
    runs: (call) => {
      if (call.url.includes("page=2")) {
        return runsResponse([
          {
            id: 2, name: "chainreaction-validate", display_title: "cascade cid-page2",
            status: "completed", conclusion: "success",
            html_url: "https://github.com/acme/infra/actions/runs/2",
            created_at: new Date(1_000).toISOString(), event: "workflow_dispatch",
          },
        ]);
      }
      // Page 1: 30 unrelated runs from concurrent activity in the CI repo,
      // none matching this cascade. Points to page 2 via the Link header —
      // the genuine run for this cascade lives there.
      return new Response(
        JSON.stringify({
          workflow_runs: Array.from({ length: 30 }, (_, i) => ({
            id: 100 + i, name: "chainreaction-validate", display_title: `cascade cid-other-${i}`,
            status: "completed", conclusion: "success",
            html_url: `https://github.com/acme/infra/actions/runs/${100 + i}`,
            created_at: new Date(1_000).toISOString(), event: "workflow_dispatch",
          })),
        }),
        { headers: { link: `<${nextUrl}>; rel="next"` } },
      );
    },
  });
  const clock = makeClock(0);
  const validator = new ActionsValidator(
    token,
    { ...baseConfig, timeoutMs: 10_000, pollIntervalMs: 1_000 },
    fn,
    clock.now,
    clock.sleep,
    () => "cid-page2",
  );

  const results = await validator.validate(changeset);

  expect(results.every((r) => r.ok === true)).toBe(true);
  expect(results.every((r) => r.output.includes("runs/2"))).toBe(true);
  const runsCalls = calls.filter((c) => c.url.includes("/actions/runs"));
  expect(runsCalls.some((c) => c.url.includes("page=2"))).toBe(true);
});

test("throws a named error rather than an opaque TypeError when a run entry has a malformed shape", async () => {
  const { fn } = stubFetch({
    dispatch: () => new Response(null, { status: 204 }),
    runs: () =>
      new Response(JSON.stringify({
        workflow_runs: [
          // display_title is missing entirely — a truncated/unexpected response.
          { id: 1, name: "chainreaction-validate", status: "completed", conclusion: "success",
            html_url: "https://github.com/acme/infra/actions/runs/1",
            created_at: new Date(1_000).toISOString(), event: "workflow_dispatch" },
        ],
      })),
  });
  const clock = makeClock(0);
  const validator = new ActionsValidator(token, baseConfig, fn, clock.now, clock.sleep, () => "cid-malformed");

  await expect(validator.validate(changeset)).rejects.toThrow(/actions validator:.*malformed/i);
});
