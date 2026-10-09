/**
 * A tool's own gate, per kind, and the isolation every tool run gets. Real
 * tools (tiny Node scripts) run as child processes over copies of a fixture
 * baseline: no network, no model, deterministic.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseToolFindings, runToolGate, runToolInCopy, skeletonRegions, spliceRegions, syntaxProblem, toolSkeleton, validToolArg, type ToolGateKind } from "../src/index.ts";

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-toolgate-test-"));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

/** The original code a tool proves itself on: two TODOs in src, one file outside its scope. */
const baseline = () =>
  tree({
    "src/a.ts": "export function a(x: number): number {\n  // TODO validate\n  return x;\n}\n",
    "src/b.ts": "export const b = 2;\n",
    "lib/c.ts": "// TODO elsewhere\n",
  });

const PASSING_TEST = 'import test from "node:test";\ntest("works", () => {});\n';
const FAILING_TEST = 'import test from "node:test";\nimport assert from "node:assert";\ntest("works", () => { assert.equal(1, 2); });\n';

/** A JS snippet: walk(dir) lists files under the cwd (skipping .git). */
const WALK = `
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === ".git" ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
const files = (process.argv.length > 2 ? process.argv.slice(2) : walk(".")).map((f) => f.replace(/^\\.\\//, "")).sort();
`;

const SCANNER = `${WALK}
for (const f of files.filter((f) => f.startsWith("src/"))) {
  readFileSync(f, "utf8").split("\\n").forEach((l, i) => { if (l.includes("TODO")) console.log(JSON.stringify({ path: f, line: i + 1, message: "a TODO remains" })); });
}
`;

const tool = (capability: string, run: string, test = PASSING_TEST, extra: Record<string, string> = {}) =>
  tree({ [`tools/${capability}/run.mjs`]: run, [`tools/${capability}/test.mjs`]: test, ...extra });

