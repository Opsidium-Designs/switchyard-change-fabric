/**
 * test-teeth: does a contract-approved change to a developer test actually
 * catch the bug it targets?
 *
 * A protected developer test changes only through a contract a human accepted
 * (a RELEASED target). A changed test that also passes on the untouched
 * baseline code proves nothing about the fix. So, for the final passing
 * revision, each released test file that revision changed is run ALONE twice:
 *   - on the revision's own tree (it should pass there), and
 *   - on the BASELINE tree (the code before the run's source changes) with the
 *     NEW test file swapped in (it should fail there: the test has teeth).
 *
 * ADVISORY ONLY: the outcome is a record. It never changes a revision's
 * verdict, its promotion, or a deploy. Anything that keeps the check from
 * running cleanly (an unknown test runner, a failed install, a crash, a
 * timeout, an abort, a test that fails on the revision when run alone) is
 * recorded as "could-not-check" with the reason, never as a finding.
 *
 * The command runs through the same injectable CommandRunner the gate uses (so
 * the same allowlisted environment, timeout, process-group kill, and abort
 * signal apply); tests inject a fake and never shell out.
 */

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { boundOutput, runAbortable, type CommandOutcome, type CommandRunner } from "./command.ts";
import { InstallingCommandRunner, dependencyInstallFailureLine } from "./dependency-install.ts";
import { changedPathsBetween, checkoutCommit, clone } from "./git.ts";
import { matchesAny } from "./pathscope.ts";

/** What the check found for one released test file. */
export type TestTeethStatus = "teeth" | "no-teeth" | "could-not-check";

/** How one run of the test file ended. */
export type TestTeethRun = "pass" | "fail" | "not-run";

/** The advisory record for one released test file the final revision changed. */
export interface TestTeethRecord {
  /** The test file (repo-relative). */
  readonly path: string;
  /** The revision whose tree supplied the new test (the final, gated one). */
  readonly rev: number;
  /** teeth: fails on baseline, passes on the revision. no-teeth: passes on both. */
  readonly status: TestTeethStatus;
  /** The test file run alone on the baseline tree with the new test swapped in. */
  readonly baseline: TestTeethRun;
  /** The test file run alone on the revision's tree. */
  readonly revision: TestTeethRun;
  /** The command that ran the file (absent when no runner was determined). */
  readonly command?: readonly string[];
  /** Why the check could not decide (could-not-check only). */
  readonly reason?: string;
}

/** The reason recorded when the project's test runner cannot be determined. */
export const TEETH_RUNNER_UNKNOWN = "runner unknown";

/** A file name a test runner would treat as a test file. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Output vitest prints when its filter matched no test file. */
const NO_TEST_FILES = /No test files found/;

/** True for a path that names a test file (`*.test.ts`, `*.spec.js`, ...). */
export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/**
 * The argv that runs one test file with the project's own test runner, read
 * from its package.json: vitest when the project declares it (the examples),
 * else undefined (runner unknown). `npx --no` never installs a missing runner.
 */
export function testFileCommand(manifestText: string | undefined, file: string): readonly string[] | undefined {
  if (manifestText === undefined) {
    return undefined;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null) {
    return undefined;
  }
  const record = manifest as Record<string, unknown>;
  const declares = (name: string): boolean =>
    ["dependencies", "devDependencies"].some((map) => {
      const deps = record[map];
      return typeof deps === "object" && deps !== null && typeof (deps as Record<string, unknown>)[name] === "string";
    });
  return declares("vitest") ? ["npx", "--no", "vitest", "run", file] : undefined;
}

/** The last non-empty line of a command's output (its likely reason), bounded. */
function lastLine(outcome: CommandOutcome): string {
  const lines = `${outcome.stdout}\n${outcome.stderr}`.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return boundOutput(lines.at(-1) ?? "no output").slice(0, 300);
}

type RunResult = { readonly run: "pass" | "fail" } | { readonly run: "not-run"; readonly reason: string };

