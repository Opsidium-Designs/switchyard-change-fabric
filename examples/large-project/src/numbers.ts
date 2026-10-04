/**
 * Number formatting helpers: pure functions over numeric values. No input
 * validation yet, so each exported function is a target for the validation goal.
 */

export function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
