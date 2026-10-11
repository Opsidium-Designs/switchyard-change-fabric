/**
 * protected-paths: the gate's CONTRACT, derived from the project itself so the
 * engine never names an app, a goal, or a file.
 *
 * The rule: the original code's existing tests are the contract. The gate is
 * only authoritative if no agent can change what it checks, so the protected
 * set is, whatever the gate's shape (an npm script, vitest with no arguments,
 * pytest, make test, cargo test):
 *   - every EXISTING test-shaped file, by the test naming conventions of the
 *     common ecosystems (`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`,
 *     `*_test.go`, `*_spec.rb`, `*Test.java`, and any file under a `test`,
 *     `tests`, `__tests__`, `spec`, or `specs` directory). NEW test files are not
 *     protected: agents may add them freely (they are not part of the contract
 *     until the check rule admits them);
 *   - test-runner and build configs that change what a test run does (vitest,
 *     vite, jest, mocha, playwright, cypress, karma, ava, babel configs,
 *     `conftest.py`, `pytest.ini`, `tox.ini`, `setup.cfg`, `noxfile.py`, and
 *     `pyproject.toml` whole, since it mixes tool config with metadata), and the
 *     package-manager configs that change what `npm run` executes (`.npmrc`,
 *     `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `.pnpmfile.cjs`), existing or
 *     newly added at the root; a config added deeper is removed at gate time;
 *   - `Makefile` / `justfile` when the gate invokes make or just;
 *   - the files the gate command runs (the argv, or for an npm script that
 *     script's tokens): a file the gate only syntax-checks (`node --check
 *     src/index.js`) is code under test and is never protected, and a directory
 *     the gate names only protects the existing test-shaped files under it;
 *   - in `package.json` only the KEYS that define the run: the scripts the gate
 *     invokes (transitively, with their `pre`/`post` lifecycle scripts), and the
 *     keys that change what runs or how modules resolve (`type`,
 *     `packageManager`, `imports`, `exports`, and the jest, mocha, ava, babel,
 *     c8, nyc, vitest sections). Other dependencies stay editable, but the
 *     gate's RUNNER packages (every program it runs through node_modules/.bin,
 *     however reached: an npm script, npx, a node_modules path; `typescript`
 *     when it runs tsc) are protected in the manifest's dependency maps and
 *     `overrides`/`resolutions`/`pnpm` sections, and their resolution (with
 *     their transitive dependencies) in an npm lockfile, entry by entry; a
 *     pnpm or yarn lockfile (or an npm one whose closure is too large to list)
 *     is protected whole (see runner-resolution in the
 *     verification package, whose integration-time check the integrator can call);
 *   - `tsconfig*.json` when the gate runs the type checker (`tsc`, `npx tsc`,
 *     `./node_modules/.bin/tsc`);
 *   - the root config a test runner reads by default (vitest/vite, jest, mocha,
 *     ava, playwright configs) when a gate step runs that runner without an
 *     explicit config flag (`--config`, `-c`, `--config-file`, also as
 *     `--flag=value`; `-c` is a syntax check only for node), and every repo file
 *     a config the gate reads names by path (setupFiles, globalSetup, ...);
 *   - every file under the acceptance gate's directories (a dedicated test
 *     directory or one named like the gate holding a gate test or config, or a
 *     directory the gate names);
 *   - harnesses the gate imports, transitively (see the import rule below).
 *   Root runner configs (pytest.ini, tox.ini, setup.cfg, pyproject.toml,
 *   conftest.py, noxfile.py, and the package-manager configs) are protected even
 *   when absent, and any such config newly added anywhere is removed at gate
 *   time. A gate that is an npm script whose manifest
 *     cannot be read protects the whole manifest instead.
 * A gate whose program is not a known test or build runner cannot be analyzed:
 * the whole manifest, `Makefile`, and `justfile` are protected too (fail
 * closed). A harness a gate file imports from outside the project is reported
 * (agents' repos never contain it).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

import { normalizeIntentEntry } from "@switchyard-change/change-core";
import { readDependencySnapshotFromDir, runnerPackagesFor, runnerResolutionContract } from "@switchyard-change/verification";

/**
 * Configs protected at the repo root even when absent (an agent may not add
 * them): package-manager configs that change what a package script runs, and
 * the root test-runner configs a runner discovers on its own.
 */
