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
  /**
   * How many OTHER source files in the repo import this file (its local
   * import in-degree). A high in-degree marks a shared seam the rest of the repo
   * depends on (a contract); a low in-degree marks a leaf consumed by few. This
   * is a purely structural fact derived from the repo's resolved import graph,
   * independent of any goal.
   */
  readonly importedByCount: number;
  /**
   * The paths of the OTHER source files this file imports (its resolved local
   * out-edges). Specifiers that do not resolve to a known source file are
   * dropped. Sorted and de-duplicated.
   */
  readonly importsFiles: readonly string[];
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
const SPEC_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const SOURCE_PATTERN = /\.[cm]?[jt]sx?$/i;
const DECLARATION_PATTERN = /\.d\.ts$/i;

/**
 * Build a structural snapshot from a flat list of repo files. Non-source files
 * (anything that is not a JavaScript or TypeScript module) and TypeScript
 * declaration files are ignored. A repo may be authored in either language or a
 * mix; the structural facts the decomposer keys on (modules, exports, imports,
 * entry points) are the same for both. Files are classified as tests when they
 * live under a `test`/`tests` directory or match a `.test.`/`.spec.` suffix;
 * everything else is a source file.
 */
export function buildRepoSnapshot(files: readonly RepoFile[]): RepoSnapshot {
  const rawSources: RawSourceFacts[] = [];
  const testFiles: string[] = [];

  for (const file of files) {
    const path = normalizePath(file.path);
    if (!SOURCE_PATTERN.test(path) || DECLARATION_PATTERN.test(path)) {
      continue;
    }
    if (isTestPath(path)) {
      testFiles.push(path);
      continue;
    }
    rawSources.push(analyzeSourceFile(path, file.content));
  }

  rawSources.sort((a, b) => comparePath(a.path, b.path));
  testFiles.sort(comparePath);

  // Second pass: resolve each file's local import specifiers to actual source
  // files and compute the import graph (out-edges per file and the in-degree
  // per file). This is a pure structural fact derived from the resolved edges,
  // independent of any goal, and is what the cohesion blueprint keys on to tell
  // a shared seam (high in-degree) from a leaf module (low in-degree).
  const knownPaths = new Set(rawSources.map((f) => f.path));
  const importsByPath = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const file of rawSources) {
    const resolved = new Set<string>();
    for (const spec of file.localImports) {
      const target = resolveLocalImport(file.path, spec, knownPaths);
      if (target && target !== file.path) {
        resolved.add(target);
      }
    }
    const out = [...resolved].sort(comparePath);
    importsByPath.set(file.path, out);
    for (const target of out) {
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }

  const sourceFiles: SourceFileFacts[] = rawSources.map((file) => ({
    ...file,
    importsFiles: importsByPath.get(file.path) ?? [],
    importedByCount: inDegree.get(file.path) ?? 0,
  }));

  const modules = groupIntoModules(sourceFiles);

  return {
    sourceFiles,
    testFiles,
    hasTests: testFiles.length > 0,
    modules,
  };
}

/** The structural facts of a source file before the import graph is resolved. */
type RawSourceFacts = Omit<SourceFileFacts, "importsFiles" | "importedByCount">;

/** Classify a path as a test file by its location or filename suffix. */
export function isTestPath(path: string): boolean {
  return TEST_PATTERN.test(path) || SPEC_PATTERN.test(path);
}

/** Derive the structural facts of a single source file from its text. */
function analyzeSourceFile(path: string, content: string): RawSourceFacts {
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
  return file.replace(/\.[cm]?[jt]sx?$/i, "");
}

/**
 * Resolve a repo-local import specifier (one starting with ".") from the
 * importing file to an actual source file path in the repo, or undefined when
 * it does not resolve to a known source file. Honors the common module
 * resolution forms: an explicit extension, a bare path tried with each known
 * source extension, and a directory index. Pure and deterministic; it only ever
 * returns a path the snapshot already knows about, so a resolved edge always
 * points at a real file.
 */
function resolveLocalImport(
  fromPath: string,
  spec: string,
  known: ReadonlySet<string>,
): string | undefined {
  const fromDir = dirOf(fromPath);
  const base = normalizePath(joinPosix(fromDir, spec));
  // An authored specifier commonly points at a sibling with a .js extension even
  // when the source file is .ts; try the specifier as-written, then the same
  // path with its extension swapped for each known source extension, then an
  // index file inside it (a directory import).
  const candidates: string[] = [];
  candidates.push(base);
  const withoutExt = base.replace(/\.[cm]?[jt]sx?$/i, "");
  const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  for (const ext of EXTENSIONS) {
    candidates.push(`${withoutExt}${ext}`);
  }
  for (const ext of EXTENSIONS) {
    candidates.push(`${base}${ext}`);
    candidates.push(`${base}/index${ext}`);
  }
  for (const candidate of candidates) {
    if (known.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Join two POSIX path fragments and collapse "." / ".." segments. */
function joinPosix(dir: string, rel: string): string {
  const segments = (dir === "" ? [] : dir.split("/")).concat(rel.split("/"));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/** Deterministic lexicographic path order. */
function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
