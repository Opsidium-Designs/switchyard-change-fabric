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
 *   GET  /api/runs/:id            the launcher-side status of a launched run
 *   GET  /api/deployments         the app URLs already deployed (read from the
 *                                  gitignored .deployments/<app>.json markers),
 *                                  so a console reload remembers a prior Deploy
 *   POST /api/cleanup {changeId, app?}  tear down that run's real Artifact repos
 *                                  and (when app is given) the app's stable
 *                                  deployed Worker
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

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import type { Connect, Plugin } from "vite";

import { boardCapable, boardGoalFileOf, TEMPLATES, templateById, type ContractPolicy, type LaunchMode, type Template } from "./src/templates";

/** The repo root, two levels up from apps/console. */
const CONSOLE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(CONSOLE_DIR, "..", "..");

/** The Worker base URL the launched run drives (same default as the console). */
const WORKER_URL = process.env.VITE_WORKER_URL ?? "http://127.0.0.1:8787";

/** A launched run the launcher is tracking. */
interface LaunchedRun {
  readonly changeId: string;
  readonly templateId: string;
  readonly child: ChildProcess;
  status: "running" | "exited";
  exitCode: number | null;
  /** The concurrency dial this run was launched with (its locked launch config). */
  readonly dial: LaunchDial;
  /** run-live, or agents on the board (run-board). */
  readonly mode: LaunchMode;
  /** The last lines of CLI output, kept small for an honest status read. */
  readonly log: string[];
}

const runs = new Map<string, LaunchedRun>();

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