export const RUNNER_CONFIG_FILES: readonly string[] = [
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  ".pnpmfile.cjs",
  "pytest.ini",
  "tox.ini",
  "setup.cfg",
  "pyproject.toml",
  "conftest.py",
  "noxfile.py",
];

/** Manifest keys that change what a run executes or how its modules resolve. */
export const MANIFEST_RUN_KEYS: readonly string[] = ["type", "packageManager", "imports", "exports", "jest", "mocha", "ava", "babel", "c8", "nyc", "vitest"];

/** Test-runner and build configs (by basename, at any depth). */
const TEST_CONFIG = /^(vitest\.(config|workspace)|vite\.config|jest\.(config|setup)|playwright\.config|cypress\.config|karma\.conf|ava\.config|babel\.config)\.[A-Za-z0-9.]+$|^\.mocharc(\.[A-Za-z0-9]+)?$|^\.babelrc(\.[A-Za-z0-9]+)?$|^(conftest|noxfile)\.py$|^(pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml)$/;
/**
 * The root configs each test runner reads on its own when a step runs it
 * without an explicit config flag. A gate step that runs the runner reads
 * them, so they are part of the acceptance gate (immutable).
 */
const RUNNER_DEFAULT_CONFIGS: Readonly<Record<string, RegExp>> = {
  vitest: /^(vitest\.(config|workspace)|vite\.config)\.[A-Za-z0-9.]+$/,
  jest: /^jest\.(config|setup)\.[A-Za-z0-9.]+$/,
  mocha: /^\.mocharc(\.[A-Za-z0-9]+)?$/,
  ava: /^ava\.config\.[A-Za-z0-9.]+$/,
  playwright: /^playwright\.config\.[A-Za-z0-9.]+$/,
};
/** The flags that point a runner at an explicit config (it then skips the root default). */
const CONFIG_FLAG = /^(--config|-c|--config-file)(=.*)?$/;
/** Shell separators that end one step of a gate script. */
const STEP_SEPARATOR = /&&|\|\||;|\|/;
/** Globs for configs added deeper than the root (removed at gate time). */
const NESTED_CONFIG_GLOBS: readonly string[] = [
  "**/vitest.config.*",
  "**/vitest.workspace.*",
  "**/vite.config.*",
  "**/jest.config.*",
  "**/jest.setup.*",
  "**/playwright.config.*",
  "**/cypress.config.*",
  "**/karma.conf.*",
  "**/ava.config.*",
  "**/babel.config.*",
  "**/.babelrc*",
  "**/.mocharc*",
  "**/conftest.py",
  "**/pytest.ini",
  "**/tox.ini",
  "**/setup.cfg",
  "**/pyproject.toml",
  "**/noxfile.py",
  "**/.npmrc",
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/bunfig.toml",
];
const TEST_FILE =
  /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|_spec\.rb$|(Test|Tests)\.(java|kt|cs|scala)$/;
const MODULE_FILE = /\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".wrangler", ".venv", "venv", "__pycache__", ".tox", "target"]);
const KNOWN_PROGRAMS = new Set([
  "npm", "npx", "node", "yarn", "pnpm", "bun", "deno", "pytest", "python", "python3", "go", "cargo",
  "make", "just", "vitest", "jest", "mocha", "tsc", "ava", "playwright",
]);
/** The most paths the contract posts on the board before test directories are collapsed. */
export const MAX_POSTED_PROTECTED = 500;

