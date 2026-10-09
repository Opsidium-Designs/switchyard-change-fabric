/**
 * Model-built codemods on the runtime's edit helpers, offline: a fake region
 * filler that writes ONLY decision logic (which handlers, which guard
 * statement, which import) produces a codemod that passes its own, unchanged
 * gate on the real service-api baseline, and the code it writes fixes the auth
 * half of that app's own gate on every one of its six resources (the
 * validation half stays for the agents). No network, no model.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { ToolRegionFiller, ToolRegionRequest } from "@switchyard-change/model-adapters";
import { runToolInCopy } from "@switchyard-change/verification";

import { regionToolAuthor } from "../src/board-tools.ts";
import { formatToolSmokeBuild, runToolSmoke } from "../src/tool-smoke.ts";

const run = promisify(execFile);
const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples", "apps");
const SERVICE_API = join(EXAMPLES, "service-api");
const GOAL = "Add input validation and require auth on every resource";
const INPUTS = ["src/resources/*.js"];
const RESOURCES = ["users", "orders", "products", "auth", "search", "notifications"];

/** Decision logic only: no file I/O, no string surgery. */
const PLAN = [
  "function plan(path, text, edit) {",
  "  const handlers = edit.functions(text).filter((fn) => fn.exported && fn.params[0]);",
  "  if (handlers.length === 0) return [];",
  "  return [",
  '    edit.addImport({ from: edit.relativeImport(path, "src/contracts/auth.js"), names: ["requireAuth"] }),',
  "    edit.insertAtStart(",
  "      { exported: true, where: (fn) => Boolean(fn.params[0]) },",
  "      (fn) => `const denied = requireAuth(${fn.params[0]});\\nif (denied) return denied;`,",
  "    ),",
  "  ];",
  "}",
].join("\n");

const EXPECT_CHANGE = [
  "function expectChange(path, before, after) {",
  '  assert.match(after, /const denied = requireAuth\\(request\\);\\n\\s*if \\(denied\\) return denied;/, path + " guards its handler");',
  '  assert.match(after, /import \\{[^}]*\\brequireAuth\\b[^}]*\\} from "\\.\\.\\/contracts\\/auth\\.js"/, path + " imports requireAuth");',
  "}",
].join("\n");

function decisionFiller(asked: ToolRegionRequest[]): ToolRegionFiller {
  return async (request) => {
    asked.push(request);
    const code: Record<string, string> = { plan: PLAN, expectChange: EXPECT_CHANGE };
    return { fills: request.regions.map((r) => ({ file: r.file, name: r.name, code: code[r.name] ?? "" })), model: "fake" };
  };
}

describe("a codemod built from decision logic on the edit helpers", () => {
  it("passes its own gate on the real service-api baseline (every check), first build, every attempt", async () => {
    const asked: ToolRegionRequest[] = [];
    const lines: string[] = [];
    const results = await runToolSmoke({
      filler: decisionFiller(asked),
      projectDir: SERVICE_API,
      goal: GOAL,
      capability: "codemod-unit",
      kind: "codemod",
      inputs: INPUTS,
      attempts: 2,
      onBuild: (a, b, r) => lines.push(formatToolSmokeBuild(a, b, r)),
    });
    expect(results.map((r) => [r.passed, r.builds.length])).toEqual([
      [true, 1],
      [true, 1],
    ]);
    const build = results[0]!.builds[0]!;
    expect(build.checks.map((c) => `${c.check}:${c.passed}`)).toEqual(["layout:true", "filled:true", "tests:true", "baseline-run:true", "changes-baseline:true", "in-scope:true", "syntax:true"]);
    expect(build.changed).toEqual(RESOURCES.map((r) => `src/resources/${r}.js`).sort());
    expect(lines[0]).toMatch(/^ {2}attempt 1 build 1: PASS \(layout ok, .*syntax ok\); changed src\/resources\/auth\.js/);
    // The model was asked only for decision regions, told the helper API, and shown real files in scope.
    expect(asked[0]!.regions.map((r) => `${r.name}:${r.signature}`)).toEqual(["plan:function plan(path, text, edit)", "expectChange:function expectChange(path, before, after)"]);
    expect(asked[0]!.regions[0]!.example).toMatch(/edit\.insertAtStart/);
    expect(asked[0]!.files.map((f) => f.path)).toEqual(["tools/codemod-unit/run.mjs", "tools/codemod-unit/test.mjs"]);
    expect(asked[0]!.files[0]!.text).toContain("edit.addImport({ from, names: [..], default? })");
    expect(asked[0]!.excerpts.map((e) => e.path)).toEqual(["src/resources/auth.js", "src/resources/notifications.js", "src/resources/orders.js"]);
    // Every in-scope file is named, not only the excerpts, so the codemod covers all six.
    expect(asked[0]!.scopeFiles).toEqual(RESOURCES.map((r) => `src/resources/${r}.js`).sort());
  }, 60_000);

  it("the codemod alone fixes the auth half of the service-api gate on all six resources, keeps every file valid, and is idempotent", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "scf-toolsmoke-test-"));
    await regionToolAuthor(decisionFiller([]))({ agent: "t", capability: "codemod-unit", kind: "codemod", inputs: INPUTS, outputs: [], worktreeDir: worktree, projectDir: SERVICE_API, goal: GOAL });
    const once = await runToolInCopy({ toolCheckoutDir: worktree, capability: "codemod-unit", layers: [SERVICE_API] });
    // A copy laid out like examples/apps (the app gate imports ../../gate-harness.mjs).
    const apps = await mkdtemp(join(tmpdir(), "scf-toolsmoke-app-"));
    const app = join(apps, "service-api");
    try {
      expect(once.exit).toBe(0);
      expect(once.modified).toEqual(RESOURCES.map((r) => `src/resources/${r}.js`).sort());
      await cp(SERVICE_API, app, { recursive: true, filter: (src) => !/node_modules/.test(src) });
      await cp(join(EXAMPLES, "gate-harness.mjs"), join(apps, "gate-harness.mjs"));
      for (const f of once.modified) {
        await mkdir(dirname(join(app, f)), { recursive: true });
        await writeFile(join(app, f), await once.read(f));
      }
      // A second run over the codemod's own output changes nothing.
      const twice = await runToolInCopy({ toolCheckoutDir: worktree, capability: "codemod-unit", layers: [app] });
      try {
        expect(twice.exit).toBe(0);
        expect(twice.modified).toEqual([]);
      } finally {
        await twice.dispose();
      }
      // The app's own syntax check, then its gate.
      for (const f of once.modified) {
        await run(process.execPath, ["--check", join(app, f)]);
      }
      const gate = await run(process.execPath, ["--test", "gate/gate.test.mjs"], { cwd: app }).then(
        (r) => r.stdout,
        (e: { stdout?: string }) => e.stdout ?? "",
      );
      for (const r of RESOURCES) {
        expect(gate).toMatch(new RegExp(`✔ ${r}: unauthenticated request is rejected`));
        expect(gate).toMatch(new RegExp(`✔ ${r}: authenticated, valid request still succeeds`));
      }
      // The validation half is the agents' work, not the codemod's.
      expect(gate).toMatch(/✖ users: authenticated but invalid input is rejected with 400/);
      expect(await readFile(join(app, "src/resources/users.js"), "utf8")).toContain(
        'export async function handle(request, parts) {\n  const denied = requireAuth(request);\n  if (denied) return denied;\n  if (request.method === "GET"',
      );
    } finally {
      await once.dispose();
      await rm(apps, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  }, 60_000);
});
