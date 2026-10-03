/**
 * Shared test helpers: build a disposable local Git checkout as a fixture, and a
 * deterministic fake command runner.
 *
 * The fixtures model what a WorkUnit workspace looks like after a runner cloned
 * the baseline, made its change, and committed. The fake command runner lets a
 * test assert verification behavior for passing and failing test/lint commands
 * without shelling out, keeping those unit tests fast and deterministic.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { CommandOutcome, CommandRunner } from "../src/command.ts";

const run = promisify(execFile);

const IDENTITY = [
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@switchyard.local",
];

/** A file to write into a fixture checkout. */
export interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Create a Git checkout at `dir` with a baseline commit containing
 * `baselineFiles`, then a second commit adding `changedFiles`. The baseline tag
 * "baseline" marks the first commit so the verifier can diff against it.
 */
export async function makeCheckout(
  dir: string,
  baselineFiles: readonly FixtureFile[],
  changedFiles: readonly FixtureFile[],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await run("git", ["-C", dir, "init", "--initial-branch=main"]);
  await writeFiles(dir, baselineFiles);
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, ...IDENTITY, "commit", "--no-verify", "-m", "baseline"]);
  await run("git", ["-C", dir, "tag", "baseline"]);
  await writeFiles(dir, changedFiles);
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, ...IDENTITY, "commit", "--no-verify", "-m", "work"]);
}

async function writeFiles(dir: string, files: readonly FixtureFile[]): Promise<void> {
  for (const file of files) {
    const abs = join(dir, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
  }
}

/** A deterministic command runner returning a fixed outcome per argv prefix. */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: { argv: readonly string[]; cwd: string }[] = [];

  constructor(private readonly outcomes: readonly { readonly match: string; readonly outcome: CommandOutcome }[]) {}

  run(argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    this.calls.push({ argv, cwd });
    const joined = argv.join(" ");
    for (const entry of this.outcomes) {
      if (joined.includes(entry.match)) {
        return Promise.resolve(entry.outcome);
      }
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }
}
