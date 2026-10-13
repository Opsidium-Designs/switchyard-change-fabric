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
//   allocate(total, weights)   split a total into integer shares proportional
//                              to the weights that add up to EXACTLY the total
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

/**
 * Split `total` into shares proportional to `weights`, never losing or adding a
 * cent: each share starts at the floor of its exact portion, and the cents left
 * over go one each to the shares with the largest remainders (an earlier share
 * wins a tie). The shares always add up to `total`.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0 || weightSum <= 0) {
    return weights.map(() => 0);
  }
  const shares = weights.map((w) => Math.floor((total * w) / weightSum));
  const remainders = weights.map((w, i) => ({ i, r: total * w - shares[i]! * weightSum }));
  let left = total - sum(shares);
  remainders.sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of remainders) {
    if (left <= 0) {
      break;
    }
    shares[i]! += 1;
    left -= 1;
  }
  return shares;
}

/** A display string, for example "$1,234.56". */
export function format(amount: Cents): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}