async function gate(kind: ToolGateKind, run: string, options: { inputs?: string[]; test?: string; extra?: Record<string, string>; timeoutMs?: number } = {}) {
  const capability = `t-${kind}`;
  return runToolGate({
    toolCheckoutDir: await tool(capability, run, options.test, options.extra),
    capability,
    kind,
    inputs: options.inputs ?? ["src/**"],
    baselineDir: await baseline(),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

const failed = (result: Awaited<ReturnType<typeof gate>>) => result.checks.filter((c) => !c.passed).map((c) => c.check);

describe("a tool's own gate", () => {
  it("scanner: passes when its tests pass, it runs clean, prints only JSON-line findings, and FINDS something on the baseline", async () => {
    const result = await gate("scanner", SCANNER);
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.check)).toEqual(["layout", "filled", "tests", "baseline-run", "output-format", "finds", "read-only"]);
    expect(result.findings).toEqual([{ path: "src/a.ts", line: 2, message: "a TODO remains" }]);
    expect(result.output).toBe("");
  });

  it("scanner: one that finds nothing on the baseline proves nothing and is not published", async () => {
    const result = await gate("scanner", `${WALK}\n// finds nothing\n`);
    expect(result.passed).toBe(false);
    expect(failed(result)).toEqual(["finds"]);
    expect(result.checks.find((c) => c.check === "finds")!.detail).toMatch(/proves nothing/);
  });

  it("scanner: output that is not machine-readable, a non-zero exit, or a changed file fails it", async () => {
    expect(failed(await gate("scanner", `${SCANNER}\nconsole.log("done scanning");\n`))).toEqual(["output-format"]);
    expect(failed(await gate("scanner", `${SCANNER}\nprocess.exit(3);\n`))).toEqual(["baseline-run"]);
    expect(failed(await gate("scanner", `${SCANNER}\nwriteFileSync("src/a.ts", "changed");\n`))).toEqual(["read-only"]);
  });

  it("check: counts only when it FAILS on the original code, naming a violation (a crash is not a failing check)", async () => {
    const check = `${SCANNER}\nprocess.exitCode = files.some((f) => f.startsWith("src/") && readFileSync(f, "utf8").includes("TODO")) ? 1 : 0;\n`;
    const result = await gate("check", check);
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.check)).toEqual(["layout", "filled", "tests", "fails-on-baseline", "output-format", "finds", "read-only"]);
    // Passing on the original code: it checks nothing.
    const lenient = await gate("check", `${WALK}\nprocess.exitCode = 0;\n`);
    expect(failed(lenient)).toEqual(["fails-on-baseline", "finds"]);
    // A crash exits non-zero but names no violation.
    expect(failed(await gate("check", "throw new Error('boom');\n"))).toEqual(["finds"]);
  });

  it("codemod: must change a baseline file inside its inputs, delete nothing, and leave valid syntax", async () => {
    const codemod = `${WALK}\nfor (const f of files.filter((f) => f.startsWith("src/"))) { const s = readFileSync(f, "utf8"); writeFileSync(f, s.replace("// TODO validate", "if (!Number.isFinite(x)) throw new TypeError('x');")); }\n`;
    const result = await gate("codemod", codemod);
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.check)).toEqual(["layout", "filled", "tests", "baseline-run", "changes-baseline", "in-scope", "syntax"]);
    expect(result.changed).toEqual(["src/a.ts"]);

    expect(failed(await gate("codemod", `${WALK}\n// changes nothing\n`))).toEqual(["changes-baseline"]);
    const outside = `${codemod}\nwriteFileSync("lib/c.ts", "// rewritten\\n");\n`;
    expect(failed(await gate("codemod", outside))).toEqual(["in-scope"]);
    const broken = `${WALK}\nwriteFileSync("src/b.ts", "export const b = (;\\n");\n`;
    const syntax = await gate("codemod", broken);
    expect(failed(syntax)).toEqual(["syntax"]);
    expect(syntax.checks.find((c) => c.check === "syntax")!.detail).toMatch(/src\/b\.ts/);
    const deletes = `${codemod}\nimport { rmSync } from "node:fs"; rmSync("src/b.ts");\n`;
    expect(failed(await gate("codemod", deletes))).toEqual(["in-scope"]);
  });

  it("every kind: its own tests must exist and pass, and it may only live in its own directory", async () => {
    expect(failed(await gate("scanner", SCANNER, { test: FAILING_TEST }))).toEqual(["tests"]);
    const noTests = await runToolGate({
      toolCheckoutDir: await tree({ "tools/t-scanner/run.mjs": SCANNER }),
      capability: "t-scanner",
      kind: "scanner",
      inputs: [],
      baselineDir: await baseline(),
    });
    expect(failed(noTests)).toEqual(["layout"]);
    expect(noTests.checks[0]!.detail).toMatch(/must test itself/);
    expect(failed(await gate("scanner", SCANNER, { extra: { "tools/other/run.mjs": "" } }))).toEqual(["layout"]);
  });
});

