/**
 * Failure attribution by parsing a failing gate's output: which units (board
 * items, WorkUnits) does it implicate? The files and resource names the output
 * reports are mapped to the units' declared paths and ids; when none does, the
 * failing TESTS (their files and describe names) are mapped to the code they
 * exercise, most specific match first. Best-effort narrowing, never a
 * correctness claim: when nothing maps, every unit is implicated
 * (`attributed: false`). A caller may also pass the OUTSTANDING
 * units (work not in the gated tree): a failure that maps only to them
 * implicates no gated unit. Shared by the local drivers and the integration
 * Workflow on Cloudflare. Pure: no I/O.
 */

/** What attribution needs of a unit. */
export interface AttributableUnit {
  readonly unitId: string;
  readonly paths: readonly string[];
}

/**
 * The attribution result for a change-level gate failure: the implicated units
 * AND whether the failure could genuinely be attributed to specific units
 * (`attributed: true` when the parse mapped at least one named file/resource to
 * a declared unit) or fell back to re-fanning ALL gated units (`attributed:
 * false`, the honest "cannot attribute" case). The boolean is what lets the
 * ladder record an honest re-fan source: a narrowed parse ("parse") versus the
 * re-fan-all fallback ("all").
 */
export function attributeFailure<U extends AttributableUnit>(
  gatedUnits: readonly U[],
  evidence: string,
  outstandingUnits: readonly U[] = [],
): { readonly units: readonly U[]; readonly attributed: boolean; readonly outstanding: readonly U[] } {
  const failingFiles = extractFailingFiles(evidence);
  const failingNames = extractFailingNames(evidence);
  const maps = (unit: U) =>
    unit.paths.some((declared) => failingFiles.some((file) => pathCovers(declared, file))) || failingNames.some((name) => unitCoversName(unit, name));
  const implicated = gatedUnits.filter(maps);
  // The same parse over the units whose work is NOT in the gated tree.
  const outstanding = outstandingUnits.filter(maps);
  if (implicated.length > 0) {
    // Mixed: only the gated units whose own failures the output names.
    return { units: implicated, attributed: true, outstanding };
  }
  if (outstanding.length > 0) {
    // Every named failure is an outstanding unit's (its fix is not in this
    // tree yet): no gated unit is implicated.
    return { units: [], attributed: true, outstanding };
  }
  // Nothing named a declared file or resource directly: the failing TESTS
  // (their files and describe names) still name the code they exercise
  // (`tests/billing/tax.test.ts` -> `src/billing/tax.ts`, `orders > ...` ->
  // `src/orders/**`). Mapped over gated and outstanding units together so the
  // most specific match wins across both.
  const tested = testSubjectMatches([...gatedUnits, ...outstandingUnits], (unit) => unit.paths, evidence);
  if (tested.size > 0) {
    return { units: gatedUnits.filter((u) => tested.has(u)), attributed: true, outstanding: outstandingUnits.filter((u) => tested.has(u)) };
  }
  // Honest fallback: if neither the named files, the named resources, nor the
  // failing tests map to any unit, re-fan all rather than silently skip (the
  // change failed either way). Attribution is best-effort narrowing, not a
  // correctness claim.
  return { units: gatedUnits, attributed: false, outstanding: [] };
}

/** Directory names that hold tests: a test path's subject starts after the last one. */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs"]);

/** Segments and words too generic to name the code a test exercises. */
const GENERIC_SEGMENTS = new Set([
  "src",
  "lib",
  "app",
  "apps",
  "packages",
  "pkg",
  "source",
  "index",
  "main",
  "dist",
  "build",
  "test",
  "tests",
  "spec",
  "specs",
  "__tests__",
  "and",
  "the",
  "for",
  "with",
]);

/** A test-NAMED file (`x.test.ts`, `x.spec.js`, `test_x.py`, `x_test.go`): the failing test itself. */
function isTestNamed(path: string): boolean {
  return /\.(test|spec)\.[A-Za-z0-9]+$/.test(path) || /(^|\/)test_[^/]+\.py$|_test\.(go|py)$/.test(path);
}

