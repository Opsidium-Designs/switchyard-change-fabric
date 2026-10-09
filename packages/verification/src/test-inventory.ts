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
