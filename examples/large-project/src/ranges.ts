/**
 * Random helpers: pure functions over a seedable range. No input validation
 * yet, so each exported function is a target for the validation goal.
 */

export function clampToRange(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

export function lerp(start: number, end: number, fraction: number): number {
  return start + (end - start) * fraction;
}
