/**
 * A tool proposal over a wide plan, within the board's payload limits: the
 * rationale names a few items and counts the rest, and a codemod's declared
 * inputs fold into directory globs when the plan's scope has more entries than
 * a proposal may carry. Used by the lead's seeded tools and the offline policy.
 */

import { BOARD_LIMITS } from "@switchyard-change/change-core";

/** At most `max` names, then how many more: a rationale stays within the board's limit on a wide plan. */
export function nameSome(names: readonly string[], max = 8): string {
  return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")}, and ${names.length - max} more`;
}

/**
 * A codemod's declared inputs within the board's limit on intent entries: the
 * scope itself when it fits, else each entry's directory as a glob
 * (`src/parking/**`), climbing one level at a time until it fits. Every file
 * the scope covered is still covered.
 */
export function toolInputsWithin(scope: readonly string[], max: number = BOARD_LIMITS.maxIntentEntries): string[] {
  const unique = [...new Set(scope)];
  // Each entry's literal directory: a file's parent, a glob's segments before its first wildcard.
  const dirs = unique.map((entry) => {
    const literal: string[] = [];
    for (const segment of entry.split("/")) {
      if (segment === "" || /[*?]/.test(segment)) {
        break;
      }
      literal.push(segment);
    }
    return /[*?]/.test(entry) ? literal : literal.slice(0, -1);
  });
  let entries = unique;
  for (let depth = Math.max(0, ...dirs.map((d) => d.length)); entries.length > max && depth >= 0; depth -= 1) {
    entries = [...new Set(dirs.map((d) => (depth === 0 || d.length === 0 ? "**" : `${d.slice(0, depth).join("/")}/**`)))];
  }
  return entries;
}
