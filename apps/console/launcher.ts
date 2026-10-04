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
 *   POST /api/launch {templateId} start a live run with a FRESH UNIQUE Change id
 *                                  and return that id for the UI to follow
 *   GET  /api/runs/:id            the launcher-side status of a launched run
 *   POST /api/cleanup {changeId}  tear down that run's real Artifact repos
 *
 * A launch spawns the existing `switchyard-change run-live` CLI (so the live run
 * driver and the CLI commands stay the single underlying implementation; the
 * console does not reimplement them). The browser then follows the run by
 * polling the Worker's own `GET /changes/:id` exactly as before. For an
 * escalating template the launch passes `--await-escalation`, so the run blocks
 * on the real pending escalation until the human answers in the console; the
 * answer is the console's existing POST straight to the Worker's resolve route.
 *
 * The launcher only ever runs one of the fixed, repo-relative templates by id.
 * It never executes a browser-supplied path or command, and it never prints or
 * forwards the Cloudflare token (the spawned CLI inherits the already-sourced
 * environment from the dev process; the launcher reads no secret itself).
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { Connect, Plugin } from "vite";

import { TEMPLATES, templateById, type Template } from "./src/templates";

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
  /** The last lines of CLI output, kept small for an honest status read. */
  readonly log: string[];
}

const runs = new Map<string, LaunchedRun>();

/** Append a line to a run's small rolling log. */
function pushLog(run: LaunchedRun, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    run.log.push(line);
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

/** Build the run-live CLI args for a template and a generated unique id. */
function runLiveArgs(template: Template, changeId: string): string[] {
  const args = ["-w", "apps/cli", "run", "dev", "--", "run-live"];
  if (template.source.kind === "change") {
    args.push("--change", resolve(REPO_ROOT, template.source.changeFile));
  } else {
    args.push("--goal-file", resolve(REPO_ROOT, template.source.goalFile));
  }
  args.push("--project", resolve(REPO_ROOT, template.projectDir));
  args.push("--worker", WORKER_URL);
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

/** Spawn a run-live child for a template and track it. */
function launch(template: Template): LaunchedRun {
  const changeId = freshChangeId(template);
  const args = runLiveArgs(template, changeId);
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
          const run = launch(template);
          sendJson(res, 201, {
            changeId: run.changeId,
            templateId: run.templateId,
            escalates: template.escalates,
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
          log: run.log,
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
          // cleanup-live CLI, scoped to that run's unique id.
          const child = spawn(
            "npm",
            [
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
            ],
            { cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
          );
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
