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
 *     c8, nyc, vitest sections). Dependencies and lockfiles stay editable;
 *   - `tsconfig*.json` when the gate runs the type checker;
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

function relativeImports(source: string): string[] {
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
  const consider = async (token: string, previous?: string): Promise<void> => {
    if (previous === "--check" || previous === "-c") {
      return;
    }
    const normalized = normalizeIntentEntry(token)?.replace(/\/\*\*$/, "");
    if (normalized === undefined || normalized === "" || /[*?#]/.test(normalized)) {
      return;
    }
    const found = await kind(join(root, normalized));
    if (found === "dir") {
      // A directory protects only the existing test-shaped files under it.
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
    }
  };
  let runsTsc = false;
  const runsMakeOrJust = (program: string | undefined) => {
    if (program !== undefined && /^(tsc|vue-tsc|tsc-files)$/.test(program)) {
      runsTsc = true;
    }
    if (program === "make" && fileSet.has("Makefile")) {
      paths.add("Makefile");
    }
    if (program === "just" && fileSet.has("justfile")) {
      paths.add("justfile");
    }
  };

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
    const words = tokens(script);
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i]!;
      const nested = packageScript(words.slice(i));
      if (nested !== undefined) {
        await walkScript(nested, depth + 1);
        i += words[i + 1] === "run" || words[i + 1] === "run-script" ? 2 : 1;
        continue;
      }
      runsMakeOrJust(word);
      await consider(word, words[i - 1]);
    }
  };

  if (gateCommand && gateCommand.length > 0) {
    const program = gateCommand[0];
    const script = packageScript(gateCommand);
    if (script !== undefined) {
      if (manifest === undefined || typeof scripts[script] !== "string") {
        fallback = `the gate runs package script "${script}" but the manifest could not be read: the whole package.json is protected`;
        paths.add("package.json");
      } else {
        await walkScript(script, 0);
      }
    } else if (program === undefined || !KNOWN_PROGRAMS.has(program)) {
      fallback = `the gate's program ${JSON.stringify(program ?? "")} cannot be analyzed: the manifest, Makefile, and justfile are protected whole`;
      for (const file of ["package.json", "Makefile", "justfile"]) {
        if (fileSet.has(file)) {
          paths.add(file);
        }
      }
      for (let i = 1; i < gateCommand.length; i += 1) {
        await consider(gateCommand[i]!, gateCommand[i - 1]);
      }
    } else {
      runsMakeOrJust(program);
      for (let i = 1; i < gateCommand.length; i += 1) {
        await consider(gateCommand[i]!, gateCommand[i - 1]);
      }
    }
  }

  // The type checker's configs, when the gate runs it.
  if (runsTsc) {
    for (const file of files) {
      if (/(^|\/)tsconfig[^/]*\.json$/.test(file)) {
        paths.add(file);
      }
    }
  }

  // Harnesses the gate imports, followed transitively (bounded depth). The
  // rule: starting from the files the gate runs and the existing test files,
  // an imported in-repo file is HARNESS (protected, and followed further) when
  // it lies in the test tree: a directory that holds a gate-named or test
  // file, or one below such a directory (the repo root only counts for files
  // directly in it). An imported file anywhere else is APPLICATION code, the
  // code under test: not protected and not followed. Imports that leave the
  // project are reported.
  const testTreeDirs = new Set([...gateFiles, ...files.filter(isTestShaped)].map((f) => posix.dirname(f)));
  const inTestTree = (rel: string): boolean => {
    const dir = posix.dirname(rel);
    return [...testTreeDirs].some((t) => (t === "." ? dir === "." : dir === t || dir.startsWith(`${t}/`)));
  };
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
      if (!visited.has(rel) && depth < 6 && MODULE_FILE.test(rel)) {
        visited.add(rel);
        queue.push({ file: rel, depth: depth + 1 });
      }
    }
  }

  const jsonKeys: { file: string; keys: string[][] }[] = [];
  if (manifest !== undefined && !paths.has("package.json")) {
    const keys = [...[...scriptKeys].sort().map((k) => ["scripts", k]), ...MANIFEST_RUN_KEYS.map((k) => [k])];
    jsonKeys.push({ file: "package.json", keys });
  }
  const all = [...paths].sort();
  return {
    paths: collapse(all, MAX_POSTED_PROTECTED),
    restore: [...all, ...NESTED_CONFIG_GLOBS],
    jsonKeys,
    keyLabels: jsonKeys.flatMap((j) => j.keys.map((k) => `${j.file} ${k.map((s, i) => (i === 0 ? s : `[${JSON.stringify(s)}]`)).join("")}`)),
    outside: [...outside].sort(),
    ...(fallback !== undefined ? { fallback } : {}),
  };
}
