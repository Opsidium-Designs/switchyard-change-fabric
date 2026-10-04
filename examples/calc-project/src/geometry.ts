/**
 * Geometry helpers: pure functions over 2D shapes.
 *
 * These exported functions take numeric input and currently trust their callers.
 * They are a natural target for a goal that adds input validation to every
 * exported function, since each needs its own guard.
 */

export function rectangleArea(width: number, height: number): number {
  return width * height;
}

export function circleArea(radius: number): number {
  return Math.PI * radius * radius;
}

export function triangleArea(base: number, height: number): number {
  return (base * height) / 2;
}
