/**
 * Arithmetic helpers: pure functions over numbers.
 *
 * These exported functions trust their callers and do no input validation yet,
 * so they are real work for a goal that adds input validation to every exported
 * function.
 */

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  return a / b;
}
