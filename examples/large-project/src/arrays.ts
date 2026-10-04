/**
 * Array helpers: pure functions over arrays. No input validation yet, so each
 * exported function is a target for the validation goal.
 */

export function first<T>(values: T[]): T {
  return values[0] as T;
}

export function last<T>(values: T[]): T {
  return values[values.length - 1] as T;
}

export function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
