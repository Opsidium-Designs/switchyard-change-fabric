/**
 * GateRunner: the Durable Object that owns one gate container (one per
 * Change) and runs integration jobs in it, plus GateEgress, the outbound
 * handler the container's HTTPS traffic to the intercepted hosts goes through.
 *
 * Credentials never enter the container. The Workflow mints short-lived
 * Artifact tokens Worker-side and hands them to runJob; they live only in the
 * props of the GateEgress handler, which adds `Authorization: Bearer` to the
 * requests the phase in force allows (see integration-egress.ts). The
 * container starts with internet access off, trusts Cloudflare's egress CA,
 * and reaches only what the current phase's handler relays.
 *
 * Every job is idempotent by its key: a finished job's outcome is stored and
 * returned again to a retry. The key covers every gate-defining field and the
 * run's configuration time, the stored outcomes are bounded (the oldest are
 * pruned), and a re-created Change clears them (clearCache). A Durable Object
 * reset or a hot reload kills the container; the next job starts it again.
 */

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import type { GateJob } from "@switchyard-change/verification/integrate-job";

import type { Env } from "./env.ts";
import { driveGateJob, type DriveOutcome, type GateContainerPort, type GateProcess } from "./integration-driver.ts";
import { decideEgress, type GateEgressProps } from "./integration-egress.ts";

/** Cloudflare's CA for intercepted container HTTPS (mounted into the container). */
export const CONTAINER_EGRESS_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/** How long a container may take to accept its first exec. */
const START_TIMEOUT_MS = 120_000;
/** How long a destroyed container may take to stop. */
const STOP_TIMEOUT_MS = 30_000;
/** The sandbox user of the gate image (see the Dockerfile): a uid no host account uses. */
export const SANDBOX_UID = 64321;
const SANDBOX_HOME = "/home/scfgate";

/** Count live (not zombie) processes of the sandbox user. */
const SANDBOX_PROCESS_CHECK =
  `n=0; for f in /proc/[0-9]*/status; do ` +
  `awk -v u=${SANDBOX_UID} '/^State:/{s=$2} /^Uid:/{id=$2} END{exit !(id==u && s!="Z" && s!="X")}' "$f" 2>/dev/null && n=$((n+1)); ` +
  `done; echo sandbox_processes=$n`;

/** What a fresh container must look like before a job: nothing anyone left behind. */
const CLEAN_CHECK = [
  SANDBOX_PROCESS_CHECK,
  `echo work_entries=$(find /work -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)`,
  `echo sandbox_owned=$(find /tmp /var/tmp /dev/shm /run/lock /work -xdev -user ${SANDBOX_UID} 2>/dev/null | wc -l)`,
  `echo home_extra=$(find ${SANDBOX_HOME} -mindepth 1 -maxdepth 1 ! -name .bashrc ! -name .bash_logout ! -name .profile 2>/dev/null | wc -l)`,
].join("; ");

/** Public endpoints the deny-all probe tries to reach (raw TCP, by IP: no DNS, no intercepted host). */
export const EGRESS_PROBE_TARGETS = ["1.1.1.1:443", "8.8.8.8:53"] as const;

/**
 * The deny-all probe: as the sandbox user, a raw TCP connect to each target
 * with a 3 s limit. Prints `egress_open=<target>` for any that connected; a
 * refused, unreachable, or timed-out connect prints nothing.
 */
const EGRESS_PROBE = EGRESS_PROBE_TARGETS.map((target) => {
  const [ip, port] = target.split(":");
  return (
    `if timeout -k 1 3 setpriv --reuid=${SANDBOX_UID} --regid=${SANDBOX_UID} --clear-groups -- ` +
    `bash -c 'exec 3<>/dev/tcp/${ip}/${port}' 2>/dev/null; then echo egress_open=${target}; fi`
  );
}).join("; ");

/** One job for the runner. */
export interface GateRunRequest {
  /** The idempotency key (a retry with the same key gets the stored outcome). */
  readonly key: string;
  readonly job: GateJob;
  readonly artifactsHost: string;
  readonly registryHost: string;
  /** Repo path to token (handed to the egress handler only). */
  readonly repos: Readonly<Record<string, string>>;
  readonly deadlineMs: number;
}

/** The runner's outcome for one job. */
export type GateRunOutcome = DriveOutcome & { readonly key: string; readonly cached?: boolean };

