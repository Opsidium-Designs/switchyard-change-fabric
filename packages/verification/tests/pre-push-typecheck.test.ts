/** The pre-push typecheck: real tsc (the repo's own TypeScript) on tiny offline fixtures, before and after an agent's edit. */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createPrePushTypecheck } from "../src/index.ts";

const run = promisify(execFile);
const TSC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "typescript", "bin", "tsc");
const check = createPrePushTypecheck({ tscPath: TSC });

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "ES2022", moduleResolution: "bundler", lib: ["ES2022"], types: [], strict: true, noEmit: true, noUnusedLocals: true, noUnusedParameters: true, skipLibCheck: true },
  include: ["src/**/*.ts"],
});

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), body);
  }
}

/** A baseline project: the tsconfig, a package.json, an (empty) installed node_modules, and `files`. */
async function baseline(files: Record<string, string>, options: { tsconfig?: boolean; nodeModules?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-prepush-base-"));
  await write(dir, { "package.json": '{ "name": "fixture" }\n', ...(options.tsconfig === false ? {} : { "tsconfig.json": TSCONFIG }), ...files });
  if (options.nodeModules !== false) {
    await mkdir(join(dir, "node_modules"));
  }
  return dir;
}

/** The agent's repo: `committed` as its earlier push (when any), then `edited` left uncommitted. */
async function agentRepo(committed: Record<string, string>, edited: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-prepush-agent-"));
  await run("git", ["init", "-q", dir]);
  if (Object.keys(committed).length > 0) {
    await write(dir, committed);
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@switchyard.local", "commit", "-q", "-m", "earlier push"]);
  }
  await write(dir, edited);
  return dir;
}

describe("createPrePushTypecheck", () => {
  it("refuses an edit that adds an unused local to a changed file, naming the TS6133 line", async () => {
    const base = await baseline({ "src/a.ts": "export function f(): number {\n  return 1;\n}\n" });
    const agent = await agentRepo({}, { "src/a.ts": "export function f(): number {\n  const unused = 2;\n  return 1;\n}\n" });
    const result = await check({ baselineDir: base, agentDir: agent, changed: ["src/a.ts"] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors).toEqual([expect.stringMatching(/^src\/a\.ts\(2,9\): error TS6133: 'unused' is declared but its value is never read/)]);
  });

  it("does not report an error the changed file already had in the baseline (lines shifted)", async () => {
    const base = await baseline({ "src/a.ts": "function g(): number {\n  const old = 1;\n  return 0;\n}\nexport const x = g();\n" });
    const agent = await agentRepo({}, { "src/a.ts": "// a comment that shifts every line\n\nfunction g(): number {\n  const old = 1;\n  return 0;\n}\nexport const x = g();\nexport const y = 2;\n" });
    expect(await check({ baselineDir: base, agentDir: agent, changed: ["src/a.ts"] })).toEqual({ ok: true });
  });

  it("does not report an error the agent's own earlier push already had", async () => {
    const base = await baseline({ "src/a.ts": "export const x = 1;\n" });
    const agent = await agentRepo(
      { "src/a.ts": "export const x: number = missingName;\n" },
      { "src/a.ts": "export const x: number = missingName;\nexport const y = 2;\n" },
    );
    expect(await check({ baselineDir: base, agentDir: agent, changed: ["src/a.ts"] })).toEqual({ ok: true });
  });

  it("does not report errors in files the edit did not change", async () => {
    const base = await baseline({
      "src/a.ts": "export const used = 1;\n",
      "src/b.ts": 'import { used } from "./a";\nexport function h(): number {\n  const stale = 3;\n  return used;\n}\n',
    });
    // The edit removes the export b.ts imports: b.ts now fails too, but b.ts is not the edit's file.
    const agent = await agentRepo({}, { "src/a.ts": "export const renamed = 1;\n" });
    expect(await check({ baselineDir: base, agentDir: agent, changed: ["src/a.ts"] })).toEqual({ ok: true });
  });

  it("borrows the project's dependencies for a revision without them only when package.json is identical", async () => {
    const project = await baseline({});
    const revision = await baseline({ "src/a.ts": "export const x = 1;\n" }, { nodeModules: false });
    const agent = await agentRepo({}, { "src/a.ts": "export const x: string = 1;\n" });
    const borrowed = await check({ baselineDir: revision, agentDir: agent, changed: ["src/a.ts"], fallbackNodeModulesDir: project });
    expect(borrowed).toMatchObject({ ok: false, errors: [expect.stringMatching(/^src\/a\.ts\(1,14\): error TS2322/)] });
    await writeFile(join(project, "package.json"), '{ "name": "other" }\n');
    expect(await check({ baselineDir: revision, agentDir: agent, changed: ["src/a.ts"], fallbackNodeModulesDir: project })).toEqual({
      ok: true,
      skipped: "no installed dependencies to typecheck against",
    });
  });

  it("skips (does not refuse) an edit whose new errors are ALL imports from modules it did not change: another item may provide them", async () => {
    const base = await baseline({ "src/shared.ts": "export const existing = 1;\n" });
    const agent = await agentRepo(
      {},
      {
        "src/x.ts":
          'import { provided } from "./shared";\nimport * as ns from "./shared";\nimport { later } from "./not-yet";\nexport const x = [provided, ns.alsoProvided, later];\n',
      },
    );
    const result = await check({ baselineDir: base, agentDir: agent, changed: ["src/x.ts"] });
    expect(result).toEqual({
      ok: true,
      skipped: "the edit's new errors are all unresolved imports from modules it did not change (./shared, ./not-yet, src/shared); another item may provide them",
    });
  });

  it("still refuses when a new error is not a cross-module import, or the missing export is in a module the edit changed", async () => {
    const base = await baseline({ "src/shared.ts": "export const existing = 1;\n", "src/a.ts": "export const kept = 1;\n" });
    const mixed = await agentRepo({}, { "src/x.ts": 'import { provided } from "./shared";\nexport const x: string = provided;\nexport const y: string = 1;\n' });
    const refused = await check({ baselineDir: base, agentDir: mixed, changed: ["src/x.ts"] });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.errors.map((e) => /error (TS\d+)/.exec(e)![1])).toEqual(["TS2305", "TS2322"]);
    // The edit removed the export its own other file imports: that is the edit's doing.
    const own = await agentRepo({}, { "src/a.ts": "export const renamed = 1;\n", "src/b.ts": 'import { kept } from "./a";\nexport const b = kept;\n' });
    const ownResult = await check({ baselineDir: base, agentDir: own, changed: ["src/a.ts", "src/b.ts"] });
    expect(ownResult).toMatchObject({ ok: false, errors: [expect.stringMatching(/^src\/b\.ts\(1,10\): error TS2305/)] });
  });

  it("skips when tsc reports a tsconfig/config error (a location-less error, or a diagnostic in tsconfig.json)", async () => {
    const extendsMissing = await baseline({ "src/a.ts": "export const x = 1;\n", "tsconfig.json": JSON.stringify({ extends: "./missing-base.json", include: ["src/**/*.ts"] }) });
    const agent = await agentRepo({}, { "src/a.ts": "export const x: string = 1;\n" });
    expect(await check({ baselineDir: extendsMissing, agentDir: agent, changed: ["src/a.ts"] })).toEqual({
      ok: true,
      skipped: expect.stringMatching(/^tsc reported a configuration error \(.*TS5083/),
    });
    const unknownOption = await baseline({
      "src/a.ts": "export const x = 1;\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, notARealOption: true }, include: ["src/**/*.ts"] }),
    });
    expect(await check({ baselineDir: unknownOption, agentDir: agent, changed: ["src/a.ts"] })).toEqual({
      ok: true,
      skipped: expect.stringMatching(/^tsc reported a configuration error \(tsconfig\.json: TS5023/),
    });
  });

  it("does not copy build output or tool state into the overlay trees", async () => {
    const base = await baseline({ "src/a.ts": "export const x = 1;\n", ".wrangler/state/blob": "state\n", "dist/a.js": "x\n", "coverage/lcov.info": "c\n" });
    // An unreadable file under a state directory would fail the copy if it were copied.
    await chmod(join(base, ".wrangler/state/blob"), 0o000);
    const agent = await agentRepo({}, { "src/a.ts": "export const x: string = 1;\n" });
    expect(await check({ baselineDir: base, agentDir: agent, changed: ["src/a.ts"] })).toMatchObject({ ok: false, errors: [expect.stringMatching(/TS2322/)] });
    await chmod(join(base, ".wrangler/state/blob"), 0o600);
  });

  it("skips a project with no tsconfig.json", async () => {
    const base = await baseline({ "src/a.ts": "export const x = 1;\n" }, { tsconfig: false });
    const agent = await agentRepo({}, { "src/a.ts": "export const x: string = 1;\n" });
    expect(await check({ baselineDir: base, agentDir: agent, changed: ["src/a.ts"] })).toEqual({ ok: true, skipped: "the project has no tsconfig.json" });
  });

  it("skips an edit that changed no TypeScript file", async () => {
    const base = await baseline({ "src/a.ts": "export const x = 1;\n" });
    const agent = await agentRepo({}, { "README.md": "notes\n" });
    expect(await check({ baselineDir: base, agentDir: agent, changed: ["README.md"] })).toEqual({ ok: true, skipped: "the edit changed no TypeScript file" });
  });

  it("skips (never throws) when no tsc can be found", async () => {
    const base = await baseline({ "src/a.ts": "export const x = 1;\n" });
    const agent = await agentRepo({}, { "src/a.ts": "export const x: string = 1;\n" });
    expect(await createPrePushTypecheck()({ baselineDir: base, agentDir: agent, changed: ["src/a.ts"] })).toEqual({
      ok: true,
      skipped: "no tsc in the project's dependencies",
    });
  });
});