describe("tool runs are contained like gate commands", () => {
  it("a tool never sees a credential from the parent environment and gets a private HOME and TMPDIR", async () => {
    const capability = "env-dump";
    const toolDir = await tool(capability, "console.log(JSON.stringify(process.env));\n");
    const parentEnv = { ...process.env, CLOUDFLARE_API_TOKEN: "cf-secret-123456", AI_GATEWAY_TOKEN: "gw-secret-654321", SWITCHYARD_API_TOKEN: "bearer-999999" };
    const run = await runToolInCopy({ toolCheckoutDir: toolDir, capability, layers: [await baseline()], parentEnv });
    try {
      expect(run.exit).toBe(0);
      expect(run.stdout).not.toMatch(/cf-secret|gw-secret|bearer-999/);
      const env = JSON.parse(run.stdout) as Record<string, string>;
      expect(env.HOME).not.toBe(process.env.HOME);
      expect(env.TMPDIR).toBeDefined();
      expect(Object.keys(env).some((k) => /TOKEN|ACCOUNT/.test(k))).toBe(false);
    } finally {
      await run.dispose();
    }
  });

  it("a tool that writes outside its working tree only writes into its private scratch root, which is removed; the source tree is untouched", async () => {
    const capability = "escape";
    const toolDir = await tool(
      capability,
      'import { writeFileSync } from "node:fs";\nwriteFileSync("../escaped.txt", "x");\nwriteFileSync("../../escaped-too.txt", "x");\nwriteFileSync("src/a.ts", "overwritten");\n',
    );
    const source = await baseline();
    const before = await readFile(join(source, "src/a.ts"), "utf8");
    const run = await runToolInCopy({ toolCheckoutDir: toolDir, capability, layers: [source] });
    expect(run.modified).toEqual(["src/a.ts"]);
    expect(run.created).toEqual([]);
    await run.dispose();
    // The real tree and its parent never saw any of it.
    expect(await readFile(join(source, "src/a.ts"), "utf8")).toBe(before);
    expect(await readdir(dirname(source))).not.toContain("escaped.txt");
    expect(await readdir(dirname(source))).not.toContain("escaped-too.txt");
  });

  it("a tool that hangs is stopped at the timeout (its whole process group is killed) and fails its gate", async () => {
    const hang = 'import { spawn } from "node:child_process";\nspawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n';
    const started = Date.now();
    const result = await gate("scanner", hang, { timeoutMs: 1500 });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(result.passed).toBe(false);
    expect(failed(result)).toEqual(["baseline-run"]);
    expect(result.checks.find((c) => c.check === "baseline-run")!.detail).toMatch(/timed out/);
  });

  it("refuses arguments that are not repo-relative paths", async () => {
    expect(validToolArg("src/a.ts")).toBe(true);
    for (const bad of ["/etc/passwd", "../x", "src/../../x", "--inspect", "", "a\\b"]) {
      expect(validToolArg(bad)).toBe(false);
    }
    const toolDir = await tool("t", SCANNER);
    await expect(runToolInCopy({ toolCheckoutDir: toolDir, capability: "t", layers: [await baseline()], args: ["../outside"] })).rejects.toThrow(/repo-relative/);
  });
});

describe("findings and syntax helpers", () => {
  it("parses JSON-line findings strictly", () => {
    expect(parseToolFindings('{"path":"src/a.ts","line":2,"message":"m"}\n\n{"path":"/abs","message":"m"}\nplain text\n{"path":"a","message":"m","extra":1}\n')).toEqual({
      findings: [{ path: "src/a.ts", line: 2, message: "m" }],
      invalidLines: 3,
      dropped: 0,
    });
  });

  it("checks JS/TS syntax with a parser (nothing executes) and JSON with JSON.parse", async () => {
    expect(await syntaxProblem("a.ts", "export function f(a: number): number { return a; }\nenum E { A }\n")).toBeUndefined();
    expect(await syntaxProblem("a.ts", "export function f(a: number: number {")).toMatch(/./);
    expect(await syntaxProblem("a.json", '{"a":1}')).toBeUndefined();
    expect(await syntaxProblem("a.json", "{")).toMatch(/JSON/);
    expect(await syntaxProblem("a.md", "# anything")).toBe("unchecked");
  });
});

