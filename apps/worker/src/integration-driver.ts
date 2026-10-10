/**
 * Drive one integration job in the gate container: the protocol side of
 * integrate-cli (see packages/verification/src/integrate-job.ts).
 *
 * The container is behind a small port (start, set the egress policy, spawn a
 * process with piped stdio), so this logic is the same against the real
 * Cloudflare container and a fake in tests:
 *
 *   1. start a FRESH container for the job (a running one is destroyed first)
 *      and check it is clean: no sandbox-user process, nothing in the work
 *      root, the temp dirs, or the sandbox user's home; nothing a previous
 *      job ran can survive into this one;
 *   2. put the fetch policy in force, start the CLI under `timeout`, and write
 *      the job;
 *   3. for each "@@scf phase <p>" the CLI prints, check that phases only move
 *      forward, put p's policy in force, and only then acknowledge; anything
 *      else ends the job;
 *   4. read "@@scf result <json>", close the egress (deny all), destroy the
 *      container (success or failure), and return the result with the phases
 *      as the evidence recorded them.
 * Before every phase that opens credentialed egress (fetch, push) the driver
 * itself checks, from outside the CLI, that no sandbox-user process is alive.
 * At the start of the gate phase (before it is acknowledged) it runs a cheap
 * deny-all probe: a short raw TCP connect to a public IP as the sandbox user;
 * if that connects, the job is refused ("egress not isolated").
 * A deadline bounds the whole job (exec has no timeout of its own): the CLI is
 * wrapped in `timeout --kill-after`, and the driver kills it and closes the
 * egress when the deadline passes.
 */

import {
  ackLine,
  parseGateJobResult,
  parseProtocolLine,
  phaseTransitionAllowed,
  scrubJobText,
  serializeGateJob,
  type EgressPhase,
  type GateJob,
  type GateJobResult,
} from "@switchyard-change/verification/integrate-job";

import { egressLabel, type GateEgressProps } from "./integration-egress.ts";

/** A process running in the container, with line-oriented stdio. */
export interface GateProcess {
  /** stdout, one line at a time (without the newline). */
  readonly lines: AsyncIterable<string>;
  /** Write one line to stdin. */
  writeLine(line: string): Promise<void>;
  /** Close stdin. */
  closeInput(): Promise<void>;
  readonly exitCode: Promise<number>;
  /** The tail of the process's stderr, if the port keeps it. */
  diagnostics?(): string;
  kill(): void;
}

/** The container, as the driver needs it. */
export interface GateContainerPort {
  /** Stop and discard the container if one is running (every job gets a fresh one). */
  reset(): Promise<void>;
  /** Start the container if it is not running, and wait until it can exec. */
  ensureRunning(): Promise<void>;
  /** Throw unless the container is clean: no sandbox process, nothing left by a sandbox user or a job. */
  assertClean(): Promise<void>;
  /** Throw if any process of the sandbox user is alive (checked before credentialed egress opens). */
  assertNoSandboxProcesses(): Promise<void>;
  /**
   * The deny-all probe at the start of the gate phase: as the sandbox user,
   * try a short raw TCP connect to a public IP. Throw (naming what connected)
   * if it succeeds: the container's egress is not isolated.
   */
  assertEgressDenied(): Promise<void>;
  /** Put an egress policy in force for every intercepted host. */
  setEgress(props: GateEgressProps): Promise<void>;
  spawn(argv: readonly string[], env: Readonly<Record<string, string>>): Promise<GateProcess>;
}

/** One phase the driver put in force. */
export interface DrivenPhase {
  readonly phase: EgressPhase | "closed";
  readonly egress: string;
  readonly at: string;
}

/** What one driven job produced. */
export interface DriveOutcome {
  readonly result?: GateJobResult;
  /** Why there is no result (credential-free). */
  readonly error?: string;
  readonly phases: readonly DrivenPhase[];
}

/** Inputs to drive one job. */
export interface DriveJobInput {
  readonly job: GateJob;
  readonly artifactsHost: string;
  readonly registryHost: string;
  /** Repo path to token: given to the egress handler only, never to the container. */
  readonly repos: Readonly<Record<string, string>>;
  /** The whole job's limit, in ms. */
  readonly deadlineMs: number;
  readonly now?: () => number;
}

/** The CLI the container runs. */
export const INTEGRATE_CLI = "/opt/scf/packages/verification/src/integrate-cli.ts";

