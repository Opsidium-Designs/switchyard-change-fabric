// storefront billing: sales tax.
//
// The tax on an order is its subtotal times the shipping region's rate. The
// storefront ships to the regions in RATES; checkout taxes every order with
// taxFor, and invoices restate the same tax.

import { fromCents, percent, toCents, type Money } from "../contracts/money.ts";

/** Sales tax rate per shipping region. */
export const RATES: Readonly<Record<string, number>> = {
  CA: 0.0725,
  NY: 0.08875,
  TX: 0.0625,
  OR: 0,
};

/** The regions the storefront ships to. */
export const REGIONS: readonly string[] = Object.keys(RATES);

/** The tax rate for a region. */
export function taxRate(region: string): number {
  return RATES[region] ?? 0;
}

/** The tax on a subtotal shipped to a region, in whole cents. */
export function taxFor(subtotal: Money, region: string): Money {
  return fromCents(toCents(percent(subtotal, taxRate(region))));
}
