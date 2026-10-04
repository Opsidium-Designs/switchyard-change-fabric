/**
 * large-project entry point: a wide math and text utilities library.
 *
 * It is the Change target for the Large console scenario. The library has many
 * small, independent modules of exported functions and no cross-module
 * dependencies, so a universal goal (add input validation to every exported
 * function) decomposes into a wide, flat work graph with more than ten
 * WorkUnits, one per source file. There are no path collisions, so the run is
 * autonomous (no human escalation step).
 */

export { add, subtract, multiply, divide } from "./arithmetic.js";
export { sum, mean, max, min } from "./statistics.js";
export { rectangleArea, circleArea, triangleArea } from "./geometry.js";
export { compoundInterest, percentOf, simpleInterest } from "./finance.js";
export { celsiusToFahrenheit, fahrenheitToCelsius, celsiusToKelvin } from "./temperature.js";
export { capitalize, reverse, truncate } from "./strings.js";
export { first, last, chunk } from "./arrays.js";
export { transpose, scale } from "./matrix.js";
export { clampToRange, lerp } from "./ranges.js";
export { addDays, daysBetween } from "./dates.js";
export { milesToKilometers, kilometersToMiles, metersToFeet } from "./conversions.js";
export { roundTo, clampPercent } from "./numbers.js";
