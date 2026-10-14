/**
 * The console dev launcher.
 *
 * This is the piece that makes the browser the control plane. The console is a
 * static single-page app and cannot clone repos, run Git, call the executor, or
 * drive the end-to-end live run; that work is Node-side. So the Vite dev server
 * (which already runs in Node under `make dev-all`) hosts a tiny launcher API
 * the browser calls:
 *
 *   GET  /api/templates          the shipped template gallery descriptors
 *   POST /api/launch {templateId, min, max, mode?, decideContracts?}
 *                                  start a live run (run-live, or run-board for
 *                                  mode "board") with a FRESH UNIQUE Change id
 *                                  and return that id for the UI to follow
 *   POST /api/deploy-app {templateId|app}  MANUALLY deploy that app in its
 *                                  CURRENT (broken) state to its STABLE live URL,
 *                                  BEFORE any fix, and return the workers.dev URL
 *                                  (409 while another launched run is still
 *                                  running: one live run at a time)
 *   GET  /api/runs                every run this launcher launched (newest
 *                                  first) and the active one, if any
 *   GET  /api/runs/:id            the launcher-side status of a launched run,
 *                                  with its promoted repo/commit once printed
 *   POST /api/publish-fixed {changeId}  upload that launched run's promoted
 *                                  commit as the fixed preview of its app
 *                                  (`publish-fixed` CLI; refused unless verified)
 *   GET  /api/deployments         the app URLs already deployed (read from the
 *                                  gitignored .deployments/<app>.json markers),
 *                                  so a console reload remembers a prior Deploy
 *   POST /api/teardown-app {templateId|app}  delete that template app's STABLE
 *                                  deployed Worker and clear its marker (the
 *                                  `teardown-app` CLI); no run's repos are touched
 *   POST /api/cleanup {changeId, app?}  tear down that run's real Artifact repos
 *                                  and (when a template app is given) the app's
 *                                  stable deployed Worker
 *   POST /api/worker/changes/...  the console's MUTATION proxy to the Worker: it
 *                                  forwards the POST to the same Worker path and,
 *                                  when SWITCHYARD_API_TOKEN is set in this dev
 *                                  process's environment, adds the bearer header
 *                                  server-side (see proxyWorkerPost)
 *
 * A launch spawns the existing `switchyard-change run-live` CLI, or, when the
 * human picks "agents on the board" for a goal template, `run-board` with the
 * same template's goal, project, and gate (so the live run
 * driver and the CLI commands stay the single underlying implementation; the
 * console does not reimplement them). The browser then follows the run by
 * polling the Worker's own `GET /changes/:id` exactly as before. For an
 * escalating template the launch passes `--await-escalation`, so the run blocks
 * on the real pending escalation until the human answers in the console; the
 * answer is the console's POST to the Worker's resolve route, sent through the
 * /api/worker proxy so the browser never holds the Worker API token.
 *
 * The launcher only ever runs one of the fixed, repo-relative templates by id.
 * It never executes a browser-supplied path or command, and it never prints or
 * forwards the Cloudflare token (the spawned CLI inherits the already-sourced
 * environment from the dev process). The only secret it reads itself is the
 * optional SWITCHYARD_API_TOKEN, which it places ONLY in the authorization
 * header of a proxied Worker POST and never logs or returns to the browser.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import type { Connect, Plugin } from "vite";

import { loadDotEnvFile, withoutCredentials } from "@switchyard-change/orchestration/credentials";

import {
  agentCountsOf,
  boardCapable,
  boardGoalFileOf,
  TEMPLATES,
  templateApps,
  templateById,
  type ContractPolicy,
  type LaunchMode,
  type Template,
} from "./src/templates";

/** The repo root, two levels up from apps/console. */
const CONSOLE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(CONSOLE_DIR, "..", "..");

/** The Worker base URL the launched run drives (same default as the console). */
const WORKER_URL = process.env.VITE_WORKER_URL ?? "http://127.0.0.1:8787";

/** A launched run's promotion, as the run's own output printed it. */
export interface PromotedOutput {
  readonly branch: string;
  /** The commit as printed (abbreviated; publish-fixed resolves it in the repo). */
  readonly commit: string;
}

/** The fixed version published for a run (publish-fixed's output). */
export interface FixedVersion {
  readonly url: string;
  readonly commit: string;
}

/** A launched run the launcher is tracking. */
export interface LaunchedRun {
  readonly changeId: string;
  readonly templateId: string;
  readonly child?: ChildProcess;
  status: "running" | "exited";
  exitCode: number | null;
  /** run-live, or agents on the board (run-board). */
  readonly mode: LaunchMode;
  /** ISO time of the launch. */
  readonly startedAt: string;
  /** The last lines of CLI output, kept small for an honest status read. */
  readonly log: string[];
  /** The promoted repo the run printed (`repo: <dir>`, or run-live's `... in <dir>`). */
  repoDir?: string;
  /** The promotion the run printed (`promoted: ...`); only a verified promotion is kept. */
  promoted?: PromotedOutput;
  /** The fixed version published from the promoted commit (POST /api/publish-fixed). */
  fixed?: FixedVersion;
  /** A publish-fixed in flight, or its last error. */
  publish?: { readonly kind: "publishing" } | { readonly kind: "failed"; readonly error: string; readonly output: readonly string[] };
  /** An output line cut across two chunks, joined with the next one. */
  partial?: string;
}

