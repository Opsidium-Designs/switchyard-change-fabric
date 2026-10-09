/**
 * The gate's TEST INVENTORY: which tests a gate run actually executed, read
 * from the runner's own output (no flags are injected, so the gate command, and
 * therefore gate-equals-deploy, is unchanged).
 *
 * Exit codes alone can be greened by code under test that exits early
 * (`process.exit(0)` at import, `os._exit(0)`, a `TestMain` that exits 0): the
 * failing tests simply never run. Recording the inventory of the BASELINE gate
 * run and requiring every later run to execute at least those tests (by name
 * where the runner prints names, by count otherwise) closes that hole.
 *
 * Recognized output (the first that matches wins):
 *   - node --test spec reporter (`✔ name (1ms)`, `ℹ tests N`, `ℹ skipped N`)
 *   - TAP, including node --test's TAP reporter (`ok 1 - name`, `# SKIP`)
 *   - go test -json (`{"Action":"pass","Test":...}`) and go test -v (`--- PASS: Name`)
 *   - pytest -v (`path::test PASSED`) and its summary line (`3 passed, 1 failed in 0.1s`)
 *   - vitest (`Tests  1 failed | 2 passed (3)`) and jest (`Tests: 1 failed, 2 passed, 3 total`)
 * A skipped or todo test does not count as executed.
 *
 * Hardening against output the code under test prints itself: only the LAST
 * summary line counts, a run must report in the baseline's format, a run that
 * reports no names when the baseline did falls short, and entries that name a
 * test FILE (node prints `✖ test/a.test.mjs` for a file that failed to load)
 * are not test names: such a file only has to contribute tests (the count).
 * The gate command is never changed (no reporter flag is injected: the gate is
 * usually an npm script whose runner invocation is not ours to rewrite), so a
 * test can still print lines that look like a reporter's; that residual risk
 * is bounded by the last-summary, format, and name rules, not eliminated.
 */

/** What one gate run executed. */
export interface TestInventory {
  /** Which reporter shape was recognized. */
  readonly format: "node-spec" | "tap" | "go-json" | "go-verbose" | "pytest" | "vitest" | "jest";
  /** Tests executed (passed or failed; skipped and todo excluded). */
  readonly count: number;
  /** Executed test names, when the format prints them (sorted, unique; never test file paths). */
  readonly names: readonly string[];
}

/** A reporter entry that names a test FILE (a file-level result), not a test. */
function isFileEntry(name: string): boolean {
  return /^\S+\.[cm]?[jt]sx?$/.test(name) || /^\S*\/\S+\.(py|go|rb)$/.test(name);
}

/** The last match of a pattern (a test can print an early fake summary; the runner's comes last). */
function lastMatch(re: RegExp, text: string): RegExpMatchArray | undefined {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  return [...text.matchAll(new RegExp(re.source, flags))].at(-1);
}

const unique = (names: Iterable<string>) => [...new Set(names)].sort();

function nodeSpec(text: string): TestInventory | undefined {
  const tests = lastMatch(/^\s*ℹ tests (\d+)\s*$/m, text);
  if (!tests) {
    return undefined;
  }
  const skipped = Number(lastMatch(/^\s*ℹ skipped (\d+)\s*$/m, text)?.[1] ?? 0);
  const todo = Number(lastMatch(/^\s*ℹ todo (\d+)\s*$/m, text)?.[1] ?? 0);
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[✔✖] (.+?) \(\d+(?:\.\d+)?ms\)(\s+#\s*(SKIP|TODO)\b.*)?\s*$/.exec(line);
    if (m && !m[2] && !isFileEntry(m[1]!.trim())) {
      names.push(m[1]!.trim());
    }
  }
  return { format: "node-spec", count: Number(tests[1]) - skipped - todo, names: unique(names) };
}

