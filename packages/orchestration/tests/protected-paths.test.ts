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
import { DEPENDENCY_MAPS, RESOLUTION_SECTIONS } from "@switchyard-change/verification";

import { deriveProtectedPaths, isTestShaped, MANIFEST_RUN_KEYS, RUNNER_CONFIG_FILES } from "../src/protected-paths.ts";

/**
 * The manifest keys for the given walked scripts (each with its pre/post
 * hooks), the run keys, and the runner packages' declarations plus the
 * resolution sections.
 */
const keysFor = (scripts: readonly string[], runners: readonly string[] = []) => [
  ...scripts.flatMap((n) => [n, `pre${n}`, `post${n}`]).sort().map((n) => ["scripts", n]),
  ...MANIFEST_RUN_KEYS.map((k) => [k]),
  ...(runners.length > 0
    ? [...DEPENDENCY_MAPS.flatMap((m) => runners.map((r) => [m, r])), ...RESOLUTION_SECTIONS.map((k) => [k])]
    : []),
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
    // Only the keys that define the run, and the gate's runner package
    // (vitest): other dependencies stay editable.
    expect(contract.jsonKeys).toEqual([{ file: "package.json", keys: keysFor(["gate"], ["vitest"]) }]);
    expect(contract.runnerPackages).toEqual(["vitest"]);
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
    expect(contract.jsonKeys[0]!.keys).toEqual(keysFor(["gate", "typecheck"], ["node"]));
  });

  it("resolves harness imports the way Node and TS bundlers do: extensionless, .js naming a .ts source, a directory index, and each extension", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { gate: "node --test checks/gate.test.ts" } }),
      "checks/gate.test.ts": [
        'import { h } from "./harness";',
        'import { j } from "./js-named.js";',
        'import { i } from "./support";',
        'import { m } from "./mod";',
        'import { c } from "./common";',
        'import app from "../src/app";',
        "",
      ].join("\n"),
      "checks/harness.ts": 'export { deep } from "./deep";\nexport const h = 1;\n',
      "checks/deep.tsx": "export const deep = 1;\n",
      "checks/js-named.ts": "export const j = 1;\n",
      "checks/support/index.ts": "export const i = 1;\n",
      "checks/mod.mts": "export const m = 1;\n",
      "checks/common.cjs": "module.exports = { c: 1 };\n",
      "checks/unused.ts": "",
      "src/app.ts": "export default {};\n",
    });
    const contract = await deriveProtectedPaths(dir, APP_GATE_COMMAND);
    expect(contract.paths).toEqual(
      expect.arrayContaining(["checks/gate.test.ts", "checks/harness.ts", "checks/deep.tsx", "checks/js-named.ts", "checks/support/index.ts", "checks/mod.mts", "checks/common.cjs"]),
    );
    expect(contract.paths).not.toContain("checks/unused.ts");
    expect(contract.paths).not.toContain("src/app.ts");
  });

  it("an exact file wins over an extension, as at run time", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { gate: "node --test checks/gate.test.mjs" } }),
      "checks/gate.test.mjs": 'import { h } from "./harness.js";\n',
      "checks/harness.js": "export const h = 1;\n",
      "checks/harness.ts": "export const h = 2;\n",
    });
    const contract = await deriveProtectedPaths(dir, APP_GATE_COMMAND);
    expect(contract.paths).toContain("checks/harness.js");
    expect(contract.paths).not.toContain("checks/harness.ts");
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
    expect(jsonKeys[0]!.keys).toEqual(keysFor(["gate", "typecheck"], ["node"]));
    expect(outside).toEqual([join(REPO, "examples/apps/gate-harness.mjs")]);
  });
});

