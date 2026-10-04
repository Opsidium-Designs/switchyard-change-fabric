/**
 * A deterministic, pure structural snapshot of a target TypeScript repository.
 *
 * The decomposer reasons about a goal against the real contents of the repo it
 * will change. To keep that reasoning pure and reproducible (and runnable in a
 * Worker, a test, or the CLI), the file-system walk is done once by a caller and
 * handed in as a plain list of files. Everything derived from it here is a pure
 * function of that list: no I/O, no clock, no randomness.
 *
 * The snapshot captures only the structural facts the decomposer keys on:
 * which files are source versus tests, how files group into directories
 * (modules), which files look like an entry point or a router, and the exported
 * symbols of each source file. None of this depends on any particular goal, so
 * the same snapshot serves every goal.
 */

/** One file handed to the snapshot: a repo-relative path and its text. */
export interface RepoFile {
  /** Repo-relative POSIX path, e.g. "src/api/handler.ts". */
  readonly path: string;
  /** The file's full text. */
  readonly content: string;
}

/** A single exported symbol discovered in a source file. */
export interface ExportedSymbol {
  readonly name: string;
  /** The kind of export, as a coarse structural category. */
  readonly kind: "function" | "class" | "const" | "type" | "interface" | "default" | "other";
}

/** A source file and the structural facts derived from it. */
export interface SourceFileFacts {
  readonly path: string;
  /** The directory the file lives in, e.g. "src/api" (POSIX, no trailing slash). */
  readonly dir: string;
  /** Exported symbols, in source order, de-duplicated by name. */
  readonly exports: readonly ExportedSymbol[];
  /** Repo-relative import specifiers this file references (local paths only). */
  readonly localImports: readonly string[];
  /** True when the file looks like a program entry point (index / main). */
  readonly isEntryPoint: boolean;
  /** True when the file looks like an HTTP router or request dispatcher. */
  readonly isRouterLike: boolean;
}

/** A directory grouping of source files, used as a candidate module boundary. */
export interface ModuleGroup {
  /** The directory path, e.g. "src/audit". */
  readonly dir: string;
  /** The source file paths in this directory (not recursive), sorted. */
  readonly files: readonly string[];
}

/** The structural snapshot the decomposer consumes. */
export interface RepoSnapshot {
  /** Source (non-test) TypeScript files, sorted by path. */
  readonly sourceFiles: readonly SourceFileFacts[];
  /** Test file paths, sorted. */
  readonly testFiles: readonly string[];
  /** True when the repo has a recognizable test layout (a tests dir or specs). */
  readonly hasTests: boolean;
  /** Source files grouped by directory, sorted by directory path. */
  readonly modules: readonly ModuleGroup[];
}

const TEST_PATTERN = /(^|\/)tests?\//i;
const SPEC_PATTERN = /\.(test|spec)\.[cm]?tsx?$/i;
const TS_SOURCE_PATTERN = /\.[cm]?tsx?$/i;
const DECLARATION_PATTERN = /\.d\.ts$/i;

/**
 * Build a structural snapshot from a flat list of repo files. Non-TypeScript
 * files and declaration files are ignored. Files are classified as tests when
 * they live under a `test`/`tests` directory or match a `.test.`/`.spec.`
 * suffix; everything else TypeScript is a source file.
 */
export function buildRepoSnapshot(files: readonly RepoFile[]): RepoSnapshot {
  const sourceFiles: SourceFileFacts[] = [];
  const testFiles: string[] = [];

  for (const file of files) {
    const path = normalizePath(file.path);
    if (!TS_SOURCE_PATTERN.test(path) || DECLARATION_PATTERN.test(path)) {
      continue;
    }
    if (isTestPath(path)) {
      testFiles.push(path);
      continue;
    }
    sourceFiles.push(analyzeSourceFile(path, file.content));
  }

  sourceFiles.sort((a, b) => comparePath(a.path, b.path));
  testFiles.sort(comparePath);

  const modules = groupIntoModules(sourceFiles);

  return {
    sourceFiles,
    testFiles,
    hasTests: testFiles.length > 0,
    modules,
  };
}

