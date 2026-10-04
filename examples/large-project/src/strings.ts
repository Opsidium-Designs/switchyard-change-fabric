/**
 * String helpers: pure functions over text. No input validation yet, so each is
 * a target for the validation goal.
 */

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function reverse(value: string): string {
  return value.split("").reverse().join("");
}

export function truncate(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) : value;
}