describe("two classes: the immutable acceptance gate and contract-changeable developer tests", () => {
  it("on the storefront: the gate suite, its harness and config, and the configs the gate run uses are immutable; developer tests stay changeable", async () => {
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../../../examples/apps/storefront", import.meta.url));
    const derived = await deriveProtectedPaths(dir, ["npm", "run", "gate"]);
    expect(derived.immutable).toEqual(expect.arrayContaining(["gate/billing.test.ts", "gate/harness.ts", "gate/money.test.ts", "gate/safety.test.ts", "gate/vitest.config.ts", "tsconfig.json", ".npmrc", "vitest.config.ts"]));
    // The root vitest.config.ts is read by the gate's plain `vitest run` step:
    // immutable. Developer TEST FILES stay changeable.
    const changeable = derived.paths.filter((p) => !derived.immutable.includes(p));
    expect(changeable).toEqual(["tests/billing/tax.test.ts", "tests/catalog.test.ts", "tests/helpers.ts", "tests/orders.test.ts"]);
    expect(derived.immutable.every((p) => derived.paths.includes(p))).toBe(true);
    // The gate's runner packages (vitest, typescript) are protected in the manifest and the real lockfile,
    // within the integration job's bounds (non-empty key segments, at most 512 keys per file).
    expect(derived.runnerPackages).toEqual(expect.arrayContaining(["typescript", "vitest"]));
    const lock = derived.jsonKeys.find((j) => j.file === "package-lock.json")!;
    expect(lock.keys).toEqual(expect.arrayContaining([["packages", "node_modules/vitest"], ["packages", "node_modules/typescript"], ["packages", "node_modules/vite"]]));
    for (const { keys } of derived.jsonKeys) {
      expect(keys.length).toBeLessThanOrEqual(512);
      expect(keys.every((k) => k.length > 0 && k.every((s) => s !== ""))).toBe(true);
    }
  });

  it("a runner's root default config is immutable only when a gate step runs that runner without an explicit config", async () => {
    const make = async (gate: string) =>
      deriveProtectedPaths(
        await project({
          "package.json": JSON.stringify({ scripts: { gate } }),
          "vitest.config.ts": "export default {}\n",
          "jest.config.js": "module.exports = {}\n",
          ".mocharc.json": "{}\n",
          "gate/vitest.config.ts": "export default {}\n",
          "gate/a.test.ts": "import { it } from 'vitest'; it('a', () => {});\n",
          "tests/b.test.ts": "import { it } from 'vitest'; it('b', () => {});\n",
        }),
        ["npm", "run", "gate"],
      );
    const both = await make("tsc --noEmit && vitest run && vitest run --config gate/vitest.config.ts");
    expect(both.immutable).toEqual(expect.arrayContaining(["vitest.config.ts", "gate/vitest.config.ts", "gate/a.test.ts"]));
    expect(both.immutable).not.toContain("tests/b.test.ts");
    expect(both.immutable).not.toContain("jest.config.js");
    expect(both.immutable).not.toContain(".mocharc.json");
    const explicitOnly = await make("vitest run --config gate/vitest.config.ts");
    expect(explicitOnly.immutable).toContain("gate/vitest.config.ts");
    expect(explicitOnly.immutable).not.toContain("vitest.config.ts");
    expect(explicitOnly.paths).toContain("vitest.config.ts");
    const viaNpx = await make("npx jest && npx mocha");
    expect(viaNpx.immutable).toEqual(expect.arrayContaining(["jest.config.js", ".mocharc.json"]));
    expect(viaNpx.immutable).not.toContain("vitest.config.ts");
  });
});

