import { describe, expect, it } from "vitest";

import { addBusinessDays, addDays, cityDate } from "../../src/contracts/time.ts";

// Calendar helpers, pinned from the deadlines the city computes today.
describe("time contract", () => {
  it("five business days from Monday 2026-03-02 is Friday 2026-03-06", () => {
    expect(addBusinessDays("2026-03-02", 5)).toBe("2026-03-06");
  });

  it("adds calendar days across a month end", () => {
    expect(addDays("2026-01-30", 3)).toBe("2026-02-02");
  });

  it("reads an instant on the city's calendar", () => {
    expect(cityDate("2026-07-04T03:00:00Z")).toBe("2026-07-03");
  });
});