/** Run the file once in `dir`, mapping anything inconclusive to not-run with its reason. */
async function runOnce(runner: CommandRunner, argv: readonly string[], dir: string, where: string, signal: AbortSignal | undefined): Promise<RunResult> {
  if (signal?.aborted) {
    return { run: "not-run", reason: `the run was interrupted before the ${where} run` };
  }
  try {
    if (runner instanceof InstallingCommandRunner) {
      const install = await runner.installFor(dir, signal ? { signal } : {});
      if (install.status === "failed") {
        return { run: "not-run", reason: `${where}: ${dependencyInstallFailureLine(install)}` };
      }
    }
    const outcome = await runAbortable(runner, argv, dir, signal);
    if (outcome.aborted === true || outcome.code === null) {
      return { run: "not-run", reason: `${where}: ${lastLine(outcome)}` };
    }
    if (NO_TEST_FILES.test(`${outcome.stdout}\n${outcome.stderr}`)) {
      return { run: "not-run", reason: `${where}: the runner found no test file to run` };
    }
    return { run: outcome.code === 0 ? "pass" : "fail" };
  } catch (error) {
    return { run: "not-run", reason: `${where}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
  }
}

/** Inputs to the directory-level check (both trees already on disk). */
export interface AssessTestTeethInput {
  /** The baseline tree. Each test file is swapped in, run, and put back. */
  readonly baselineDir: string;
  /** The revision's tree (its test files are the new ones). */
  readonly revisionDir: string;
  /** The changed released test files to check (repo-relative). */
  readonly paths: readonly string[];
  readonly rev: number;
  readonly runner: CommandRunner;
  readonly signal?: AbortSignal;
}

/**
 * Check each test file on the two trees (see the module comment). Never
 * throws for a check that cannot run: each such file is recorded
 * could-not-check with its reason. The baseline tree is left as it was.
 */
export async function assessTestTeeth(input: AssessTestTeethInput): Promise<TestTeethRecord[]> {
  const manifest = await readFile(join(input.revisionDir, "package.json"), "utf8").catch(() => undefined);
  const records: TestTeethRecord[] = [];
  for (const path of input.paths) {
    const base = { path, rev: input.rev };
    const argv = testFileCommand(manifest, path);
    if (argv === undefined) {
      records.push({ ...base, status: "could-not-check", baseline: "not-run", revision: "not-run", reason: TEETH_RUNNER_UNKNOWN });
      continue;
    }
    const onRevision = await runOnce(input.runner, argv, input.revisionDir, `rev ${input.rev}`, input.signal);
    if (onRevision.run !== "pass") {
      records.push({
        ...base,
        status: "could-not-check",
        baseline: "not-run",
        revision: onRevision.run,
        command: argv,
        reason: "reason" in onRevision ? onRevision.reason : `the test fails on rev ${input.rev} when run alone`,
      });
      continue;
    }
    const target = join(input.baselineDir, path);
    let original: Buffer | undefined;
    let onBaseline: RunResult;
    try {
      original = await readFile(target).catch(() => undefined);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(input.revisionDir, path)));
      onBaseline = await runOnce(input.runner, argv, input.baselineDir, "baseline", input.signal);
    } catch (error) {
      onBaseline = { run: "not-run", reason: `baseline: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
    } finally {
      // Put the baseline tree back for the next file.
      if (original !== undefined) {
        await writeFile(target, original).catch(() => undefined);
      } else {
        await rm(target, { force: true }).catch(() => undefined);
      }
    }
    records.push(
      onBaseline.run === "not-run"
        ? { ...base, status: "could-not-check", baseline: "not-run", revision: "pass", command: argv, reason: onBaseline.reason }
        : { ...base, status: onBaseline.run === "fail" ? "teeth" : "no-teeth", baseline: onBaseline.run, revision: "pass", command: argv },
    );
  }
  return records;
}

/** Inputs to the repo-level check (clones the two commits itself). */
export interface CheckReleasedTestTeethInput {
  /** The integration repo's remote (authenticated when it needs a token; runGit moves the token to a header). */
  readonly remote: string;
  /** The project baseline: the integration branch's head before any revision. */
  readonly baselineCommit: string;
  /** The final, passing revision's gated commit and its number. */
  readonly revisionCommit: string;
  readonly rev: number;
  /** The released (contract-accepted) targets: paths or globs. */
  readonly released: readonly string[];
  readonly runner: CommandRunner;
  /** Where the checkouts are made (the gate's shared harness must resolve from here). */
  readonly workRoot?: string;
  readonly signal?: AbortSignal;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * The repo-level check: clone the revision and the baseline, find the released
 * test files the revision changed (and still has), and assess each. Returns
 * an empty list when there is nothing to check. Never throws: a failure to
 * prepare the trees records every candidate (or, when even the candidates are
 * unknown, one record for the released targets) as could-not-check.
 */
export async function checkReleasedTestTeeth(input: CheckReleasedTestTeethInput): Promise<TestTeethRecord[]> {
  const released = input.released.filter((t) => t.trim() !== "");
  if (released.length === 0) {
    return [];
  }
  let root: string | undefined;
  let candidates: string[] | undefined;
  try {
    root = await mkdtemp(join(input.workRoot ?? tmpdir(), "scf-teeth-"));
    const revisionDir = join(root, "revision");
    const baselineDir = join(root, "baseline");
    await clone(input.remote, revisionDir);
    await checkoutCommit(revisionDir, input.revisionCommit);
    const changed = await changedPathsBetween(revisionDir, input.baselineCommit, input.revisionCommit);
    candidates = [];
    for (const path of changed) {
      if (isTestFile(path) && matchesAny(path, released) && (await exists(join(revisionDir, path)))) {
        candidates.push(path);
      }
    }
    if (candidates.length === 0) {
      return [];
    }
    await clone(input.remote, baselineDir);
    await checkoutCommit(baselineDir, input.baselineCommit);
    return await assessTestTeeth({
      baselineDir,
      revisionDir,
      paths: candidates,
      rev: input.rev,
      runner: input.runner,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    const reason = `could not prepare the trees: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
    return (candidates ?? [released.join(", ")]).map((path) => ({ path, rev: input.rev, status: "could-not-check" as const, baseline: "not-run" as const, revision: "not-run" as const, reason }));
  } finally {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
