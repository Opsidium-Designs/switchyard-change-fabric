/**
 * Date helpers: pure functions over epoch milliseconds. No input validation
 * yet, so each exported function is a target for the validation goal.
 */

export function addDays(epochMs: number, days: number): number {
  return epochMs + days * 24 * 60 * 60 * 1000;
}

export function daysBetween(startMs: number, endMs: number): number {
  return (endMs - startMs) / (24 * 60 * 60 * 1000);
}