describe("the gate's toolchain, configs, and directories", () => {
  const lockfile = JSON.stringify({
    name: "app",
    lockfileVersion: 3,
    packages: {
      "": { name: "app", devDependencies: { jest: "29.0.0", typescript: "5.7.2", "left-pad": "1.3.0" } },
      "node_modules/jest": { version: "29.0.0", resolved: "https://registry.npmjs.org/jest/-/jest-29.0.0.tgz", integrity: "sha512-j", dependencies: { "jest-cli": "29.0.0" }, bin: { jest: "bin/jest.js" } },
      "node_modules/jest-cli": { version: "29.0.0", resolved: "https://registry.npmjs.org/jest-cli/-/jest-cli-29.0.0.tgz", integrity: "sha512-c" },
      "node_modules/typescript": { version: "5.7.2", resolved: "https://registry.npmjs.org/typescript/-/typescript-5.7.2.tgz", integrity: "sha512-t", bin: { tsc: "bin/tsc", tsserver: "bin/tsserver" } },
      "node_modules/left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: "sha512-l" },
    },
  });

  it("protects the runner packages (through npx and tsc) in the manifest and the lockfile; other dependencies stay editable", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { gate: "npx tsc --noEmit && npx jest" }, devDependencies: { jest: "29.0.0", typescript: "5.7.2", "left-pad": "1.3.0" } }),
      "package-lock.json": lockfile,
      "tsconfig.json": "{}",
    });
    const contract = await deriveProtectedPaths(dir, APP_GATE_COMMAND);
    expect(contract.runnerPackages).toEqual(expect.arrayContaining(["jest", "typescript"]));
    const pkg = contract.jsonKeys.find((j) => j.file === "package.json")!.keys;
    expect(pkg).toEqual(expect.arrayContaining([["devDependencies", "jest"], ["devDependencies", "typescript"], ["overrides"]]));
    expect(pkg).not.toContainEqual(["devDependencies", "left-pad"]);
    const lock = contract.jsonKeys.find((j) => j.file === "package-lock.json")!.keys;
    expect(lock).toEqual(expect.arrayContaining([["packages", "node_modules/jest"], ["packages", "node_modules/jest-cli"], ["packages", "node_modules/typescript"]]));
    expect(lock).not.toContainEqual(["packages", "node_modules/left-pad"]);
    expect(contract.keyLabels).toEqual(
      expect.arrayContaining([expect.stringMatching(/^package-lock\.json entries of the gate's runner packages and their dependencies \(jest, typescript; 3 package entries\)$/)]),
    );
    expect(contract.paths).not.toContain("package-lock.json");
    // A pnpm lockfile cannot be analyzed per entry: protected whole.
    const pnpm = await deriveProtectedPaths(
      await project({ "package.json": JSON.stringify({ scripts: { gate: "vitest run" } }), "pnpm-lock.yaml": "lockfileVersion: 9\n" }),
      APP_GATE_COMMAND,
    );
    expect(pnpm.immutable).toContain("pnpm-lock.yaml");
  });

  it("protects tsconfig when tsc runs as `npx tsc` or `./node_modules/.bin/tsc`, in a script or as the direct argv", async () => {
    const files = { "tsconfig.json": "{}", "src/a.ts": "" };
    for (const gate of ["npx tsc --noEmit", "./node_modules/.bin/tsc --noEmit"]) {
      const viaScript = await deriveProtectedPaths(await project({ ...files, "package.json": JSON.stringify({ scripts: { gate } }) }), APP_GATE_COMMAND);
      expect(viaScript.immutable, gate).toContain("tsconfig.json");
    }
    for (const argv of [["npx", "tsc", "--noEmit"], ["./node_modules/.bin/tsc", "--noEmit"]]) {
      const direct = await deriveProtectedPaths(await project(files), argv);
      expect(direct.immutable, argv.join(" ")).toContain("tsconfig.json");
    }
  });

  it("treats -c as a config flag (except for node), splits --flag=value, and follows the setup files a gate config names", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { gate: "jest -c config/jest.gate.js && vitest run --config=config/vitest.gate.ts && node -c src/app.js" } }),
      "config/jest.gate.js": 'module.exports = { setupFiles: ["<rootDir>/support/setup.js"], globalSetup: "./config/global.js" };\n',
      "config/vitest.gate.ts": 'export default { test: { setupFiles: ["./vsetup"], include: ["src/**/*.test.ts"], environment: "node" } };\n',
      "config/global.js": "",
      "config/vsetup.ts": "",
      "support/setup.js": 'import { x } from "./more.js";\n',
      "support/more.js": "export const x = 1;\n",
      "src/app.js": "",
    });
    const contract = await deriveProtectedPaths(dir, APP_GATE_COMMAND);
    expect(contract.immutable).toEqual(
      expect.arrayContaining(["config/jest.gate.js", "config/vitest.gate.ts", "support/setup.js", "config/global.js", "config/vsetup.ts", "support/more.js"]),
    );
    // node -c only syntax-checks: the file is code under test.
    expect(contract.paths).not.toContain("src/app.js");
  });

  it("every file under the acceptance gate directory is immutable (fixtures, expected outputs)", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { gate: "node --test gate/a.test.mjs" } }),
      "gate/a.test.mjs": 'import { readFileSync } from "node:fs";\n',
      "gate/expected.json": "{}",
      "gate/fixtures/input.txt": "x",
      "src/app.mjs": "",
    });
    const contract = await deriveProtectedPaths(dir, APP_GATE_COMMAND);
    expect(contract.immutable).toEqual(expect.arrayContaining(["gate/a.test.mjs", "gate/expected.json", "gate/fixtures/input.txt"]));
    expect(contract.paths).not.toContain("src/app.mjs");
  });

  it("a colocated test is not a harness root: what it imports is application code, never locked", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { gate: "node --test src/a.test.mjs && node --test tests" } }),
      "src/a.test.mjs": 'import { a } from "./a.mjs";\nimport { util } from "./util.mjs";\n',
      "src/a.mjs": "export const a = 1;\n",
      "src/util.mjs": "export const util = 1;\n",
      "src/b.test.mjs": 'import { b } from "./b.mjs";\n',
      "src/b.mjs": "export const b = 1;\n",
      "tests/c.test.mjs": 'import { h } from "./helpers/h.mjs";\nimport { a } from "../src/a.mjs";\n',
      "tests/helpers/h.mjs": "export const h = 1;\n",
      "tests/data.json": "{}",
    });
    const contract = await deriveProtectedPaths(dir, APP_GATE_COMMAND);
    expect(contract.immutable).toContain("src/a.test.mjs");
    for (const app of ["src/a.mjs", "src/util.mjs", "src/b.mjs"]) {
      expect(contract.paths, app).not.toContain(app);
    }
    // A dedicated test directory the gate names stays a harness root, fully immutable.
    expect(contract.immutable).toEqual(expect.arrayContaining(["tests/c.test.mjs", "tests/helpers/h.mjs", "tests/data.json"]));
  });
});
