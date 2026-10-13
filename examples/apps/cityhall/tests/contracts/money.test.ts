import { describe, expect, it } from "vitest";

import { format, percentOf, sum } from "../../src/contracts/money.ts";

describe("money contract", () => {
  it("takes a share in basis points, half cent up", () => {
    expect(percentOf(1000, 725)).toBe(73);
    expect(percentOf(4500, 1000)).toBe(450);
  });

  it("sums and formats cents", () => {
    expect(sum([125, 75])).toBe(200);
    expect(format(123456)).toBe("$1,234.56");
  });
});
