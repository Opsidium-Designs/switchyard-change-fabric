/**
 * cli-transport: run a model call through the operator's own, locally installed
 * and logged-in coding CLI (Claude Code's `claude -p`), instead of the
 * Cloudflare AI Gateway.
 *
 * This is an operator-selected local transport: the call runs on the
 * operator's machine under the operator's own CLI login and subscription. The
 * repository never holds a provider key and never makes a provider HTTP call
 * here; it only spawns the CLI binary the operator installed.
 *
 * The CLI is pluggable behind one `CliDriver` (how to build the argv, the stdin
 * prompt, and how to read the CLI's output). Claude Code is implemented; a
 * Codex driver can be added behind the same interface.
 *
 * Every call is hardened the same way (see runCli):
 *   - spawned directly (no shell), the prompt written to stdin;
 *   - tools are disabled (`--tools ""`), no session is persisted, no user or
 *     project settings and no MCP servers are loaded, so the CLI is a pure
 *     text-in/text-out model call that cannot touch the filesystem;
 *   - the working directory is a fresh EMPTY temp directory, removed after;
 *   - the environment is an allowlist (PATH, HOME, USER, LANG, TERM, the XDG
 *     dirs and CLAUDE_CONFIG_DIR when set): no repo credential (Cloudflare,
 *     gateway, Git host tokens) ever reaches the CLI;
 *   - stdout and stderr are bounded, and a timeout or an abort kills the
 *     CLI's whole process group.
 *
 * Errors are classified like the gateway's: a usage or rate limit is a
 * RateLimitError (with the reset time as retryAfterMs when the CLI names one),
 * a missing login is a CliAuthError, a missing binary a CliNotFoundError, and
 * an empty or garbled reply an UnusableModelOutputError.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GatewayJsonSchemaReply, JsonSchemaCaller, JsonSchemaRequest } from "./gateway-json-schema.ts";
import { RateLimitError } from "./rate-limit.ts";
import {
  UnusableModelOutputError,
  WorkersAiTimeoutError,
  type WorkersAiInvoke,
  type WorkersAiInvokeRequest,
  type WorkersAiInvokeResult,
  type WorkersAiMessage,
} from "./workers-ai.ts";

/** The local CLIs a driver can name. */
export type CliDriverName = "claude" | "codex";

/** The default per-call timeout for a local CLI call (5 minutes). */
export const DEFAULT_CLI_TIMEOUT_MS = 300_000;

/** The most stdout a CLI call may produce before it is killed (8 MiB). */
export const MAX_CLI_STDOUT_BYTES = 8 * 1024 * 1024;

/** The most stderr kept from a CLI call (64 KiB); the rest is dropped. */
export const MAX_CLI_STDERR_BYTES = 64 * 1024;

/**
 * The longest system prompt passed on the command line. Linux caps a single
 * argument at 128 KiB, so a longer one is refused clearly rather than failing
 * the spawn with E2BIG.
 */
export const MAX_CLI_SYSTEM_PROMPT_BYTES = 120_000;

/** The only environment names a CLI child receives (when set). */
export const CLI_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
];

/** One CLI model call. */
export interface CliRequest {
  /** The model id or alias (for Claude: sonnet, opus, haiku, or a full id). */
  readonly model: string;
  readonly messages: readonly WorkersAiMessage[];
  /** A JSON schema the reply must conform to (structured output), when set. */
  readonly schema?: unknown;
}