/** The outbound handler for the container's intercepted HTTPS requests. */
export class GateEgress extends WorkerEntrypoint<Env, GateEgressProps> {
  override async fetch(request: Request): Promise<Response> {
    const decision = decideEgress(this.ctx.props, request.method, request.url, request.headers);
    if (!decision.allow) {
      return new Response(`egress denied by the integration gate policy: ${decision.reason}\n`, { status: 403 });
    }
    return fetch(decision.url, {
      method: request.method,
      headers: decision.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
  }
}

type EgressFactory = (options: { readonly props: GateEgressProps }) => Fetcher;

/** The real container behind the driver's port. */
class CloudflareGatePort implements GateContainerPort {
  private caTrusted = false;

  constructor(
    private readonly container: Container,
    private readonly egress: EgressFactory,
  ) {}

  async reset(): Promise<void> {
    const c = this.container;
    if (c.running) {
      await c.destroy("integration job over: every job gets a fresh container").catch(() => undefined);
    }
    const started = Date.now();
    while (c.running) {
      if (Date.now() - started > STOP_TIMEOUT_MS) {
        throw new Error(`the gate container did not stop within ${STOP_TIMEOUT_MS / 1000} s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.caTrusted = false;
  }

  async assertClean(): Promise<void> {
    const report = await this.shell(CLEAN_CHECK);
    const dirty = report
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\S+=\d+$/.test(l) && !l.endsWith("=0"));
    if (dirty.length > 0) {
      throw new Error(`the gate container is not clean before the job (${dirty.join(", ")})`);
    }
  }

  async assertNoSandboxProcesses(): Promise<void> {
    const report = await this.shell(SANDBOX_PROCESS_CHECK);
    if (report.trim() !== "sandbox_processes=0") {
      throw new Error(`a sandbox process is alive (${report.trim()})`);
    }
  }

  async assertEgressDenied(): Promise<void> {
    const report = (await this.shell(EGRESS_PROBE)).trim();
    const open = report
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("egress_open="));
    if (open.length > 0) {
      throw new Error(`the sandbox user connected to ${open.map((l) => l.slice("egress_open=".length)).join(", ")}`);
    }
  }

  /** Run a root check script and return its output (throws on a non-zero exit). */
  private async shell(script: string): Promise<string> {
    const proc = await this.container.exec(["bash", "-c", script], { stderr: "combined" });
    const output = await proc.output();
    const text = new TextDecoder().decode(output.stdout);
    if (output.exitCode !== 0) {
      throw new Error(`a container check failed (exit ${output.exitCode}): ${text.trim().slice(-200)}`);
    }
    return text;
  }

  async ensureRunning(): Promise<void> {
    const c = this.container;
    if (!c.running) {
      c.start({ enableInternet: false });
    }
    const started = Date.now();
    let lastError = "";
    for (;;) {
      try {
        const probe = await c.exec(["true"]);
        if ((await probe.exitCode) === 0) {
          break;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() - started > START_TIMEOUT_MS) {
        throw new Error(`the gate container did not start within ${START_TIMEOUT_MS / 1000} s (${lastError})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.caTrusted = false;
  }

  async setEgress(props: GateEgressProps): Promise<void> {
    for (const host of new Set([props.artifactsHost, props.registryHost])) {
      await this.container.interceptOutboundHttps(host, this.egress({ props }));
    }
    if (!this.caTrusted) {
      // The egress CA appears once HTTPS interception is registered: trust it
      // then (idempotent; a restarted container needs it again).
      await this.trustEgressCa();
      this.caTrusted = true;
    }
  }

  private async trustEgressCa(): Promise<void> {
    const script =
      `for i in $(seq 1 40); do test -s ${CONTAINER_EGRESS_CA} && break; sleep 0.25; done; ` +
      `cp ${CONTAINER_EGRESS_CA} /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates >/dev/null 2>&1`;
    const trust = await this.container.exec(["bash", "-c", script], { stderr: "combined" });
    const output = await trust.output();
    if (output.exitCode !== 0) {
      const text = new TextDecoder().decode(output.stdout).trim().slice(-300);
      throw new Error(`the gate container could not trust the egress CA (exit ${output.exitCode}: ${text})`);
    }
  }

  async spawn(argv: readonly string[], env: Readonly<Record<string, string>>): Promise<GateProcess> {
    const proc = await this.container.exec([...argv], {
      cwd: "/opt/scf",
      env: {
        PATH: "/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/root",
        // npm reaches the registry through the intercept: trust its CA too.
        NODE_EXTRA_CA_CERTS: CONTAINER_EGRESS_CA,
        ...env,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const writer = proc.stdin?.getWriter();
    const encoder = new TextEncoder();
    // Drain stderr (diagnostics) so the process never blocks on a full pipe;
    // keep its tail for a job that ends without a result.
    let tail = "";
    const decoder = new TextDecoder();
    void proc.stderr
      ?.pipeTo(
        new WritableStream<Uint8Array>({
          write(chunk) {
            tail = (tail + decoder.decode(chunk, { stream: true })).slice(-2000);
          },
        }),
      )
      .catch(() => undefined);
    return {
      lines: readLines(proc.stdout),
      async writeLine(line: string) {
        if (!writer) {
          throw new Error("the job's stdin is not writable");
        }
        await writer.write(encoder.encode(`${line}\n`));
      },
      async closeInput() {
        await writer?.close().catch(() => undefined);
      },
      exitCode: proc.exitCode,
      diagnostics: () => tail,
      kill() {
        try {
          proc.kill(9);
        } catch {
          // already gone
        }
      },
    };
  }
}

/** A byte stream as lines. */
async function* readLines(stream: ReadableStream | null): AsyncIterable<string> {
  if (!stream) {
    return;
  }
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
    }
    if (buffer.length > 4 * 1024 * 1024) {
      throw new Error("the job printed an unbounded line");
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") {
    yield buffer;
  }
}

const OUTCOME_PREFIX = "gate-job:";
/** The stored outcomes' keys, oldest first (what pruning drops first). */
const OUTCOME_INDEX = "gate-job-index";
/** The most finished outcomes a runner keeps for replay (older ones are pruned). */
export const OUTCOMES_KEPT = 64;

export class GateRunner extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  /** Run one job (serialized per runner), or return the stored outcome for its key. */
  async runJob(request: GateRunRequest): Promise<GateRunOutcome> {
    const run = this.queue.then(() => this.runOne(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Whether the container is running (for status and cleanup). */
  async status(): Promise<{ readonly available: boolean; readonly running: boolean }> {
    return { available: this.ctx.container !== undefined, running: this.ctx.container?.running ?? false };
  }

  /**
   * Forget every stored outcome (a re-created Change is a fresh run: nothing a
   * prior run finished may be replayed into it). Returns how many were dropped.
   */
  async clearCache(): Promise<{ readonly cleared: number }> {
    const listed = await this.ctx.storage.list({ prefix: OUTCOME_PREFIX });
    const keys = [...listed.keys()];
    for (let i = 0; i < keys.length; i += 128) {
      await this.ctx.storage.delete(keys.slice(i, i + 128));
    }
    await this.ctx.storage.delete(OUTCOME_INDEX);
    return { cleared: keys.length };
  }

  /** Store a finished outcome for replay, keeping at most OUTCOMES_KEPT (oldest dropped first). */
  private async remember(key: string, result: GateRunOutcome): Promise<void> {
    const storageKey = `${OUTCOME_PREFIX}${key}`;
    const index = ((await this.ctx.storage.get<string[]>(OUTCOME_INDEX)) ?? []).filter((k) => k !== storageKey);
    index.push(storageKey);
    const dropped = index.length > OUTCOMES_KEPT ? index.splice(0, index.length - OUTCOMES_KEPT) : [];
    await this.ctx.storage.put(storageKey, result);
    await this.ctx.storage.put(OUTCOME_INDEX, index);
    for (let i = 0; i < dropped.length; i += 128) {
      await this.ctx.storage.delete(dropped.slice(i, i + 128));
    }
  }

  /** Stop the container (cleanup). */
  async shutdown(): Promise<{ readonly running: boolean }> {
    if (this.ctx.container?.running) {
      await this.ctx.container.destroy("integration gate shutdown").catch(() => undefined);
    }
    return { running: this.ctx.container?.running ?? false };
  }

  private async runOne(request: GateRunRequest): Promise<GateRunOutcome> {
    const stored = await this.ctx.storage.get<GateRunOutcome>(`${OUTCOME_PREFIX}${request.key}`);
    if (stored !== undefined) {
      return { ...stored, cached: true };
    }
    const container = this.ctx.container;
    if (!container) {
      return {
        key: request.key,
        error: "this Worker runs without the gate container (no container is bound, or `wrangler dev` runs with containers disabled)",
        phases: [],
      };
    }
    const exportsOf = (this.ctx as unknown as { readonly exports?: Record<string, EgressFactory> }).exports;
    const egress = exportsOf?.GateEgress;
    if (!egress) {
      return { key: request.key, error: "the GateEgress entrypoint is not available (ctx.exports needs the enable_ctx_exports flag)", phases: [] };
    }
    const outcome = await driveGateJob(new CloudflareGatePort(container, egress), {
      job: request.job,
      artifactsHost: request.artifactsHost,
      registryHost: request.registryHost,
      repos: request.repos,
      deadlineMs: request.deadlineMs,
    });
    const result: GateRunOutcome = { key: request.key, ...outcome };
    const finished =
      outcome.result !== undefined &&
      !(outcome.result.kind === "integrate" && outcome.result.transient === true) &&
      !(outcome.result.kind === "advance" && !outcome.result.advanced);
    if (finished) {
      // Only a finished job is replayed; a failure to run (or to advance) is retried.
      await this.remember(request.key, result);
    }
    return result;
  }
}
