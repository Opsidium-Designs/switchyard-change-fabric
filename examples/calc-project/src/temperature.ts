/**
 * Temperature conversion helpers: pure functions over scalar readings.
 *
 * Another independent module of exported functions with no dependencies, so the
 * "add input validation to every exported function" goal fans out one more
 * WorkUnit here.
 */

export function celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}

export function fahrenheitToCelsius(fahrenheit: number): number {
  return ((fahrenheit - 32) * 5) / 9;
}
