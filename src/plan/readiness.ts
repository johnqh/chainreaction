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
  const problems: string[] = [];
  for (const repo of required) {
    const result = results.get(repo);
    if (!result) {
      problems.push(`${repo}: never prepared`);
      continue;
    }
    if (!result.ready) {
      problems.push(`${repo}: ${result.blockers.join("; ")}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `cannot start a cascade — ${problems.length} repositor${problems.length === 1 ? "y is" : "ies are"} not ready:\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}