/** The parsed outcome of a successful CLI call. */
export interface CliResult {
  /** The reply text (for a schema call, the raw text the CLI also returned). */
  readonly text: string;
  /** The schema-conforming object, when the call carried a schema and the CLI returned one. */
  readonly structured?: unknown;
  /** Why the model stopped, mapped to the gateway vocabulary ("stop", or "length" when truncated). */
  readonly finishReason?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

/** How one local CLI is invoked and read. */
export interface CliDriver {
  readonly name: CliDriverName;
  /** The binary to spawn (a name on PATH, or an absolute path). */
  readonly bin: string;
  /** A human label for messages ("claude CLI"). */
  readonly label: string;
  /** The argv (after the binary) for one call. Never enables a tool. */
  buildArgs(request: CliRequest): string[];
  /** The text written to the CLI's stdin for one call. */
  buildStdin(request: CliRequest): string;
  /**
   * Files written into the call's empty temp directory before it starts
   * (name -> content; plain file names only), for a CLI that reads an input
   * such as a JSON schema from a file. Never a credential.
   */
  buildFiles?(request: CliRequest): Readonly<Record<string, string>>;
  /**
   * Read the CLI's output: the parsed result on success; throws a classified
   * error (RateLimitError, CliAuthError, UnusableModelOutputError, or a plain
   * Error) otherwise.
   */
  parse(stdout: string, stderr: string, exitCode: number | null, request: CliRequest): CliResult;
  /** The argv that prints the CLI's version (a cheap readiness probe; no model call). */
  readonly versionArgs: readonly string[];
  /** The argv that prints the CLI's login state, when it has one (no model call). */
  readonly authStatusArgs?: readonly string[];
  /** Read the login state from `authStatusArgs` output (undefined when unreadable). */
  parseAuthStatus?(stdout: string): { readonly loggedIn: boolean; readonly method?: string } | undefined;
}

/** Thrown when the CLI binary is not installed (or not on PATH). */
export class CliNotFoundError extends Error {
  readonly bin: string;
  constructor(driverLabel: string, bin: string) {
    super(
      `the ${driverLabel} was not found (${JSON.stringify(bin)} is not on PATH or not executable): ` +
        "install it and log in, or point the binary setting (for Claude: CLAUDE_CLI_BIN) at it",
    );
    this.name = "CliNotFoundError";
    this.bin = bin;
  }
}

/** Thrown when the CLI is installed but not logged in (or its login expired). Never retried. */
export class CliAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliAuthError";
  }
}

/** True for a CliAuthError (by type, or by name across module copies). */
export function isCliAuthError(error: unknown): error is CliAuthError {
  return error instanceof CliAuthError || (error instanceof Error && error.name === "CliAuthError");
}

/** True for a CliNotFoundError (by type, or by name across module copies). */
export function isCliNotFoundError(error: unknown): error is CliNotFoundError {
  return error instanceof CliNotFoundError || (error instanceof Error && error.name === "CliNotFoundError");
}

// ---------------------------------------------------------------------------
// Prompt serialization (shared by drivers)
// ---------------------------------------------------------------------------