/** The derived contract. */
export interface ProtectedPaths {
  /** Repo-relative paths the board refuses claims on (posted with the goal), sorted. */
  readonly paths: readonly string[];
  /** Paths and globs the integrator restores from the baseline before the gate runs. */
  readonly restore: readonly string[];
  /** Keys inside editable JSON files the integrator restores. */
  readonly jsonKeys: readonly { readonly file: string; readonly keys: readonly (readonly string[])[] }[];
  /** The keys, as display labels for the board (`package.json scripts["gate"]`). */
  readonly keyLabels: readonly string[];
  /** Gate dependencies outside the project (absolute; never in an agent's repo). */
  readonly outside: readonly string[];
  /** Why the conservative fallback applied, if it did. */
  readonly fallback?: string;
  /**
   * The IMMUTABLE acceptance gate (a subset of `paths`): what the declared gate
   * command runs or references by name (its scripts' file arguments, the test
   * files of a directory it names), the test files and runner configs in those
   * gate directories, the harness they import, and the toolchain files the gate
   * invokes (a Makefile, a type-checker config it runs). No agent ever changes
   * these: there is no contract route for them, even if a human would accept.
   * The rest of `paths` (the project's pre-existing developer tests and
   * configs) stays contract-changeable with a human's approval.
   */
  readonly immutable: readonly string[];
  /**
   * The gate's runner packages (the programs it runs and their packages): their
   * declarations and lockfile resolution are protected (`jsonKeys`), and the
   * integrator checks the gated tree against the baseline for them
   * (`assertRunnerResolutionUnchanged` in the verification package).
   */
  readonly runnerPackages: readonly string[];
}

/** A test-shaped repo path (any ecosystem's convention). */
export function isTestShaped(path: string): boolean {
  return TEST_FILE.test(path);
}

/** A test-runner, build, or package-manager config file (by basename). */
export function isRunnerConfig(path: string): boolean {
  const base = posix.basename(path);
  return TEST_CONFIG.test(base) || RUNNER_CONFIG_FILES.includes(base);
}

/** Split a shell-ish script into word tokens (no expansion; quotes stripped). */
function tokens(script: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s;&|()<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(script)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out;
}

async function kind(path: string): Promise<"file" | "dir" | undefined> {
  try {
    const s = await stat(path);
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

/** Every repo file (POSIX, sorted), skipping VCS, dependency, and build directories. */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
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

function insideRoot(root: string, abs: string): string | undefined {
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || resolve(root, rel) !== abs) {
    return undefined;
  }
  return rel.split(sep).join(posix.sep);
}

/** The extensions a relative specifier may leave off, in the order Node/TS bundler resolution tries them. */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** A JS-extension specifier may name a TS source (the TS ESM convention: `./x.js` is `./x.ts`). */
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

/**
 * The candidate files a relative specifier resolves to, in order, as Node and
 * TS bundler resolution try them: the exact path, a JS extension's TS source,
 * the path plus each extension, then `<path>/index.<ext>`.
 */
export function importCandidates(abs: string): string[] {
  const out = [abs];
  const ext = posix.extname(abs.split(sep).join(posix.sep));
  for (const ts of JS_TO_TS[ext] ?? []) {
    out.push(abs.slice(0, abs.length - ext.length) + ts);
  }
  for (const e of RESOLVE_EXTENSIONS) {
    out.push(abs + e);
  }
  for (const e of RESOLVE_EXTENSIONS) {
    out.push(join(abs, `index${e}`));
  }
  return out;
}

/** The relative specifiers a module imports (static, dynamic, and `require`), in source order. */
export function relativeImports(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[1]) {
      out.push(match[1]);
    }
  }
  return out;
}

