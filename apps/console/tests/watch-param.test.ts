/**
 * ?watch=<change id> lets the console follow a run started from the CLI,
 * read-only. Only a well-formed change id is accepted.
 */
import { describe, expect, it } from "vitest";

import { watchedChangeId } from "../src/App.tsx";

describe("watchedChangeId", () => {
  it("accepts a well-formed change id", () => {
    expect(watchedChangeId("?watch=change-board-mv6xtzak")).toBe("change-board-mv6xtzak");
  });

  it("rejects an absent or malformed id", () => {
    expect(watchedChangeId("")).toBeNull();
    expect(watchedChangeId("?watch=")).toBeNull();
    expect(watchedChangeId("?watch=../admin")).toBeNull();
    expect(watchedChangeId("?watch=change-ABC")).toBeNull();
    expect(watchedChangeId(`?watch=change-${"a".repeat(65)}`)).toBeNull();
  });
});