const runs = new Map<string, LaunchedRun>();

/** True while a launch is between its 409 check and the run being tracked (a pre-deploy can take a while). */
let launching = false;

/**
 * What one line of a launched run's output says about its promotion, if
 * anything. The CLI prints (after leading spaces):
 *   run-board: `promoted: branch <b> commit <c>` then `repo: <dir>`
 *   run-live:  `promoted: <b> (<c>) in <dir>`
 * An unverified promotion (`promoted unverified (no gate): ...`) and a refused
 * one are ignored: there is no fixed version to publish from them. Exported for tests.
 */
export function parseRunOutputLine(line: string): { readonly repoDir?: string; readonly promoted?: PromotedOutput } | undefined {
  const text = line.trim();
  const board = text.match(/^promoted: branch (\S+) commit ([0-9a-f]{7,64})$/);
  if (board) {
    return { promoted: { branch: board[1]!, commit: board[2]! } };
  }
  const live = text.match(/^promoted: (\S+) \(([0-9a-f]{7,64})\) in (\/.+)$/);
  if (live) {
    return { promoted: { branch: live[1]!, commit: live[2]! }, repoDir: live[3]! };
  }
  const repo = text.match(/^repo: (\/.+)$/);
  if (repo) {
    return { repoDir: repo[1]! };
  }
  return undefined;
}

/** The public view of a tracked run (GET /api/runs and /api/runs/:id). */
export function runView(run: LaunchedRun, withLog = false): Record<string, unknown> {
  return {
    changeId: run.changeId,
    templateId: run.templateId,
    status: run.status,
    exitCode: run.exitCode,
    mode: run.mode,
    startedAt: run.startedAt,
    ...(run.repoDir !== undefined ? { repoDir: run.repoDir } : {}),
    ...(run.promoted !== undefined ? { promoted: run.promoted } : {}),
    ...(run.fixed !== undefined ? { fixed: run.fixed } : {}),
    ...(run.publish !== undefined ? { publish: run.publish } : {}),
    ...(withLog ? { log: run.log } : {}),
  };
}

/** The launched run still running, if any: only one live run at a time. */
export function activeRun(tracked: Iterable<LaunchedRun> = runs.values()): LaunchedRun | undefined {
  for (const run of tracked) {
    if (run.status === "running") {
      return run;
    }
  }
  return undefined;
}

/** The 409 a launch gets while another launched run is still running (or one is being launched). */
export function launchConflict(tracked: Iterable<LaunchedRun> = runs.values(), launchInFlight = false): EndpointResult | undefined {
  const active = activeRun(tracked);
  if (active) {
    return {
      status: 409,
      body: {
        error: `a run is in progress: ${active.changeId} (${active.templateId}). One live run at a time: wait for it to finish.`,
        activeRun: { changeId: active.changeId, templateId: active.templateId, mode: active.mode, startedAt: active.startedAt },
      },
    };
  }
  if (launchInFlight) {
    return { status: 409, body: { error: "another launch is starting. One live run at a time." } };
  }
  return undefined;
}

/**
 * Mask URL userinfo and bare Artifact tokens (a failed `git clone` echoes its
 * token-bearing URL). Mirrors redactSecrets in the orchestration package; the
 * launcher stays free of workspace imports.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/\bart_v\d+_[A-Za-z0-9_%.=-]+/g, "art_***");
}

/**
 * Append a chunk of a run's output to its small rolling log, and keep what it
 * says about the promotion (the log scrolls; the promotion must not). Lines
 * are split on newlines; a line cut across two chunks is joined first.
 * Exported for tests.
 */
export function pushLog(run: LaunchedRun, chunk: string): void {
  const text = (run.partial ?? "") + chunk;
  const parts = text.split(/\r?\n/);
  run.partial = parts.pop() ?? "";
  for (const line of parts) {
    if (line.trim() === "") {
      continue;
    }
    const said = parseRunOutputLine(line);
    if (said?.promoted) {
      run.promoted = said.promoted;
    }
    if (said?.repoDir) {
      run.repoDir = said.repoDir;
    }
    run.log.push(redactSecrets(line));
    if (run.log.length > 50) {
      run.log.shift();
    }
  }
}

