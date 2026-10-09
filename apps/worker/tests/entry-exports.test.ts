/**
 * The Workers runtime rejects a main module that exports anything other than a
 * handler, a class, or a function ("Incorrect type for map entry ..."), and
 * refuses to start. The offline harness imports `handleRequest` directly and
 * never boots workerd, so this guards the entry module's runtime exports here.
 */
import { describe, expect, it } from "vitest";

import * as entry from "../src/index.ts";

describe("worker entry module", () => {
  it("exports only functions, classes, or the default handler", () => {
    for (const [name, value] of Object.entries(entry)) {
      if (name === "default") {
        expect(typeof (value as { fetch?: unknown }).fetch).toBe("function");
        continue;
      }
      expect({ name, type: typeof value }).toEqual({ name, type: "function" });
    }
  });
});
