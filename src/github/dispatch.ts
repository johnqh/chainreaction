import type { ChangesetEntry } from "../graph/types";

export function dependentsOf(
  entries: ChangesetEntry[],
  pkg: string,
): ChangesetEntry[] {
  return entries.filter((e) => Object.hasOwn(e.depBumps, pkg));
}
