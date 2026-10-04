/**
 * Temperature conversion helpers: pure functions over scalar readings. No input
 * validation yet, so each exported function is a target for the validation goal.
 */

export function celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}

export function fahrenheitToCelsius(fahrenheit: number): number {
  return ((fahrenheit - 32) * 5) / 9;
}

export function celsiusToKelvin(celsius: number): number {
  return celsius + 273.15;
}
