/**
 * A small injectable command runner used by verification checks.
 *
 * Checks (the configured test command, the optional lint command) run as plain
 * argv in a working directory and report an exit code plus captured output. The
 * runner is injectable so tests can supply a deterministic fake and never shell
 * out, while production uses a real child-process runner. Nothing here calls a
 * model: a check's outcome is a pure function of the command and the checkout.
 */

import { execFile } from "node:child_process";

/** The outcome of running one command. */
export interface CommandOutcome {
  /** Process exit code; 0 means success. A non-zero or null code is a failure. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs an argv command in a working directory and captures its output. */
export interface CommandRunner {
  run(argv: readonly string[], cwd: string): Promise<CommandOutcome>;
}

/** Largest captured output kept per stream, so evidence stays bounded. */
export const MAX_CAPTURED_CHARS = 4000;

/** Trim and length-bound captured text so evidence is small and stable. */
export function boundOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CAPTURED_CHARS) {
    return trimmed;
  }
  const head = trimmed.slice(0, MAX_CAPTURED_CHARS);
  return `${head}\n...[truncated ${trimmed.length - MAX_CAPTURED_CHARS} chars]`;
}

/**
 * The default runner: execute the argv with Node's child_process. A non-zero
 * exit is reported as a CommandOutcome (not thrown), so a failing test command
 * becomes a failed check rather than an exception.
 */
export class ChildProcessCommandRunner implements CommandRunner {
  run(argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const [program, ...args] = argv;
    if (program === undefined) {
      return Promise.resolve({ code: null, stdout: "", stderr: "empty command" });
    }
    return new Promise((resolve) => {
      execFile(program, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof error.code === "number") {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        if (error) {
          // Spawn failure (for example the program was not found).
          resolve({ code: null, stdout, stderr: stderr || error.message });
          return;
        }
        resolve({ code: 0, stdout, stderr });
      });
    });
  }
}
