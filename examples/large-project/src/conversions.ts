/**
 * Unit conversion helpers: pure functions over distances. No input validation
 * yet, so each exported function is a target for the validation goal.
 */

export function milesToKilometers(miles: number): number {
  return miles * 1.609344;
}

export function kilometersToMiles(kilometers: number): number {
  return kilometers / 1.609344;
}

export function metersToFeet(meters: number): number {
  return meters * 3.28084;
}