describe("the runtime's tool skeleton", () => {
  it.each(["scanner", "codemod", "check", "index"] as const)("an unfilled %s skeleton parses but can never pass its own gate", async (kind) => {
    const capability = `sk-${kind}`;
    const files = toolSkeleton(kind, capability, ["src/**"]);
    expect(await syntaxProblem("run.mjs", files["run.mjs"]!)).toBeUndefined();
    expect(await syntaxProblem("test.mjs", files["test.mjs"]!)).toBeUndefined();
    const toolDir = await tree(Object.fromEntries(Object.entries(files).map(([name, body]) => [`tools/${capability}/${name}`, body])));
    const result = await runToolGate({ toolCheckoutDir: toolDir, capability, kind, inputs: ["src/**"], baselineDir: await baseline() });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.check === "filled")).toMatchObject({ passed: false });
    expect(result.checks.find((c) => c.check === "filled")!.detail).toMatch(/SWITCHYARD-TOOL-SKELETON/);
  });

  it("a filled skeleton with one FILL marker left still fails", async () => {
    const files = toolSkeleton("scanner", "half", []);
    const run = files["run.mjs"]!.split("\n").filter((l) => !l.includes("SWITCHYARD-TOOL-SKELETON")).join("\n");
    const toolDir = await tree({ "tools/half/run.mjs": run, "tools/half/test.mjs": PASSING_TEST });
    const result = await runToolGate({ toolCheckoutDir: toolDir, capability: "half", kind: "scanner", inputs: [], baselineDir: await baseline() });
    expect(result.checks.find((c) => c.check === "filled")).toMatchObject({ passed: false });
  });
});

describe("a codemod built on the runtime's edit helpers", () => {
  /** The codemod skeleton with its two decision regions filled, as a tools checkout. */
  async function filledCodemod(capability: string, plan: string, expectChange: string): Promise<string> {
    const files = toolSkeleton("codemod", capability, ["src/**"]);
    const filled: Record<string, string> = {};
    for (const [name, body] of Object.entries(files)) {
      const regions = skeletonRegions(body);
      filled[`tools/${capability}/${name}`] = regions.length === 0 ? body : spliceRegions(body, regions.map((r) => ({ name: r.name, code: r.name === "plan" ? plan : expectChange })));
    }
    return tree(filled);
  }

  it("ships lib/edit.mjs (no marker in it), and a decision-only fill passes its own gate: its test ran on a copy of the original code", async () => {
    const files = toolSkeleton("codemod", "guard", ["src/**"]);
    expect(Object.keys(files).sort()).toEqual(["README.md", "lib/edit.mjs", "run.mjs", "test.mjs"]);
    expect(files["lib/edit.mjs"]).not.toMatch(/FILL-(?:BEGIN|END)|SWITCHYARD-TOOL-SKELETON/);
    const toolDir = await filledCodemod(
      "guard",
      ["function plan(path, text, edit) {", "  return [edit.insertAtStart({ exported: true }, (fn) => `check(${fn.params[0]});`)];", "}"].join("\n"),
      ["function expectChange(path, before, after) {", '  assert.match(after, /check\\(x\\);/, path);', "}"].join("\n"),
    );
    const base = await baseline();
    const result = await runToolGate({ toolCheckoutDir: toolDir, capability: "guard", kind: "codemod", inputs: ["src/**"], baselineDir: base });
    expect(result.checks.map((c) => `${c.check}:${c.passed}`)).toEqual(["layout:true", "filled:true", "tests:true", "baseline-run:true", "changes-baseline:true", "in-scope:true", "syntax:true"]);
    expect(result.changed).toEqual(["src/a.ts"]);
    // The gate's baseline itself was never written (the test got a copy).
    expect(await readFile(join(base, "src/a.ts"), "utf8")).toBe("export function a(x: number): number {\n  // TODO validate\n  return x;\n}\n");
  });

  it("an edit that would break the file is skipped by the helpers, so the file stays valid and the gate fails honestly on changing nothing", async () => {
    const toolDir = await filledCodemod(
      "broken",
      ["function plan(path, text, edit) {", '  return [edit.insertAtStart({ exported: true }, "if (x {")];', "}"].join("\n"),
      ["function expectChange(path, before, after) {", "  assert.ok(after);", "}"].join("\n"),
    );
    const result = await runToolGate({ toolCheckoutDir: toolDir, capability: "broken", kind: "codemod", inputs: ["src/**"], baselineDir: await baseline() });
    expect(result.passed).toBe(false);
    expect(failed(result)).toEqual(["tests", "changes-baseline"]);
    expect(result.checks.find((c) => c.check === "syntax")).toMatchObject({ passed: true });
    expect(result.output).toMatch(/the result would not parse/);
  });

  it("a non-idempotent plan fails its own test (a second run must change nothing)", async () => {
    const toolDir = await filledCodemod(
      "grows",
      // Decision logic that is NOT idempotent: a fresh statement every run.
      ["function plan(path, text, edit) {", "  const n = (text.match(/tick\\(/g) || []).length;", "  return [edit.insertAtStart({ exported: true }, `tick(${n});`)];", "}"].join("\n"),
      ["function expectChange(path, before, after) {", "  assert.match(after, /tick\\(/);", "}"].join("\n"),
    );
    const result = await runToolGate({ toolCheckoutDir: toolDir, capability: "grows", kind: "codemod", inputs: ["src/**"], baselineDir: await baseline() });
    expect(failed(result)).toEqual(["tests"]);
    expect(result.output).toMatch(/a second run must change nothing/);
  });
});

