/**
 * Geometry helpers: pure functions over 2D shapes. No guards yet, so each is a
 * target for the input-validation goal.
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
