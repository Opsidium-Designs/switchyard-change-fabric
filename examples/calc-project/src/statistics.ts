/**
 * Statistics helpers: pure functions over number arrays.
 *
 * As with the other modules here, these exported functions do not yet validate
 * their inputs, so a goal that adds input validation to every exported function
 * has real work to do in each file.
 */

export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function variance(values: number[]): number {
  const m = mean(values);
  return mean(values.map((value) => (value - m) ** 2));
}