/** The npm script an argv runs (`npm run <name>`, `npm test`, `yarn <name>`, ...). */
function packageScript(argv: readonly string[]): string | undefined {
  const [program, ...rest] = argv;
  const args = rest.filter((a) => !a.startsWith("-"));
  if (program === "npm" || program === "pnpm" || program === "bun") {
    if ((args[0] === "run" || args[0] === "run-script") && args[1]) {
      return args[1];
    }
    if (args[0] === "test" || args[0] === "t") {
      return "test";
    }
  }
  if (program === "yarn" && args[0]) {
    return args[0] === "run" ? args[1] : args[0];
  }
  return undefined;
}

/** Programs that run the next word as a program (`npx vitest`, `cross-env A=1 jest`). */
const WRAPPERS = new Set(["npx", "bunx", "exec", "dlx", "env", "cross-env", "time", "nice", "nohup"]);
/** Package managers whose next word may be a bin (`yarn vitest`, `pnpm exec jest`). */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** A test-tree directory segment (a dedicated test directory). */
const TEST_DIR_SEGMENT = /^(tests?|__tests__|specs?)$/;
/** A directory named like the acceptance gate (`gate`, `gates`, `acceptance-gate`). */
const GATE_DIR_SEGMENT = /gate/i;

/**
 * The programs one gate step runs: its first word (after environment
 * assignments), the word a wrapper or package manager runs (`npx vitest`,
 * `yarn jest`), and any bin or package reached through `node_modules`
 * (`./node_modules/.bin/tsc`, `node node_modules/vitest/vitest.mjs`).
 * Basenames; flags skipped.
 */
export function stepPrograms(words: readonly string[]): string[] {
  const out: string[] = [];
  let expect = true;
  for (const word of words) {
    const viaModules = /(?:^|\/)node_modules\/(?:\.bin\/([^/]+)|(@[^/]+\/[^/]+|[^/@.][^/]*))/.exec(word);
    if (viaModules) {
      out.push(viaModules[1] ?? viaModules[2]!);
    }
    if (!expect || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word.startsWith("-")) {
      continue;
    }
    const base = posix.basename(word);
    out.push(base);
    expect = WRAPPERS.has(base) || PACKAGE_MANAGERS.has(base);
  }
  return out;
}

/** The stem a test file tests (`a.test.ts`, `test_a.py`, `a_test.go`, `ATest.java` are all `a`/`A`). */
function testStem(file: string): string {
  return posix
    .basename(file)
    .replace(/\.(test|spec)\.[A-Za-z0-9]+$/, "")
    .replace(/^test_(.*)\.py$/, "$1")
    .replace(/_(test|spec)\.[A-Za-z0-9]+$/, "")
    .replace(/(Test|Tests)\.(java|kt|cs|scala)$/, "");
}

/** The string literals in a config's source that look like repo-relative file paths. */
function configPathStrings(source: string): string[] {
  const out: string[] = [];
  const re = /["'`]([^"'`\n]{1,300})["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const raw = match[1]!.replace(/^<rootDir>\//, "");
    if (/[*?{}\s$]/.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw) || !/[/.]/.test(raw)) {
      continue;
    }
    out.push(raw);
  }
  return out;
}

/** Collapse test-shaped files under dedicated test directories into `dir/**` until the list fits. */
function collapse(paths: readonly string[], max: number): string[] {
  if (paths.length <= max) {
    return [...paths];
  }
  const out = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    const at = segments.findIndex((s) => /^(tests?|__tests__|specs?)$/.test(s));
    out.add(at >= 0 && isTestShaped(path) ? `${segments.slice(0, at + 1).join("/")}/**` : path);
  }
  return [...out].sort();
}

