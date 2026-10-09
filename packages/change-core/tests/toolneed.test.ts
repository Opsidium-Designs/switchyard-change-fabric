/**
 * M4: the agent-for-agent tool-build trigger is derived from the WORK, not the
 * goal string.
 *
 * `detectToolRequirement` reads only the Change's shape (its WorkUnits, their
 * declared paths, and the generic edit kind the decomposer encodes in the unit
 * id). It fires when a group of units repeats the SAME mechanical transform
 * across enough distinct files that one agent building a tool pays for itself,
 * and does not fire otherwise. These tests pin that:
 *
 *   (a) it DOES fire for a wide fan-out (many units, same edit kind, many
 *       files): a tool is justified;
 *   (b) it does NOT fire for a layered Change of distinct units (a module + an
 *       api + a tests unit), because no group repeats one transform across many
 *       files;
 *   (c) it is derived from the Change shape, not the goal string: two Changes
 *       whose units have the same shape but came from different goals yield the
 *       same requirement, and shrinking the fan-out below the threshold stops it
 *       firing;
 *   (d) exactly one tool is recommended (the largest qualifying fan-out).
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decompose, detectBoardToolNeed, detectToolRequirement, objectiveChangeWords, parseChangeSpec, type RepoFile } from "../src/index.ts";

// A flat library repo: independent modules of exported functions, no router.
const FLAT_REPO: RepoFile[] = [
  { path: "src/statistics.ts", content: "export function mean(v: number[]): number { return 0; }\n" },
  { path: "src/geometry.ts", content: "export function area(w: number, h: number): number { return w * h; }\n" },
  { path: "src/finance.ts", content: "export function pct(a: number, p: number): number { return 0; }\n" },
  { path: "src/temperature.ts", content: "export function toC(f: number): number { return f; }\n" },
  { path: "src/index.ts", content: "export { mean } from './statistics.js';\n" },
];

// A layered repo: a model module, an api that depends on it, an entry point and
// tests. This is the audit shape: distinct units doing different work.
const LAYERED_REPO: RepoFile[] = [
  { path: "src/audit/events.ts", content: "export interface AuditEvent { id: number }\n" },
  { path: "src/audit/store.ts", content: "export class AuditStore {}\n" },
  { path: "src/api/audit/handler.ts", content: "export function createAuditApi() { return {}; }\n" },
  { path: "src/index.ts", content: "export { AuditStore } from './audit/store.js';\n" },
  { path: "tests/audit/store.test.ts", content: "import { AuditStore } from '../../src/audit/store.js';\n" },
];

const UNIVERSAL_GOAL = "Add input validation to every exported function";
const AUDIT_GOAL = "Add organization-level audit logging with a read API and tests";

describe("M4: the tool-build trigger is derived from the work, not the goal", () => {
  it("DOES fire for a wide fan-out: many units repeating one transform over many files", () => {
    const change = decompose({ goal: UNIVERSAL_GOAL, repo: FLAT_REPO }).change;
    const req = detectToolRequirement(change);
    expect(req).toBeDefined();
    expect(req?.editKind).toBe("validate");
    expect(req?.toolUnitId).toBe("tool-validate");
    expect(req?.capability).toBe("codemod:validate");
    // The fan-out units are the consumers, and the tool spans their files.
    expect(req?.consumers.length).toBeGreaterThanOrEqual(3);
    expect(req?.files.length).toBeGreaterThanOrEqual(3);
  });

  it("does NOT fire for a layered Change of distinct units (no repeated transform)", () => {
    const change = decompose({ goal: AUDIT_GOAL, repo: LAYERED_REPO }).change;
    // Sanity: this is the layered shape (it has dependency edges / distinct ids).
    expect(change.work.length).toBeGreaterThan(1);
    const req = detectToolRequirement(change);
    expect(req).toBeUndefined();
  });

  it("does NOT fire for the hand-authored audit Change (the make-demo collision case)", () => {
    const change = parseChangeSpec(`
id: change-audit-logging
objective: Add organization-level audit logging
work:
  - id: model
    objective: Implement audit event persistence
    paths: [src/audit/**]
  - id: api
    objective: Add API read endpoints
    depends_on: [model]
    paths: [src/api/audit/**, src/audit/events.ts]
  - id: tests
    objective: Add audit logging tests
    paths: [tests/audit/**, src/audit/events.ts]
`);
    expect(detectToolRequirement(change)).toBeUndefined();
  });

  it("is keyed on the work shape, not the goal string: same shape, different goal, same requirement", () => {
    // Two different universal goal strings reduce to the same fan-out shape over
    // the same repo, so the SAME tool requirement is detected.
    const a = decompose({ goal: "Add input validation to every exported function", repo: FLAT_REPO }).change;
    const b = decompose({ goal: "Guard each exported function with validation", repo: FLAT_REPO }).change;
    const reqA = detectToolRequirement(a);
    const reqB = detectToolRequirement(b);
    expect(reqA?.capability).toBe(reqB?.capability);
    expect([...(reqA?.consumers ?? [])].sort()).toEqual([...(reqB?.consumers ?? [])].sort());
    expect([...(reqA?.files ?? [])].sort()).toEqual([...(reqB?.files ?? [])].sort());
  });

  it("does NOT fire when the fan-out is below the min-fanout threshold", () => {
    // The same wide fan-out, but a higher threshold than the number of files, so
    // the repetition no longer justifies a tool. Same code path, structural dial.
    const change = decompose({ goal: UNIVERSAL_GOAL, repo: FLAT_REPO }).change;
    const fileCount = detectToolRequirement(change)?.files.length ?? 0;
    expect(fileCount).toBeGreaterThan(0);
    const req = detectToolRequirement(change, { minFanout: fileCount + 1 });
    expect(req).toBeUndefined();
  });

  it("recommends exactly one tool (the largest qualifying fan-out)", () => {
    const change = decompose({ goal: UNIVERSAL_GOAL, repo: FLAT_REPO }).change;
    const req = detectToolRequirement(change);
    // One requirement object, not a list; it names a single capability.
    expect(req).toBeDefined();
    expect(typeof req?.capability).toBe("string");
  });

  it("does not count a unit as its own consumer: a tool-* unit is structural", () => {
    // A Change that already has a tool-builder unit does not re-detect a need for
    // the same capability (the redundancy guard), and the tool-builder unit is
    // not grouped as repeated content work.
    const change = parseChangeSpec(`
id: already-tooled
objective: already has a validate tool
work:
  - id: tool-validate
    objective: build the validate codemod
    paths: [tools/validate-codemod.mjs]
  - id: validate-a
    objective: validate a
    paths: [src/a.ts]
  - id: validate-b
    objective: validate b
    paths: [src/b.ts]
  - id: validate-c
    objective: validate c
    paths: [src/c.ts]
`);
    // The tool unit already exists, so no second tool is recommended.
    expect(detectToolRequirement(change)).toBeUndefined();
  });
});

describe("detectBoardToolNeed (the structural rule over board items)", () => {
  const files = ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts", "src/index.ts", "tests/a.test.ts", "README.md"];

  it("fires on two or more outstanding items sharing an edit kind whose scopes cover enough unprotected files", () => {
    const need = detectBoardToolNeed(
      [
        { item: "add-a", scopeHint: ["src/a/**"], status: "open" },
        { item: "add-b", scopeHint: ["src/b/**"], status: "claimed" },
        { item: "add-index", scopeHint: ["src/index.ts"], status: "open" },
        { item: "tests", scopeHint: ["tests/**"], status: "open" },
      ],
      files,
    );
    expect(need).toEqual({
      editKind: "add",
      signal: "id-prefix",
      items: ["add-a", "add-b", "add-index"],
      files: ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts", "src/index.ts"],
      scope: ["src/a/**", "src/b/**", "src/index.ts"],
      scanner: "scan-add",
      codemod: "codemod-add",
    });
  });

  it("does not fire for distinct work, a single item, too few files, done items, tool items, or protected files", () => {
    expect(detectBoardToolNeed([{ item: "core", scopeHint: ["src/**"], status: "open" }, { item: "api", scopeHint: ["src/**"], status: "open" }], files)).toBeUndefined();
    expect(detectBoardToolNeed([{ item: "add-all", scopeHint: ["src/**"], status: "open" }], files)).toBeUndefined();
    expect(detectBoardToolNeed([{ item: "add-a", scopeHint: ["src/a/x.ts"], status: "open" }, { item: "add-b", scopeHint: ["src/b/z.ts"], status: "open" }], files)).toBeUndefined();
    expect(
      detectBoardToolNeed([{ item: "add-a", scopeHint: ["src/a/**"], status: "done" }, { item: "add-b", scopeHint: ["src/b/**"], status: "done" }], files),
    ).toBeUndefined();
    expect(
      detectBoardToolNeed([{ item: "tool-scan", scopeHint: ["src/**"], status: "open", tool: true }, { item: "tool-fix", scopeHint: ["src/**"], status: "open", tool: true }], files),
    ).toBeUndefined();
    expect(
      detectBoardToolNeed(
        [{ item: "add-a", scopeHint: ["src/a/**"], status: "open" }, { item: "add-b", scopeHint: ["src/b/**"], status: "open" }],
        files,
        { protected: ["src/a/x.ts"] },
      ),
    ).toBeUndefined();
  });
});

describe("detectBoardToolNeed: near-identical objectives over sibling files (a planner that names items freely)", () => {
  // Exactly the live planner's shape: numbered ids with different prefixes, one objective per resource, sibling files.
  const names = ["auth", "notifications", "orders", "products", "search", "users"];
  const live = names.map((name, i) => ({
    item: `u${i + 1}-${name}-resource`,
    objective: `Add input validation and require authentication in the ${name} resource handler so malformed or unauthenticated requests are rejected with 400 or 401`,
    scopeHint: [`src/resources/${name}.js`],
    status: "open",
  }));
  const files = [...names.map((n) => `src/resources/${n}.js`), "src/index.js", "src/ui.js", "src/contracts/auth.js", "src/contracts/response.js", "package.json"];

  it("groups all six live items into one change and names scanner and codemod capabilities for it", () => {
    const need = detectBoardToolNeed(live, files);
    expect(need).toMatchObject({
      signal: "objective",
      editKind: "add-input",
      items: live.map((i) => i.item),
      files: names.map((n) => `src/resources/${n}.js`).sort(),
      scanner: "scan-add-input",
      codemod: "codemod-add-input",
    });
    // Each item's own words (its file, its id) are not part of the change.
    expect(objectiveChangeWords(live[0]!)).not.toContain("auth");
    expect(objectiveChangeWords(live[0]!)).not.toContain("resource");
  });

  it("unrelated objectives in sibling files do not group", () => {
    const unrelated = [
      { item: "u1-a", objective: "Add input validation to the request handler", scopeHint: ["src/resources/a.js"], status: "open" },
      { item: "u2-b", objective: "Document the pagination rules for listing endpoints", scopeHint: ["src/resources/b.js"], status: "open" },
      { item: "u3-c", objective: "Rename the logger and remove dead branches", scopeHint: ["src/resources/c.js"], status: "open" },
    ];
    expect(detectBoardToolNeed(unrelated, ["src/resources/a.js", "src/resources/b.js", "src/resources/c.js"])).toBeUndefined();
  });

  it("the same objective across unrelated directories groups at most per directory", () => {
    const objective = "Add input validation and require authentication in the handler";
    const spread = [
      { item: "u1-x", objective, scopeHint: ["src/a/x.js"], status: "open" },
      { item: "u2-y", objective, scopeHint: ["lib/b/y.js"], status: "open" },
      { item: "u3-z", objective, scopeHint: ["tools/c/z.js"], status: "open" },
    ];
    const spreadFiles = ["src/a/x.js", "lib/b/y.js", "tools/c/z.js"];
    expect(detectBoardToolNeed(spread, spreadFiles)).toBeUndefined();
    const twoHere = [...spread, { item: "u4-w", objective, scopeHint: ["src/a/w.js"], status: "open" }];
    expect(detectBoardToolNeed(twoHere, [...spreadFiles, "src/a/w.js"])).toBeUndefined(); // 2 files < 3
    expect(detectBoardToolNeed(twoHere, [...spreadFiles, "src/a/w.js"], { minFanout: 2 })).toMatchObject({ signal: "objective", items: ["u1-x", "u4-w"] });
  });

  it("the same file name in sibling directories counts as siblings (a file pattern)", () => {
    const handlers = ["users", "orders", "products"].map((m, i) => ({
      item: `t${i}-${m}`,
      objective: `Return a problem body for every error in the ${m} handler`,
      scopeHint: [`src/${m}/handler.ts`],
      status: "open",
    }));
    expect(detectBoardToolNeed(handlers, handlers.map((h) => h.scopeHint[0]!))).toMatchObject({ signal: "objective", items: handlers.map((h) => h.item) });
  });
});

describe("detectBoardToolNeed on the recorded live plan (an identical lead sentence, item-specific tails)", () => {
  // id | objective | scope, as the live planner wrote them (board-live-tools-5).
  const live = readFileSync(new URL("./fixtures/live-plan-objectives.txt", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const [item, objective, scope] = line.split(" | ");
      return { item: item!, objective: objective!, scopeHint: [...scope!.matchAll(/'([^']+)'/g)].map((m) => m[1]!), status: "open" };
    });
  const files = ["auth", "notifications", "orders", "products", "search", "users"].map((n) => `src/resources/${n}.js`).concat(["src/index.js", "src/contracts/auth.js", "src/contracts/response.js"]);

  it("whole-objective Jaccard alone misses them, but the first clause groups U2..U6 (U1, phrased differently, may stay out)", () => {
    expect(live.map((i) => i.item)).toEqual(["U1-res-auth", "U2-res-notifications", "U3-res-orders", "U4-res-products", "U5-res-search", "U6-res-users"]);
    const need = detectBoardToolNeed(live, files);
    expect(need).toMatchObject({ signal: "objective", scanner: expect.stringMatching(/^scan-/), codemod: expect.stringMatching(/^codemod-/) });
    expect(need!.items).toEqual(expect.arrayContaining(["U2-res-notifications", "U3-res-orders", "U4-res-products", "U5-res-search", "U6-res-users"]));
    expect(need!.files).toEqual(expect.arrayContaining(["src/resources/notifications.js", "src/resources/orders.js", "src/resources/products.js", "src/resources/search.js", "src/resources/users.js"]));
    expect(need!.files.every((f) => f.startsWith("src/resources/"))).toBe(true);
    // The first clause keeps a dotted path whole: "auth.js" does not end it.
    const first = objectiveChangeWords(live[1]!, "first");
    expect(first).toEqual(expect.arrayContaining(["require", "auth", "start", "handler", "calling", "requireauth", "contracts"]));
    expect(first).not.toContain("validation"); // the item-specific tail is not part of the first clause
    expect(first).not.toContain("notifications"); // the item's own words are removed
  });

  it("an identical first clause in unrelated directories still does not group", () => {
    const spread = live.slice(1, 4).map((i, k) => ({ ...i, scopeHint: [[`src/a/x.js`, `lib/b/y.js`, `tools/c/z.js`][k]!] }));
    expect(detectBoardToolNeed(spread, ["src/a/x.js", "lib/b/y.js", "tools/c/z.js"])).toBeUndefined();
  });
});