/** The command line: the CLI under coreutils `timeout` (exec itself has none). */
export function cliArgv(deadlineMs: number): string[] {
  const seconds = Math.max(5, Math.ceil(deadlineMs / 1000));
  return [
    "timeout",
    "--kill-after=5",
    String(seconds),
    "node",
    "--disable-warning=ExperimentalWarning",
    "--experimental-transform-types",
    INTEGRATE_CLI,
  ];
}

/** Drive one job to its result. Never throws for a job-level failure. */
export async function driveGateJob(port: GateContainerPort, input: DriveJobInput): Promise<DriveOutcome> {
  const now = input.now ?? Date.now;
  const phases: DrivenPhase[] = [];
  const policy = (phase: EgressPhase | "closed"): GateEgressProps => ({
    phase,
    artifactsHost: input.artifactsHost,
    registryHost: input.registryHost,
    repos: phase === "fetch" || phase === "push" ? input.repos : {},
  });
  const enter = async (phase: EgressPhase | "closed"): Promise<void> => {
    await port.setEgress(policy(phase));
    phases.push({ phase, egress: egressLabel(phase), at: new Date(now()).toISOString() });
  };

  let child: GateProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await port.reset();
    await port.ensureRunning();
    await port.assertClean();
    await port.assertNoSandboxProcesses();
    await enter("fetch");
    child = await port.spawn(cliArgv(input.deadlineMs), {});
    const running = child;
    const deadline = new Promise<{ readonly timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), input.deadlineMs + 10_000);
    });
    const session = (async (): Promise<DriveOutcome> => {
      await running.writeLine(serializeGateJob(input.job));
      let current: EgressPhase = "fetch";
      for await (const line of running.lines) {
        const parsed = parseProtocolLine(line);
        if (parsed === undefined) {
          continue;
        }
        if (parsed.kind === "invalid") {
          return { error: `the job's protocol broke: ${parsed.error}`, phases };
        }
        if (parsed.kind === "phase") {
          if (!phaseTransitionAllowed(current, parsed.phase)) {
            return { error: `the job asked to move from ${current} back to ${parsed.phase}: refused`, phases };
          }
          if (parsed.phase !== current || phases.at(-1)?.phase !== parsed.phase) {
            if (parsed.phase === "push") {
              // Credentialed egress opens only with no sandbox process alive.
              try {
                await port.assertNoSandboxProcesses();
              } catch (error) {
                return { error: `containment failed before the push phase: ${error instanceof Error ? error.message : String(error)}`, phases };
              }
            }
            await enter(parsed.phase);
            if (parsed.phase === "gate") {
              // The gate runs agent code: before it may start, check from
              // outside the CLI that the sandbox user really reaches nothing.
              try {
                await port.assertEgressDenied();
              } catch (error) {
                return { error: `egress not isolated: refused before the gate phase (${error instanceof Error ? error.message : String(error)})`, phases };
              }
            }
          }
          current = parsed.phase;
          await running.writeLine(ackLine(parsed.phase));
          continue;
        }
        const result = parseGateJobResult(parsed.value);
        return result.ok ? { result: result.value, phases } : { error: `the job's result is malformed: ${result.error}`, phases };
      }
      const code = await running.exitCode.catch(() => -1);
      const said = scrubJobText(running.diagnostics?.() ?? "").trim().split("\n").slice(-3).join(" | ").slice(0, 400);
      return { error: `the job ended without a result (exit ${code}${code === 124 || code === 137 ? ": timed out" : ""})${said ? `: ${said}` : ""}`, phases };
    })();
    // When the deadline wins the race, a session that rejects later must not
    // surface as an unhandled rejection (the race still sees an earlier one).
    session.catch(() => undefined);
    const settled = await Promise.race([session, deadline]);
    if ("timedOut" in settled) {
      running.kill();
      return { error: `the job did not finish within ${Math.round(input.deadlineMs / 1000)} s and was stopped`, phases };
    }
    return settled;
  } catch (error) {
    child?.kill();
    return { error: `the gate container failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), phases };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    await child?.closeInput().catch(() => undefined);
    // Whatever happened, the egress is closed when the job is over, and the
    // container is discarded: the next job starts from the image.
    await enter("closed").catch(() => undefined);
    await port.reset().catch(() => undefined);
  }
}
