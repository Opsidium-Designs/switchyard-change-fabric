/**
 * tool-gate: running agent-built tools, and the gate a tool must pass before it
 * is published for other agents.
 *
 * A tool is code one agent wrote and other agents will run, so it runs exactly
 * like a gate command: the allowlisted environment (no credential), a private
 * HOME and temp dir, its own process group killed at the timeout or when its
 * output overflows, and never in a real checkout. Every run happens in a fresh
 * COPY of the tree it acts on (the baseline for its gate, the consumer's own
 * view for a use) under a private scratch root, so a tool that writes outside
 * its directory (`../x`) writes into that scratch root, which is removed. What
 * it changed is read back by comparing the copy before and after the run; the
 * caller decides what (if anything) is kept.
 *
 * The tool contract (generic, any repo): a tool lives in
 * `tools/<capability>/` of the Change's tools repo, its entry point is
 * `tools/<capability>/run.mjs` (a Node ES module), it is run as
 * `node tools/<capability>/run.mjs [paths...]` with the target tree as its
 * working directory (no paths: the whole tree), and its own tests are the
 * `tools/<capability>/test*` files, run with `node --test`. A scanner or a
 * check reports findings as JSON lines `{"path", "line"?, "message"}` on
 * stdout.
 *
 * The gate, by kind (a tool that cannot prove it does something proves
 * nothing):
 *   - every kind: its own tests pass; the layout is only its own directory;
 *   - scanner: runs clean on the baseline (exit 0, bounded output), prints
 *     only machine-readable findings, FINDS at least one, changes nothing;
 *   - check: FAILS on the baseline (a non-zero exit with at least one
 *     machine-readable violation, so a crash does not count), changes nothing;
 *   - codemod: runs clean on the baseline and changes at least one existing
 *     baseline file, only inside its declared scope (its inputs), deletes
 *     nothing, and leaves every file it touched syntactically valid (plus the
 *     project's declared check command, when one is given);
 *   - harness, repro, index: run clean on the baseline without changing any
 *     existing baseline file.
 *
 * Residual risk (the same as for gates): same-user isolation is not complete.
 * A tool can READ files the OS user can read by absolute path, and a child that
 * leaves its process group with `setsid` survives the group kill. The real fix
 * is a sandbox (a separate user or container), out of scope here.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ChildProcessCommandRunner, type CommandOutcome } from "./command.ts";
import { matchesAny } from "./pathscope.ts";

/** The tool kinds (mirrors the board's vocabulary). */
export type ToolGateKind = "scanner" | "codemod" | "check" | "harness" | "repro" | "index";

/** The entry point every tool exposes, inside its own directory. */
export const TOOL_ENTRY = "run.mjs";

/** Directories never copied into a tool's working tree (and never read back). */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "coverage", ".wrangler"]);

/**
 * The marker of an UNFILLED tool skeleton. The runtime writes a skeleton as
 * the first commit of a tool's branch (an executor that only makes anchored
 * edits cannot create files); every file of it carries this marker line and
 * FILL-BEGIN/FILL-END regions, and the gate refuses any tool that still has
 * one, so an unfilled skeleton can never be published.
 */
export const TOOL_SKELETON_MARKER = "SWITCHYARD-TOOL-SKELETON";
const FILL_MARKER = /FILL-(?:BEGIN|END)\b/;

/**
 * The edit helpers the runtime ships with every codemod skeleton (at
 * `tools/<capability>/lib/edit.mjs`): safe, re-parse-validated, idempotent
 * edit primitives, so a codemod's own code only DECIDES what to change.
 */
export const TOOL_EDIT_LIB = "lib/edit.mjs";

let editLibSource: string | undefined;

/** The source of the codemod edit helpers (read once, from this package). */
export function toolEditLibSource(): string {
  editLibSource ??= readFileSync(new URL("./tool-lib/edit.mjs", import.meta.url), "utf8");
  return editLibSource;
}

/**
 * The variable a tool's own tests see during its gate: a fresh COPY of the
 * original code the tool proves itself on (never the gate's baseline itself),
 * so a codemod's test exercises real files in its scope instead of a
 * hand-written fixture.
 */
export const TOOL_BASELINE_ENV = "SWITCHYARD_TOOL_BASELINE";

/** The repo-relative entry path of a tool. */
export function toolEntryPath(capability: string): string {
  return `tools/${capability}/${TOOL_ENTRY}`;
}

/** How a consumer runs a tool (recorded with its publication). */
export function toolUsage(capability: string): string {
  return `node ${toolEntryPath(capability)} [paths...]  (cwd: the tree it acts on; no paths: the whole tree)`;
}

/** The default limit on one tool run (and on a tool's own tests). */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const DEFAULT_TOOL_TEST_TIMEOUT_MS = 120_000;
/** The most output a tool run may write per stream before it is stopped. */
export const DEFAULT_TOOL_MAX_OUTPUT = 1024 * 1024;
/** The findings a run reports at most (the board bounds them the same way). */
export const MAX_TOOL_FINDINGS = 64;

