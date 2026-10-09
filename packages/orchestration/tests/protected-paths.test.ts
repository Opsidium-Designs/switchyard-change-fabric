/**
 * The gate's contract is derived from the project, never named by the engine:
 * the original code's existing tests (any ecosystem's naming), test-runner and
 * package-manager configs, the files the gate runs, and the manifest KEYS the
 * gate uses. New test files, dependencies, and app modules stay editable.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { APP_GATE_COMMAND } from "../src/app-gate-wiring.ts";
import { deriveProtectedPaths, isTestShaped, MANIFEST_RUN_KEYS, RUNNER_CONFIG_FILES } from "../src/protected-paths.ts";

/** The manifest keys for the given walked scripts (each with its pre/post hooks) plus the run keys. */
const keysFor = (...scripts: string[]) => [
  ...scripts.flatMap((n) => [n, `pre${n}`, `post${n}`]).sort().map((n) => ["scripts", n]),
  ...MANIFEST_RUN_KEYS.map((k) => [k]),
];

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-protected-"));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

describe("deriveProtectedPaths: the original code's existing tests are the contract", () => {
  it("recognizes test files across ecosystems, never app modules named like helpers", () => {
    for (const path of [
      "src/a.test.ts",
      "src/b.spec.js",
      "tests/anything.txt",
      "pkg/__tests__/x.js",
      "app/test_models.py",
      "app/models_test.py",
      "server/handler_test.go",
      "spec/user_spec.rb",
      "src/test/java/FooTest.java",
    ]) {
      expect(isTestShaped(path), path).toBe(true);
    }
    for (const path of ["src/helper.js", "src/setup.ts", "src/testing.ts", "src/contest.ts", "lib/attest.py"]) {
      expect(isTestShaped(path), path).toBe(false);
    }
  });

  it("protects every existing test and config whatever the gate (here: vitest with no arguments), never new tests or app code", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { gate: "vitest run" }, devDependencies: { vitest: "1" } }),
      "vitest.config.ts": "export default {}\n",
      "src/a.ts": "",
      "src/a.test.ts": "",
      "src/helper.ts": "",
      "tests/b.test.ts": "",
    });
    const contract = await deriveProtectedPaths(dir, APP_GATE_COMMAND);
    expect(contract.paths).toEqual(
      [...RUNNER_CONFIG_FILES, "src/a.test.ts", "tests/b.test.ts", "vitest.config.ts"].sort(),
    );
    expect(contract.restore).toEqual(expect.arrayContaining(["src/a.test.ts", "**/vitest.config.*", "**/conftest.py"]));
    // Only the keys that define the run; dependencies and lockfiles stay editable.
    expect(contract.jsonKeys).toEqual([{ file: "package.json", keys: keysFor("gate") }]);
    expect(contract.keyLabels).toEqual(expect.arrayContaining(['package.json scripts["gate"]', 'package.json scripts["pregate"]', "package.json jest"]));
    expect(contract.paths).not.toContain("package.json");
  });

  it("follows the scripts the gate invokes and the files it runs, never a file it only syntax-checks or a whole parent directory", async () => {
    const dir = await project({
      "package.json": JSON.stringify({
        scripts: { gate: "npm run typecheck && node --test checks/gate.test.mjs && node verify/run.mjs", typecheck: "node --check src/index.js" },
      }),
      "checks/gate.test.mjs": 'import x from "../../harness.mjs";\nimport app from "../src/index.js";\nimport { h } from "./support/util.mjs";\n',
      "checks/support/util.mjs": 'export { d } from "./deep.mjs";\nexport const h = 1;\n',
      "checks/support/deep.mjs": "export const d = 1;\n",
      "checks/fixtures.mjs": "",
      "verify/run.mjs": "",
      "verify/other.mjs": "",
      "src/index.js": 'import { helper } from "./helper.js";\n',
      "src/helper.js": "",
    });
    const contract = await deriveProtectedPaths(dir, APP_GATE_COMMAND);
    // The harness the gate imports, transitively; the app code it imports is the code under test.
    expect(contract.paths).toEqual(expect.arrayContaining(["checks/gate.test.mjs", "checks/support/util.mjs", "checks/support/deep.mjs", "verify/run.mjs"]));
    for (const p of contract.paths) {
      expect(p.endsWith("/**"), p).toBe(false);
      expect(p.startsWith("src/"), p).toBe(false);
    }
    expect(contract.paths).not.toContain("verify/other.mjs");
    expect(contract.paths).not.toContain("checks/fixtures.mjs");
    expect(contract.jsonKeys[0]!.keys).toEqual(keysFor("gate", "typecheck"));
  });

  it("resolves harness imports the way Node and TS bundlers do: extensionless, .js naming a .ts source, a directory index, and each extension", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { gate: "node --test gate/gate.test.ts" } }),
      "gate/gate.test.ts": [
        'import { h } from "./harness";',
        'import { j } from "./js-named.js";',
        'import { i } from "./support";',
        'import { m } from "./mod";',
        'import { c } from "./common";',
        'import app from "../src/app";',
        "",
      ].join("\n"),
      "gate/harness.ts": 'export { deep } from "./deep";\nexport const h = 1;\n',
      "gate/deep.tsx": "export const deep = 1;\n",
      "gate/js-named.ts": "export const j = 1;\n",
      "gate/support/index.ts": "export const i = 1;\n",
      "gate/mod.mts": "export const m = 1;\n",
      "gate/common.cjs": "module.exports = { c: 1 };\n",
      "gate/unused.ts": "",
      "src/app.ts": "export default {};\n",
    });
    const contract = await deriveProtectedPaths(dir, APP_GATE_COMMAND);
    expect(contract.paths).toEqual(
      expect.arrayContaining(["gate/gate.test.ts", "gate/harness.ts", "gate/deep.tsx", "gate/js-named.ts", "gate/support/index.ts", "gate/mod.mts", "gate/common.cjs"]),
    );
    expect(contract.paths).not.toContain("gate/unused.ts");
    expect(contract.paths).not.toContain("src/app.ts");
  });

  it("an exact file wins over an extension, as at run time", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { gate: "node --test gate/gate.test.mjs" } }),
      "gate/gate.test.mjs": 'import { h } from "./harness.js";\n',
      "gate/harness.js": "export const h = 1;\n",
      "gate/harness.ts": "export const h = 2;\n",
    });
    const contract = await deriveProtectedPaths(dir, APP_GATE_COMMAND);
    expect(contract.paths).toContain("gate/harness.js");
    expect(contract.paths).not.toContain("gate/harness.ts");
  });

  it("protects tsconfig files when the gate runs the type checker, and removes newly added root runner configs", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { gate: "tsc -p tsconfig.build.json && node --test" } }),
      "tsconfig.json": "{}",
      "tsconfig.build.json": "{}",
      "packages/x/tsconfig.json": "{}",
    });
    const contract = await deriveProtectedPaths(dir, APP_GATE_COMMAND);
    expect(contract.paths).toEqual(expect.arrayContaining(["tsconfig.json", "tsconfig.build.json", "packages/x/tsconfig.json", "pytest.ini", "pyproject.toml"]));
    expect(contract.restore).toEqual(expect.arrayContaining(["**/pytest.ini", "**/pyproject.toml", "**/tox.ini", "**/.npmrc"]));
    const noTsc = await deriveProtectedPaths(await project({ "package.json": JSON.stringify({ scripts: { gate: "node --test" } }), "tsconfig.json": "{}" }), APP_GATE_COMMAND);
    expect(noTsc.paths).not.toContain("tsconfig.json");
  });

  it("covers pytest and make shaped gates", async () => {
    const py = await project({ "pyproject.toml": "[tool.pytest.ini_options]\n", "app/x.py": "", "tests/test_x.py": "", "tests/conftest.py": "" });
    expect((await deriveProtectedPaths(py, ["pytest", "-q"])).paths).toEqual(
      expect.arrayContaining(["pyproject.toml", "tests/test_x.py", "tests/conftest.py"]),
    );
    const mk = await project({ Makefile: "test:\n\tgo test ./...\n", "x_test.go": "", "x.go": "" });
    const contract = await deriveProtectedPaths(mk, ["make", "test"]);
    expect(contract.paths).toEqual(expect.arrayContaining(["Makefile", "x_test.go"]));
    expect(contract.paths).not.toContain("x.go");
  });

  it("fails closed when the gate cannot be analyzed", async () => {
    const dir = await project({ "package.json": "{}", Makefile: "", "gate.sh": "", "src/a.js": "" });
    const contract = await deriveProtectedPaths(dir, ["./gate.sh"]);
    expect(contract.fallback).toMatch(/cannot be analyzed/);
    expect(contract.paths).toEqual(expect.arrayContaining(["package.json", "Makefile"]));
    const unreadable = await project({ "package.json": "{ not json" });
    const npm = await deriveProtectedPaths(unreadable, APP_GATE_COMMAND);
    expect(npm.fallback).toMatch(/manifest could not be read/);
    expect(npm.paths).toContain("package.json");
  });

  it("derives the example app's contract and reports its shared harness as outside the project", async () => {
    const app = join(REPO, "examples/apps/service-api");
    const { paths, outside, jsonKeys } = await deriveProtectedPaths(app, APP_GATE_COMMAND);
    expect(paths).toEqual(expect.arrayContaining(["gate/gate.test.mjs", "gate/bugfix.test.mjs"]));
    expect(paths).not.toContain("package.json");
    expect(paths.some((p) => p.startsWith("src/") || p.endsWith("/**"))).toBe(false);
    expect(jsonKeys[0]!.keys).toEqual(keysFor("gate", "typecheck"));
    expect(outside).toEqual([join(REPO, "examples/apps/gate-harness.mjs")]);
  });
});