/** The system messages joined into one system prompt (blank-line separated). */
export function cliSystemPrompt(messages: readonly WorkersAiMessage[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
}

/**
 * The non-system messages as the stdin prompt. A single user message is sent
 * verbatim; a multi-turn history is serialized with a clear role header per
 * message, in order, so the model sees who said what. Deterministic.
 */
export function cliStdinPrompt(messages: readonly WorkersAiMessage[]): string {
  const rest = messages.filter((m) => m.role !== "system");
  if (rest.length === 1 && rest[0]!.role === "user") {
    return rest[0]!.content;
  }
  return rest.map((m) => `=== ${m.role.toUpperCase()} ===\n${m.content}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

/** A CLI message that says a usage or rate limit was hit. */
const RATE_LIMIT_TEXT = /usage limit|rate limit|rate_limit|\b429\b|limit reached|hit your limit|resets? at/i;

/** A CLI message that says it is not logged in (or the login is no longer valid). */
const AUTH_TEXT =
  /not logged in|please run \/login|run \/login|invalid api key|authentication_error|authentication failed|oauth token (?:has )?expired|token has expired|unauthori[sz]ed|\b401\b|credit balance is too low/i;

/** The longest reset delay honoured as given (a day). */
const MAX_RESET_MS = 24 * 60 * 60 * 1000;

/**
 * The delay until a usage limit resets, parsed from the CLI's message, in ms:
 * an epoch suffix (`...|1760000000`), "try again in 20 minutes", or
 * "resets 3pm" / "resets at 15:30" (the next such local time). Undefined when
 * the message names none. Clamped to a day.
 */
export function parseCliResetMs(message: string, now: number = Date.now()): number | undefined {
  const clamp = (ms: number): number => Math.min(MAX_RESET_MS, Math.max(0, Math.round(ms)));
  const epoch = /\|\s*(\d{10})\b/.exec(message);
  if (epoch) {
    return clamp(Number(epoch[1]) * 1000 - now);
  }
  const rel = /(?:try again|retry|resets?) in (\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(message);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const factor = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1000;
    return clamp(n * factor);
  }
  const at = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(message);
  if (at) {
    let hour = Number(at[1]);
    const minute = at[2] !== undefined ? Number(at[2]) : 0;
    const meridiem = at[3]?.toLowerCase();
    if (meridiem === undefined && at[2] === undefined) {
      return undefined;
    }
    if (meridiem === "pm" && hour < 12) {
      hour += 12;
    } else if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
    if (hour > 23 || minute > 59) {
      return undefined;
    }
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    let ms = target.getTime() - now;
    if (ms <= 0) {
      ms += 24 * 60 * 60 * 1000;
    }
    return clamp(ms);
  }
  return undefined;
}

/** A short, single-line excerpt of CLI text for an error message (never the prompt). */
function excerpt(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// The Claude Code driver
// ---------------------------------------------------------------------------

/** Options for the Claude Code driver. */
export interface ClaudeCliDriverOptions {
  /** The binary (default `claude` on PATH). */
  readonly bin?: string;
  /** The clock for reset-time parsing (tests). */
  readonly now?: () => number;
}

/** The single JSON object `claude -p --output-format json` prints. */
interface ClaudeResultJson {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly is_error?: unknown;
  readonly api_error_status?: unknown;
  readonly result?: unknown;
  readonly structured_output?: unknown;
  readonly stop_reason?: unknown;
  readonly usage?: {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
    readonly cache_creation_input_tokens?: unknown;
    readonly cache_read_input_tokens?: unknown;
  };
}

/** Find the CLI's result object in its stdout (the last line that parses as one). */
function claudeResultFrom(stdout: string): ClaudeResultJson | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return undefined;
  }
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as ClaudeResultJson;
      }
    } catch {
      // not this line
    }
  }
  return undefined;
}

/**
 * The Claude Code driver: `claude -p --output-format json` with tools off, no
 * session persistence, no settings sources, strict (empty) MCP config, the
 * system prompt as `--system-prompt`, the schema (when given) as
 * `--json-schema`, and the model as `--model`. The prompt goes on stdin.
 */
export function createClaudeCliDriver(options: ClaudeCliDriverOptions = {}): CliDriver {
  const bin = (options.bin ?? "").trim() || "claude";
  const now = options.now ?? Date.now;
  const label = "claude CLI";
  return {
    name: "claude",
    bin,
    label,
    versionArgs: ["--version"],
    authStatusArgs: ["auth", "status"],
    buildArgs(request) {
      const system = cliSystemPrompt(request.messages);
      if (Buffer.byteLength(system, "utf8") > MAX_CLI_SYSTEM_PROMPT_BYTES) {
        throw new Error(
          `the system prompt for the ${label} call is ${Buffer.byteLength(system, "utf8")} bytes, over the ${MAX_CLI_SYSTEM_PROMPT_BYTES}-byte command-line limit`,
        );
      }
      return [
        "-p",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--tools",
        "",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--system-prompt",
        system,
        ...(request.schema !== undefined ? ["--json-schema", JSON.stringify(request.schema)] : []),
        "--model",
        request.model,
      ];
    },
    buildStdin(request) {
      return cliStdinPrompt(request.messages);
    },
    parse(stdout, stderr, exitCode, request) {
      const result = claudeResultFrom(stdout);
      if (result === undefined) {
        const what = `${stderr}\n${stdout}`;
        if (AUTH_TEXT.test(what)) {
          throw notLoggedIn(label);
        }
        if (RATE_LIMIT_TEXT.test(what)) {
          throw rateLimited(label, request.model, what, now());
        }
        if (stdout.trim() === "" && exitCode !== 0) {
          throw new Error(
            `the ${label} call for ${request.model} exited with code ${exitCode ?? "unknown"} and no output` +
              (stderr.trim() !== "" ? `: ${excerpt(stderr)}` : ""),
          );
        }
        throw new UnusableModelOutputError(
          stdout.trim() === ""
            ? `the ${label} returned an empty response for ${request.model}`
            : `the ${label} returned a non-JSON response for ${request.model}`,
        );
      }
      const isError = result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success");
      const text = typeof result.result === "string" ? result.result : "";
      const status = finiteNumber(result.api_error_status);
      if (isError) {
        const what = `${text}\n${stderr}`;
        if (status === 429 || RATE_LIMIT_TEXT.test(what)) {
          throw rateLimited(label, request.model, what, now());
        }
        if (status === 401 || status === 403 || AUTH_TEXT.test(what)) {
          throw notLoggedIn(label);
        }
        const subtype = typeof result.subtype === "string" && /^[A-Za-z_-]{1,60}$/.test(result.subtype) ? result.subtype : "error";
        throw new Error(
          `the ${label} call failed for ${request.model} (${subtype}${status !== undefined ? `, HTTP ${status}` : ""})` +
            (text.trim() !== "" ? `: ${excerpt(text)}` : ""),
        );
      }
      const usage = result.usage;
      const input = finiteNumber(usage?.input_tokens);
      const cacheCreate = finiteNumber(usage?.cache_creation_input_tokens);
      const cacheRead = finiteNumber(usage?.cache_read_input_tokens);
      // Every prompt token the model read, cached or not (the gateway's prompt_tokens).
      const inputTokens = input === undefined && cacheCreate === undefined && cacheRead === undefined ? undefined : (input ?? 0) + (cacheCreate ?? 0) + (cacheRead ?? 0);
      const outputTokens = finiteNumber(usage?.output_tokens);
      const stop = typeof result.stop_reason === "string" ? result.stop_reason : undefined;
      return {
        text,
        ...(result.structured_output !== undefined && result.structured_output !== null ? { structured: result.structured_output } : {}),
        finishReason: stop === "max_tokens" ? "length" : "stop",
        ...(inputTokens !== undefined || outputTokens !== undefined
          ? { usage: { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) } }
          : {}),
      };
    },
    parseAuthStatus(stdout) {
      try {
        const parsed = JSON.parse(stdout.trim()) as { loggedIn?: unknown; authMethod?: unknown };
        if (typeof parsed.loggedIn !== "boolean") {
          return undefined;
        }
        const method = typeof parsed.authMethod === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(parsed.authMethod) ? parsed.authMethod : undefined;
        // Only the login flag and the method are read: never the email or the organization.
        return { loggedIn: parsed.loggedIn, ...(method !== undefined ? { method } : {}) };
      } catch {
        return undefined;
      }
    },
  };
}

function notLoggedIn(label: string, loginHint = "run `claude` in a terminal and log in"): CliAuthError {
  return new CliAuthError(`the local ${label} is not logged in (or its login expired): ${loginHint}, then rerun`);
}

function rateLimited(label: string, model: string, text: string, now: number): RateLimitError {
  const retryAfterMs = parseCliResetMs(text, now);
  return new RateLimitError(
    `the ${label} hit a usage or rate limit for ${model}` + (retryAfterMs !== undefined ? ` (resets in about ${Math.ceil(retryAfterMs / 1000)} s)` : ""),
    { status: 429, model, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  );
}


// ---------------------------------------------------------------------------
// The OpenAI Codex CLI driver
// ---------------------------------------------------------------------------

/** Options for the Codex driver. */
export interface CodexCliDriverOptions {
  /** The binary (default `codex` on PATH). */
  readonly bin?: string;
  /** The clock for reset-time parsing (tests). */
  readonly now?: () => number;
}

/** The file the schema is written to in the call's temp directory. */
export const CODEX_SCHEMA_FILE = "schema.json";

/** A model value that means "the CLI's own default" (no -m flag). */
const CODEX_DEFAULT_MODEL = "default";

/** One JSONL event `codex exec --json` prints. */
interface CodexEvent {
  readonly type?: unknown;
  readonly message?: unknown;
  readonly item?: { readonly type?: unknown; readonly text?: unknown };
  readonly error?: { readonly message?: unknown };
  readonly usage?: {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
    readonly reasoning_output_tokens?: unknown;
  };
}

/** The events in Codex's stdout, in order (lines that do not parse are skipped). */
function codexEvents(stdout: string): CodexEvent[] {
  const out: CodexEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) out.push(parsed as CodexEvent);
    } catch {
      // not an event line
    }
  }
  return out;
}

/** Codex nests the provider's error as a JSON string inside `message`; read its inner message when it is one. */
function codexErrorText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    const inner = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown; status?: unknown };
    const message = typeof inner.error?.message === "string" ? inner.error.message : typeof inner.message === "string" ? inner.message : raw;
    return typeof inner.status === "number" ? `${message} (HTTP ${inner.status})` : message;
  } catch {
    return raw;
  }
}

/**
 * The OpenAI Codex CLI driver: `codex exec --json` in the call's empty temp
 * directory with a read-only sandbox, approvals never granted, no inherited
 * shell environment, web search off, no user config or rules, and no session
 * persistence. Codex has no tool-off switch, so the hardening is the sandbox
 * plus the empty directory and the allowlisted environment: a model-run
 * command can read nothing of the repo and change nothing. Codex has no
 * system-prompt flag either, so the system prompt leads the stdin prompt. A
 * schema is written to schema.json in the temp directory and passed as
 * --output-schema. The model `default` omits -m (the CLI's own default).
 */
export function createCodexCliDriver(options: CodexCliDriverOptions = {}): CliDriver {
  const bin = (options.bin ?? "").trim() || "codex";
  const now = options.now ?? Date.now;
  const label = "codex CLI";
  const loginHint = "run `codex login` in a terminal";
  return {
    name: "codex",
    bin,
    label,
    versionArgs: ["--version"],
    authStatusArgs: ["login", "status"],
    buildArgs(request) {
      return [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "-c",
        'approval_policy="never"',
        "-c",
        'shell_environment_policy.inherit="none"',
        "-c",
        'web_search="disabled"',
        "--color",
        "never",
        ...(request.model.trim() !== "" && request.model !== CODEX_DEFAULT_MODEL ? ["--model", request.model] : []),
        ...(request.schema !== undefined ? ["--output-schema", CODEX_SCHEMA_FILE] : []),
        "-",
      ];
    },
    buildStdin(request) {
      const system = cliSystemPrompt(request.messages);
      const prompt = cliStdinPrompt(request.messages);
      return system.trim() === "" ? prompt : `=== SYSTEM ===\n${system}\n\n${prompt}`;
    },
    buildFiles(request): Record<string, string> {
      const files: Record<string, string> = {};
      if (request.schema !== undefined) files[CODEX_SCHEMA_FILE] = JSON.stringify(request.schema);
      return files;
    },
    parse(stdout, stderr, exitCode, request) {
      const events = codexEvents(stdout);
      const failure = events.find((e) => e.type === "turn.failed" || e.type === "error");
      if (failure !== undefined) {
        const text = codexErrorText(failure.type === "turn.failed" ? failure.error?.message : failure.message);
        const what = `${text}\n${stderr}`;
        if (RATE_LIMIT_TEXT.test(what)) {
          throw rateLimited(label, request.model, what, now());
        }
        if (AUTH_TEXT.test(what)) {
          throw notLoggedIn(label, loginHint);
        }
        throw new Error(`the ${label} call failed for ${request.model}` + (text.trim() !== "" ? `: ${excerpt(text)}` : ""));
      }
      const messages = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string");
      const text = messages.length > 0 ? String(messages[messages.length - 1]!.item!.text) : "";
      if (text === "") {
        const what = `${stderr}\n${stdout}`;
        if (AUTH_TEXT.test(what)) {
          throw notLoggedIn(label, loginHint);
        }
        if (RATE_LIMIT_TEXT.test(what)) {
          throw rateLimited(label, request.model, what, now());
        }
        if (exitCode !== 0) {
          throw new Error(
            `the ${label} call for ${request.model} exited with code ${exitCode ?? "unknown"} and no reply` + (stderr.trim() !== "" ? `: ${excerpt(stderr)}` : ""),
          );
        }
        throw new UnusableModelOutputError(`the ${label} returned an empty response for ${request.model}`);
      }
      let structured: unknown;
      if (request.schema !== undefined) {
        try {
          structured = JSON.parse(text);
        } catch {
          structured = undefined;
        }
      }
      const done = [...events].reverse().find((e) => e.type === "turn.completed");
      const inputTokens = finiteNumber(done?.usage?.input_tokens);
      const output = finiteNumber(done?.usage?.output_tokens);
      const reasoning = finiteNumber(done?.usage?.reasoning_output_tokens);
      const outputTokens = output === undefined && reasoning === undefined ? undefined : (output ?? 0) + (reasoning ?? 0);
      return {
        text,
        ...(structured !== undefined && structured !== null ? { structured } : {}),
        finishReason: "stop",
        ...(inputTokens !== undefined || outputTokens !== undefined
          ? { usage: { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) } }
          : {}),
      };
    },
    parseAuthStatus(stdout) {
      const line = stdout.trim().split(/\r?\n/)[0] ?? "";
      if (/^not logged in/i.test(line)) return { loggedIn: false };
      const match = /^logged in(?: using (.+))?$/i.exec(line);
      if (!match) return undefined;
      const method = match[1]?.trim();
      // Only the login state and its method are read: never an account or key.
      return { loggedIn: true, ...(method !== undefined && /^[A-Za-z0-9 ._-]{1,40}$/.test(method) ? { method } : {}) };
    },
  };
}

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

/** The inference paths a run can use. */
export const INFERENCE_MODES = ["gateway", "claude-cli", "codex-cli"] as const;
export type InferenceMode = (typeof INFERENCE_MODES)[number];

/**
 * Parse an inference mode (SWITCHYARD_INFERENCE or --inference). Blank is the
 * default, the AI Gateway. Anything else is refused clearly.
 */
export function parseInferenceMode(raw: string | undefined, source = "SWITCHYARD_INFERENCE"): InferenceMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") {
    return "gateway";
  }
  if ((INFERENCE_MODES as readonly string[]).includes(value)) {
    return value as InferenceMode;
  }
  throw new Error(`${source} must be one of ${INFERENCE_MODES.join(", ")} (got ${JSON.stringify(raw ?? "")})`);
}

/**
 * The CLI driver for a local-CLI inference mode: Claude Code for
 * `claude-cli`, the OpenAI Codex CLI for `codex-cli`.
 */
export function cliDriverFor(
  mode: Exclude<InferenceMode, "gateway">,
  options: { readonly claudeBin?: string; readonly codexBin?: string } = {},
): CliDriver {
  if (mode === "codex-cli") {
    return createCodexCliDriver(options.codexBin !== undefined ? { bin: options.codexBin } : {});
  }
  return createClaudeCliDriver(options.claudeBin !== undefined ? { bin: options.claudeBin } : {});
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** The spawn the runner uses (node's, or a fake in tests). */
export type CliSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Options for one CLI run. */
export interface RunCliOptions {
  /** Kill the CLI after this many ms (0 disables; default DEFAULT_CLI_TIMEOUT_MS). */
  readonly timeoutMs?: number;
  /** Abort the call (kills the CLI's process group). */
  readonly signal?: AbortSignal;
  /** Injectable spawn (tests). Defaults to node's spawn. */
  readonly spawn?: CliSpawn;
  /** The environment the allowlist is taken from (default process.env). */
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  /** Where the per-call empty working directory is created (default the OS temp dir). */
  readonly tmpRoot?: string;
}

/** The allowlisted environment a CLI child gets: never a repo credential. */
export function cliChildEnv(source: Readonly<Record<string, string | undefined>> = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of CLI_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined && value !== "") {
      out[name] = value;
    }
  }
  return out;
}

/** What one spawn produced. */
interface SpawnOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** Kill a detached child's whole process group (falling back to the child alone). */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Spawn `bin args` in an empty temp dir with the allowlisted env, write
 * `stdin`, and collect bounded output. Rejects with CliNotFoundError (ENOENT),
 * WorkersAiTimeoutError (timeout), or an abort error.
 */
async function spawnBounded(
  driver: Pick<CliDriver, "bin" | "label">,
  args: readonly string[],
  stdin: string,
  what: string,
  options: RunCliOptions,
  files: Readonly<Record<string, string>> = {},
): Promise<SpawnOutcome> {
  const spawn = options.spawn ?? (nodeSpawn as unknown as CliSpawn);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const maxStdout = options.maxStdoutBytes ?? MAX_CLI_STDOUT_BYTES;
  const maxStderr = options.maxStderrBytes ?? MAX_CLI_STDERR_BYTES;
  if (options.signal?.aborted) {
    throw abortError(driver.label, what);
  }
  const cwd = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "scf-cli-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        throw new Error(`the ${driver.label} call asked to write an unsafe file name ${JSON.stringify(name)}`);
      }
      await writeFile(join(cwd, name), content, { mode: 0o600 });
    }
    return await new Promise<SpawnOutcome>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(driver.bin, [...args], {
          cwd,
          env: cliChildEnv(options.sourceEnv ?? process.env),
          stdio: ["pipe", "pipe", "pipe"],
          // Its own process group, so a timeout kills the CLI and anything it started.
          detached: true,
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        reject((error as NodeJS.ErrnoException)?.code === "ENOENT" ? new CliNotFoundError(driver.label, driver.bin) : error);
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let settled = false;
      let failure: Error | undefined;
      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        options.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const fail = (error: Error): void => {
        if (failure === undefined) {
          failure = error;
        }
        killGroup(child);
      };
      const onAbort = (): void => fail(abortError(driver.label, what));
      const timer =
        timeoutMs > 0
          ? setTimeout(() => fail(new WorkersAiTimeoutError(`the ${driver.label} ${what} timed out after ${timeoutMs}ms`)), timeoutMs)
          : undefined;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > maxStdout) {
          fail(new UnusableModelOutputError(`the ${driver.label} ${what} produced more than ${maxStdout} bytes of output`));
          return;
        }
        out.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (errBytes < maxStderr) {
          const room = maxStderr - errBytes;
          err.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        }
        errBytes += chunk.length;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish(() => reject(error.code === "ENOENT" ? new CliNotFoundError(driver.label, driver.bin) : error));
      });
      child.on("close", (code) => {
        finish(() => {
          if (failure !== undefined) {
            reject(failure);
            return;
          }
          resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), exitCode: code });
        });
      });
      // A CLI that exits before reading its stdin must not crash the run (EPIPE).
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin, "utf8");
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function abortError(label: string, what: string): Error {
  const error = new Error(`the ${label} ${what} was aborted`);
  error.name = "AbortError";
  return error;
}

/**
 * Run one model call through a local CLI and return the parsed result (see
 * the module comment for the hardening). Throws the driver's classified
 * errors, CliNotFoundError, or WorkersAiTimeoutError.
 */
export async function runCli(driver: CliDriver, request: CliRequest, options: RunCliOptions = {}): Promise<CliResult> {
  const args = driver.buildArgs(request);
  const stdin = driver.buildStdin(request);
  const outcome = await spawnBounded(driver, args, stdin, `call for ${request.model}`, options, driver.buildFiles?.(request) ?? {});
  return driver.parse(outcome.stdout, outcome.stderr, outcome.exitCode, request);
}

/** The outcome of probing a CLI's readiness (no model call). */
export interface CliProbe {
  readonly ok: boolean;
  /** The version line, when the binary answered. */
  readonly version?: string;
  /** The login state, when the CLI reports one. */
  readonly loggedIn?: boolean;
  readonly authMethod?: string;
  /** Why it is not ready (no secret). */
  readonly reason?: string;
}

/**
 * Probe a local CLI: its version (the binary runs) and, when the driver knows
 * how, its login state. Makes no model call. Never throws.
 */
export async function probeCli(driver: CliDriver, options: RunCliOptions = {}): Promise<CliProbe> {
  const short: RunCliOptions = { ...options, timeoutMs: options.timeoutMs ?? 15_000 };
  let version: string;
  try {
    const out = await spawnBounded(driver, driver.versionArgs, "", "version probe", short);
    if (out.exitCode !== 0) {
      return { ok: false, reason: `\`${driver.bin} ${driver.versionArgs.join(" ")}\` exited with code ${out.exitCode ?? "unknown"}` };
    }
    version = (out.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "unknown version").slice(0, 80);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (driver.authStatusArgs === undefined || driver.parseAuthStatus === undefined) {
    return { ok: true, version };
  }
  try {
    const out = await spawnBounded(driver, driver.authStatusArgs, "", "login probe", short);
    // Some CLIs (codex) print their login state on stderr.
    const status = driver.parseAuthStatus(out.stdout) ?? (out.stderr.trim() !== "" ? driver.parseAuthStatus(out.stderr) : undefined);
    if (status === undefined) {
      return { ok: true, version, reason: "login state unknown (the CLI did not report it)" };
    }
    return {
      ok: status.loggedIn,
      version,
      loggedIn: status.loggedIn,
      ...(status.method !== undefined ? { authMethod: status.method } : {}),
      ...(status.loggedIn ? {} : { reason: `the ${driver.label} is not logged in: run \`claude\` in a terminal and log in` }),
    };
  } catch (error) {
    return { ok: true, version, reason: `login state unknown (${error instanceof Error ? error.message : String(error)})` };
  }
}