/** One finding a scanner or check printed. */
export interface ToolFinding {
  readonly path: string;
  readonly line?: number;
  readonly message: string;
}

/** Isolation settings for a tool run. */
export interface ToolRunLimits {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** The environment to allowlist from (default process.env); a credential in it never reaches the tool. */
  readonly parentEnv?: NodeJS.ProcessEnv;
  /** The node binary (default: the running one). */
  readonly nodePath?: string;
}

/** What one isolated tool run did. */
export interface ToolRunResult {
  readonly exit: number | null;
  /** Why the run was stopped (timeout, output overflow), when it was. */
  readonly stopped?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly findings: readonly ToolFinding[];
  /** Non-empty stdout lines that were not a well-formed finding. */
  readonly invalidLines: number;
  /** Findings beyond MAX_TOOL_FINDINGS (counted, not kept). */
  readonly droppedFindings: number;
  /** Existing files whose content changed, files created, files deleted (repo-relative, sorted). */
  readonly modified: readonly string[];
  readonly created: readonly string[];
  readonly deleted: readonly string[];
  /** Read a changed or created file's new content (before `dispose`). */
  readonly read: (path: string) => Promise<Buffer>;
  /** Remove the run's private scratch root. */
  readonly dispose: () => Promise<void>;
}

/** A repo-relative path a tool may be given as an argument (no absolute path, no `..`, no option). */
export function validToolArg(arg: string): boolean {
  if (arg === "" || arg.length > 512 || arg.startsWith("-") || arg.startsWith("/") || arg.includes("\\") || arg.includes("\0")) {
    return false;
  }
  return arg.split("/").every((seg) => seg !== ".." && seg !== "");
}

/** Copy the layers (later ones overlaid on earlier ones) into `dest`, skipping VCS and build dirs and symlinks. */
export async function materializeToolTree(layers: readonly string[], dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const layer of layers) {
    for (const rel of await listFiles(layer)) {
      await mkdir(dirname(join(dest, rel)), { recursive: true });
      await cp(join(layer, rel), join(dest, rel));
    }
  }
}

/** Regular files under `dir`, repo-relative and sorted (skipping VCS/build dirs and symlinks). */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(path);
        }
      } else if (entry.isFile()) {
        out.push(path);
      }
    }
  };
  await walk("");
  return out.sort();
}

async function hashTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rel of await listFiles(dir)) {
    const info = await lstat(join(dir, rel)).catch(() => undefined);
    if (info?.isFile()) {
      out.set(rel, createHash("sha256").update(await readFile(join(dir, rel))).digest("hex"));
    }
  }
  return out;
}

/**
 * Parse a tool's stdout as JSON-lines findings. Every non-empty line must be a
 * JSON object `{path, line?, message}` with a repo-relative path; anything else
 * counts as an invalid line.
 */
export function parseToolFindings(stdout: string): { findings: ToolFinding[]; invalidLines: number; dropped: number } {
  const findings: ToolFinding[] = [];
  let invalidLines = 0;
  let dropped = 0;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    const v = value as Record<string, unknown>;
    const ok =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof v.path === "string" &&
      validToolArg(v.path) &&
      typeof v.message === "string" &&
      v.message.trim() !== "" &&
      (v.line === undefined || (typeof v.line === "number" && Number.isInteger(v.line) && v.line >= 1)) &&
      Object.keys(v).every((k) => k === "path" || k === "line" || k === "message");
    if (!ok) {
      invalidLines += 1;
      continue;
    }
    if (findings.length >= MAX_TOOL_FINDINGS) {
      dropped += 1;
      continue;
    }
    findings.push({
      path: v.path as string,
      ...(v.line !== undefined ? { line: v.line as number } : {}),
      message: (v.message as string).trim().slice(0, 200),
    });
  }
  return { findings, invalidLines, dropped };
}

/** A runner for one tool command: allowlisted env, private HOME, bounded time and output, process-group kill. */
function isolatedRunner(home: string, limits: ToolRunLimits, timeoutMs: number, extraEnv?: Readonly<Record<string, string>>): ChildProcessCommandRunner {
  return new ChildProcessCommandRunner({
    timeoutMs,
    maxBuffer: limits.maxOutputBytes ?? DEFAULT_TOOL_MAX_OUTPUT,
    parentEnv: { ...(limits.parentEnv ?? process.env), HOME: home, CI: "1" },
    ...(extraEnv ? { extraEnv } : {}),
  });
}

/** Options for one isolated run of a tool over a tree. */
export interface RunToolOptions extends ToolRunLimits {
  /** A checkout of the tools repo at the tool's commit. */
  readonly toolCheckoutDir: string;
  readonly capability: string;
  /** The tree the tool acts on, as layers (a later layer overlays an earlier one). */
  readonly layers: readonly string[];
  /** Repo-relative paths passed to the tool (validated). */
  readonly args?: readonly string[];
  /** Where the private scratch root is made (default: the OS temp dir). */
  readonly scratchParent?: string;
}