/** Generate a fresh, unique, filesystem-safe Change id for a launch. */
function freshChangeId(template: Template): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `console-${template.id}-${stamp}${rand}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * Push the template's own agent counts for a mode as --min/--max. The console
 * has no dial: a launch always runs with the counts the template declares, and
 * nothing in the request body can change them.
 */
function pushAgentCounts(args: string[], template: Template, mode: LaunchMode): void {
  const { min, max } = agentCountsOf(template, mode);
  args.push("--min", String(min), "--max", String(max));
}

/** Build the run-live CLI args for a template and a generated unique id. */
export function runLiveArgs(template: Template, changeId: string): string[] {
  const args = ["-w", "apps/cli", "run", "dev", "--", "run-live"];
  if (template.source.kind === "change") {
    args.push("--change", resolve(REPO_ROOT, template.source.changeFile));
  } else {
    args.push("--goal-file", resolve(REPO_ROOT, template.source.goalFile));
  }
  args.push("--project", resolve(REPO_ROOT, template.projectDir));
  args.push("--worker", WORKER_URL);
  // The template's own run-live agent counts (the CLI reads --min/--max).
  pushAgentCounts(args, template, "live");
  // A dynamic-branching template carries a discovery marker: pass it so a
  // completing unit discovers follow-up work carrying that marker in the target
  // repo, growing the live WorkGraph. The marker is a generic repo fact, not a
  // per-template script, so discovery stays goal-agnostic.
  if (template.discoverMarker) {
    args.push("--discover-marker", template.discoverMarker);
    args.push("--discover-project", resolve(REPO_ROOT, template.projectDir));
  }
  // A real-app template carries an app under examples/apps: pass it so a verified
  // run REDEPLOYS the fixed app IN PLACE to the app's stable worker name, but
  // ONLY when the app was already deployed by a manual Deploy before the run.
  // The run never deploys fresh; without a prior manual deploy it deploys nothing
  // and still promotes to Git. The stable name is derived from the app, not the
  // run id, so the manual broken deploy and the post-fix redeploy share one URL.
  if (template.app) {
    args.push("--deploy-app", resolve(REPO_ROOT, "examples/apps", template.app));
    args.push("--deploy-app-name", `switchyard-change-fabric-${template.app}`);
    // A real-app template MUST run the per-app verification gate and the bounded
    // model-escalation ladder, so a console-launched real-app run is held to the
    // same mechanical ground truth as the CLI. The run-live CLI already
    // auto-enables the gate when the target project declares a `gate` script
    // (every examples/apps/<app> does), but we pass --gate explicitly so a
    // console app run is gated by intent, not only by the auto-default. The
    // intro (non-app) template has no app and no gate script, so it is NOT
    // forced through a gate it does not have (absence of a gate stays honest).
    args.push("--gate");
  }
  // Give the run the fresh unique id the UI will follow, and leave the repos in
  // place at the end (watch) so the finished graph can be studied before the
  // human triggers per-run cleanup from the UI.
  args.push("--id", changeId, "--watch");
  // The escalating template blocks on a human answering in the console.
  if (template.escalates) {
    args.push("--await-escalation");
  }
  return args;
}

/** The launch options a browser body may choose (validated, never trusted). */
export interface LaunchOptions {
  readonly mode: LaunchMode;
  readonly contractPolicy: ContractPolicy;
}

/**
 * Validate the launch mode and contract policy from a launch body. Anything
 * unknown is refused; a board launch is only allowed for a goal template.
 */
export function launchOptionsFromBody(
  body: Record<string, unknown>,
  template: Template,
): { readonly ok: true; readonly options: LaunchOptions } | { readonly ok: false; readonly error: string } {
  const mode = body.mode === undefined ? "live" : body.mode;
  if (mode !== "live" && mode !== "board") {
    return { ok: false, error: "mode must be live or board" };
  }
  const policy = body.decideContracts === undefined ? "console" : body.decideContracts;
  if (policy !== "console" && policy !== "accept" && policy !== "reject") {
    return { ok: false, error: "decideContracts must be console, accept, or reject" };
  }
  if (mode === "board" && !boardCapable(template)) {
    return { ok: false, error: `${template.name} has no goal to post, so it cannot run on the board` };
  }
  if (mode === "live" && policy !== "console") {
    return { ok: false, error: "decideContracts applies only to a board run" };
  }
  return { ok: true, options: { mode, contractPolicy: policy } };
}

/**
 * Resolve a launch request body to a fixed template and validated options.
 * Only `templateId`, `mode`, and `decideContracts` are read: any `min`/`max`
 * in the body is ignored, because a launch always runs with the template's own
 * agent counts. Exported for tests.
 */
export function launchRequestFromBody(
  body: Record<string, unknown>,
):
  | { readonly ok: true; readonly template: Template; readonly options: LaunchOptions }
  | { readonly ok: false; readonly error: string } {
  const templateId = typeof body.templateId === "string" ? body.templateId : "";
  const template = templateById(templateId);
  if (!template) {
    return { ok: false, error: `unknown template: ${templateId || "(none)"}` };
  }
  const chosen = launchOptionsFromBody(body, template);
  if (!chosen.ok) {
    return { ok: false, error: chosen.error };
  }
  return { ok: true, template, options: chosen.options };
}

/**
 * Build the run-board CLI args for a goal template: the same goal, project,
 * app, and gate as its run-live launch, the template's own board agent counts,
 * plus the template's own board
 * budget flags (`--max-inflight`, `--max-turns`, `--timeout-ms`) when it
 * declares them. When the template's app is deployed (its Worker serves the
 * original at the production URL), `--preview-passing` uploads each revision
 * whose gate passes as a Worker VERSION under ONE alias, `fixed-<change tag>`
 * (never a production deploy; failing revisions are not uploaded), so the run
 * has a before and an after side by side as soon as a revision passes, and the
 * production URL keeps the original. A version needs that Worker to exist, so
 * it is not passed otherwise (the launcher deploys the original first).
 * `--decide-contracts` is passed ONLY for an automatic policy (and stays last);
 * otherwise each contract decision waits for the human's answer in the console.
 */
export function runBoardArgs(
  template: Template,
  changeId: string,
  policy: ContractPolicy,
  appDeployed = false,
): string[] {
  const goalFile = boardGoalFileOf(template);
  if (goalFile === undefined) {
    throw new Error(`${template.id} has no goal to post on the board`);
  }
  const args = ["-w", "apps/cli", "run", "dev", "--", "run-board"];
  args.push("--goal-file", resolve(REPO_ROOT, goalFile));
  args.push("--project", resolve(REPO_ROOT, template.projectDir));
  args.push("--worker", WORKER_URL);
  pushAgentCounts(args, template, "board");
  const options = template.boardOptions;
  if (options?.maxInflight !== undefined) {
    args.push("--max-inflight", String(options.maxInflight));
  }
  if (options?.maxTurns !== undefined) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options?.timeoutMs !== undefined) {
    args.push("--timeout-ms", String(options.timeoutMs));
  }
  if (template.app) {
    args.push("--deploy-app", resolve(REPO_ROOT, "examples/apps", template.app));
    args.push("--deploy-app-name", `switchyard-change-fabric-${template.app}`);
    if (appDeployed) {
      args.push("--preview-passing");
    }
  }
  // A board run is always held to the project's declared gate: both board
  // templates' projects declare one. A project without one then reads "gate
  // REQUIRED but missing" and cannot pass, rather than passing unchecked.
  args.push("--gate");
  args.push("--id", changeId, "--watch");
  if (policy !== "console") {
    args.push("--decide-contracts", policy);
  }
  return args;
}

/**
 * The CLI args for a launch, by mode. `appDeployed` (the template's app has a
 * live deployment marker) turns on the fixed preview for a board run; run-live
 * has no preview route and keeps its redeploy-in-place behavior. Exported for tests.
 */
export function launchArgs(
  template: Template,
  changeId: string,
  options: LaunchOptions,
  appDeployed = false,
): string[] {
  return options.mode === "board"
    ? runBoardArgs(template, changeId, options.contractPolicy, appDeployed)
    : runLiveArgs(template, changeId);
}

/** Read a small JSON body from a Connect request. */
async function readJson(req: Connect.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Send a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(payload);
}

/** The header every /api/worker proxy response carries (see src/worker-post.ts). */
export const WORKER_PROXY_MARKER = "x-switchyard-proxy";

/** The largest request body the Worker proxy relays (a resolve body is tiny). */
const MAX_PROXY_BODY_BYTES = 1_000_000;

/** The outcome of one proxied Worker POST, ready to write to the response. */
export interface ProxiedResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/**
 * Validate a browser-supplied proxy path: it must be a plain Worker Change path
 * (`/changes/...`), with no query, fragment, backslash, empty segment, or `..`
 * segment (raw or percent-encoded), so the proxy can only ever reach the
 * Worker's own Change routes and never another host or path.
 */
export function isAllowedProxyPath(path: string): boolean {
  if (!/^\/changes\/[A-Za-z0-9._~%:@!$&'()*+,;=/-]+$/.test(path)) {
    return false;
  }
  if (path.includes("//") || path.includes("\\")) {
    return false;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  return !decoded.split("/").some((segment) => segment === ".." || segment === ".") && !decoded.includes("\\");
}

/**
 * Forward one console mutation to the Worker. The path is validated against the
 * allowlist; the bearer is added ONLY when a token is configured (it is never
 * logged and never echoed back); the Worker's status and body are relayed as is.
 * An unreachable Worker is a 502. Pure apart from the injected fetch, so it is
 * testable offline.
 */
export async function proxyWorkerPost(options: {
  readonly path: string;
  readonly body: string;
  readonly contentType?: string;
  readonly workerUrl: string;
  readonly token?: string;
  readonly fetchFn?: typeof fetch;
}): Promise<ProxiedResponse> {
  if (!isAllowedProxyPath(options.path)) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "the Worker proxy only forwards /changes/... paths" }),
    };
  }
  const headers: Record<string, string> = {
    "content-type": options.contentType && options.contentType !== "" ? options.contentType : "application/json",
  };
  const token = options.token?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const base = options.workerUrl.replace(/\/$/, "");
  try {
    const res = await (options.fetchFn ?? fetch)(`${base}${options.path}`, {
      method: "POST",
      headers,
      body: options.body,
    });
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/json",
      body: await res.text(),
    };
  } catch {
    return {
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: `cannot reach the Worker at ${base}` }),
    };
  }
}

/** Read a raw request body, refusing one larger than the proxy limit. */
async function readRawBody(req: Connect.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_PROXY_BODY_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read the per-app deployment markers (`.deployments/<app>.json`, written by the
 * deploy-app CLI and cleared on teardown) for the given known apps and return
 * app -> URL. Only template apps are read (never a browser-supplied name), and
 * only an https URL is returned; a missing or malformed marker is skipped. The
 * marker holds only the public URL, never a secret.
 */
export async function readDeployedUrls(
  repoRoot: string,
  apps: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const app of apps) {
    if (!/^[A-Za-z0-9._-]+$/.test(app)) {
      continue;
    }
    try {
      const raw = await readFile(join(repoRoot, ".deployments", `${app}.json`), "utf8");
      const parsed = JSON.parse(raw) as { url?: unknown };
      if (typeof parsed.url === "string" && /^https:\/\/\S+$/.test(parsed.url)) {
        out[app] = parsed.url;
      }
    } catch {
      /* no marker: the app is not deployed */
    }
  }
  return out;
}

/** The spawn the launcher uses; injectable so tests run with a fake child process. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** The options every spawned CLI gets: the repo root and NO credential in its environment. */
function cliSpawnOptions(): SpawnOptions {
  return {
    cwd: REPO_ROOT,
    // Never pass a credential through a spawned run's environment: the CLI reads .env into memory itself.
    env: withoutCredentials(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  };
}

/** The outcome of one short-lived CLI command: its exit code and its (redacted) non-empty output lines. */
export interface CliResult {
  readonly code: number | null;
  readonly output: string[];
}

/** Run one short CLI command (`npm <args>`) to completion and collect its output. */
export function runCli(spawnFn: SpawnFn, args: readonly string[]): Promise<CliResult> {
  return new Promise((resolveResult) => {
    const out: string[] = [];
    let child: ChildProcess;
    try {
      child = spawnFn("npm", args, cliSpawnOptions());
    } catch (error) {
      resolveResult({ code: null, output: [redactSecrets(error instanceof Error ? error.message : String(error))] });
      return;
    }
    const lines = () =>
      out
        .join("")
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map(redactSecrets);
    let settled = false;
    const settle = (code: number | null) => {
      if (!settled) {
        settled = true;
        resolveResult({ code, output: lines() });
      }
    };
    child.stdout?.on("data", (d: Buffer) => out.push(d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => out.push(d.toString("utf8")));
    child.on("error", (error: Error) => {
      out.push(`\n${error.message}\n`);
      settle(null);
    });
    child.on("exit", (code) => settle(code));
  });
}

/**
 * Resolve the app a deploy/teardown body names, ONLY when it belongs to a
 * template: a known `templateId` with an app, else an `app` that some template
 * names. Anything else (an unknown app, a path, a non-string) is undefined.
 */
export function knownAppFromBody(body: Record<string, unknown>, templates: readonly Template[] = TEMPLATES): string | undefined {
  const templateId = typeof body.templateId === "string" ? body.templateId : "";
  if (templateId !== "") {
    return templates.find((t) => t.id === templateId)?.app;
  }
  const app = typeof body.app === "string" ? body.app : "";
  return app !== "" && templateApps(templates).includes(app) ? app : undefined;
}

/** The `deploy-app` CLI args: deploy the app's CURRENT code to its stable Worker. */
export function deployAppArgs(app: string): string[] {
  return ["-w", "apps/cli", "run", "dev", "--", "deploy-app", "--app", app, "--worker", WORKER_URL];
}

/** The `teardown-app` CLI args: delete the app's stable Worker and clear its marker (no repos touched). */
export function teardownAppArgs(app: string): string[] {
  return ["-w", "apps/cli", "run", "dev", "--", "teardown-app", "--app", app];
}

/** A launcher endpoint's answer: an HTTP status and a JSON body. */
export interface EndpointResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * POST /api/deploy-app: deploy a template's app in its CURRENT (broken) state to
 * its STABLE workers.dev URL and return that URL, or the CLI's error.
 */
export async function deployAppRequest(body: Record<string, unknown>, spawnFn: SpawnFn = spawn): Promise<EndpointResult> {
  const app = knownAppFromBody(body);
  if (app === undefined) {
    const named = typeof body.templateId === "string" && body.templateId !== "" ? body.templateId : body.app;
    return { status: 400, body: { error: `unknown or non-app template/app: ${typeof named === "string" && named !== "" ? named : "(none)"}` } };
  }
  const result = await runCli(spawnFn, deployAppArgs(app));
  const match = result.output.join("\n").match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/);
  if (result.code === 0 && match) {
    return { status: 201, body: { app, url: match[0] } };
  }
  return {
    status: 502,
    body: { app, error: "deploy did not complete (is the app deployable and the account authenticated?)", output: result.output },
  };
}

/**
 * POST /api/teardown-app: delete a template's app's stable Worker and clear its
 * marker through the `teardown-app` CLI. No run's repos are touched.
 */
export async function teardownAppRequest(body: Record<string, unknown>, spawnFn: SpawnFn = spawn): Promise<EndpointResult> {
  const app = knownAppFromBody(body);
  if (app === undefined) {
    const named = typeof body.templateId === "string" && body.templateId !== "" ? body.templateId : body.app;
    return { status: 400, body: { error: `unknown app: ${typeof named === "string" && named !== "" ? named : "(none)"}` } };
  }
  const result = await runCli(spawnFn, teardownAppArgs(app));
  if (result.code === 0) {
    return { status: 200, body: { app, ok: true, output: result.output } };
  }
  return { status: 502, body: { app, ok: false, error: `could not remove ${app}`, output: result.output } };
}

/** What a launch needs; injectable so tests run with a fake spawn and their own run table. */
export interface LaunchDeps {
  readonly spawnFn: SpawnFn;
  readonly tracked: Map<string, LaunchedRun>;
  /** Whether the app is deployed now (its .deployments marker). */
  readonly appDeployed: (app: string) => Promise<boolean>;
  /** The one-launch-at-a-time latch across the pre-deploy. */
  readonly state: { launching: boolean };
}

const defaultLaunchDeps: LaunchDeps = {
  spawnFn: spawn,
  tracked: runs,
  appDeployed: async (app) => (await readDeployedUrls(REPO_ROOT, [app]))[app] !== undefined,
  state: {
    get launching() {
      return launching;
    },
    set launching(value: boolean) {
      launching = value;
    },
  },
};

/**
 * POST /api/launch: start a run of a template with a fresh unique id and track
 * it. Refused with 409 while a launched run is still running (one live run at
 * a time; the body names it). A BOARD run of an app template gets the fixed
 * preview (`--preview-passing`), which needs the app's Worker: when the app is
 * not deployed, the launcher deploys the ORIGINAL first (the same deploy-app
 * command as the Deploy button), so the before is live from the start; if that
 * deploy fails the run still launches, without the fixed preview, and the
 * response says why. Exported for tests.
 */
export async function launchRequest(body: Record<string, unknown>, deps: LaunchDeps = defaultLaunchDeps): Promise<EndpointResult> {
  const resolved = launchRequestFromBody(body);
  if (!resolved.ok) {
    return { status: 400, body: { error: resolved.error } };
  }
  const conflict = launchConflict(deps.tracked.values(), deps.state.launching);
  if (conflict) {
    return conflict;
  }
  const { template, options } = resolved;
  deps.state.launching = true;
  try {
    const changeId = freshChangeId(template);
    let appDeployed = template.app ? await deps.appDeployed(template.app) : false;
    let deployedOriginal: string | undefined;
    let previewSkipped: string | undefined;
    if (template.app && options.mode === "board" && !appDeployed) {
      const deployed = await deployAppRequest({ templateId: template.id }, deps.spawnFn);
      if (deployed.status === 201 && typeof deployed.body.url === "string") {
        appDeployed = true;
        deployedOriginal = deployed.body.url;
      } else {
        previewSkipped = `the original ${template.app} could not be deployed first, so this run has no fixed preview: ${String(deployed.body.error ?? "deploy failed")}`;
      }
    }
    const args = launchArgs(template, changeId, options, appDeployed);
    // The spawned CLI reads .env into memory itself: no credential is forwarded
    // through its environment (code it runs could read a parent's environ).
    const child = deps.spawnFn("npm", args, cliSpawnOptions());
    const run: LaunchedRun = {
      changeId,
      templateId: template.id,
      child,
      status: "running",
      exitCode: null,
      mode: options.mode,
      startedAt: new Date().toISOString(),
      log: [],
    };
    child.stdout?.on("data", (data: Buffer) => pushLog(run, data.toString("utf8")));
    child.stderr?.on("data", (data: Buffer) => pushLog(run, data.toString("utf8")));
    child.on("error", (error: Error) => {
      pushLog(run, `\n${error.message}\n`);
      run.status = "exited";
    });
    child.on("exit", (code) => {
      pushLog(run, "\n");
      run.status = "exited";
      run.exitCode = code;
    });
    deps.tracked.set(changeId, run);
    return {
      status: 201,
      body: {
        changeId,
        templateId: template.id,
        escalates: template.escalates,
        mode: options.mode,
        ...(deployedOriginal !== undefined ? { deployedOriginal } : {}),
        ...(previewSkipped !== undefined ? { previewSkipped } : {}),
      },
    };
  } finally {
    deps.state.launching = false;
  }
}

/** The `publish-fixed` CLI args: upload the run's promoted commit as the fixed preview of its app. */
export function publishFixedArgs(changeId: string, app: string, repoDir: string, promoted: PromotedOutput): string[] {
  return [
    "-w",
    "apps/cli",
    "run",
    "dev",
    "--",
    "publish-fixed",
    "--change-id",
    changeId,
    "--app",
    app,
    "--repo",
    repoDir,
    "--commit",
    promoted.commit,
    "--branch",
    promoted.branch,
    "--worker",
    WORKER_URL,
  ];
}

/**
 * POST /api/publish-fixed {changeId}: publish the fixed version of a run THIS
 * launcher launched, from the promoted repo and commit its own output printed.
 * The browser names only the run; the repo, commit, branch, and app come from
 * the launcher's own tracking and the template. The CLI refuses unless the
 * Worker records the run as verified by a gate that ran (see publish-fixed.ts).
 * Exported for tests.
 */
export async function publishFixedRequest(
  body: Record<string, unknown>,
  deps: { readonly spawnFn: SpawnFn; readonly tracked: Map<string, LaunchedRun> } = defaultLaunchDeps,
): Promise<EndpointResult> {
  const changeId = typeof body.changeId === "string" ? body.changeId : "";
  const run = changeId === "" ? undefined : deps.tracked.get(changeId);
  if (!run) {
    return { status: 404, body: { error: `no launched run ${changeId || "(none)"}: only a run launched from this console can be published here` } };
  }
  const app = templateById(run.templateId)?.app;
  if (!app) {
    return { status: 400, body: { error: `${run.templateId} has no app to publish` } };
  }
  if (run.fixed) {
    return { status: 200, body: { changeId, app, fixed: run.fixed } };
  }
  if (run.status === "running") {
    return { status: 409, body: { error: "the run is still running: publish its fixed version after it has promoted and exited" } };
  }
  if (!run.promoted || !run.repoDir) {
    return { status: 409, body: { error: "the run printed no verified promotion (no promoted commit and repo), so there is no fixed version to publish" } };
  }
  if (run.publish?.kind === "publishing") {
    return { status: 409, body: { error: "the fixed version is already being published" } };
  }
  run.publish = { kind: "publishing" };
  const result = await runCli(deps.spawnFn, publishFixedArgs(changeId, app, run.repoDir, run.promoted));
  const url = result.output.map((line) => line.trim().match(/^fixed version: (https:\/\/\S+\.workers\.dev\S*)$/)?.[1]).find((u) => u !== undefined);
  const commit = result.output.map((line) => line.trim().match(/^fixed: ([0-9a-f]{7,64}) /)?.[1]).find((c) => c !== undefined);
  if (result.code === 0 && url) {
    run.fixed = { url, commit: commit ?? run.promoted.commit };
    run.publish = undefined;
    return { status: 201, body: { changeId, app, fixed: run.fixed } };
  }
  const error = "publishing the fixed version did not complete";
  run.publish = { kind: "failed", error, output: result.output };
  return { status: 502, body: { changeId, app, error, output: result.output } };
}

/**
 * GET /api/templates: the gallery descriptors, each with its goal file's text
 * (`goalText`, read from the fixed repo-relative goal file), so the console
 * can find the app of a run started from the CLI by its objective. A goal file
 * that cannot be read is simply left out.
 */
export async function templatesWithGoalText(repoRoot: string = REPO_ROOT, templates: readonly Template[] = TEMPLATES): Promise<Template[]> {
  return Promise.all(
    templates.map(async (template) => {
      const goalFile = boardGoalFileOf(template);
      if (goalFile === undefined) return template;
      try {
        return { ...template, goalText: (await readFile(resolve(repoRoot, goalFile), "utf8")).trim() };
      } catch {
        return template;
      }
    }),
  );
}

/** GET /api/runs: every run this launcher launched (newest first) and the one still running, if any. */
export function listRuns(tracked: Map<string, LaunchedRun> = runs): Record<string, unknown> {
  const list = [...tracked.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((run) => runView(run));
  return { runs: list, active: activeRun(tracked.values())?.changeId ?? null };
}

/**
 * The Vite plugin: mount the launcher middleware on the dev server. In a
 * production build the console is static and this launcher is a dev-only
 * affordance, so the plugin only installs the middleware in dev.
 */
export function launcherPlugin(): Plugin {
  return {
    name: "switchyard-change-launcher",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/templates", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        void templatesWithGoalText().then((templates) => sendJson(res, 200, { templates }));
      });

      server.middlewares.use("/api/deployments", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        void readDeployedUrls(REPO_ROOT, templateApps()).then((deployments) =>
          sendJson(res, 200, { deployments }),
        );
      });

      server.middlewares.use("/api/launch", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void readJson(req)
          .then((body) => launchRequest(body))
          .then((result) => sendJson(res, result.status, result.body))
          .catch(() => {
            if (!res.headersSent) {
              sendJson(res, 500, { error: "launch failed" });
            }
          });
      });

      server.middlewares.use("/api/publish-fixed", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        // Publish a launched run's fixed version: its promoted commit, as a
        // preview version of the app's Worker beside the original. The body
        // names only the run; everything else comes from the launcher's own
        // tracking of that run's output.
        void readJson(req)
          .then((body) => publishFixedRequest(body))
          .then((result) => sendJson(res, result.status, result.body))
          .catch(() => {
            if (!res.headersSent) {
              sendJson(res, 500, { error: "publish failed" });
            }
          });
      });

      server.middlewares.use("/api/deploy-app", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        // The MANUAL deploy: deploy a real-app template's app in its CURRENT
        // (broken) state to its STABLE workers.dev URL, so a human sees the break
        // BEFORE launching a fix. This runs the `deploy-app` CLI (which records a
        // per-app marker holding the live URL), then returns that URL. The run
        // the human launches later redeploys the fixed code IN PLACE to the same
        // URL. Resolves the app only from a fixed template id or an app that
        // belongs to a template, never a browser-supplied path.
        void readJson(req)
          .then((body) => deployAppRequest(body))
          .then((result) => sendJson(res, result.status, result.body))
          .catch(() => {
            if (!res.headersSent) {
              sendJson(res, 500, { error: "deploy failed" });
            }
          });
      });

      server.middlewares.use("/api/teardown-app", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        // Remove a template's deployed app: delete its STABLE Worker (its
        // revision previews are versions of it, so they go too) and clear its
        // marker through the `teardown-app` CLI. No run's repos are touched; the
        // app must belong to a template, never a browser-supplied path.
        void readJson(req)
          .then((body) => teardownAppRequest(body))
          .then((result) => sendJson(res, result.status, result.body))
          .catch(() => {
            if (!res.headersSent) {
              sendJson(res, 500, { error: "teardown failed" });
            }
          });
      });

      server.middlewares.use("/api/runs", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        let id: string;
        try {
          id = decodeURIComponent((req.url ?? "").replace(/^\/+/, "").split("?")[0] ?? "");
        } catch {
          sendJson(res, 400, { error: "malformed run id" });
          return;
        }
        if (id === "") {
          // The listing: every run this launcher launched, and the active one.
          sendJson(res, 200, listRuns());
          return;
        }
        const run = runs.get(id);
        if (!run) {
          sendJson(res, 404, { error: `no launched run ${id}` });
          return;
        }
        sendJson(res, 200, runView(run, true));
      });

      // The console's MUTATION proxy. Connect strips the mount prefix, so
      // req.url is the Worker path (e.g. /changes/<id>/escalations/<e>/resolve).
      // Every response carries the proxy marker so the console knows it reached
      // the proxy and never re-sends the mutation directly.
      server.middlewares.use("/api/worker", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          res.setHeader(WORKER_PROXY_MARKER, "1");
          const body = await readRawBody(req);
          if (body === null) {
            sendJson(res, 413, { error: "request body too large" });
            return;
          }
          const proxied = await proxyWorkerPost({
            path: req.url ?? "",
            body,
            contentType: String(req.headers["content-type"] ?? ""),
            workerUrl: WORKER_URL,
            token: process.env.SWITCHYARD_API_TOKEN ?? loadDotEnvFile(join(REPO_ROOT, ".env"))?.SWITCHYARD_API_TOKEN,
          });
          res.statusCode = proxied.status;
          res.setHeader("content-type", proxied.contentType);
          res.end(proxied.body);
        })().catch(() => {
          if (!res.headersSent) {
            res.setHeader(WORKER_PROXY_MARKER, "1");
            sendJson(res, 502, { error: "worker proxy failed" });
          }
        });
      });

      server.middlewares.use("/api/cleanup", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void readJson(req).then((body) => {
          const changeId = typeof body.changeId === "string" ? body.changeId : "";
          if (changeId === "") {
            sendJson(res, 400, { error: "cleanup requires a changeId" });
            return;
          }
          // Tear down this run's real Artifact repos through the existing
          // cleanup-live CLI, scoped to that run's unique id. When the body names
          // an app it must be a template's app; its STABLE deployed Worker is
          // then torn down too (the console no longer sends one: it removes a
          // deployed app separately, through /api/teardown-app).
          const app = typeof body.app === "string" ? body.app : "";
          if (app !== "" && !templateApps().includes(app)) {
            sendJson(res, 400, { error: `unknown app: ${app}` });
            return;
          }
          const cleanupArgs = [
            "-w",
            "apps/cli",
            "run",
            "dev",
            "--",
            "cleanup-live",
            "--change-id",
            changeId,
            "--worker",
            WORKER_URL,
          ];
          if (app !== "") {
            cleanupArgs.push("--app", app);
          }
          return runCli(spawn, cleanupArgs).then((result) =>
            sendJson(res, result.code === 0 ? 200 : 502, {
              changeId,
              ok: result.code === 0,
              output: result.output,
            }),
          );
        }).catch(() => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: "cleanup failed" });
          }
        });
      });
    },
  };
}