/** Whether a path lies in an installed dependency (never a unit's code). */
function inDependency(path: string): boolean {
  return /(^|[\/])node_modules[\/]/.test(path);
}

/**
 * The failing TESTS a gate output reports: test-named files (from vitest's
 * `FAIL <file> > ...` and failed-file `❯ <file> (...)` lines, jest's
 * `FAIL <file>`, and any error location in a test file, as node:test's stack
 * frames give) and describe names (vitest's `× <describe> > <test>` and
 * `FAIL <file> > <describe> > <test>`, jest's `● <describe> › <test>`).
 * Passing lines (`✓`, `✔`, `PASS`) are never read. Linear time.
 */
function extractFailingTests(evidence: string): { readonly files: readonly string[]; readonly describes: readonly string[] } {
  const files = new Set<string>();
  const describes = new Set<string>();
  const lines = evidence.split(/\r?\n/).filter((line) => !/^\s*[>$] /.test(line));
  const addFile = (raw: string) => {
    const clean = raw.replace(/^file:\/\//, "").replace(/(:\d+)+$/, "");
    if (isTestNamed(clean) && !inDependency(clean)) {
      files.add(clean);
    }
  };
  for (const raw of errorLocations(lines.join("\n"))) {
    addFile(raw);
  }
  const addDescribe = (title: string, separator: string) => {
    const at = title.indexOf(separator);
    if (at > 0) {
      describes.add(title.slice(0, at).trim());
    }
  };
  for (const line of lines) {
    const marker = /^\s*(FAIL|\u276f|[\u00d7\u2716\u2717]|\u25cf)\s+/.exec(line);
    if (!marker) {
      continue;
    }
    const rest = line.slice(marker[0].length);
    const space = rest.search(/\s/);
    const token = space < 0 ? rest : rest.slice(0, space);
    if (isTestNamed(token.replace(/(:\d+)+$/, ""))) {
      addFile(token);
      // `FAIL <file> > <describe> > <test>`: the describe follows the file.
      if (rest.slice(token.length).startsWith(" > ")) {
        addDescribe(rest.slice(token.length + 3), " > ");
      }
      continue;
    }
    if (marker[1] === "\u25cf") {
      addDescribe(rest, " \u203a ");
    } else if (marker[1] !== "FAIL" && marker[1] !== "\u276f") {
      addDescribe(rest, " > ");
    }
  }
  return { files: [...files], describes: [...describes] };
}

/** A name and its simple singular/plural forms (`order` <-> `orders`). */
function nameVariants(name: string): ReadonlySet<string> {
  return new Set([name, `${name}s`, name.endsWith("s") ? name.slice(0, -1) : name]);
}

/**
 * The SUBJECT of a test file: its path after the last test directory, with the
 * test suffix dropped, lowercased (`tests/billing/tax.test.ts` ->
 * `billing/tax`, `src/orders/cart.test.ts` -> `src/orders/cart`).
 */
function testSubject(file: string): string[] {
  const segments = file.split(/[\\/]/).filter((seg) => seg !== "");
  let start = 0;
  segments.forEach((seg, i) => {
    if (TEST_DIRS.has(seg.toLowerCase()) && i < segments.length - 1) {
      start = i + 1;
    }
  });
  const subject = segments.slice(start).map((seg) => seg.toLowerCase());
  const last = subject.pop() ?? "";
  const stem = last
    .replace(/\.(test|spec)\.[a-z0-9]+$/, "")
    .replace(/^test_/, "")
    .replace(/_test\.[a-z0-9]+$/, "")
    .replace(/\.[a-z0-9]+$/, "");
  return stem === "" ? subject : [...subject, stem];
}

/**
 * A declared path's shape: its directory segments and its full segments with
 * the file extension dropped (a glob is cut at its first wildcard segment, so
 * `src/orders/**` is the directory `src/orders`).
 */
function declaredShape(declared: string): { readonly dirs: readonly string[]; readonly full: readonly string[] } {
  const segments = declared.replace(/^\.\//, "").split("/").filter((seg) => seg !== "");
  const wild = segments.findIndex((seg) => seg.includes("*"));
  const kept = (wild < 0 ? segments : segments.slice(0, wild)).map((seg) => seg.toLowerCase());
  if (wild < 0 && kept.length > 0 && hasExtension(kept.at(-1)!)) {
    return { dirs: kept.slice(0, -1), full: [...kept.slice(0, -1), kept.at(-1)!.replace(/\.[a-z0-9]+$/, "")] };
  }
  return { dirs: kept, full: kept };
}

/**
 * How specifically a declared path matches a test subject (0: not at all):
 *   3: the subject's directory AND name (`billing/tax` -> `src/billing/tax.ts`);
 *   2: its name (`tax` -> `.../tax.ts`, `orders` -> `src/orders/**`);
 *   1: its domain, a directory named like the subject's directory or name
 *      (`orders` -> `src/orders/cart.ts`, `billing/tax` -> `src/billing/*`).
 */
function subjectTier(declared: string, subject: readonly string[]): number {
  const { dirs, full } = declaredShape(declared);
  const name = subject.at(-1);
  if (name === undefined || full.length === 0) {
    return 0;
  }
  if (subject.length >= 2 && full.length >= 2 && full.at(-1) === name && full.at(-2) === subject.at(-2)) {
    return 3;
  }
  if (nameVariants(name).has(full.at(-1)!)) {
    return 2;
  }
  const domain = subject.slice(-2).filter((seg) => !GENERIC_SEGMENTS.has(seg));
  return dirs.some((dir) => !GENERIC_SEGMENTS.has(dir) && domain.some((seg) => nameVariants(seg).has(dir))) ? 1 : 0;
}

/**
 * The candidates the failing tests in `evidence` exercise, each test subject
 * resolved to its MOST SPECIFIC matches only (see subjectTier). Test files
 * are the stronger evidence: describe names are used only when no failing
 * test file maps. A describe name is tried word by word from its last word
 * (the head noun: `checkout tax` is about tax) and the first word that maps
 * wins. Pure, deterministic.
 */
function testSubjectMatches<T>(candidates: readonly T[], pathsOf: (candidate: T) => readonly string[], evidence: string): ReadonlySet<T> {
  const { files, describes } = extractFailingTests(evidence);
  const best = (subject: readonly string[]): T[] => {
    let top = 0;
    let out: T[] = [];
    for (const candidate of candidates) {
      const tier = Math.max(0, ...pathsOf(candidate).map((declared) => subjectTier(declared, subject)));
      if (tier > top) {
        top = tier;
        out = [candidate];
      } else if (tier > 0 && tier === top) {
        out.push(candidate);
      }
    }
    return out;
  };
  const matched = new Set<T>(files.flatMap((file) => best(testSubject(file))));
  if (matched.size > 0) {
    return matched;
  }
  for (const title of describes) {
    const words = title
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((word) => word.length >= 3 && !GENERIC_SEGMENTS.has(word));
    for (const word of words.reverse()) {
      const hits = best([word]);
      if (hits.length > 0) {
        hits.forEach((hit) => matched.add(hit));
        break;
      }
    }
  }
  return matched;
}

/**
 * Extract the distinct failing RESOURCE NAMES from a failing gate output. The
 * change-level gate is a node:test suite whose assertion names are keyed by the
 * resource NAME, not a source path (e.g. `users: authenticated, valid request
 * still succeeds` or `users must still succeed`). This pulls the leading
 * `<name>` token off those failing-assertion lines so a name->unit map can be
 * built even when the output names no source file. Returns a deduplicated list;
 * an empty list means no resource name was attributable.
 */
function extractFailingNames(evidence: string): readonly string[] {
  const found = new Set<string>();
  const lines = evidence.split(/\r?\n/);
  // Deterministic tokens for a failing assertion across BOTH node:test reporters:
  //   - the TAP reporter: `not ok 1 - <name>: ...` / a bare `<name>: ...` /
  //     `<name> must ...` at the line start;
  //   - the SPEC reporter (the DEFAULT when node --test runs piped/non-TTY, which
  //     is how the gate runs): a failing test line is prefixed by a STATUS GLYPH
  //     such as `✖ users: ...` (U+2716) or `✔`/`✓`/`✗`, so the leading identifier
  //     sits AFTER that glyph, not at the line start.
  // The optional prefix therefore allows the TAP shapes AND a leading FAILING
  // status glyph with its whitespace, so `✖ <name>: ...` yields `<name>`. Only
  // the FAILING glyphs (`✖` U+2716, `✗` U+2717, `×` U+00D7) are allowed, NOT the
  // passing `✔`/`✓`: the SPEC reporter prints a `✔ <name>: ...` line for every
  // PASSING test too, so matching a passing glyph would misattribute a passing
  // resource as failing and re-fan a unit that did not fail.
  const prefix = String.raw`(?:not ok\s+\d+\s+-\s+|#\s+|[\u2716\u2717\u00d7]\s+|\s*)?`;
  const colonShape = new RegExp(`^${prefix}([A-Za-z0-9_-]+):\\s+\\S`);
  const mustShape = new RegExp(`^${prefix}([A-Za-z0-9_-]+)\\s+must\\s+\\S`);
  // The SPEC reporter prints the failure detail as an indented assertion message
  // such as `  AssertionError [ERR_ASSERTION]: users must reject ...`, where the
  // real resource token sits MID-LINE after the error class and code, not at the
  // line start. Scan that message anywhere in the line for the leading resource
  // token that precedes a `must`/`:` so the name is recovered even when the
  // top-level `✖ <name>` line was not captured.
  // The error-class span is bounded so a long colon-free line stays linear.
  const assertionShape = /(?:Error|AssertionError)[^:]{0,200}:\s+([A-Za-z0-9_-]+)\s+(?:must\b|should\b)/;
  for (const line of lines) {
    const colon = colonShape.exec(line);
    if (colon && colon[1]) {
      found.add(colon[1]);
      continue;
    }
    const must = mustShape.exec(line);
    if (must && must[1]) {
      found.add(must[1]);
      continue;
    }
    const assertion = assertionShape.exec(line);
    if (assertion && assertion[1]) {
      found.add(assertion[1]);
    }
  }
  return [...found];
}

/**
 * Whether a gated unit owns a failing resource name. The unit->resource
 * relationship is carried by the unit's id and its declared paths: a resource
 * `users` is owned by the unit whose id is (or ends with) `users` or whose
 * declared paths contain a `.../<name>.js` (or `<name>.ts`) segment. Matching is
 * on whole path segments so `users` never matches `users-admin.js`.
 */
function unitCoversName(unit: AttributableUnit, name: string): boolean {
  const n = name.toLowerCase();
  const id = unit.unitId.toLowerCase();
  if (id === n || id.endsWith(`-${n}`) || id.endsWith(`/${n}`) || id.endsWith(`:${n}`)) {
    return true;
  }
  return unit.paths.some((declared) => {
    const normalized = declared.replace(/^\.\//, "").replace(/[*]+/g, "");
    const segments = normalized.split("/").filter((seg) => seg.length > 0);
    return segments.some((seg) => {
      const base = seg.replace(/\.[A-Za-z0-9]+$/, "").toLowerCase();
      return base === n;
    });
  });
}

/**
 * Extract repo-relative file paths named in a failing gate output. node:test and
 * typecheck output name source files (e.g. `src/routes/create.js`) in assertion
 * and stack-trace lines, so a conservative path-shaped match pulls those out.
 * Returns a deduplicated list; an empty list means nothing attributable.
 */
function extractFailingFiles(evidence: string): readonly string[] {
  // Command echoes name every file a script checks, failing or not: npm, yarn,
  // and pnpm print each script's command line as `> <command>` after its
  // `> <package>@<version> <script>` header, and shells print `$ <command>`.
  // Those lines say nothing about what failed, so they are ignored.
  const lines = evidence.split(/\r?\n/).filter((line) => !/^\s*[>$] /.test(line));
  const text = lines.join("\n");
  // Error LOCATIONS (`<path>:<line>`, as in a syntax error or a stack frame)
  // name the file that failed; prefer them when there are any.
  const located = new Set<string>();
  // `<path>:<line>` (stack frames, most runners) and tsc's `<path>(<line>,<col>)`.
  // A location inside an installed dependency is never a unit's code.
  for (const raw of errorLocations(text)) {
    if (!inDependency(raw)) {
      located.add(raw);
    }
  }
  if (located.size > 0) {
    return [...located];
  }
  const found = new Set<string>();
  // Otherwise: path-shaped tokens, one or more segments separated by `/`,
  // ending in a file with an extension.
  for (const raw of pathTokens(text)) {
    if (!inDependency(raw)) {
      found.add(raw);
    }
  }
  return [...found];
}

/**
 * The longest path-shaped token attribution considers. Gate output is
 * agent-influenced, so a token longer than any real path is ignored rather
 * than walked (it names no file a unit declares).
 */
const MAX_PATH_TOKEN = 1024;

/** A character a path token may contain. */
const PATH_RUN = /[A-Za-z0-9_./-]+/g;

/**
 * The maximal runs of path characters in `text`, each with its start offset.
 * One forward pass with a single-class, non-nested pattern: linear time, so a
 * long unbroken token in a failing gate's output cannot stall the integrator.
 * Runs longer than MAX_PATH_TOKEN are skipped.
 */
function pathRuns(text: string): Array<{ readonly run: string; readonly start: number }> {
  const out: Array<{ run: string; start: number }> = [];
  PATH_RUN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_RUN.exec(text)) !== null) {
    if (match[0].length <= MAX_PATH_TOKEN) {
      out.push({ run: match[0], start: match.index });
    }
  }
  return out;
}

/** Whether `segment` ends in a file extension: `<one or more chars>.<alnum>+`. */
function hasExtension(segment: string): boolean {
  const dot = segment.lastIndexOf(".");
  return dot >= 1 && dot < segment.length - 1 && /^[A-Za-z0-9]+$/.test(segment.slice(dot + 1));
}

/**
 * Error LOCATIONS in `text`: a path ending in a file with an extension,
 * immediately followed by `:<line>` (stack frames, most runners) or tsc's
 * `(<line>,<col>)`. A one-letter drive prefix (`C:`) is kept; `node:` internals
 * and paths with no directory are dropped. Linear time (see pathRuns).
 */
function errorLocations(text: string): string[] {
  const out: string[] = [];
  for (const { run, start } of pathRuns(text)) {
    const end = start + run.length;
    const last = run.slice(run.lastIndexOf("/") + 1);
    if (!hasExtension(last)) {
      continue;
    }
    const next = text.charCodeAt(end + 1);
    const lineFollows = text[end] === ":" && next >= 48 && next <= 57;
    const tscFollows = text[end] === "(" && /^\(\d{1,9},\d{1,9}\)/.test(text.slice(end, end + 22));
    if (!lineFollows && !tscFollows) {
      continue;
    }
    if (text.slice(Math.max(0, start - 5), start) === "node:") {
      continue;
    }
    const drive =
      start >= 2 && text[start - 1] === ":" && /[A-Za-z]/.test(text[start - 2]!) && (start < 3 || !/[A-Za-z0-9_./-]/.test(text[start - 3]!))
        ? text.slice(start - 2, start)
        : "";
    const raw = `${drive}${run}`;
    if (raw.includes("/")) {
      out.push(raw);
    }
  }
  return out;
}

/**
 * Path-shaped tokens in `text`: one or more segments separated by `/`, ending
 * in a file with an extension (`src/a.js`, `pkg/lib/x.test.ts`). Per run of path
 * characters the token starts at the first non-slash character that has a
 * slash after it and ends at the furthest `.<alnum>+` extension after that
 * slash with at least one character between them. Linear time.
 */
function pathTokens(text: string): string[] {
  const out: string[] = [];
  const isAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  for (const { run } of pathRuns(text)) {
    let s = 0;
    while (s < run.length && run[s] === "/") {
      s += 1;
    }
    const slash = run.indexOf("/", s);
    if (s >= run.length || slash < 0) {
      continue;
    }
    // Walk back from the end over alphanumeric runs: the first one preceded by
    // a dot far enough past the slash ends the token.
    let e = run.length;
    let found = -1;
    while (e > slash + 2) {
      let a = e;
      while (a > slash + 1 && isAlnum(run.charCodeAt(a - 1))) {
        a -= 1;
      }
      if (a < e && run[a - 1] === "." && a - 1 >= slash + 2) {
        found = e;
        break;
      }
      e = a < e ? a : e - 1;
    }
    if (found > 0) {
      out.push(run.slice(s, found));
    }
  }
  return out;
}

/**
 * Whether a declared WorkUnit path covers a failing file path. Supports an exact
 * match, a directory/prefix match (the declared path is a parent of the file),
 * and a simple `*`/`**` glob (as the example apps declare, e.g. `src/routes/**`).
 */
function pathCovers(declared: string, file: string): boolean {
  // A failing file is often reported by its ABSOLUTE path in the checkout the
  // gate ran in (`/tmp/scf-integration-x/src/a.js`): it covers a declared path
  // when any trailing part of it does.
  const segments = file.replace(/^\.\//, "").split("/").filter((seg) => seg !== "");
  for (let i = 0; i < segments.length; i += 1) {
    if (pathCoversRelative(declared, segments.slice(i).join("/"))) {
      return true;
    }
  }
  return false;
}

function pathCoversRelative(declared: string, file: string): boolean {
  const d = declared.replace(/^\.\//, "").replace(/\/+$/, "");
  const f = file.replace(/^\.\//, "");
  if (d === f) {
    return true;
  }
  if (d.includes("*")) {
    // Translate a simple glob to a RegExp: `**` matches across segments, `*`
    // within a segment. Anchored to the whole path.
    const escaped = d
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*");
    return new RegExp(`^${escaped}$`).test(f);
  }
  // Directory/prefix match: the declared path is a parent directory of the file.
  return f === d || f.startsWith(`${d}/`);
}

/**
 * How a failing revision's implicated items were chosen: `outstanding` means
 * the failure mapped only to items NOT in the revision, so no merged item is
 * implicated.
 */
export type ImplicationSource = "parse" | "jev" | "all" | "outstanding";

/**
 * Combine the parse with an advisory typed-decision pick into the implicated
 * set and its HONEST source label. Shared by the local integrator and the
 * integration Workflow on Cloudflare so both record the same set and label:
 *   - no confident pick: the parse (`parse`), or every merged item when the
 *     parse attributed nothing (`all`);
 *   - an unattributed parse ("all") and a confident pick: the pick ALONE
 *     (`jev`), never the pick unioned with every item;
 *   - an attributed parse and a pick it already contains: the parse (`parse`:
 *     the pick changed nothing);
 *   - an attributed parse and a pick outside it: the parse plus the pick (`jev`);
 *   - when the parse ALSO mapped failures to outstanding items (not in the
 *     revision): it explained the failure, so no pick adds blame to a merged
 *     item it cleared: the parse's merged items (`parse`), or none
 *     (`outstanding`) when every failure was an outstanding item's.
 * Picks naming items outside `merged` are ignored. The result keeps `merged`'s order.
 */
export function combineAttribution(input: {
  readonly merged: readonly string[];
  /** The parse's implicated items (every merged item when it attributed nothing). */
  readonly parsed: readonly string[];
  readonly attributed: boolean;
  /** The confident typed-decision pick(s); empty for none. */
  readonly picks: readonly string[];
  /** Items not in the revision the parse mapped failures to (absent or empty: none). */
  readonly outstanding?: readonly string[];
}): { readonly items: readonly string[]; readonly source: ImplicationSource } {
  const picks = input.picks.filter((p) => input.merged.includes(p));
  const ordered = (set: ReadonlySet<string>) => input.merged.filter((id) => set.has(id));
  if (input.attributed && (input.outstanding ?? []).length > 0) {
    const parsed = ordered(new Set(input.parsed));
    return parsed.length > 0 ? { items: parsed, source: "parse" } : { items: [], source: "outstanding" };
  }
  if (picks.length === 0) {
    return input.attributed
      ? { items: ordered(new Set(input.parsed)), source: "parse" }
      : { items: [...input.merged], source: "all" };
  }
  if (!input.attributed) {
    return { items: ordered(new Set(picks)), source: "jev" };
  }
  const parsed = new Set(input.parsed);
  if (picks.every((p) => parsed.has(p))) {
    return { items: ordered(parsed), source: "parse" };
  }
  return { items: ordered(new Set([...parsed, ...picks])), source: "jev" };
}

/**
 * The repo files a failing gate output points at, most telling evidence first:
 *   1. failing test TITLES mapped to the modules named like them (`users: ...`
 *      or `users must ...` -> a source file `users.*`, or its singular/plural)
 *      and error LOCATIONS outside stack frames (a type error's
 *      `path(line,col)`, a syntax error's `path:line`);
 *   2. only when there are none: stack frames, and of each stack only the
 *      outermost repo frame that is not a test (the CALLER nearest the test).
 *      A file seen only as a deeper callee in a frame (a shared helper the
 *      failing code called, such as a contract's check) is never the place a
 *      failure is "in";
 *   3. only when there are no locations at all: path-shaped tokens;
 *   4. only when none of those resolve: the source files the failing tests
 *      exercise (`tests/billing/tax.test.ts` -> `src/billing/tax.ts`, a
 *      describe `orders > ...` -> `src/orders/*`), most specific match first.
 * A location inside `node_modules` is never a repo file.
 * An absolute path in the gate's checkout resolves by its repo-relative
 * suffix. Test files are excluded (they are the contract, or new tests).
 * Pure, sorted, deduplicated.
 */
export function failingRepoFiles(evidence: string, repoFiles: readonly string[]): string[] {
  const sources = repoFiles.filter((f) => !isTestFile(f));
  const resolve = (raw: string): string | undefined => {
    const clean = raw.replace(/^file:\/\//, "").replace(/^\.\//, "");
    if (inDependency(clean)) {
      return undefined;
    }
    return repoFiles.find((f) => clean === f || clean.endsWith(`/${f}`));
  };
  const titled = new Set<string>();
  for (const name of extractFailingNames(evidence)) {
    const n = name.toLowerCase();
    const variants = new Set([n, `${n}s`, n.endsWith("s") ? n.slice(0, -1) : n]);
    for (const file of sources) {
      const base = (file.split("/").pop() ?? "").replace(/\.[A-Za-z0-9]+$/, "").toLowerCase();
      if (variants.has(base)) {
        titled.add(file);
      }
    }
  }
  const lines = evidence.split(/\r?\n/).filter((line) => !/^\s*[>$] /.test(line));
  const locationsIn = (line: string): string[] => errorLocations(line);
  const nonFrame = new Set<string>();
  const callers = new Set<string>();
  let stack: string[] = [];
  const closeStack = () => {
    const caller = stack.filter((f) => !isTestFile(f)).at(-1);
    if (caller !== undefined) {
      callers.add(caller);
    }
    stack = [];
  };
  for (const line of lines) {
    if (/^\s*at\s/.test(line)) {
      for (const raw of locationsIn(line)) {
        const hit = resolve(raw);
        if (hit !== undefined) {
          stack.push(hit);
        }
      }
      continue;
    }
    closeStack();
    for (const raw of locationsIn(line)) {
      const hit = resolve(raw);
      if (hit !== undefined && !isTestFile(hit)) {
        nonFrame.add(hit);
      }
    }
  }
  closeStack();
  const first = new Set([...titled, ...nonFrame]);
  if (first.size > 0) {
    return [...first].sort();
  }
  if (callers.size > 0) {
    return [...callers].sort();
  }
  const out = new Set<string>();
  for (const raw of extractFailingFiles(evidence)) {
    const hit = resolve(raw);
    if (hit && !isTestFile(hit)) {
      out.add(hit);
    }
  }
  if (out.size > 0) {
    return [...out].sort();
  }
  // Last: the source files the failing tests exercise (their files and
  // describe names, most specific match first).
  return [...testSubjectMatches(sources, (file) => [file], evidence)].sort();
}

/** A test-shaped path (never a module a failure is "in"). */
function isTestFile(path: string): boolean {
  return /(^|\/)(tests?|__tests__|specs?)\//.test(path) || /\.(test|spec)\.[A-Za-z0-9]+$/.test(path) || /(^|\/)test_[^/]+\.py$|_test\.(go|py)$/.test(path);
}