/** Classify a path as a test file by its location or filename suffix. */
export function isTestPath(path: string): boolean {
  return TEST_PATTERN.test(path) || SPEC_PATTERN.test(path);
}

/** Derive the structural facts of a single source file from its text. */
function analyzeSourceFile(path: string, content: string): SourceFileFacts {
  const dir = dirOf(path);
  const base = baseName(path).toLowerCase();
  return {
    path,
    dir,
    exports: extractExports(content),
    localImports: extractLocalImports(content),
    isEntryPoint: base === "index" || base === "main" || base === "server" || base === "app",
    isRouterLike: looksLikeRouter(path, content),
  };
}

/**
 * Extract exported symbols with a small, deterministic set of regexes. This is
 * intentionally a lightweight structural scan, not a full parser: it recognizes
 * the common `export`/`export default` forms that matter for deciding which
 * files carry public surface the goal might target.
 */
function extractExports(content: string): readonly ExportedSymbol[] {
  const found = new Map<string, ExportedSymbol>();
  const add = (name: string, kind: ExportedSymbol["kind"]): void => {
    const trimmed = name.trim();
    if (trimmed !== "" && !found.has(trimmed)) {
      found.set(trimmed, { name: trimmed, kind });
    }
  };

  const declPattern =
    /export\s+(?:async\s+)?(function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(declPattern)) {
    const keyword = match[1] ?? "";
    const name = match[2] ?? "";
    add(name, declKind(keyword));
  }

  if (/export\s+default\b/.test(content)) {
    add("default", "default");
  }

  // Named re-exports and export lists: `export { a, b as c }`.
  const listPattern = /export\s*\{([^}]*)\}/g;
  for (const match of content.matchAll(listPattern)) {
    const inner = match[1] ?? "";
    for (const part of inner.split(",")) {
      const name = (part.split(/\bas\b/).pop() ?? "").trim();
      if (name !== "" && name !== "type") {
        add(name, "other");
      }
    }
  }

  return [...found.values()];
}

function declKind(keyword: string): ExportedSymbol["kind"] {
  switch (keyword) {
    case "function":
      return "function";
    case "class":
      return "class";
    case "const":
    case "let":
    case "var":
      return "const";
    case "type":
      return "type";
    case "interface":
      return "interface";
    default:
      return "other";
  }
}

/** Extract repo-local import specifiers (those starting with "." ) from a file. */
function extractLocalImports(content: string): readonly string[] {
  const specs = new Set<string>();
  const importPattern = /\bfrom\s+["']([^"']+)["']/g;
  for (const match of content.matchAll(importPattern)) {
    const spec = match[1] ?? "";
    if (spec.startsWith(".")) {
      specs.add(spec);
    }
  }
  return [...specs].sort();
}

/**
 * A file looks router-like when its name or its contents suggest request
 * dispatch: a `router`/`routes` name, or recognizable routing surface such as
 * registering routes or matching request paths. Deterministic and content-only.
 */
function looksLikeRouter(path: string, content: string): boolean {
  const base = baseName(path).toLowerCase();
  if (base === "router" || base === "routes" || base === "route") {
    return true;
  }
  const routingSurface =
    /\b(createRouter|addRoute|registerRoute|routeTable|dispatch|req\.path|request\.path)\b/;
  return routingSurface.test(content);
}

/** Group source files by their directory into candidate module boundaries. */
function groupIntoModules(sourceFiles: readonly SourceFileFacts[]): readonly ModuleGroup[] {
  const byDir = new Map<string, string[]>();
  for (const file of sourceFiles) {
    const list = byDir.get(file.dir) ?? [];
    list.push(file.path);
    byDir.set(file.dir, list);
  }
  const groups: ModuleGroup[] = [];
  for (const [dir, files] of byDir) {
    groups.push({ dir, files: [...files].sort(comparePath) });
  }
  groups.sort((a, b) => comparePath(a.dir, b.dir));
  return groups;
}

/** Normalize to POSIX separators and strip any leading "./". */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.replace(/\.[cm]?tsx?$/i, "");
}

/** Deterministic lexicographic path order. */
function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
