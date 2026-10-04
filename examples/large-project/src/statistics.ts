/**
 * Statistics helpers: pure functions over number arrays. No input validation
 * yet, so each exported function is in scope for the validation goal.
 */

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function mean(values: number[]): number {
  return sum(values) / values.length;
}

export function max(values: number[]): number {
  return values.reduce((best, value) => (value > best ? value : best), values[0] as number);
}

export function min(values: number[]): number {
  return values.reduce((best, value) => (value < best ? value : best), values[0] as number);
}
