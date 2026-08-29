import type { PrepareResult } from "../prepare/types";

/**
 * Refuse to plan a cascade that includes a repository which cannot take part.
 *
 * An unprepared repo does not fail at launch — it fails silently in the middle,
 * when its PR never merges and every level below it waits forever. Failing here,
 * naming every repo and every reason, is the whole point.
 */
export function assertPrepared(
  results: Map<string, PrepareResult>,
  required: string[],
): void {
  if (required.length === 0) {
    // An empty target set must never read as "nothing to certify, so pass" —
    // assertScoped guards a different value (package names) on the other
    // side of an unwritten package-name -> repo-name mapping, and a mapping
    // step that silently drops unknowns would turn this into a no-op that
    // reports success.
    throw new Error("assertPrepared: refusing to certify an empty repository set");
  }
  const problems: string[] = [];
  for (const repo of required) {
    const result = results.get(repo);
    if (!result) {
      problems.push(`${repo}: never prepared`);
      continue;
    }
    if (!result.ready) {
      problems.push(`${repo}: ${result.blockers.join("; ")}`);
      continue;
    }
    if (result.mechanism === "control-plane") {
      // control-plane merge is Plan D, not implemented yet. Recording the
      // fallback mechanism is what Prepare is meant to do; certifying it as
      // ready is not — a control-plane repo's PR never merges today, and
      // every level below it waits forever.
      //
      // Delete this check in Plan D, once the check_suite watcher lands and
      // can actually merge control-plane repos itself.
      problems.push(`${repo}: needs control-plane merge, which is not implemented yet`);
      continue;
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `cannot start a cascade — ${problems.length} repositor${problems.length === 1 ? "y is" : "ies are"} not ready:\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}
