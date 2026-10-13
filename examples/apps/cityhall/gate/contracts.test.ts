// Acceptance: the shared contracts every domain builds on.
//
// money   integer cents; percentOf rounds half up; allocate(total, weights)
//         splits a total into proportional integer shares that add up to it
//         exactly (largest remainders get the leftover cents, earlier wins a tie)
// time    business days skip weekends AND city holidays, and the start date
//         never counts; cityDate reads an instant on the America/Chicago calendar
// validate  one pagination rule: limit an integer 1 to 100 (default 20),
//           offset an integer 0 or more (default 0), anything else a 400
// auth    four demo tokens, three roles
//
// The contract modules are imported as namespaces and read through `any`, so
// an operation the contract does not have yet fails its test instead of the
// typecheck.

import { describe, expect, it } from "vitest";

import * as authModule from "../src/contracts/auth.ts";
import * as moneyModule from "../src/contracts/money.ts";
import * as timeModule from "../src/contracts/time.ts";
import * as validateModule from "../src/contracts/validate.ts";
import { BAD_PAGES } from "./harness.ts";

const money = moneyModule as any;
const time = timeModule as any;
const validate = validateModule as any;
const auth = authModule as any;

describe("money contract", () => {
  it("percentOf rounds an exact half cent up", () => {
    expect(money.percentOf(1000, 725)).toBe(73);
    expect(money.percentOf(1525, 5000)).toBe(763);
    expect(money.percentOf(1999, 1000)).toBe(200);
    expect(money.percentOf(0, 500)).toBe(0);
  });

  it("sum adds integer cents", () => {
    expect(money.sum([1999, 1, 0, 250])).toBe(2250);
  });

  it("offers allocate(total, weights)", () => {
    expect(typeof money.allocate).toBe("function");
  });

  it("allocate splits 1000 three ways as 334, 333, 333", () => {
    expect(money.allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
  });

  it("allocate gives leftover cents to the largest remainders", () => {
    expect(money.allocate(10, [1, 2, 3])).toEqual([2, 3, 5]);
    expect(money.allocate(100001, [2, 1, 1])).toEqual([50001, 25000, 25000]);
  });

  it("allocate breaks remainder ties toward the earlier share", () => {
    expect(money.allocate(100, [1, 1, 1, 1, 1, 1, 1])).toEqual([15, 15, 14, 14, 14, 14, 14]);
  });

  it("allocate never loses or invents a cent", () => {
    for (let total = 0; total <= 400; total += 7) {
      for (const weights of [[3, 7, 11], [1, 1], [5], [2, 2, 2, 2, 1], [700, 1100, 1300]]) {
        const shares: number[] = money.allocate(total, weights);
        expect(shares).toHaveLength(weights.length);
        expect(shares.every((s) => Number.isInteger(s) && s >= 0)).toBe(true);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });
});

describe("time contract", () => {
  it("counts business days after the start date, not including it", () => {
    expect(time.addBusinessDays("2026-03-02", 3)).toBe("2026-03-05");
    expect(time.addBusinessDays("2026-03-02", 5)).toBe("2026-03-09");
  });

  it("skips the weekend", () => {
    expect(time.addBusinessDays("2026-03-06", 1)).toBe("2026-03-09");
    expect(time.addBusinessDays("2026-03-05", 3)).toBe("2026-03-10");
  });

  it("starts counting from a weekend start date", () => {
    expect(time.addBusinessDays("2026-03-07", 1)).toBe("2026-03-09");
  });

  it("skips city holidays", () => {
    expect(time.addBusinessDays("2026-07-02", 1)).toBe("2026-07-06");
    expect(time.addBusinessDays("2026-08-31", 10)).toBe("2026-09-15");
  });

  it("skips the Thanksgiving holidays", () => {
    expect(time.addBusinessDays("2026-11-25", 2)).toBe("2026-12-01");
    expect(time.addBusinessDays("2026-11-23", 10)).toBe("2026-12-09");
  });

  it("isBusinessDay knows weekends and holidays", () => {
    expect(time.isBusinessDay("2026-03-02")).toBe(true);
    expect(time.isBusinessDay("2026-03-07")).toBe(false);
    expect(time.isBusinessDay("2026-09-07")).toBe(false);
  });

  it("cityDate reads an instant on the city's calendar", () => {
    expect(time.cityDate("2026-03-06T23:30:00-06:00")).toBe("2026-03-06");
    expect(time.cityDate("2026-03-07T04:30:00Z")).toBe("2026-03-06");
    expect(time.cityDate("2026-11-01T04:30:00Z")).toBe("2026-10-31");
  });

  it("addMonths clamps to the end of a shorter month", () => {
    expect(time.addMonths("2024-02-29", 24)).toBe("2026-02-28");
    expect(time.addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(time.addMonths("2026-04-01", 3)).toBe("2026-07-01");
  });
});

describe("validate contract: the shared pagination rule", () => {
  const page = (query: string) => validate.readPage(new URL(`http://cityhall.local/x?${query}`));

  it("defaults to limit 20 and offset 0", () => {
    expect(page("")).toEqual({ limit: 20, offset: 0 });
  });

  it("accepts the bounds 1 and 100", () => {
    expect(page("limit=1&offset=0")).toEqual({ limit: 1, offset: 0 });
    expect(page("limit=100&offset=250")).toEqual({ limit: 100, offset: 250 });
  });

  for (const query of BAD_PAGES) {
    it(`refuses ${query} with a 400 Response`, () => {
      const result = page(query);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
    });
  }

  it("pageOf slices and reports the page", () => {
    expect(validate.pageOf([1, 2, 3, 4, 5], { limit: 2, offset: 1 })).toEqual({ items: [2, 3], total: 5, limit: 2, offset: 1 });
  });
});

describe("auth contract", () => {
  const withToken = (token?: string) => new Request("http://cityhall.local/", token ? { headers: { authorization: `Bearer ${token}` } } : {});

  it("maps the demo tokens to their roles", () => {
    expect(auth.principalOf(withToken("resident-ana"))?.role).toBe("resident");
    expect(auth.principalOf(withToken("clerk-token"))?.role).toBe("clerk");
    expect(auth.principalOf(withToken("admin-token"))?.role).toBe("admin");
    expect(auth.principalOf(withToken("nope"))).toBeNull();
  });

  it("requireStaff is 401 without a token and 403 for a resident", () => {
    expect(auth.requireStaff(withToken()).status).toBe(401);
    expect(auth.requireStaff(withToken("resident-ben")).status).toBe(403);
    expect(auth.requireStaff(withToken("admin-token")).role).toBe("admin");
  });
});
