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

import { runtimeEnv } from "./credentials.ts";

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
  const env = options.env ?? runtimeEnv();
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
  const auth = await probeCloudflareAuth(runCommand, wrangler.status === "ok");
  checks.push(auth);

  // Artifacts reachability (optional, best-effort). When authenticated, this
  // actually probes the live Artifacts service; offline it is honestly reported
  // as using the local fallback.
  checks.push(await probeArtifacts(runCommand, wrangler.status === "ok", auth.status === "ok"));

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

/**
 * Artifacts reachability. When wrangler is present and the account is
 * authenticated, this actually asks the live service to list namespaces: a
 * success means real Artifacts is reachable (`ok`), a failure is reported
 * honestly (`unknown`) rather than claimed as working. Without auth it reports
 * that the offline local fallback is used instead. It never throws.
 */
async function probeArtifacts(
  runCommand: (program: string, args: readonly string[]) => Promise<string>,
  wranglerPresent: boolean,
  authenticated: boolean,
): Promise<DoctorCheck> {
  if (!wranglerPresent) {
    return {
      name: "Artifacts namespace",
      status: "unknown",
      required: false,
      detail: "wrangler not available; offline demo uses the honest local-filesystem fallback",
    };
  }
  if (!authenticated) {
    return {
      name: "Artifacts namespace",
      status: "unknown",
      required: false,
      detail:
        "not authenticated; run `npx wrangler login` or set CLOUDFLARE_API_TOKEN for real Artifacts (offline demo uses the local fallback)",
    };
  }
  try {
    const out = await runCommand("npx", ["wrangler", "artifacts", "namespaces", "list"]);
    // The open-beta command prints a warning but still lists namespaces; any
    // non-error completion means the live Artifacts service answered us.
    const reachable = !/not authenticated|unauthorized|forbidden|error/i.test(out);
    if (reachable) {
      return {
        name: "Artifacts namespace",
        status: "ok",
        required: false,
        detail: "live Artifacts reachable (namespaces listed against the account)",
      };
    }
    return {
      name: "Artifacts namespace",
      status: "unknown",
      required: false,
      detail: "authenticated but Artifacts did not list cleanly; offline demo uses the local fallback",
    };
  } catch {
    return {
      name: "Artifacts namespace",
      status: "unknown",
      required: false,
      detail:
        "authenticated but could not reach Artifacts (open beta access or network); offline demo uses the local fallback",
    };
  }
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