/**
 * Run a tool once over a COPY of the given tree, isolated like a gate command,
 * and report its exit, its findings, and every file it changed in the copy.
 * The caller reads changed content through `read` and must call `dispose`.
 */
export async function runToolInCopy(options: RunToolOptions): Promise<ToolRunResult> {
  const args = options.args ?? [];
  const bad = args.filter((a) => !validToolArg(a));
  if (bad.length > 0 || args.length > 64) {
    throw new Error(`tool arguments must be at most 64 repo-relative paths (refused: ${bad.slice(0, 4).join(", ")})`);
  }
  const root = await mkdtemp(join(options.scratchParent ?? tmpdir(), "scf-tool-"));
  const dispose = () => rm(root, { recursive: true, force: true }).catch(() => undefined);
  try {
    const target = join(root, "work", "target");
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    await materializeToolTree(options.layers, target);
    const before = await hashTree(target);
    const runner = isolatedRunner(home, options, options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
    const started = Date.now();
    const outcome = await runner.run([options.nodePath ?? process.execPath, join(options.toolCheckoutDir, toolEntryPath(options.capability)), ...args], target);
    const durationMs = Date.now() - started;
    const after = await hashTree(target);
    const modified: string[] = [];
    const created: string[] = [];
    const deleted: string[] = [];
    for (const [rel, hash] of after) {
      const was = before.get(rel);
      if (was === undefined) {
        created.push(rel);
      } else if (was !== hash) {
        modified.push(rel);
      }
    }
    for (const rel of before.keys()) {
      if (!after.has(rel)) {
        deleted.push(rel);
      }
    }
    const parsed = parseToolFindings(outcome.stdout);
    const stopped = outcome.code === null ? stoppedReason(outcome) : undefined;
    return {
      exit: outcome.code,
      ...(stopped !== undefined ? { stopped } : {}),
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      durationMs,
      findings: parsed.findings,
      invalidLines: parsed.invalidLines,
      droppedFindings: parsed.dropped,
      modified: modified.sort(),
      created: created.sort(),
      deleted: deleted.sort(),
      read: (path: string) => readFile(join(target, path)),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function stoppedReason(outcome: CommandOutcome): string {
  const line = outcome.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .at(-1);
  return line ?? "the tool did not exit normally";
}

/**
 * The skeleton of a tool, by kind: run.mjs and test.mjs with the CLI, the
 * scope handling, the output format, and the test harness already in place,
 * and FILL regions (between `// FILL-BEGIN <name>` and `// FILL-END <name>`)
 * for what the tool must do. Every unfilled function throws, the test fails,
 * and the gate's `filled` check refuses it until the marker line and every
 * FILL line are gone.
 *
 * A codemod's regions hold DECISION logic only: `plan` returns edits built
 * with the runtime's edit helpers (`lib/edit.mjs`, shipped with the skeleton),
 * which apply them re-parse-validated and idempotently, and `expectChange`
 * asserts what one changed file must now contain. Its test runs the codemod
 * on a copy of the original code (the gate's `SWITCHYARD_TOOL_BASELINE`) and
 * checks that it changes something, that every changed file parses, and that
 * a second run changes nothing.
 */
export function toolSkeleton(kind: ToolGateKind, capability: string, inputs: readonly string[]): Record<string, string> {
  const marker = `// ${TOOL_SKELETON_MARKER}: complete every FILL region with anchored edits (replace the code between the FILL-BEGIN and FILL-END lines), then delete this line and every FILL-BEGIN/FILL-END line. An unfilled skeleton fails its own gate.`;
  const finds = kind === "scanner" || kind === "check";
  const regions =
    kind === "codemod"
      ? [
          "// The edit helpers (lib/edit.mjs, written by the runtime; never change it). plan() only DECIDES: the",
          "// runtime applies its edits, re-parses the file after each one (an edit that would break it is skipped",
          "// and reported on stderr), and every edit is idempotent, so a second run changes nothing:",
          "//   edit.functions(text): [{ name, kind (function|arrow|method), exported, async, params, header, body, line }]",
          "//   edit.insertAtStart(target, statement): statement first in every matched function body",
          "//   edit.wrapBody(target, before, after): wrap every matched function body",
          "//   edit.addImport({ from, names: [..], default? }): add the import unless it is already there",
          "//   edit.replaceOnce(find, replacement): only when `find` occurs exactly once",
          '//   edit.relativeImport(path, "src/x/y.js"): the import specifier from this file to a repo file',
          "// A target: a function name, a RegExp on the name, (fn) => boolean, or { name, exported, kind, async, pattern, where }.",
          "// A statement (and before/after) is a string, or (fn) => string built from the function (undefined skips it).",
          "// FILL-BEGIN plan: decide the edits for ONE file and return them as an array built with the edit helpers ([] when the file needs nothing). Decision logic only: never read or write a file and never rewrite the text yourself (no string surgery, no regex replace over code).",
          "function plan(path, text, edit) {",
          '  throw new Error("tool skeleton: plan() is not filled in");',
          "}",
          "// FILL-END plan",
        ]
      : finds
        ? [
            "// FILL-BEGIN detect: return the places in one file that need the change, as [{ line, message }] (line is 1-based; message is short).",
            "function detect(path, text) {",
            '  throw new Error("tool skeleton: detect() is not filled in");',
            "}",
            "// FILL-END detect",
          ]
        : [
            "// FILL-BEGIN run: do the tool's work for the given files; never change an existing file.",
            "function work(files) {",
            '  throw new Error("tool skeleton: work() is not filled in");',
            "}",
            "// FILL-END run",
          ];
  const main =
    kind === "codemod"
      ? [
          "let changed = 0;",
          "for (const file of targets()) {",
          '  const before = readFileSync(file, "utf8");',
          "  const result = edit.applyEdits(file, before, plan(file, before, edit));",
          '  for (const finding of result.findings) console.error("codemod: " + finding);',
          "  if (result.text !== before) {",
          '    writeFileSync(file, result.text, "utf8");',
          "    changed += 1;",
          "  }",
          "}",
          'console.error("codemod: changed " + changed + " file(s)");',
        ]
      : finds
        ? [
            "let found = 0;",
            "for (const file of targets()) {",
            '  for (const place of detect(file, readFileSync(file, "utf8"))) {',
            "    found += 1;",
            "    console.log(JSON.stringify({ path: file, line: place.line, message: String(place.message).slice(0, 200) }));",
            "  }",
            "}",
            ...(kind === "check" ? ["process.exitCode = found > 0 ? 1 : 0;"] : []),
          ]
        : ["work(targets());"];
  const run = [
    "#!/usr/bin/env node",
    marker,
    `// The ${kind} tool ${capability}. Usage: node tools/${capability}/run.mjs [paths...] from the repository root (no paths: every file in its inputs).`,
    'import { readdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    ...(kind === "codemod" ? [`import * as edit from "./${TOOL_EDIT_LIB}";`] : []),
    "",
    `const SCOPE = ${JSON.stringify(inputs)};`,
    'const SKIP = new Set([".git", "node_modules", "dist", "build", "coverage", "tools"]);',
    "// The board's glob syntax: ** is any number of whole path segments (none included).",
    "const globRe = (g) => {",
    '  if (g === "**") return /^.*$/;',
    '  const segs = g.split("/");',
    '  let out = "";',
    "  segs.forEach((seg, i) => {",
    '    if (seg === "**") { out += i === 0 ? "(?:[^/]+/)*" : "(?:/[^/]+)*"; return; }',
    '    const lit = seg.replace(/[.+^${}()|[\\]\\\\]/g, "\\\\$&").replace(/\\*/g, "[^/]*").replace(/\\?/g, "[^/]");',
    '    out += i === 0 || (i === 1 && segs[0] === "**") ? lit : "/" + lit;',
    "  });",
    '  return new RegExp("^" + out + "$");',
    "};",
    "const scopes = SCOPE.map(globRe);",
    "const inScope = (p) => scopes.length === 0 || scopes.some((re) => re.test(p));",
    "const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => SKIP.has(e.name) ? [] : e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []);",
    'const targets = () => (process.argv.length > 2 ? process.argv.slice(2) : walk(".")).map((p) => p.replace(/^\\.\\//, "").split("\\\\").join("/")).filter(inScope).sort();',
    "",
    ...regions,
    "",
    ...main,
    "",
  ].join("\n");
  const test = kind === "codemod" ? codemodTest(marker, capability) : [
    marker,
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { spawnSync } from "node:child_process";',
    'import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const RUN = fileURLToPath(new URL("./run.mjs", import.meta.url));',
    'const run = (cwd, args = []) => spawnSync(process.execPath, [RUN, ...args], { cwd, encoding: "utf8" });',
    "",
    `test("${kind} ${capability} on a fixture", () => {`,
    '  const dir = mkdtempSync(join(tmpdir(), "tool-test-"));',
    "  try {",
    finds
      ? "    // FILL-BEGIN fixture: write a small file inside the tool's inputs that needs the change, run the tool, and assert its JSON-line findings (then fix the file and assert it finds nothing)."
      : "    // FILL-BEGIN fixture: build a small fixture, run the tool, and assert what it produces.",
    '    assert.fail("tool skeleton: this test is not filled in");',
    "    // FILL-END fixture",
    "    void run; void mkdirSync; void readFileSync; void writeFileSync; void dirname;",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
  ].join("\n");
  const readme = [
    `# ${capability} (${kind})`,
    "",
    "An agent-built tool. It is published only after it passes its own gate.",
    "",
    `Run: \`node tools/${capability}/run.mjs [paths...]\` from the repository root.`,
    `Inputs: ${inputs.join(", ") || "the whole repository"}`,
    ...(kind === "codemod" ? ["", `Its edits are applied by \`${TOOL_EDIT_LIB}\` (the runtime's helpers): each is re-parse-validated and idempotent.`] : []),
    "",
  ].join("\n");
  return { "run.mjs": run, "test.mjs": test, "README.md": readme, ...(kind === "codemod" ? { [TOOL_EDIT_LIB]: toolEditLibSource() } : {}) };
}

/** A codemod skeleton's test: run it on a copy of the original code; it must change something, keep every file parsing, and be idempotent. */
function codemodTest(marker: string, capability: string): string {
  return [
    marker,
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { spawnSync } from "node:child_process";',
    'import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `import { parseProblem } from "./${TOOL_EDIT_LIB}";`,
    "",
    'const RUN = fileURLToPath(new URL("./run.mjs", import.meta.url));',
    `const BASELINE = process.env.${TOOL_BASELINE_ENV};`,
    'const run = (cwd, args = []) => spawnSync(process.execPath, [RUN, ...args], { cwd, encoding: "utf8" });',
    'const SKIP = new Set([".git", "node_modules", "dist", "build", "coverage", "tools"]);',
    "/** Every file under root (repo-relative path to its text). */",
    'const snapshot = (root, rel = "", out = new Map()) => {',
    "  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {",
    "    if (SKIP.has(e.name)) continue;",
    '    const p = rel === "" ? e.name : rel + "/" + e.name;',
    "    if (e.isDirectory()) snapshot(root, p, out);",
    '    else if (e.isFile()) out.set(p, readFileSync(join(root, p), "utf8"));',
    "  }",
    "  return out;",
    "};",
    "",
    "// FILL-BEGIN expectChange: assert that ONE file the codemod changed now carries the intended change (assertions on its text before and after, with assert). The harness below already runs the codemod on a copy of the original code and checks that it changes a file, that every changed file still parses, and that a second run changes nothing.",
    "function expectChange(path, before, after) {",
    '  throw new Error("tool skeleton: expectChange() is not filled in");',
    "}",
    "// FILL-END expectChange",
    "",
    `test("codemod ${capability} on a copy of the original code: changes it, keeps it parsing, and is idempotent", () => {`,
    `  assert.ok(BASELINE, "${TOOL_BASELINE_ENV} is not set: the tool gate runs this test on a copy of the original code");`,
    '  const dir = mkdtempSync(join(tmpdir(), "tool-test-"));',
    "  try {",
    "    cpSync(BASELINE, dir, { recursive: true });",
    "    const original = snapshot(dir);",
    "    const first = run(dir);",
    "    assert.equal(first.status, 0, first.stderr);",
    "    const once = snapshot(dir);",
    "    const changed = [...once.keys()].filter((p) => once.get(p) !== original.get(p));",
    '    assert.ok(changed.length > 0, "the codemod changed no file of the original code\\n" + first.stderr);',
    "    for (const p of changed) {",
    '      assert.ok(original.has(p), "the codemod created " + p);',
    "      const problem = parseProblem(p, once.get(p));",
    '      assert.equal(problem, undefined, p + " no longer parses: " + problem);',
    "      expectChange(p, original.get(p), once.get(p));",
    "    }",
    "    const second = run(dir);",
    "    assert.equal(second.status, 0, second.stderr);",
    '    assert.deepEqual(snapshot(dir), once, "a second run must change nothing");',
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
  ].join("\n");
}

/** One FILL region of a skeleton file: its name, its guidance, and the signature its code must keep. */
export interface SkeletonRegion {
  readonly name: string;
  /** The text after the region name on its FILL-BEGIN line. */
  readonly guidance: string;
  /** The first code line inside the region (the function signature the fill must define). */
  readonly signature: string;
}

const BEGIN_LINE = /^[ \t]*\/\/ FILL-BEGIN ([A-Za-z0-9_-]+)\b:?\s*(.*)$/;
const END_LINE = /^[ \t]*\/\/ FILL-END ([A-Za-z0-9_-]+)\b/;

/** The FILL regions of a skeleton file, in order. */
export function skeletonRegions(text: string): SkeletonRegion[] {
  const lines = text.split("\n");
  const out: SkeletonRegion[] = [];
  lines.forEach((line, i) => {
    const m = BEGIN_LINE.exec(line);
    if (m) {
      const next = (lines[i + 1] ?? "").trim();
      // A function region keeps its signature; a statements region (a test body) has none.
      out.push({ name: m[1]!, guidance: m[2]!.trim(), signature: /^(?:async\s+)?function\b/.test(next) ? next.replace(/\s*\{$/, "") : "" });
    }
  });
  return out;
}

/** Why a region splice was refused. */
export class RegionSpliceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegionSpliceError";
  }
}

/**
 * Splice code into a skeleton file's FILL regions, anchored on the markers
 * the runtime itself wrote: each fill replaces everything from its
 * `// FILL-BEGIN <name>` line through its `// FILL-END <name>` line. Refused
 * (nothing changes) when a fill names a region the file does not have, or a
 * region's markers are missing, duplicated, or out of order. When every region
 * of the file is filled, the skeleton marker line goes too; otherwise it
 * stays, and the tool's own gate refuses the file.
 */
export function spliceRegions(text: string, fills: readonly { readonly name: string; readonly code: string }[]): string {
  const lines = text.split("\n");
  const begins = new Map<string, number[]>();
  const ends = new Map<string, number[]>();
  lines.forEach((line, i) => {
    const b = BEGIN_LINE.exec(line);
    if (b) begins.set(b[1]!, [...(begins.get(b[1]!) ?? []), i]);
    const e = END_LINE.exec(line);
    if (e) ends.set(e[1]!, [...(ends.get(e[1]!) ?? []), i]);
  });
  const seen = new Set<string>();
  for (const fill of fills) {
    if (seen.has(fill.name)) {
      throw new RegionSpliceError(`region ${fill.name} is filled twice`);
    }
    seen.add(fill.name);
    const b = begins.get(fill.name) ?? [];
    const e = ends.get(fill.name) ?? [];
    if (b.length === 0 && e.length === 0) {
      throw new RegionSpliceError(`there is no FILL region named ${fill.name}`);
    }
    if (b.length !== 1 || e.length !== 1 || e[0]! < b[0]!) {
      throw new RegionSpliceError(`the markers of region ${fill.name} are missing, duplicated, or out of order`);
    }
    if (FILL_MARKER.test(fill.code) || fill.code.includes(TOOL_SKELETON_MARKER)) {
      throw new RegionSpliceError(`the code for region ${fill.name} contains a skeleton marker`);
    }
  }
  // Splice from the bottom up so earlier line numbers stay valid.
  const order = [...fills].sort((a, b) => begins.get(b.name)![0]! - begins.get(a.name)![0]!);
  for (const fill of order) {
    const from = begins.get(fill.name)![0]!;
    const to = ends.get(fill.name)![0]!;
    lines.splice(from, to - from + 1, ...fill.code.replace(/\n$/, "").split("\n"));
  }
  const allFilled = [...begins.keys()].every((name) => seen.has(name));
  return (allFilled ? lines.filter((l) => !l.includes(TOOL_SKELETON_MARKER)) : lines).join("\n");
}

/** One check of a tool's gate (the board's BoardToolGateCheck). */
export interface ToolGateCheck {
  readonly check: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** A tool gate's result: every check, the verdict, and bounded output for a failure. */
export interface ToolGateResult {
  readonly passed: boolean;
  readonly checks: readonly ToolGateCheck[];
  /** Bounded output of what failed (empty on a pass). The caller scrubs credentials before recording it. */
  readonly output: string;
  /** What the baseline run found (scanner, check) and changed (codemod), for the record. */
  readonly findings: readonly ToolFinding[];
  readonly changed: readonly string[];
}

/** Options for a tool's own gate. */
export interface ToolGateOptions extends ToolRunLimits {
  readonly toolCheckoutDir: string;
  readonly capability: string;
  readonly kind: ToolGateKind;
  /** The tool's declared inputs: a codemod may change only files inside them. */
  readonly inputs: readonly string[];
  /** The ORIGINAL code the tool must prove itself on. */
  readonly baselineDir: string;
  readonly testTimeoutMs?: number;
  /** The project's own syntax or type check (argv), run in the codemod's output tree when declared. */
  readonly syntaxCommand?: readonly string[];
  readonly scratchParent?: string;
}

function clip(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `...${trimmed.slice(trimmed.length - max)}` : trimmed;
}

/**
 * Check that a file the codemod changed still parses. JavaScript and
 * TypeScript go through Node's own TypeScript parser (`stripTypeScriptTypes`,
 * which fails on a syntax error and executes nothing); JSON through
 * JSON.parse. Other files are not checked (and are said to be).
 */
export async function syntaxProblem(path: string, content: string): Promise<string | undefined | "unchecked"> {
  if (/\.json$/i.test(path)) {
    try {
      JSON.parse(content);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (!/\.(?:[cm]?[jt]s)$/i.test(path)) {
    return "unchecked";
  }
  const mod = (await import("node:module")) as { stripTypeScriptTypes?: (code: string, options?: { mode?: string }) => string };
  if (typeof mod.stripTypeScriptTypes !== "function") {
    return "unchecked";
  }
  try {
    mod.stripTypeScriptTypes(content, { mode: "transform" });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Run a tool's OWN gate on the original code (see the module comment for the
 * rules per kind). Deterministic for a given tool, baseline, and Node: nothing
 * here calls a model.
 */
export async function runToolGate(options: ToolGateOptions): Promise<ToolGateResult> {
  const checks: ToolGateCheck[] = [];
  const failures: string[] = [];
  const dir = `tools/${options.capability}`;
  const add = (check: string, passed: boolean, detail: string, output?: string) => {
    checks.push({ check, passed, detail: clip(detail) });
    if (!passed) {
      failures.push(`${check}: ${clip(detail, 500)}${output ? `\n${tail(output, 1500)}` : ""}`);
    }
  };
  const result = (findings: readonly ToolFinding[] = [], changed: readonly string[] = []): ToolGateResult => ({
    passed: checks.every((c) => c.passed),
    checks,
    output: checks.every((c) => c.passed) ? "" : tail(failures.join("\n"), 1900),
    findings,
    changed,
  });

  // 1. Layout: only its own directory, an entry point, and its own tests.
  const files = await listFiles(options.toolCheckoutDir);
  const foreign = files.filter((f) => !f.startsWith(`${dir}/`));
  const tests = files.filter((f) => f.startsWith(`${dir}/`) && /^test[^/]*\.(?:mjs|js|cjs)$/.test(f.slice(dir.length + 1)));
  const hasEntry = files.includes(toolEntryPath(options.capability));
  add(
    "layout",
    foreign.length === 0 && hasEntry && tests.length > 0,
    foreign.length > 0
      ? `files outside ${dir}/: ${foreign.slice(0, 5).join(", ")}`
      : !hasEntry
        ? `no entry point ${toolEntryPath(options.capability)}`
        : tests.length === 0
          ? `no tests (${dir}/test*.mjs): a tool must test itself`
          : `${dir}/ with ${TOOL_ENTRY} and ${tests.length} test file(s)`,
  );
  if (!checks[0]!.passed) {
    return result();
  }
  // An unfilled (or half-filled) skeleton never passes.
  const unfilled: string[] = [];
  for (const f of files) {
    const text = await readFile(join(options.toolCheckoutDir, f), "utf8").catch(() => "");
    if (text.includes(TOOL_SKELETON_MARKER) || FILL_MARKER.test(text)) {
      unfilled.push(f);
    }
  }
  add(
    "filled",
    unfilled.length === 0,
    unfilled.length === 0 ? "no skeleton marker or FILL region left" : `the skeleton is not filled in yet (a ${TOOL_SKELETON_MARKER} line or a FILL region remains in ${unfilled.join(", ")})`,
  );
  if (unfilled.length > 0) {
    return result();
  }

  // 2. Its own tests pass (run isolated, from the tools checkout), with a
  // private copy of the original code they may use as their fixture.
  const scratch = await mkdtemp(join(options.scratchParent ?? tmpdir(), "scf-toolgate-"));
  try {
    const home = join(scratch, "home");
    await mkdir(home, { recursive: true });
    const baselineCopy = join(scratch, "baseline");
    await materializeToolTree([options.baselineDir], baselineCopy);
    const testRun = await isolatedRunner(home, options, options.testTimeoutMs ?? DEFAULT_TOOL_TEST_TIMEOUT_MS, { [TOOL_BASELINE_ENV]: baselineCopy }).run(
      [options.nodePath ?? process.execPath, "--test", ...tests],
      options.toolCheckoutDir,
    );
    const summary = /^(?:#|\u2139)\s*pass (\d+)/m.exec(testRun.stdout)?.[1];
    add(
      "tests",
      testRun.code === 0,
      testRun.code === 0
        ? `its own tests passed (${summary ?? "?"} test(s))`
        : testRun.code === null
          ? `its own tests were stopped: ${stoppedReason(testRun)}`
          : `its own tests failed (exit ${testRun.code})`,
      testRun.code === 0 ? undefined : `${testRun.stdout}\n${testRun.stderr}`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }

  // 3. The run on the baseline, judged by kind.
  const run = await runToolInCopy({
    toolCheckoutDir: options.toolCheckoutDir,
    capability: options.capability,
    layers: [options.baselineDir],
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options.parentEnv !== undefined ? { parentEnv: options.parentEnv } : {}),
    ...(options.nodePath !== undefined ? { nodePath: options.nodePath } : {}),
    ...(options.scratchParent !== undefined ? { scratchParent: options.scratchParent } : {}),
  });
  try {
    const outputOf = `${run.stdout}\n${run.stderr}`;
    const bytes = Buffer.byteLength(run.stdout) + Buffer.byteLength(run.stderr);
    // No wall-clock time: the result is recorded on the board and must repeat run to run.
    const ran = `exit ${run.exit ?? "none"}, ${bytes} byte(s) of output`;
    const changed = [...run.modified, ...run.created, ...run.deleted];
    const readOnly = () =>
      add(
        "read-only",
        changed.length === 0,
        changed.length === 0 ? "changed no file on the baseline" : `a ${options.kind} must not change files; it changed ${changed.slice(0, 5).join(", ")}`,
      );
    const format = () =>
      add(
        "output-format",
        run.invalidLines === 0,
        run.invalidLines === 0
          ? `machine-readable: ${run.findings.length + run.droppedFindings} JSON-line finding(s) {path, line?, message}`
          : `${run.invalidLines} stdout line(s) are not a JSON finding {path, line?, message}`,
        run.invalidLines === 0 ? undefined : run.stdout,
      );
    if (run.stopped !== undefined) {
      add("baseline-run", false, `stopped on the baseline: ${run.stopped}`, outputOf);
      return result(run.findings, changed);
    }
    switch (options.kind) {
      case "check": {
        // A check counts only if it FAILS on the original code, with a violation it can name.
        add("fails-on-baseline", run.exit !== 0, run.exit !== 0 ? `failed on the original code as a check must (${ran})` : `passed on the original code, so it checks nothing (${ran})`, run.exit !== 0 ? undefined : outputOf);
        format();
        add("finds", run.findings.length > 0, run.findings.length > 0 ? `named ${run.findings.length} violation(s) on the baseline` : "named no violation on the baseline (a crash is not a failing check)");
        readOnly();
        break;
      }
      case "scanner": {
        add("baseline-run", run.exit === 0, `ran on the baseline: ${ran}`, run.exit === 0 ? undefined : outputOf);
        format();
        const missing: string[] = [];
        for (const f of run.findings) {
          const exists = await lstat(join(options.baselineDir, f.path)).then((s) => s.isFile()).catch(() => false);
          if (!exists && !missing.includes(f.path)) {
            missing.push(f.path);
          }
        }
        add(
          "finds",
          run.findings.length > 0 && missing.length === 0,
          run.findings.length === 0
            ? "found nothing on the baseline: a scanner that finds nothing proves nothing"
            : missing.length > 0
              ? `findings name files that do not exist: ${missing.slice(0, 5).join(", ")}`
              : `found ${run.findings.length + run.droppedFindings} place(s) in ${new Set(run.findings.map((f) => f.path)).size} file(s) on the baseline`,
        );
        readOnly();
        break;
      }
      case "codemod": {
        add("baseline-run", run.exit === 0, `ran on the baseline: ${ran}`, run.exit === 0 ? undefined : outputOf);
        add(
          "changes-baseline",
          run.modified.length > 0,
          run.modified.length > 0 ? `changed ${run.modified.length} baseline file(s)` : "changed no baseline file: a codemod that changes nothing proves nothing",
        );
        const outside = changed.filter((f) => options.inputs.length === 0 || !matchesAny(f, options.inputs));
        add(
          "in-scope",
          outside.length === 0 && run.deleted.length === 0,
          run.deleted.length > 0
            ? `deleted ${run.deleted.slice(0, 5).join(", ")} (a codemod may not delete files)`
            : outside.length > 0
              ? `changed files outside its inputs (${options.inputs.join(", ")}): ${outside.slice(0, 5).join(", ")}`
              : `every change is inside its inputs (${options.inputs.join(", ")})`,
        );
        const problems: string[] = [];
        let unchecked = 0;
        for (const f of [...run.modified, ...run.created]) {
          const problem = await syntaxProblem(f, (await run.read(f)).toString("utf8"));
          if (problem === "unchecked") {
            unchecked += 1;
          } else if (problem !== undefined) {
            problems.push(`${f}: ${problem}`);
          }
        }
        add(
          "syntax",
          problems.length === 0,
          problems.length > 0
            ? `left invalid syntax: ${problems.slice(0, 3).join("; ")}`
            : `every changed file parses${unchecked > 0 ? ` (${unchecked} file(s) of a type with no parser were not checked)` : ""}`,
        );
        if (options.syntaxCommand && options.syntaxCommand.length > 0) {
          // The project's declared check, in a copy of the baseline with the codemod applied.
          const declared = await runDeclaredCheck(options, run);
          add("declared-check", declared.code === 0, declared.code === 0 ? `${options.syntaxCommand.join(" ")} passed on the changed tree` : `${options.syntaxCommand.join(" ")} failed on the changed tree (exit ${declared.code ?? "none"})`, declared.code === 0 ? undefined : `${declared.stdout}\n${declared.stderr}`);
        }
        break;
      }
      default: {
        add("baseline-run", run.exit === 0, `ran on the baseline: ${ran}`, run.exit === 0 ? undefined : outputOf);
        const touched = [...run.modified, ...run.deleted];
        add(
          "leaves-baseline",
          touched.length === 0,
          touched.length === 0 ? "left every baseline file as it was" : `changed baseline file(s) ${touched.slice(0, 5).join(", ")}`,
        );
      }
    }
    return result(run.findings, changed);
  } finally {
    await run.dispose();
  }
}

async function runDeclaredCheck(options: ToolGateOptions, run: ToolRunResult): Promise<CommandOutcome> {
  const root = await mkdtemp(join(options.scratchParent ?? tmpdir(), "scf-toolcheck-"));
  try {
    const tree = join(root, "tree");
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    await materializeToolTree([options.baselineDir], tree);
    for (const f of [...run.modified, ...run.created]) {
      await mkdir(dirname(join(tree, f)), { recursive: true });
      await writeFile(join(tree, f), await run.read(f));
    }
    return await isolatedRunner(home, options, options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS).run(options.syntaxCommand!, tree);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
