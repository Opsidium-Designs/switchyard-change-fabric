// storefront SHARED money contract.
//
// Every domain that handles an amount (catalog prices, cart and order totals,
// tax, invoices, payments, refunds) imports these helpers, so the whole service
// does arithmetic on money one way. The public HTTP API always speaks integer
// cents (`priceCents`, `totalCents`, `amountCents`); this module converts at
// that boundary.
//
// Today a Money value is a floating-point number of DOLLARS (19.99). Domains
// store Money, do arithmetic with add/multiply/percent, and convert back to
// cents with toCents when they build a response.

/** An amount of money, in dollars. */
export type Money = number;

/** Zero dollars. */
export const ZERO: Money = 0;

/** Money from an integer number of cents (the API's unit). */
export function fromCents(cents: number): Money {
  return cents / 100;
}

/** The integer number of cents in an amount (what the API reports). */
export function toCents(amount: Money): number {
  return Math.floor(amount * 100);
}

/** a + b. */
export function add(a: Money, b: Money): Money {
  return a + b;
}

/** a - b. */
export function subtract(a: Money, b: Money): Money {
  return a - b;
}

/** An amount times a whole quantity (a line total). */
export function multiply(amount: Money, quantity: number): Money {
  return amount * quantity;
}

/** A fraction of an amount, for example a tax rate of 0.0725. */
export function percent(amount: Money, rate: number): Money {
  return amount * rate;
}

/** The sum of a list of amounts. */
export function sum(amounts: readonly Money[]): Money {
  return amounts.reduce((total, amount) => add(total, amount), ZERO);
}

/** a > b. */
export function greaterThan(a: Money, b: Money): boolean {
  return a > b;
}

/** A display string, for example "$19.99". */
export function format(amount: Money): string {
  return `$${amount.toFixed(2)}`;
}