// ---------------------------------------------------------------------------
// Adapters onto the existing seams
// ---------------------------------------------------------------------------

/** Options for the CLI adapters. */
export interface CliInvokeOptions extends RunCliOptions {
  /** Injectable runner (tests). Defaults to runCli. */
  readonly run?: (driver: CliDriver, request: CliRequest, options: RunCliOptions) => Promise<CliResult>;
}

function runnerOptions(options: CliInvokeOptions): RunCliOptions {
  const { run: _run, ...rest } = options;
  return rest;
}

/**
 * The executor transport (WorkersAiInvoke) over a local CLI: the reply text,
 * finishReason "stop" (or "length" when the CLI reports truncation, which the
 * executor reports as a ModelBudgetError), and the usage. No completion
 * ceiling is sent (the CLI has no flag for one), so `maxTokens` is absent.
 */
export function createCliInvoke(driver: CliDriver, options: CliInvokeOptions = {}): WorkersAiInvoke {
  const run = options.run ?? runCli;
  const rest = runnerOptions(options);
  return async (request: WorkersAiInvokeRequest): Promise<WorkersAiInvokeResult> => {
    const result = await run(driver, { model: request.model, messages: request.messages }, rest);
    return {
      text: result.text,
      finishReason: result.finishReason ?? "stop",
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    };
  };
}

