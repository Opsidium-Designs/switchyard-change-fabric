/**
 * calc-project entry point: a tiny math utilities library.
 *
 * It is the Change target for the second seeded goal
 * (examples/goals/add-input-validation.goal.txt). The library deliberately has
 * several small, independent modules of exported functions and no cross-module
 * dependencies, so a goal that acts on "every exported function" decomposes into
 * a wide, flat work graph (one WorkUnit per module, no edges), which is a
 * different shape from the layered audit-logging example.
 */

export { mean, variance } from "./statistics.js";
export { rectangleArea, circleArea, triangleArea } from "./geometry.js";
export { compoundInterest, percentOf } from "./finance.js";
export { celsiusToFahrenheit, fahrenheitToCelsius } from "./temperature.js";
