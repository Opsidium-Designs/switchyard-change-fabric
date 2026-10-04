/**
 * Finance helpers: pure functions over monetary amounts and rates.
 *
 * Like the other calc modules, these exported functions do not guard their
 * inputs yet, so they are in scope for an "add input validation to every
 * exported function" goal.
 */

export function compoundInterest(principal: number, rate: number, periods: number): number {
  return principal * (1 + rate) ** periods;
}

export function percentOf(amount: number, percent: number): number {
  return (amount * percent) / 100;
}
