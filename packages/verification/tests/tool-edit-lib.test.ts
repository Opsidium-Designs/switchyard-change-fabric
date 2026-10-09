/**
 * The edit helpers the runtime ships with every codemod skeleton
 * (src/tool-lib/edit.mjs): each primitive, idempotency, refusal of ambiguous
 * matches, and refusal of results that do not parse. Pure, offline.
 */
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { toolEditLibSource } from "../src/index.ts";

interface Fn {
  readonly name?: string;
  readonly kind: "function" | "arrow" | "method";
  readonly exported: boolean;
  readonly isDefault: boolean;
  readonly async: boolean;
  readonly params: readonly (string | null)[];
  readonly header: string;
  readonly body: string;
  readonly line: number;
}
type Edit = { readonly op: string };
interface EditLib {
  functions(text: string): Fn[];
  insertAtStart(target: unknown, statement: string | ((fn: Fn) => string | undefined)): Edit;
  wrapBody(target: unknown, before: string | ((fn: Fn) => string), after: string | ((fn: Fn) => string)): Edit;
  addImport(spec: { from: string; names?: string[]; default?: string }): Edit;
  replaceOnce(find: string, replacement: string): Edit;
  applyEdits(path: string, text: string, edits: readonly unknown[]): { text: string; findings: string[]; applied: number };
  relativeImport(fromFile: string, toFile: string): string;
  parseProblem(path: string, text: string): string | undefined;
}

// A computed specifier: the helper is plain JS shipped to tools, loaded as such.
const LIB_URL = new URL("../src/tool-lib/edit.mjs", import.meta.url).href;
const lib = (await import(LIB_URL)) as EditLib;

const HANDLER = [
  'import { json } from "../contracts/response.js";',
  "",
  "const ITEMS = [];",
  "",
  "export async function handle(request, parts) {",
  '  if (request.method === "GET") {',
  "    return json({ items: ITEMS });",
  "  }",
  '  return json({ ok: `made ${parts.length}` }, 201);',
  "}",
  "",
  "function helper(x) { return x; }",
  "",
  "export const other = async (req) => {",
  "  return json({ req: String(req) });",
  "};",
  "",
].join("\n");

const guard = (fn: Fn) => `const denied = requireAuth(${fn.params[0]});\nif (denied) return denied;`;

/** Apply once, then again on the output: the second pass must change nothing. */
function twice(path: string, text: string, edits: readonly unknown[]) {
  const first = lib.applyEdits(path, text, edits);
  const second = lib.applyEdits(path, first.text, edits);
  expect(second.text).toBe(first.text);
  expect(second.applied).toBe(0);
  return first;
}

