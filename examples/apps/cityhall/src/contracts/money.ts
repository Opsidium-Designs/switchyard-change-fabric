// cityhall SHARED money contract.
//
// Every amount in the API is an integer number of cents (`feeCents`,
// `amountCents`, ...). Modules that compute a fee, a discount, a split, or a
// refund import these helpers so the whole city does money arithmetic one way.
//
//   isCents(v)                 a safe integer number of cents
//   sum(amounts)               the total of a list of amounts
//   percentOf(amount, bps)     a share of an amount given in basis points
//                              (10000 = 100%), rounded to the nearest cent
//                              with an exact half cent rounding UP
//   format(amount)             "$1,234.56"

/** An integer number of cents. */
export type Cents = number;

/** True for a safe integer (a whole number of cents). */
export function isCents(value: unknown): value is Cents {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** The total of a list of amounts. */
export function sum(amounts: readonly Cents[]): Cents {
  return amounts.reduce((total, amount) => total + amount, 0);
}

/** amount x bps / 10000, rounded half up (amount and bps are non-negative). */
export function percentOf(amount: Cents, basisPoints: number): Cents {
  return Math.floor((amount * basisPoints + 5000) / 10000);
}

/** A display string, for example "$1,234.56". */
export function format(amount: Cents): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}