/**
 * One schema-constrained call over a local CLI, shaped like the gateway's
 * (`content` is the reply JSON as a string): the schema rides `--json-schema`
 * and the reply is the CLI's structured output, falling back to the reply text
 * when it is JSON. A missing or non-JSON reply is the caller's responseError.
 */
export async function callCliJsonSchema(
  driver: CliDriver,
  request: JsonSchemaRequest,
  options: CliInvokeOptions = {},
): Promise<GatewayJsonSchemaReply> {
  const run = options.run ?? runCli;
  let result: CliResult;
  try {
    result = await run(driver, { model: request.model, messages: request.messages, schema: request.schema }, runnerOptions(options));
  } catch (error) {
    if (error instanceof UnusableModelOutputError) {
      throw request.responseError(error.message);
    }
    throw error;
  }
  let content: string | undefined;
  if (result.structured !== undefined) {
    content = JSON.stringify(result.structured);
  } else if (result.text.trim() !== "") {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(result.text.trim());
    const candidate = fenced ? fenced[1]! : result.text.trim();
    try {
      JSON.parse(candidate);
      content = candidate;
    } catch {
      content = undefined;
    }
  }
  if (content === undefined) {
    throw request.responseError(
      `the ${driver.label} ${request.label} reply had no structured output for ${request.model}` +
        (result.finishReason === "length" ? " (the reply was truncated)" : ""),
    );
  }
  return { content, ...(result.usage !== undefined ? { usage: result.usage } : {}) };
}

/** A JsonSchemaCaller over a local CLI (for the planner, agent turns, and tool fills). */
export function createCliJsonSchemaCaller(driver: CliDriver, options: CliInvokeOptions = {}): JsonSchemaCaller {
  return (request) => callCliJsonSchema(driver, request, options);
}