/** Derive the contract for a project and its gate command (argv). */
export async function deriveProtectedPaths(projectDir: string, gateCommand?: readonly string[]): Promise<ProtectedPaths> {
  const root = resolve(projectDir);
  const files = await listFiles(root);
  const fileSet = new Set(files);
  const paths = new Set<string>(RUNNER_CONFIG_FILES);
  for (const file of files) {
    if (isTestShaped(file) || isRunnerConfig(file)) {
      paths.add(file);
    }
  }
  const outside = new Set<string>();
  const scriptKeys = new Set<string>();
  let fallback: string | undefined;

  let manifest: { scripts?: Record<string, unknown> } | undefined;
  try {
    manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
  } catch {
    manifest = undefined;
  }
  const scripts = manifest?.scripts ?? {};

  const gateFiles: string[] = [];
  // Directories the gate names directly (fully part of the acceptance gate).
  const namedDirs = new Set<string>();
  // Runner configs the gate reads (an explicit config flag, or a root default).
  const configFiles = new Set<string>();
  // The programs the gate runs, and every other word (for the runner packages).
  const programs = new Set<string>();
  const otherWords = new Set<string>();
  const consider = async (raw: string, previous: string | undefined, program: string | undefined): Promise<void> => {
    // `node --check f` / `node -c f` only syntax-checks f (code under test);
    // for any other program `-c` names a config.
    if (previous === "--check" || (previous === "-c" && program === "node")) {
      return;
    }
    // `--flag=value`: the value is what the gate reads.
    const assigned = /^(--?[A-Za-z][\w-]*)=(.*)$/.exec(raw);
    if (assigned && assigned[1] === "--check") {
      return;
    }
    const token = assigned ? assigned[2]! : raw;
    const flag = assigned ? assigned[1]! : previous;
    const normalized = normalizeIntentEntry(token)?.replace(/\/\*\*$/, "");
    if (normalized === undefined || normalized === "" || /[*?#]/.test(normalized)) {
      return;
    }
    const found = await kind(join(root, normalized));
    if (found === "dir") {
      namedDirs.add(normalized);
      // A directory protects the existing test-shaped files under it (and, as
      // a directory the gate names, everything under it: see below).
      for (const file of files) {
        if (file.startsWith(`${normalized}/`) && isTestShaped(file)) {
          paths.add(file);
          gateFiles.push(file);
        }
      }
      return;
    }
    if (found === "file") {
      paths.add(normalized);
      gateFiles.push(normalized);
      if (flag !== undefined && CONFIG_FLAG.test(flag)) {
        configFiles.add(normalized);
      }
    }
  };
  let runsTsc = false;
  const runsMakeOrJust = (program: string | undefined) => {
    // The type checker however it is reached (`tsc`, `npx tsc`, `./node_modules/.bin/tsc`).
    if (program !== undefined && /^(tsc|vue-tsc|tsc-files)$/.test(posix.basename(program))) {
      runsTsc = true;
    }
    if (program === "make" && fileSet.has("Makefile")) {
      paths.add("Makefile");
      gateFiles.push("Makefile");
    }
    if (program === "just" && fileSet.has("justfile")) {
      paths.add("justfile");
      gateFiles.push("justfile");
    }
  };

  // A step that runs a test runner without an explicit config reads the
  // runner's root default config: the gate reads it, so it is a gate file.
  const runnerDefaults = (step: readonly string[]): void => {
    const runner = step.map((w) => posix.basename(w)).find((w) => RUNNER_DEFAULT_CONFIGS[w] !== undefined);
    if (runner === undefined || step.some((w) => CONFIG_FLAG.test(w))) {
      return;
    }
    for (const file of files) {
      if (!file.includes("/") && RUNNER_DEFAULT_CONFIGS[runner]!.test(file)) {
        paths.add(file);
        gateFiles.push(file);
        configFiles.add(file);
      }
    }
  };
  const notePrograms = (words: readonly string[]): void => {
    stepPrograms(words).forEach((p) => programs.add(p));
    words.forEach((w) => otherWords.add(posix.basename(w)));
  };
  /** The program a step runs (past wrappers and package managers), for flag meaning. */
  const mainProgram = (words: readonly string[]): string | undefined => stepPrograms(words).find((p) => !WRAPPERS.has(p) && !PACKAGE_MANAGERS.has(p));

  const seen = new Set<string>();
  const walkScript = async (name: string, depth: number): Promise<void> => {
    const script = scripts[name];
    if (typeof script !== "string" || seen.has(name) || depth > 8) {
      return;
    }
    seen.add(name);
    // npm runs pre<name> and post<name> around <name>: they are part of the run.
    scriptKeys.add(name);
    scriptKeys.add(`pre${name}`);
    scriptKeys.add(`post${name}`);
    for (const step of script.split(STEP_SEPARATOR)) {
      const words = tokens(step);
      const stepScript = packageScript(words);
      if (stepScript === undefined || typeof scripts[stepScript] !== "string") {
        runnerDefaults(words);
        notePrograms(words);
      }
      const program = mainProgram(words);
      for (let i = 0; i < words.length; i += 1) {
        const word = words[i]!;
        const nested = packageScript(words.slice(i));
        if (nested !== undefined) {
          await walkScript(nested, depth + 1);
          i += words[i + 1] === "run" || words[i + 1] === "run-script" ? 2 : 1;
          continue;
        }
        runsMakeOrJust(word);
        await consider(word, words[i - 1], program);
      }
    }
  };

  if (gateCommand && gateCommand.length > 0) {
    const program = gateCommand[0];
    const script = packageScript(gateCommand);
    if (script !== undefined) {
      if (manifest === undefined || typeof scripts[script] !== "string") {
        fallback = `the gate runs package script "${script}" but the manifest could not be read: the whole package.json is protected`;
        paths.add("package.json");
        gateFiles.push("package.json");
      } else {
        await walkScript(script, 0);
      }
    } else if (
      program === undefined ||
      // A known runner by name, or reached through node_modules/.bin (never a repo script of that name).
      !(KNOWN_PROGRAMS.has(program) || (/(^|\/)node_modules\/\.bin\/[^/]+$/.test(program) && KNOWN_PROGRAMS.has(posix.basename(program))))
    ) {
      fallback = `the gate's program ${JSON.stringify(program ?? "")} cannot be analyzed: the manifest, Makefile, and justfile are protected whole`;
      for (const file of ["package.json", "Makefile", "justfile"]) {
        if (fileSet.has(file)) {
          paths.add(file);
          gateFiles.push(file);
        }
      }
      notePrograms(gateCommand);
      for (let i = 1; i < gateCommand.length; i += 1) {
        runsMakeOrJust(gateCommand[i]);
        await consider(gateCommand[i]!, gateCommand[i - 1], program);
      }
    } else {
      runnerDefaults(gateCommand);
      notePrograms(gateCommand);
      const runs = mainProgram(gateCommand);
      for (let i = 0; i < gateCommand.length; i += 1) {
        // Every word: `npx tsc` and `./node_modules/.bin/tsc` run the type checker too.
        runsMakeOrJust(gateCommand[i]);
        if (i > 0) {
          await consider(gateCommand[i]!, gateCommand[i - 1], runs);
        }
      }
    }
  }

  // Paths a runner config the gate reads names (setupFiles, globalSetup, a
  // reporter, a custom environment): the gate runs them, so they are part of
  // it. Every string literal that resolves to a repo file, relative to the
  // config's directory or the project root, is followed.
  for (const config of [...configFiles].sort()) {
    let source: string;
    try {
      source = await readFile(join(root, config), "utf8");
    } catch {
      continue;
    }
    for (const literal of configPathStrings(source)) {
      for (const base of [posix.dirname(config), "."]) {
        const joined = posix.normalize(posix.join(base, literal));
        if (joined.startsWith("..") || joined.startsWith("/")) {
          continue;
        }
        const hit = importCandidates(joined).map((c) => c.split(sep).join(posix.sep)).find((c) => fileSet.has(c));
        if (hit !== undefined && hit !== config) {
          paths.add(hit);
          gateFiles.push(hit);
          break;
        }
      }
    }
  }

  // The type checker's configs, when the gate runs it.
  if (runsTsc) {
    for (const file of files) {
      if (/(^|\/)tsconfig[^/]*\.json$/.test(file)) {
        paths.add(file);
        gateFiles.push(file);
      }
    }
  }

  // Harnesses the gate imports, followed transitively (bounded depth). The
  // rule: starting from the files the gate runs and the existing test files,
  // an imported in-repo file is HARNESS (protected, and followed further) when
  // it lies in a HARNESS ROOT or below one: a dedicated test directory
  // (`test`, `tests`, `__tests__`, `spec`, `specs` anywhere in its path), a
  // directory the gate names, or the directory of a file the gate runs (a
  // gate test, script, or runner config) unless that directory is COLOCATED
  // (it holds the module a gate test is named after: `a.ts` beside
  // `a.test.ts`). The repo root only counts for files directly in it. A
  // developer test outside a dedicated test directory is not a root: what a
  // colocated test imports is APPLICATION code, the code under test, never
  // protected or followed. Imports that leave the project are reported.
  const colocated = (dir: string): boolean =>
    !dir.split("/").some((s) => TEST_DIR_SEGMENT.test(s)) &&
    gateFiles.some(
      (g) =>
        posix.dirname(g) === dir &&
        isTestShaped(g) &&
        files.some((f) => posix.dirname(f) === dir && !isTestShaped(f) && MODULE_FILE.test(f) && posix.basename(f).replace(/\.[^.]+$/, "") === testStem(g)),
    );
  const harnessRoots = new Set<string>([
    ...namedDirs,
    ...gateFiles.filter((f) => isTestShaped(f) || isRunnerConfig(f) || MODULE_FILE.test(f)).map((f) => posix.dirname(f)).filter((d) => !colocated(d)),
  ]);
  const inTestTree = (rel: string): boolean => {
    const dir = posix.dirname(rel);
    if (dir.split("/").some((s) => TEST_DIR_SEGMENT.test(s))) {
      return true;
    }
    return [...harnessRoots].some((t) => (t === "." ? dir === "." : dir === t || dir.startsWith(`${t}/`)));
  };
  const importsOf = new Map<string, string[]>();
  const queue = [...new Set([...gateFiles, ...files.filter(isTestShaped)])].filter((f) => MODULE_FILE.test(f)).map((f) => ({ file: f, depth: 0 }));
  const visited = new Set(queue.map((q) => q.file));
  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    let source: string;
    try {
      source = await readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const spec of relativeImports(source)) {
      // Resolve as the runtime would (extensionless, `.js` naming a `.ts`
      // source, a directory's index), so a harness imported bundler-style is
      // protected like one imported by its exact name.
      let rel: string | undefined;
      let outsideFile: string | undefined;
      for (const candidate of importCandidates(resolve(dirname(join(root, file)), spec))) {
        const inside = insideRoot(root, candidate);
        if (inside !== undefined ? fileSet.has(inside) : (await kind(candidate)) === "file") {
          rel = inside;
          outsideFile = inside === undefined ? candidate : undefined;
          break;
        }
      }
      if (outsideFile !== undefined) {
        outside.add(outsideFile);
        continue;
      }
      if (rel === undefined || !inTestTree(rel)) {
        continue;
      }
      paths.add(rel);
      importsOf.set(file, [...(importsOf.get(file) ?? []), rel]);
      if (!visited.has(rel) && depth < 6 && MODULE_FILE.test(rel)) {
        visited.add(rel);
        queue.push({ file: rel, depth: depth + 1 });
      }
    }
  }

  // The gate's own toolchain: the packages it runs (and what they depend on,
  // as the baseline lockfile resolves them) are protected in the manifest and
  // the lockfile, so a worker cannot swap the runner through the dependency
  // set (see runner-resolution in the verification package).
  const snapshot = await readDependencySnapshotFromDir(root);
  const runnerPackages = runnerPackagesFor(runsTsc ? [...programs, "tsc"] : programs, snapshot, otherWords);
  const runner = runnerResolutionContract(snapshot, runnerPackages);
  for (const file of runner.wholeFiles) {
    paths.add(file);
    gateFiles.push(file);
  }
  const jsonKeys: { file: string; keys: string[][] }[] = [];
  const lockLabels: string[] = [];
  if (manifest !== undefined && !paths.has("package.json")) {
    const runnerKeys = runner.jsonKeys.find((j) => j.file === "package.json")?.keys ?? [];
    const keys = [...[...scriptKeys].sort().map((k) => ["scripts", k]), ...MANIFEST_RUN_KEYS.map((k) => [k]), ...runnerKeys.map((k) => [...k])];
    jsonKeys.push({ file: "package.json", keys });
  }
  for (const entry of runner.jsonKeys) {
    if (entry.file === "package.json" || paths.has(entry.file)) {
      continue;
    }
    jsonKeys.push({ file: entry.file, keys: entry.keys.map((k) => [...k]) });
    const closure = runner.closure[entry.file] ?? [];
    const installed = runnerPackages.filter((n) => closure.includes(`node_modules/${n}`));
    lockLabels.push(
      `${entry.file} entries of the gate's runner packages and their dependencies (${installed.join(", ") || "none installed"}; ${closure.length} package entr${closure.length === 1 ? "y" : "ies"})`,
    );
  }
  // The immutable acceptance gate: the files the gate names, the test files and
  // runner configs in the (non-root) directories of the test or config files it
  // names, and the harness those import (transitively).
  // The package-manager and runner configs protected even when absent change
  // how the gate itself runs: immutable too.
  const immutable = new Set<string>([...gateFiles.filter((f) => paths.has(f)), ...RUNNER_CONFIG_FILES]);
  const gateDirs = new Set(
    gateFiles.filter((f) => isTestShaped(f) || isRunnerConfig(f)).map((f) => posix.dirname(f)).filter((d) => d !== "." && !colocated(d)),
  );
  // The ACCEPTANCE GATE directories (a dedicated test directory, or one named
  // like the gate, that holds a gate test or config; or a directory the gate
  // names): EVERY file under them is immutable (fixtures, expected outputs,
  // setup files, helpers reached by path rather than by import). Other
  // directories of gate tests or configs keep the narrower rule: their test
  // files and runner configs.
  const wholeDirs = [
    ...[...namedDirs].filter((d) => d !== "." && d !== "" && !colocated(d)),
    ...[...gateDirs].filter((d) => d.split("/").some((s) => TEST_DIR_SEGMENT.test(s) || GATE_DIR_SEGMENT.test(s))),
  ];
  for (const file of files) {
    const dir = posix.dirname(file);
    if (gateDirs.has(dir) && (isTestShaped(file) || isRunnerConfig(file))) {
      immutable.add(file);
    }
    if (wholeDirs.some((d) => dir === d || dir.startsWith(`${d}/`))) {
      paths.add(file);
      immutable.add(file);
    }
  }
  const pending = [...immutable];
  while (pending.length > 0) {
    for (const rel of importsOf.get(pending.pop()!) ?? []) {
      if (!immutable.has(rel)) {
        immutable.add(rel);
        pending.push(rel);
      }
    }
  }
  const all = [...paths].sort();
  return {
    immutable: [...immutable].sort(),
    paths: collapse(all, MAX_POSTED_PROTECTED),
    restore: [...all, ...NESTED_CONFIG_GLOBS],
    jsonKeys,
    keyLabels: [
      ...jsonKeys
        .filter((j) => j.file === "package.json")
        .flatMap((j) => j.keys.map((k) => `${j.file} ${k.map((s, i) => (i === 0 ? s : `[${JSON.stringify(s)}]`)).join("")}`)),
      ...lockLabels,
    ],
    runnerPackages,
    outside: [...outside].sort(),
    ...(fallback !== undefined ? { fallback } : {}),
  };
}
