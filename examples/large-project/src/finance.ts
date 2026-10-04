/**
 * Finance helpers: pure functions over amounts and rates. No input validation
 * yet, so these are in scope for the validation goal.
 */

export function compoundInterest(principal: number, rate: number, periods: number): number {
  return principal * (1 + rate) ** periods;
}

export function percentOf(amount: number, percent: number): number {
  return (amount * percent) / 100;
}

export function simpleInterest(principal: number, rate: number, periods: number): number {
  return principal * rate * periods;
}
