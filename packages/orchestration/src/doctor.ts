/**
 * doctor: check local prerequisites and report readiness, offline-safe.
 *
 * The check is deliberately defensive: it never throws on a missing optional
 * tool or an absent credential. Required tools (Node, Git) are reported with
 * their version; optional ones (wrangler, Cloudflare auth, Artifacts) are probed
 * best-effort and reported as present, absent, or unknown. It also reports which
 * executor modes are available: the deterministic noop executor is always
 * available (it needs nothing), and the openai-compatible mode is reported as
 * available only when a transport and model are configured.
 *
 * It runs entirely locally and times out any external probe quickly so a run
 * with no network still finishes fast.
 */

import { execFile } from "node:child_process";

/** How a single check came out. */
export type CheckStatus = "ok" | "missing" | "unknown";

/** One prerequisite check result. */
export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  /** Whether this prerequisite is required for the offline demo flow. */
  readonly required: boolean;
  /** A short, human-readable detail (version, reason, or guidance). */
  readonly detail: string;
}

/** The whole readiness report. */
export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  /** True when every required check is ok. */
  readonly ready: boolean;
}

/** Environment inputs for the doctor, injectable for tests. */
export interface DoctorEnv {
  /** Process environment (reads EXECUTOR, AI_GATEWAY_* etc). */
  readonly env?: Record<string, string | undefined>;
  /**
   * Command runner, injectable for tests. Resolves to the trimmed stdout, or
   * rejects when the command is missing or fails.
   */
  readonly runCommand?: (program: string, args: readonly string[]) => Promise<string>;
}

/** Run the full readiness check and return a structured report. */
export async function runDoctor(options: DoctorEnv = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? defaultRunCommand;

  const checks: DoctorCheck[] = [];

  // Node (required): we are already running under Node, so report its version.
  checks.push({
    name: "Node.js",
    status: "ok",
    required: true,
    detail: `present (${process.version})`,
  });

  // Git (required for the clone/commit/push and promotion flow).
  checks.push(await probeVersion(runCommand, "Git", "git", ["--version"], true));

  // wrangler (optional: only needed to reach the real Cloudflare services).
  const wrangler = await probeVersion(runCommand, "wrangler", "npx", ["wrangler", "--version"], false);
  checks.push(wrangler);

  // Cloudflare auth (optional, best-effort). Only probed when wrangler is here.
  checks.push(await probeCloudflareAuth(runCommand, wrangler.status === "ok"));

  // Artifacts reachability (optional, best-effort). Honestly reported as
  // unknown offline: the demo uses the local fallback and never needs it.
  checks.push(probeArtifacts(wrangler.status === "ok"));

  // Executor modes.
  checks.push(...executorChecks(env));

  const ready = checks.filter((c) => c.required).every((c) => c.status === "ok");
  return { checks, ready };
}

/** Render a readiness report as a readable, plain-text block. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("switchyard-change doctor: local readiness report");
  lines.push("");
  for (const check of report.checks) {
    const mark = check.status === "ok" ? "ok " : check.status === "missing" ? "-- " : "?? ";
    const req = check.required ? "[required]" : "[optional]";
    lines.push(`  ${mark} ${check.name} ${req}: ${check.detail}`);
  }
  lines.push("");
  if (report.ready) {
    lines.push("Ready: the offline demo flow can run (make demo).");
  } else {
    const missing = report.checks
      .filter((c) => c.required && c.status !== "ok")
      .map((c) => c.name);
    lines.push(`Not ready: install the required prerequisite(s): ${missing.join(", ")}.`);
  }
  return lines.join("\n");
}

/** Probe a tool's version via `<program> <args>`; report ok/missing. */
async function probeVersion(
  runCommand: (program: string, args: readonly string[]) => Promise<string>,
  name: string,
  program: string,
  args: readonly string[],
  required: boolean,
): Promise<DoctorCheck> {
  try {
    const out = await runCommand(program, args);
    const version = firstLine(out);
    return { name, status: "ok", required, detail: `present (${version})` };
  } catch {
    return {
      name,
      status: "missing",
      required,
      detail: required ? "not found on PATH (install it to continue)" : "not found (optional)",
    };
  }
}

/** Best-effort Cloudflare auth probe. Never throws; unknown when not logged in. */
async function probeCloudflareAuth(
  runCommand: (program: string, args: readonly string[]) => Promise<string>,
  wranglerPresent: boolean,
): Promise<DoctorCheck> {
  if (!wranglerPresent) {
    return {
      name: "Cloudflare auth",
      status: "unknown",
      required: false,
      detail: "wrangler not available, cannot check (optional for offline demo)",
    };
  }
  try {
    const out = await runCommand("npx", ["wrangler", "whoami"]);
    const logged = /account|logged in|email/i.test(out) && !/not authenticated|not logged in/i.test(out);
    if (logged) {
      return {
        name: "Cloudflare auth",
        status: "ok",
        required: false,
        detail: "logged in (real Artifacts reachable)",
      };
    }
    return {
      name: "Cloudflare auth",
      status: "unknown",
      required: false,
      detail: "not logged in (run `npx wrangler login` for real Artifacts; offline demo does not need it)",
    };
  } catch {
    return {
      name: "Cloudflare auth",
      status: "unknown",
      required: false,
      detail: "could not determine (offline demo does not need it)",
    };
  }
}

/** Artifacts reachability is only meaningful with Cloudflare auth; honest unknown otherwise. */
function probeArtifacts(wranglerPresent: boolean): DoctorCheck {
  return {
    name: "Artifacts namespace",
    status: "unknown",
    required: false,
    detail: wranglerPresent
      ? "reachability unknown without a logged-in account; offline demo uses the local fallback"
      : "wrangler not available; offline demo uses the honest local-filesystem fallback",
  };
}

/** Report which executor modes are available from configuration. */
function executorChecks(env: Record<string, string | undefined>): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // noop is always available: it needs nothing and makes a deterministic edit.
  checks.push({
    name: "Executor: noop",
    status: "ok",
    required: false,
    detail: "always available (deterministic, zero inference; used by the demo)",
  });

  // openai-compatible is available only when a transport/model path is set.
  const model = env.AI_GATEWAY_MODEL ?? env.WORKERS_AI_MODEL;
  const hasModel = typeof model === "string" && model.trim() !== "" && model.trim() !== "provider/model";
  if (hasModel) {
    checks.push({
      name: "Executor: openai-compatible",
      status: "ok",
      required: false,
      detail: `configured (model ${model}); supply a chat transport to run it`,
    });
  } else {
    checks.push({
      name: "Executor: openai-compatible",
      status: "unknown",
      required: false,
      detail:
        "not configured (set AI_GATEWAY_MODEL or WORKERS_AI_MODEL and provide a transport to enable)",
    });
  }
  return checks;
}

/** The default command runner with a short timeout, so probes never hang. */
async function defaultRunCommand(program: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      program,
      [...args],
      { timeout: 5000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve((stdout || stderr || "").toString());
      },
    );
    child.on("error", reject);
  });
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line ?? "present";
}