/** Append a line to a run's small rolling log. */
function pushLog(run: LaunchedRun, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
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
 * The concurrency dial captured for a launch. The human sets min/max in the
 * console BEFORE launching, and that choice becomes this run's launch config:
 * it is passed straight through to the run-live CLI as --min/--max, so the
 * launched run uses it from the first wave. It is NOT changed mid-run (the
 * console locks the dial once a run is active), so a run keeps the dial it was
 * launched with.
 */
export interface LaunchDial {
  readonly min: number;
  readonly max: number;
}

/** The dial defaults, matching the CLI's own dialFromArgs defaults. */
const DEFAULT_DIAL: LaunchDial = { min: 1, max: 3 };

/**
 * Read and clamp a numeric dial bound from the launch body. A missing or
 * non-finite value falls back to the default; the value is clamped to the same
 * 0..8 range the console sliders expose, so a browser-supplied body can never
 * drive the dial out of range.
 */
function dialBound(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(0, Math.min(8, Math.round(n)));
}

/** Resolve the launch dial from the request body, clamped and defaulted. */
function dialFromBody(body: Record<string, unknown>): LaunchDial {
  const min = dialBound(body.min, DEFAULT_DIAL.min);
  const max = dialBound(body.max, DEFAULT_DIAL.max);
  // Keep the dial coherent: max is never below min, min is never below one.
  const safeMin = Math.max(1, min);
  return { min: safeMin, max: Math.max(safeMin, max) };
}

/** Build the run-live CLI args for a template, a generated unique id, and a dial. */
export function runLiveArgs(template: Template, changeId: string, dial: LaunchDial): string[] {
  const args = ["-w", "apps/cli", "run", "dev", "--", "run-live"];
  if (template.source.kind === "change") {
    args.push("--change", resolve(REPO_ROOT, template.source.changeFile));
  } else {
    args.push("--goal-file", resolve(REPO_ROOT, template.source.goalFile));
  }
  args.push("--project", resolve(REPO_ROOT, template.projectDir));
  args.push("--worker", WORKER_URL);
  // The dial the human set BEFORE launching is this run's launch config. The
  // run-live CLI already reads --min/--max (dialFromArgs), so passing them here
  // means the launched run recruits under exactly the dial that was chosen; the
  // console then locks the dial read-only for the life of the run.
  args.push("--min", String(dial.min), "--max", String(dial.max));
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
 * Build the run-board CLI args for a goal template: the same goal, project,
 * dial, app, and gate as its run-live launch. `--decide-contracts` is passed
 * ONLY for an automatic policy; otherwise each contract decision waits for the
 * human's answer in the console.
 */
export function runBoardArgs(template: Template, changeId: string, dial: LaunchDial, policy: ContractPolicy): string[] {
  const goalFile = boardGoalFileOf(template);
  if (goalFile === undefined) {
    throw new Error(`${template.id} has no goal to post on the board`);
  }
  const args = ["-w", "apps/cli", "run", "dev", "--", "run-board"];
  args.push("--goal-file", resolve(REPO_ROOT, goalFile));
  args.push("--project", resolve(REPO_ROOT, template.projectDir));
  args.push("--worker", WORKER_URL);
  args.push("--min", String(dial.min), "--max", String(dial.max));
  if (template.app) {
    args.push("--deploy-app", resolve(REPO_ROOT, "examples/apps", template.app));
    args.push("--deploy-app-name", `switchyard-change-fabric-${template.app}`);
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

/** The CLI args for a launch, by mode. Exported for tests. */
export function launchArgs(template: Template, changeId: string, dial: LaunchDial, options: LaunchOptions): string[] {
  return options.mode === "board"
    ? runBoardArgs(template, changeId, dial, options.contractPolicy)
    : runLiveArgs(template, changeId, dial);
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

/** The largest request body the Worker proxy relays (a resolve/dial body is tiny). */
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

/** Spawn a run-live child for a template under a chosen dial and track it. */
function launch(template: Template, dial: LaunchDial, options: LaunchOptions): LaunchedRun {
  const changeId = freshChangeId(template);
  const args = launchArgs(template, changeId, dial, options);
  // Inherit the dev process environment (already sourced from .env by the make
  // target), so the Workers AI executor and the Artifacts token are present
  // without the launcher ever reading or forwarding the secret itself.
  const child = spawn("npm", args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run: LaunchedRun = {
    changeId,
    templateId: template.id,
    child,
    status: "running",
    exitCode: null,
    dial,
    mode: options.mode,
    log: [],
  };
  child.stdout?.on("data", (data: Buffer) => pushLog(run, data.toString("utf8")));
  child.stderr?.on("data", (data: Buffer) => pushLog(run, data.toString("utf8")));
  child.on("exit", (code) => {
    run.status = "exited";
    run.exitCode = code;
  });
  runs.set(changeId, run);
  return run;
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
        sendJson(res, 200, { templates: TEMPLATES });
      });

      server.middlewares.use("/api/deployments", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        const apps = TEMPLATES.flatMap((t) => (t.app ? [t.app] : []));
        void readDeployedUrls(REPO_ROOT, apps).then((deployments) =>
          sendJson(res, 200, { deployments }),
        );
      });

      server.middlewares.use("/api/launch", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void readJson(req).then((body) => {
          const templateId = typeof body.templateId === "string" ? body.templateId : "";
          const template = templateById(templateId);
          if (!template) {
            sendJson(res, 400, { error: `unknown template: ${templateId || "(none)"}` });
            return;
          }
          // The dial the human set before launching is captured as this run's
          // launch config and passed through to the run-live CLI as --min/--max.
          const dial = dialFromBody(body);
          const chosen = launchOptionsFromBody(body, template);
          if (!chosen.ok) {
            sendJson(res, 400, { error: chosen.error });
            return;
          }
          const run = launch(template, dial, chosen.options);
          sendJson(res, 201, {
            changeId: run.changeId,
            templateId: run.templateId,
            escalates: template.escalates,
            dial: run.dial,
            mode: run.mode,
          });
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
        void readJson(req).then((body) => {
          const templateId = typeof body.templateId === "string" ? body.templateId : "";
          const appFromBody = typeof body.app === "string" ? body.app : "";
          const template = templateId !== "" ? templateById(templateId) : undefined;
          const app = template?.app ?? (appFromBody !== "" ? appFromBody : "");
          const known = TEMPLATES.some((t) => t.app === app);
          if (app === "" || !known) {
            sendJson(res, 400, { error: `unknown or non-app template/app: ${templateId || appFromBody || "(none)"}` });
            return;
          }
          const child = spawn(
            "npm",
            ["-w", "apps/cli", "run", "dev", "--", "deploy-app", "--app", app, "--worker", WORKER_URL],
            { cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
          );
          const out: string[] = [];
          child.stdout?.on("data", (d: Buffer) => out.push(d.toString("utf8")));
          child.stderr?.on("data", (d: Buffer) => out.push(d.toString("utf8")));
          child.on("exit", (code) => {
            const text = out.join("");
            const match = text.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/);
            const url = match ? match[0] : undefined;
            if (code === 0 && url) {
              sendJson(res, 201, { app, url });
            } else {
              sendJson(res, 502, {
                app,
                error: "deploy did not complete (is the app deployable and the account authenticated?)",
                output: text.split(/\r?\n/).filter((line) => line.trim() !== ""),
              });
            }
          });
        });
      });

      server.middlewares.use("/api/runs", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        const id = decodeURIComponent((req.url ?? "").replace(/^\/+/, "").split("?")[0] ?? "");
        const run = id === "" ? undefined : runs.get(id);
        if (!run) {
          sendJson(res, 404, { error: `no launched run ${id}` });
          return;
        }
        sendJson(res, 200, {
          changeId: run.changeId,
          templateId: run.templateId,
          status: run.status,
          exitCode: run.exitCode,
          dial: run.dial,
          mode: run.mode,
          log: run.log,
        });
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
            token: process.env.SWITCHYARD_API_TOKEN,
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
          // an app (the active template's app), tear its STABLE deployed Worker
          // down too and clear its per-app marker, so a manual Deploy never leaks
          // even when the run itself never redeployed.
          const app = typeof body.app === "string" ? body.app : "";
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
          const child = spawn("npm", cleanupArgs, {
            cwd: REPO_ROOT,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const out: string[] = [];
          child.stdout?.on("data", (d: Buffer) => out.push(d.toString("utf8")));
          child.stderr?.on("data", (d: Buffer) => out.push(d.toString("utf8")));
          child.on("exit", (code) => {
            sendJson(res, code === 0 ? 200 : 502, {
              changeId,
              ok: code === 0,
              output: out.join("").split(/\r?\n/).filter((line) => line.trim() !== ""),
            });
          });
        });
      });
    },
  };
}
