/**
 * integrate-cli: the gate container's entrypoint for one integration job.
 *
 *   node --experimental-transform-types integrate-cli.ts
 *
 * Reads the job (one JSON line) from stdin, runs it (integrate-run.ts), asks
 * the orchestrator for each egress phase on stdout ("@@scf phase <phase>") and
 * waits for "ack <phase>" on stdin, then prints "@@scf result <json>" and
 * exits 0. Only those protocol lines go to stdout; diagnostics go to stderr.
 * The streams belong to this process alone: the install and the gate run as
 * another user with their output captured, so they cannot forge a phase
 * request or an acknowledgement.
 *
 * Environment:
 *   SCF_WORK_ROOT     where checkouts are made (default /work)
 *   SCF_SANDBOX_UID   run the install and the gate as this uid (and SCF_SANDBOX_GID,
 *   SCF_SANDBOX_HOME  that user's group and home); unset runs them as this user
 *   SCF_ACK_TIMEOUT_MS  how long to wait for an acknowledgement (default 120000)
 */

import { createInterface } from "node:readline";

import {
  ackLine,
  INTEGRATE_JOB_VERSION,
  parseGateJob,
  phaseLine,
  resultLine,
  type EgressPhase,
  type GateJobResult,
} from "./integrate-job.ts";
import { runGateJob, type GateSandbox } from "./integrate-run.ts";

function sandboxFromEnv(env: NodeJS.ProcessEnv): GateSandbox | undefined {
  if (env.SCF_SANDBOX_UID === undefined || env.SCF_SANDBOX_UID === "") {
    return undefined;
  }
  const uid = Number(env.SCF_SANDBOX_UID);
  const gid = Number(env.SCF_SANDBOX_GID ?? env.SCF_SANDBOX_UID);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
    throw new Error("SCF_SANDBOX_UID/GID must be positive integers (never root)");
  }
  return { uid, gid, home: env.SCF_SANDBOX_HOME ?? "/home/scfgate" };
}

async function main(): Promise<number> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })[Symbol.asyncIterator]();
  const ackTimeoutMs = Number(process.env.SCF_ACK_TIMEOUT_MS ?? 120_000);
  const print = (line: string) => process.stdout.write(`${line}\n`);
  const next = async (what: string): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = await Promise.race([
        lines.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no ${what} within ${ackTimeoutMs} ms`)), ackTimeoutMs);
        }),
      ]);
      if (read.done) {
        throw new Error(`stdin closed before the ${what}`);
      }
      return String(read.value).trim();
    } finally {
      clearTimeout(timer);
    }
  };

  let parsed: ReturnType<typeof parseGateJob>;
  try {
    parsed = parseGateJob(JSON.parse(await next("job")));
  } catch (error) {
    parsed = { ok: false, error: `the job is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed.ok) {
    const refused: GateJobResult = {
      version: INTEGRATE_JOB_VERSION,
      kind: "integrate",
      outcome: "refused",
      error: `invalid job: ${parsed.error}`,
      phases: [],
      durationMs: 0,
    };
    print(resultLine(refused));
    return 2;
  }
  const result = await runGateJob(parsed.value, {
    workRoot: process.env.SCF_WORK_ROOT ?? "/work",
    ...(sandboxFromEnv(process.env) ? { sandbox: sandboxFromEnv(process.env)! } : {}),
    hooks: {
      async phase(phase: EgressPhase) {
        print(phaseLine(phase));
        const ack = await next(`acknowledgement of the ${phase} phase`);
        if (ack !== ackLine(phase)) {
          throw new Error(`expected "${ackLine(phase)}", got ${JSON.stringify(ack.slice(0, 60))}`);
        }
      },
    },
  });
  print(resultLine(result));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`integrate-cli: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
