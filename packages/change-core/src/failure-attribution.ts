/**
 * Failure attribution by parsing a failing gate's output: which units (board
 * items, WorkUnits) does it implicate? The files and resource names the output
 * reports are mapped to the units' declared paths and ids. Best-effort
 * narrowing, never a correctness claim: when nothing maps, every unit is
 * implicated (`attributed: false`). Shared by the local drivers and the
 * integration Workflow on Cloudflare. Pure: no I/O.
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
): { readonly units: readonly U[]; readonly attributed: boolean } {
  const failingFiles = extractFailingFiles(evidence);
  const failingNames = extractFailingNames(evidence);
  if (failingFiles.length === 0 && failingNames.length === 0) {
    return { units: gatedUnits, attributed: false }; // nothing to attribute to: re-fan all
  }
  const implicated = gatedUnits.filter(
    (unit) =>
      unit.paths.some((declared) => failingFiles.some((file) => pathCovers(declared, file))) ||
      failingNames.some((name) => unitCoversName(unit, name)),
  );
  // Honest fallback: if neither the named files nor the named resources map to
  // any unit, re-fan all rather than silently skip (the change failed either
  // way). Attribution is best-effort narrowing, not a correctness claim.
  return implicated.length > 0
    ? { units: implicated, attributed: true }
    : { units: gatedUnits, attributed: false };
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
  const assertionShape = /(?:Error|AssertionError)[^:]*:\s+([A-Za-z0-9_-]+)\s+(?:must\b|should\b)/;
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
  const at = /((?:[A-Za-z]:)?[A-Za-z0-9_./-]*\/?[A-Za-z0-9_.-]+\.[A-Za-z0-9]+):\d+/g;
  let match: RegExpExecArray | null;
  while ((match = at.exec(text)) !== null) {
    const raw = match[1]!.replace(/^file:\/\//, "");
    if (!/^node:/.test(match[0]) && !raw.startsWith("node:") && raw.includes("/")) {
      located.add(raw);
    }
  }
  if (located.size > 0) {
    return [...located];
  }
  const found = new Set<string>();
  // Otherwise: path-shaped tokens, one or more segments separated by `/`,
  // ending in a file with an extension.
  const re = /([A-Za-z0-9_.-]+\/[A-Za-z0-9/_.-]+\.[A-Za-z0-9]+)/g;
  while ((match = re.exec(text)) !== null) {
    const raw = match[1];
    if (raw) {
      found.add(raw);
    }
  }
  return [...found];
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