describe("the codemod edit helpers", () => {
  it("is the file the skeleton ships", () => {
    expect(toolEditLibSource()).toContain("export function applyEdits(");
    expect(toolEditLibSource()).not.toMatch(/FILL-(?:BEGIN|END)|SWITCHYARD-TOOL-SKELETON/);
    expect(fileURLToPath(LIB_URL)).toMatch(/tool-lib\/edit\.mjs$/);
  });

  it("finds functions by kind, name, export, and parameters (strings, templates, regexes, and comments do not confuse it)", () => {
    const text = [
      "// function fake(a) { in a comment }",
      'const s = "function nope(x) {";',
      "const re = /function \\w+\\(\\)\\s*\\{/g;",
      HANDLER,
      "export default function main({ a }, ...rest) { return a; }",
      "class Box { constructor(v) { this.v = v; } async get(key: string): Promise<{ v: number }> { return { v: 1 }; } }",
      "export function typed<T>(x: T, y?: number): { x: T } { return { x }; }",
      "const arrow = x => { return x; };",
      "const expr = (x) => x + 1;",
    ].join("\n");
    const fns = lib.functions(text).map((f) => `${f.kind}:${f.name}:${f.exported ? "exp" : "-"}:${f.async ? "async" : "-"}:${f.params.join("|")}`);
    expect(fns).toEqual([
      "function:handle:exp:async:request|parts",
      "function:helper:-:-:x",
      "arrow:other:exp:async:req",
      "function:main:exp:-:|rest",
      "method:constructor:-:-:v",
      "method:get:-:async:key",
      "function:typed:exp:-:x|y",
      "arrow:arrow:-:-:x",
    ]);
    const handle = lib.functions(HANDLER)[0]!;
    expect(handle.header).toBe("export async function handle(request, parts)");
    expect(handle.line).toBe(5);
    expect(handle.body).toContain("return json({ items: ITEMS });");
  });

  it("insertAtStart: puts the statement first in every matched body, indented, and is idempotent", () => {
    const out = twice("src/r.js", HANDLER, [lib.insertAtStart({ exported: true }, guard)]);
    expect(out.findings).toEqual([]);
    expect(out.text).toContain("export async function handle(request, parts) {\n  const denied = requireAuth(request);\n  if (denied) return denied;\n  if (request.method");
    expect(out.text).toContain("export const other = async (req) => {\n  const denied = requireAuth(req);\n  if (denied) return denied;\n  return json");
    expect(out.text).toContain("function helper(x) { return x; }"); // not exported: untouched
    expect(lib.parseProblem("src/r.js", out.text)).toBeUndefined();
  });

  it("insertAtStart: a one-line or empty body gets its own lines; a skip (undefined) leaves the function", () => {
    const out = twice("a.ts", "function f(a: number) { return a; }\nfunction g() {}\n", [lib.insertAtStart(/^[fg]$/, (fn) => (fn.name === "g" ? undefined : "check(a);"))]);
    expect(out.text).toBe("function f(a: number) {\n  check(a);\n  return a; }\nfunction g() {}\n");
  });

  it("wrapBody: wraps every matched body and is idempotent", () => {
    const out = twice("src/r.js", HANDLER, [lib.wrapBody("handle", "try {", "} catch (error) {\n  return json({ error: String(error) }, 500);\n}")]);
    expect(out.findings).toEqual([]);
    expect(out.text).toContain("export async function handle(request, parts) {\n  try {\n    if (request.method");
    expect(out.text).toContain("  } catch (error) {\n    return json({ error: String(error) }, 500);\n  }\n}");
    // The template literal's text is unchanged.
    expect(out.text).toContain("made ${parts.length}");
    expect(lib.parseProblem("src/r.js", out.text)).toBeUndefined();
  });

  it("addImport: adds a new import after the last one, merges into an existing import of the module, and is idempotent", () => {
    const out = twice("src/resources/r.js", HANDLER, [
      lib.addImport({ from: lib.relativeImport("src/resources/r.js", "src/contracts/auth.js"), names: ["requireAuth"] }),
      lib.addImport({ from: "../contracts/response.js", names: ["json", "problem"] }),
    ]);
    expect(out.text.split("\n").slice(0, 3)).toEqual(['import { json, problem } from "../contracts/response.js";', 'import { requireAuth } from "../contracts/auth.js";', ""]);
    expect(out.applied).toBe(2);
    // Already imported: nothing to do.
    expect(lib.applyEdits("src/r.js", out.text, [lib.addImport({ from: "../contracts/auth.js", names: ["requireAuth"] })]).applied).toBe(0);
    // No import yet: after a leading comment block, before the code.
    const bare = twice("x.js", "// header\n\nexport const a = 1;\n", [lib.addImport({ from: "./y.js", default: "y", names: ["z"] })]);
    expect(bare.text).toBe('// header\n\nimport y, { z } from "./y.js";\nexport const a = 1;\n');
  });

  it("relativeImport: the specifier between repo files", () => {
    expect(lib.relativeImport("src/resources/users.js", "src/contracts/auth.js")).toBe("../contracts/auth.js");
    expect(lib.relativeImport("src/a.js", "src/b.js")).toBe("./b.js");
  });

  it("replaceOnce: replaces a unique snippet, refuses an ambiguous or missing one, and is idempotent (even when the replacement contains the snippet)", () => {
    const out = twice("src/r.js", HANDLER, [lib.replaceOnce("const ITEMS = [];", "const ITEMS = []; // store")]);
    expect(out.text).toContain("const ITEMS = []; // store\n");
    const wrapping = twice("src/r.js", HANDLER, [lib.replaceOnce("return x;", "return audit(x);")]);
    expect(wrapping.text).toContain("function helper(x) { return audit(x); }");
    const ambiguous = lib.applyEdits("src/r.js", HANDLER, [lib.replaceOnce("return", "yield")]);
    expect(ambiguous.text).toBe(HANDLER);
    expect(ambiguous.findings).toEqual([expect.stringMatching(/matches 4 places \(ambiguous\); refused/)]);
    const missing = lib.applyEdits("src/r.js", HANDLER, [lib.replaceOnce("nowhere", "x")]);
    expect(missing.findings).toEqual([expect.stringMatching(/was not found/)]);
  });

  it("refuses any edit whose result would not parse, keeping the others", () => {
    const out = lib.applyEdits("src/r.js", HANDLER, [
      lib.insertAtStart("handle", "if (request {"),
      lib.replaceOnce("const ITEMS = [];", "const ITEMS = [;"),
      lib.wrapBody("helper", "try {", "} catch {"),
      lib.insertAtStart("helper", "x = x || 0;"),
    ]);
    expect(out.findings).toEqual([
      expect.stringMatching(/^insert-start handle \(line 5\): the result would not parse/),
      expect.stringMatching(/^replaceOnce: the result would not parse/),
      expect.stringMatching(/^wrap-body helper \(line 12\): the result would not parse/),
    ]);
    expect(out.applied).toBe(1);
    expect(out.text).toContain("function helper(x) {\n  x = x || 0;\n  return x; }");
    expect(lib.parseProblem("src/r.js", out.text)).toBeUndefined();
  });

  it("leaves a file that does not parse as it was, with a finding; reports a target nothing matches", () => {
    const broken = "export function a() {\n";
    const out = lib.applyEdits("a.js", broken, [lib.insertAtStart({ exported: true }, "x();")]);
    expect(out.text).toBe(broken);
    expect(out.findings).toEqual([expect.stringMatching(/does not parse before any edit/)]);
    expect(lib.applyEdits("src/r.js", HANDLER, [lib.insertAtStart("nothing", "x();")]).findings).toEqual([expect.stringMatching(/no function matches nothing/)]);
    expect(lib.applyEdits("src/r.js", HANDLER, [{ op: 1 }, "text"]).findings).toHaveLength(2);
    // Structural edits need a JS/TS file; a snippet replace works anywhere.
    expect(lib.applyEdits("README.md", "# a\n", [lib.insertAtStart("a", "x")]).findings).toEqual([expect.stringMatching(/not a JavaScript or TypeScript file/)]);
    expect(lib.applyEdits("README.md", "# a\n", [lib.replaceOnce("# a", "# b")]).text).toBe("# b\n");
  });

  it("parses like the tool gate: TypeScript through Node's parser, JSON with JSON.parse, unbalanced brackets refused", () => {
    expect(lib.parseProblem("a.ts", "export function f(a: number): number { return a; }\nenum E { A }\n")).toBeUndefined();
    expect(lib.parseProblem("a.ts", "export function f(a: number: number {")).toMatch(/./);
    expect(lib.parseProblem("a.js", "const t = `x ${`y ${1}`} z`;\nconst r = /[}]/;\n")).toBeUndefined();
    expect(lib.parseProblem("a.js", "function f() {\n  return 1;\n")).toMatch(/never closed/);
    expect(lib.parseProblem("a.json", "{")).toMatch(/JSON/);
  });
});