function tap(text: string): TestInventory | undefined {
  const names: string[] = [];
  let seen = false;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(not )?ok \d+(?: -)? ?(.*?)\s*(#\s*(SKIP|TODO)\b.*)?$/i.exec(line);
    if (!m) {
      continue;
    }
    seen = true;
    if (!m[3] && m[2] && m[2] !== "" && !isFileEntry(m[2].trim())) {
      names.push(m[2].trim());
    }
  }
  if (!seen) {
    return undefined;
  }
  const planned = lastMatch(/^\s*# tests (\d+)\s*$/m, text);
  const skipped = Number(lastMatch(/^\s*# skip(?:ped)? (\d+)\s*$/m, text)?.[1] ?? 0);
  const todo = Number(lastMatch(/^\s*# todo (\d+)\s*$/m, text)?.[1] ?? 0);
  const all = unique(names);
  return { format: "tap", count: planned ? Number(planned[1]) - skipped - todo : all.length, names: all };
}

function goJson(text: string): TestInventory | undefined {
  const names: string[] = [];
  let seen = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(line) as { Action?: string; Test?: string; Package?: string };
      if (typeof event.Action === "string" && "Package" in event) {
        seen = true;
      }
      if ((event.Action === "pass" || event.Action === "fail") && typeof event.Test === "string") {
        names.push(`${event.Package ?? ""}:${event.Test}`);
      }
    } catch {
      // Not a go test -json line.
    }
  }
  return seen ? { format: "go-json", count: unique(names).length, names: unique(names) } : undefined;
}

function goVerbose(text: string): TestInventory | undefined {
  const names = [...text.matchAll(/^\s*--- (PASS|FAIL): (\S+)/gm)].map((m) => m[2]!);
  return names.length > 0 ? { format: "go-verbose", count: unique(names).length, names: unique(names) } : undefined;
}

function pytest(text: string): TestInventory | undefined {
  const names = [...text.matchAll(/^(\S+::\S+)\s+(PASSED|FAILED|ERROR|XFAIL|XPASS)\b/gm)].map((m) => m[1]!);
  const summary = lastMatch(
    /(?:^|=\s)((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?|rerun|subtests? passed|subtests? failed|subtests? skipped)(?:, )?)+) in [\d.]+s/m,
    text,
  );
  if (!summary && names.length === 0) {
    return undefined;
  }
  let count = unique(names).length;
  if (summary) {
    const part = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(summary[1]!)?.[1] ?? 0);
    count = Math.max(count, part("passed") + part("failed") + part("errors?") + part("xfailed") + part("xpassed"));
  }
  return { format: "pytest", count, names: unique(names) };
}

function vitest(text: string): TestInventory | undefined {
  const line = lastMatch(/^\s*Tests\s+(.*)\((\d+)\)\s*$/m, text);
  if (!line) {
    return undefined;
  }
  const skipped = Number(/(\d+) skipped/.exec(line[1]!)?.[1] ?? 0) + Number(/(\d+) todo/.exec(line[1]!)?.[1] ?? 0);
  return { format: "vitest", count: Number(line[2]) - skipped, names: [] };
}

function jest(text: string): TestInventory | undefined {
  const line = lastMatch(/^\s*Tests:\s+(.*?)(\d+) total\s*$/m, text);
  if (!line) {
    return undefined;
  }
  const skipped = Number(/(\d+) skipped/.exec(line[1]!)?.[1] ?? 0) + Number(/(\d+) todo/.exec(line[1]!)?.[1] ?? 0);
  return { format: "jest", count: Number(line[2]) - skipped, names: [] };
}

/**
 * Read the inventory from a run's two streams. The runners this reads report
 * on stdout (node --test, pytest, go test, vitest, jest), so stdout is read
 * first; stderr only when stdout has no report. When BOTH streams carry a
 * report and they disagree, the run reports `undefined` (no trustworthy
 * inventory), so a test printing a fake summary on the other stream cannot
 * stand in for the runner's.
 */
export function readStreamInventory(stdout: string, stderr: string): TestInventory | undefined {
  const fromOut = readTestInventory(stdout);
  const fromErr = readTestInventory(stderr);
  if (fromOut && fromErr && (fromOut.format !== fromErr.format || fromOut.count !== fromErr.count)) {
    return undefined;
  }
  return fromOut ?? fromErr;
}

/** Read the executed-test inventory from a gate run's combined output, if its shape is recognized. */
export function readTestInventory(output: string): TestInventory | undefined {
  for (const parse of [nodeSpec, goJson, tap, goVerbose, pytest, vitest, jest]) {
    const found = parse(output);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Did `current` execute at least the baseline's tests? Every baseline test name
 * must have executed (when both runs print names) and the executed count must
 * not have dropped. Returns the reason when it did not.
 */
export function inventoryShortfall(baseline: TestInventory, current: TestInventory | undefined): string | undefined {
  if (current === undefined) {
    return `the gate output no longer reports which tests ran (the baseline run executed ${baseline.count} test(s), ${baseline.format})`;
  }
  if (current.format !== baseline.format) {
    return `the gate output is reported as ${current.format}, not the baseline's ${baseline.format}`;
  }
  if (baseline.names.length > 0 && current.names.length === 0) {
    return `the gate output names no tests, but the baseline run named ${baseline.names.length}`;
  }
  if (baseline.names.length > 0) {
    const ran = new Set(current.names);
    const missing = baseline.names.filter((n) => !ran.has(n));
    if (missing.length > 0) {
      // Counts only: the names never leave the integrator (code under test
      // could otherwise learn which lines to print).
      return `${missing.length} of the ${baseline.names.length} baseline test(s) did not execute`;
    }
  }
  if (current.count < baseline.count) {
    return `only ${current.count} test(s) executed, fewer than the ${baseline.count} the baseline run executed`;
  }
  return undefined;
}

/**
 * The baseline inventory once a HUMAN accepted contract changes to protected
 * paths (`targets`): a changed or removed test file may rename or drop tests.
 * Where the format names tests with their file (pytest `path::test`), the
 * entries of those files are dropped and the count lowered by as many. Where
 * it does not, the inventory cannot be adjusted honestly, so it is not used
 * (`relaxed` says why; the gate falls back to its exit code).
 */
export function inventoryAfterContracts(
  baseline: TestInventory,
  targets: readonly string[],
): { readonly inventory?: TestInventory; readonly relaxed?: string } {
  if (targets.length === 0) {
    return { inventory: baseline };
  }
  if (baseline.format === "pytest" && baseline.names.length > 0) {
    const dropped = baseline.names.filter((n) => targets.some((t) => n.startsWith(`${t}::`)));
    return {
      inventory: { ...baseline, count: Math.max(0, baseline.count - dropped.length), names: baseline.names.filter((n) => !dropped.includes(n)) },
    };
  }
  return {
    relaxed: `accepted contract change(s) to ${targets.join(", ")}: the ${baseline.format} inventory cannot be adjusted per file, so revisions use the gate's exit code`,
  };
}

/** One runner summary in a gate run: its counts and the test files it listed. */
export interface TestSuiteProgress {
  readonly passed: number;
  readonly failed: number;
  /** passed + failed (skipped and todo excluded). */
  readonly total: number;
  /** The test files this suite's report named (repo-relative as the runner printed them; bounded). */
  readonly files?: readonly string[];
}

/** How many of the gate's checks passed in one run (advisory progress; never a verdict). */
export interface TestProgress {
  /** The runner shape; absent when no runner summary was found (only `typeErrors` or `unfinished`). */
  readonly format?: TestInventory["format"];
  readonly passed: number;
  readonly failed: number;
  /** passed + failed (skipped and todo excluded). */
  readonly total: number;
  /** Per suite, in run order, when the gate ran several (one summary each) or a suite listed its files. */
  readonly suites?: readonly TestSuiteProgress[];
  /** Type-checker errors the run printed (`path(l,c): error TS2339: ...`): a typecheck step failed. */
  readonly typeErrors?: number;
  /** Test files a suite listed after the last summary: it started but its summary is missing. */
  readonly unfinished?: readonly string[];
  /** The captured output was cut short (the bounded evidence), so later summaries may be missing. */
  readonly truncated?: boolean;
}

/** The most suites and files per suite a progress record keeps. */
const MAX_PROGRESS_SUITES = 16;
const MAX_SUITE_FILES = 40;
/** A test-file path token, as runners print them (`tests/a.test.ts`, `gate/b.spec.js`, `tests/test_x.py`). */
const TEST_FILE_TOKEN =
  /(?:^|[\s"'(:])((?:[A-Za-z0-9_.@-]+\/)*(?:[A-Za-z0-9_.-]+\.(?:test|spec)\.[cm]?[jt]sx?|test_[A-Za-z0-9_]+\.py|[A-Za-z0-9_]+_test\.(?:py|go)))\b/g;

function filesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TEST_FILE_TOKEN)) {
    const file = m[1]!.replace(/^\.\//, "");
    if (!file.startsWith("/") && !file.split("/").includes("..")) {
      out.add(file);
    }
    if (out.size >= MAX_SUITE_FILES) {
      break;
    }
  }
  return [...out];
}

/**
 * Read how many tests passed and failed from a gate run's output, in the same
 * runner shapes as the inventory (node --test spec and TAP, vitest, jest,
 * pytest, go). A run with several runner summaries (a gate that runs two
 * suites, `vitest run && vitest run --config gate/...`) is split per summary:
 * each suite keeps its own counts and the test files its report named (the
 * text between the previous summary and its own), so a caller can tell the
 * acceptance suite from a developer suite. Type-checker errors are counted
 * (a typecheck step that failed stops a `&&` gate before any suite runs).
 * Undefined when nothing is recognized. ADVISORY: it measures progress between
 * revisions and never decides a verdict (the gate's exit code and inventory do).
 */
export function readTestProgress(output: string): TestProgress | undefined {
  const num = (re: RegExp, text: string) => Number(re.exec(text)?.[1] ?? 0);
  const typeErrors = [...output.matchAll(/\(\d+,\d+\): error TS\d+:|^\s*error TS\d+:/gm)].length;
  const truncated = /\.\.\.\[truncated \d+ chars\]/.test(output);
  const extras = { ...(typeErrors > 0 ? { typeErrors } : {}), ...(truncated ? { truncated } : {}) };
  /** Summaries at their offsets: each suite's text runs from the previous summary's end. */
  const bySummary = (format: NonNullable<TestProgress["format"]>, matches: { index: number; end: number; passed: number; failed: number }[]): TestProgress | undefined => {
    if (matches.length === 0) {
      return undefined;
    }
    let from = 0;
    const suites: TestSuiteProgress[] = matches.slice(0, MAX_PROGRESS_SUITES).map((m) => {
      const files = filesIn(output.slice(from, m.index));
      from = m.end;
      return { passed: m.passed, failed: m.failed, total: m.passed + m.failed, ...(files.length > 0 ? { files } : {}) };
    });
    const unfinished = filesIn(output.slice(from));
    const passed = suites.reduce((n, s) => n + s.passed, 0);
    const failed = suites.reduce((n, s) => n + s.failed, 0);
    const listed = suites.length > 1 || suites.some((s) => s.files !== undefined);
    return {
      format,
      passed,
      failed,
      total: passed + failed,
      ...(listed ? { suites } : {}),
      ...extras,
      ...(unfinished.length > 0 ? { unfinished } : {}),
    };
  };
  const at = (re: RegExp, counts: (m: RegExpMatchArray) => { passed: number; failed: number }) =>
    [...output.matchAll(re)].map((m) => ({ index: m.index!, end: m.index! + m[0].length, ...counts(m) }));
  const vitest = at(/^\s*Tests\s+(.*)\((\d+)\)\s*$/gm, (m) => ({ passed: num(/(\d+) passed/, m[1]!), failed: num(/(\d+) failed/, m[1]!) }));
  if (vitest.length > 0) {
    return bySummary("vitest", vitest);
  }
  const jest = at(/^\s*Tests:\s+(.*?)(\d+) total\s*$/gm, (m) => ({ passed: num(/(\d+) passed/, m[1]!), failed: num(/(\d+) failed/, m[1]!) }));
  if (jest.length > 0) {
    return bySummary("jest", jest);
  }
  const nodePass = at(/^\s*ℹ pass (\d+)\s*$/gm, (m) => ({ passed: Number(m[1]), failed: 0 }));
  if (nodePass.length > 0) {
    const nodeFail = [...output.matchAll(/^\s*ℹ fail (\d+)\s*$/gm)];
    return bySummary("node-spec", nodePass.map((m, i) => ({ ...m, failed: Number(nodeFail[i]?.[1] ?? 0) })));
  }
  const pytest = at(/(?:^|=\s)((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)(?:, )?)+) in [\d.]+s/gm, (m) => ({
    passed: num(/(\d+) passed/, m[1]!),
    failed: num(/(\d+) failed/, m[1]!) + num(/(\d+) errors?/, m[1]!),
  }));
  if (pytest.length > 0) {
    return bySummary("pytest", pytest);
  }
  const goPass = [...output.matchAll(/^\s*--- PASS: /gm)].length;
  const goFail = [...output.matchAll(/^\s*--- FAIL: /gm)].length;
  if (goPass + goFail > 0) {
    return { format: "go-verbose", passed: goPass, failed: goFail, total: goPass + goFail, ...extras };
  }
  let ok = 0;
  let notOk = 0;
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(not )?ok \d+\b/i.exec(line);
    if (m && !/#\s*(SKIP|TODO)\b/i.test(line)) {
      if (m[1]) notOk += 1;
      else ok += 1;
    }
  }
  if (ok + notOk > 0) {
    return { format: "tap", passed: ok, failed: notOk, total: ok + notOk, ...extras };
  }
  const unfinished = filesIn(output);
  return typeErrors > 0 ? { passed: 0, failed: 0, total: 0, ...extras, ...(unfinished.length > 0 ? { unfinished } : {}) } : undefined;
}

/** A revision's advisory progress as the board records it (counts per suite, the acceptance suite labeled). */
export interface GateProgress {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly suites?: readonly { readonly passed: number; readonly failed: number; readonly total: number; readonly suite?: "acceptance" | "developer" }[];
  /** The acceptance suite's own counts (the suites whose files are in the immutable acceptance gate). */
  readonly acceptance?: { readonly passed: number; readonly failed: number; readonly total: number };
  /** Why the acceptance suite has no count on this run (`typecheck failed (2 errors)`): an earlier step stopped the gate. */
  readonly acceptanceNotRun?: string;
}

/**
 * Label a run's progress against the immutable acceptance gate: a suite whose
 * listed files include an acceptance file is the ACCEPTANCE suite, one that
 * listed only other test files is a DEVELOPER suite, and one that listed none
 * stays unlabeled. When the acceptance gate is known and no suite of the run is
 * (or may be) the acceptance suite, the reason is stated instead of a number:
 * a typecheck that failed, a developer suite that failed first (a `&&` gate
 * stops there), or a summary the bounded output did not capture. Undefined
 * when there is nothing to report. ADVISORY only.
 */
export function labelGateProgress(progress: TestProgress | undefined, acceptanceFiles: readonly string[]): GateProgress | undefined {
  if (progress === undefined) {
    return undefined;
  }
  const acceptance = new Set(acceptanceFiles);
  const known = acceptance.size > 0;
  const raw = progress.suites ?? (progress.total > 0 ? [{ passed: progress.passed, failed: progress.failed, total: progress.total }] : []);
  const suites = raw.slice(0, MAX_PROGRESS_SUITES).map((s) => {
    const files = s.files ?? [];
    const suite: "acceptance" | "developer" | undefined =
      !known || files.length === 0 ? undefined : files.some((f) => acceptance.has(f)) ? "acceptance" : "developer";
    return { passed: s.passed, failed: s.failed, total: s.total, ...(suite ? { suite } : {}) };
  });
  const accepted = suites.filter((s) => s.suite === "acceptance");
  const sum = (list: readonly { passed: number; failed: number }[]) => {
    const passed = list.reduce((n, s) => n + s.passed, 0);
    const failed = list.reduce((n, s) => n + s.failed, 0);
    return { passed, failed, total: passed + failed };
  };
  const base = {
    passed: progress.passed,
    failed: progress.failed,
    total: progress.total,
    ...(suites.length > 1 || suites.some((s) => s.suite !== undefined) ? { suites } : {}),
  };
  if (accepted.length > 0) {
    return { ...base, acceptance: sum(accepted) };
  }
  // An unlabeled suite may be the acceptance suite: say nothing more.
  if (!known || suites.some((s) => s.suite === undefined)) {
    return progress.total > 0 ? base : undefined;
  }
  const developerFailed = suites.filter((s) => s.failed > 0).reduce((n, s) => n + s.failed, 0);
  const unfinishedAcceptance = (progress.unfinished ?? []).some((f) => acceptance.has(f));
  const reason =
    progress.typeErrors !== undefined && progress.typeErrors > 0
      ? `typecheck failed (${progress.typeErrors} error${progress.typeErrors === 1 ? "" : "s"})`
      : developerFailed > 0
        ? `the developer suite failed first (${developerFailed} failed)`
        : unfinishedAcceptance || progress.truncated
          ? "its summary was not captured (the gate output was cut short)"
          : "no acceptance suite summary in the gate output";
  return { ...base, acceptanceNotRun: reason };
}
