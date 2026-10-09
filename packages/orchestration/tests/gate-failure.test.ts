/**
 * A real failing gate output (a fix that redeclared an identifier, so the
 * typecheck step failed before any test ran; from a live service-api board
 * run, paths anonymized): the revision's reason leads with the SyntaxError,
 * and attribution implicates only the item whose file the error names, not
 * every file npm echoed in the typecheck command line.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { attributeRevisionFailure, firstLines, gateFailureLine } from "../src/run-board.ts";

const stdout = readFileSync(new URL("./fixtures/gate-syntax-error.stdout.txt", import.meta.url), "utf8");
const stderr = readFileSync(new URL("./fixtures/gate-syntax-error.stderr.txt", import.meta.url), "utf8");
const RESOURCES = ["users", "orders", "products", "auth", "search", "notifications"];

describe("a gate that failed on a syntax error", () => {
  it("leads with the gate's own failing line, never an npm command echo", () => {
    expect(gateFailureLine(`${stdout}\n${stderr}`)).toBe("SyntaxError: Identifier 'authResponse' has already been declared");
    expect(gateFailureLine("> node --check src/a.js\n> npm run gate\n")).toBeUndefined();
  });

  it("implicates only the item whose file the error location names", async () => {
    const items = RESOURCES.map((r) => ({ id: `unit-${r}`, objective: `fix ${r}`, paths: [`src/resources/${r}.js`] }));
    const output = [gateFailureLine(`${stdout}\n${stderr}`), stdout, stderr, "integration app-gate failed over the promoted tree (exit 1)"].join("\n");
    expect(await attributeRevisionFailure({ items, output, changeId: "c" })).toEqual({ items: ["unit-users"], source: "parse" });
  });

  it("cuts a long reason at a word, never mid-word", () => {
    const reason = firstLines(`integration app-gate exited 0 but did not run its tests: test inventory: ${"word ".repeat(80)}`, 120);
    expect(reason.length).toBeLessThanOrEqual(120);
    expect(reason).toMatch(/ word\.\.\.$|\bword\.\.\.$/);
  });
});