describe("splicing region fills on the skeleton's own markers", () => {
  const run = toolSkeleton("codemod", "fix", ["src/**"])["run.mjs"]!;

  it("lists each region with its signature", () => {
    expect(skeletonRegions(run)).toEqual([{ name: "plan", guidance: expect.stringMatching(/Decision logic only/), signature: "function plan(path, text, edit)" }]);
    expect(skeletonRegions(toolSkeleton("codemod", "fix", ["src/**"])["test.mjs"]!)).toEqual([{ name: "expectChange", guidance: expect.stringMatching(/ONE file the codemod changed/), signature: "function expectChange(path, before, after)" }]);
    expect(skeletonRegions(toolSkeleton("scanner", "s", [])["test.mjs"]!)).toEqual([{ name: "fixture", guidance: expect.stringMatching(/write a small file/), signature: "" }]);
  });

  it("replaces a region between its markers and removes the skeleton line once every region is filled", async () => {
    const out = spliceRegions(run, [{ name: "plan", code: 'function plan(path, text, edit) {\n  return [edit.replaceOnce("var ", "let ")];\n}' }]);
    expect(out).not.toMatch(/FILL-(BEGIN|END)|SWITCHYARD-TOOL-SKELETON/);
    expect(out).toContain('return [edit.replaceOnce("var ", "let ")];');
    expect(await syntaxProblem("run.mjs", out)).toBeUndefined();
  });

  it("refuses an unknown region, a region filled twice, broken markers, and code that carries a marker", () => {
    expect(() => spliceRegions(run, [{ name: "detect", code: "x" }])).toThrow(/no FILL region named detect/);
    expect(() => spliceRegions(run, [{ name: "plan", code: "a" }, { name: "plan", code: "b" }])).toThrow(/filled twice/);
    const doubled = run.replace("// FILL-END plan", "// FILL-END plan\n// FILL-BEGIN plan: again\n// FILL-END plan");
    expect(() => spliceRegions(doubled, [{ name: "plan", code: "a" }])).toThrow(/missing, duplicated, or out of order/);
    expect(() => spliceRegions(run, [{ name: "plan", code: "// FILL-END plan" }])).toThrow(/contains a skeleton marker/);
  });

  it("a partial fill keeps the skeleton line, so the gate still refuses it", () => {
    const test = toolSkeleton("scanner", "s", [])["test.mjs"]!;
    const run2 = toolSkeleton("scanner", "s", [])["run.mjs"]!;
    expect(spliceRegions(run2, [{ name: "detect", code: "function detect(path, text) { return []; }" }])).not.toContain("SWITCHYARD-TOOL-SKELETON");
    expect(spliceRegions(test, [])).toContain("SWITCHYARD-TOOL-SKELETON");
  });
});
