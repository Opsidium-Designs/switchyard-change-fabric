/**
 * The pure half of the replay exporter: page a Change's board log and snapshot
 * from a Worker, scrub local absolute paths, refuse anything token-like, and
 * maintain the replay index. The CLI wrapper (export-replay.ts) does the file
 * I/O; everything here takes its inputs (fetch, env, repo root) as arguments so
 * it is tested offline.
 *
 * A replay file is the recorded board log (the exact messages the Worker
 * holds, so the console's fold replays them byte for byte) plus a slim,
 * allow-listed slice of the ChangeState snapshot (status, objective, the
 * recorded integration verdict, escalations, the dial). Nothing outside that
 * allow list is published: no production deployment URL, no repo identities.
 * Revision previews are the one exception, on purpose: each is a public
 * workers.dev URL of a Worker version built from one revision's commit, kept
 * only when it is well formed (https, workers.dev, no credentials).
 */

import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";
import { readPreviews } from "../src/previews.ts";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** The format tag written into every replay file. */
export const REPLAY_FORMAT = "switchyard-replay/v1";

/** The snapshot fields a replay keeps (everything else is dropped before publishing). */
export const SNAPSHOT_ALLOW = ["id", "objective", "status", "dial", "integration", "planningFailure", "escalations", "board", "previews"] as const;

export interface ReplayFile {
  readonly format: typeof REPLAY_FORMAT;
  readonly changeId: string;
  readonly messages: readonly BoardMessage[];
  readonly snapshot: Record<string, unknown> | null;
}

export type ReplayOutcome = "verified" | "unverified" | "failed" | "unknown";

export interface ReplayIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly app: string;
  readonly outcome: ReplayOutcome;
  readonly description: string;
  readonly messages: number;
}

export interface ReplayIndex {
  readonly format: typeof REPLAY_FORMAT;
  readonly runs: readonly ReplayIndexEntry[];
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

/** Characters that end a path inside free text (gate output, stack traces). */
const PATH_CHAR = "[^\\s\"'`<>()\\[\\]{},;]";
/**
 * Not preceded by something that makes it part of a URL or a longer path; a
 * `file://` URL's path is a local path too.
 */
const PATH_START = "(?<=^|[^\\w.:/~-]|file://)";

/**
 * A temp work directory: `/tmp/<dir>` (optionally `/worktrees/<dir>` below it,
 * the board's integration and agent worktrees) or the macOS per-user temp root.
 */
const TEMP_ROOT = new RegExp(
  `${PATH_START}(?:/private)?(?:/tmp|/var/tmp|/var/folders/${PATH_CHAR}+?/${PATH_CHAR}+?/T)/(?:${PATH_CHAR}+?)(?:/worktrees/${PATH_CHAR}+?)?(?=/|${PATH_CHAR.replace("[^", "[")}|$)`,
  "g",
);
/** A home directory: `/home/<user>`, `/Users/<user>`, or `/root`. */
const HOME_ROOT = new RegExp(`${PATH_START}(?:/home/${PATH_CHAR}+?|/Users/${PATH_CHAR}+?|/root)(?=/|${PATH_CHAR.replace("[^", "[")}|$)`, "g");

/** Anything still shaped like a local absolute path after scrubbing. */
const RESIDUAL_PATH = /(?<![\w.-])(?:\/tmp\/|\/var\/tmp\/|\/var\/folders\/|\/private\/|\/home\/|\/Users\/|\/root\/)/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scrub one string: the repo root becomes repo-relative, a temp work directory
 * becomes `<work>`, and a home directory becomes `<home>`. Text that is not a
 * local absolute path is left exactly as it is.
 */
export function scrubString(text: string, repoRoot?: string): string {
  let out = text;
  if (repoRoot !== undefined && repoRoot.length > 1) {
    const root = repoRoot.replace(/\/+$/, "");
    out = out.replace(new RegExp(`${escapeRegExp(root)}/`, "g"), "").replace(new RegExp(`${escapeRegExp(root)}(?![\\w-])`, "g"), ".");
  }
  return out.replace(TEMP_ROOT, "<work>").replace(HOME_ROOT, "<home>");
}

/** Scrub every string (and object key) in a JSON value, returning a new value. */
export function scrubValue<T>(value: T, repoRoot?: string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubString(v, repoRoot);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [scrubString(k, repoRoot), walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

// ---------------------------------------------------------------------------
// Secret detection
// ---------------------------------------------------------------------------

export interface SecretFinding {
  /** Where in the JSON value (dotted path). */
  readonly at: string;
  /** What kind of secret it looks like (never the value itself). */
  readonly kind: string;
}

interface Detector {
  readonly kind: string;
  readonly test: (text: string) => boolean;
}

function hasMixedCase(text: string): boolean {
  return /[a-z]/.test(text) && /[A-Z]/.test(text) && /\d/.test(text);
}

const DETECTORS: readonly Detector[] = [
  // A bearer credential (the word alone, in prose, is fine; a token after it is not).
  { kind: "bearer token", test: (t) => /\bBearer\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}/i.test(t) },
  // Cloudflare Artifacts repo tokens.
  { kind: "artifact token (art_v*)", test: (t) => /\bart_v[0-9A-Za-z_-]{6,}/.test(t) },
  { kind: "private key", test: (t) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t) },
  // Common provider key shapes.
  { kind: "provider key", test: (t) => /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/.test(t) },
  // Credentials embedded in a URL (https://user:secret@host).
  { kind: "credential in URL", test: (t) => /\bhttps?:\/\/[^\s/:@]+:[^\s/@]{6,}@/.test(t) },
  // A long hex secret. 40 hex is a Git commit id (the log is full of them), so
  // it is allowed; anything else from 32 hex up (an account id, an API secret)
  // is not.
  {
    kind: "long hex secret",
    test: (t) => [...t.matchAll(/(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g)].some((m) => m[0].length !== 40),
  },
  // A long base64 / base64url run mixing upper, lower, and digits.
  {
    kind: "long base64 secret",
    test: (t) => [...t.matchAll(/[A-Za-z0-9+_=-]{32,}/g)].some((m) => hasMixedCase(m[0]) && !/^[0-9a-f]+$/.test(m[0])),
  },
];

/**
 * Parse a dotenv file's KEY=VALUE lines (comments, blank lines, `export `
 * prefixes, and surrounding quotes handled). The exporter reads the repo's
 * gitignored .env this way, into memory only, so the secrets a live run uses
 * are checked for even though make never exports them to this process.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]!] = value;
  }
  return out;
}

/** Env var names whose values must never appear in a replay. */
const SENSITIVE_ENV_NAME = /TOKEN|SECRET|KEY|ACCOUNT/i;
/** Shorter values are too generic to match on (a "1", a "true"). */
const MIN_ENV_VALUE = 8;

/** The sensitive env values to look for, as {name, value} pairs (names are reported, values never). */
export function sensitiveEnvValues(env: Record<string, string | undefined>): { readonly name: string; readonly value: string }[] {
  return Object.entries(env).flatMap(([name, value]) =>
    SENSITIVE_ENV_NAME.test(name) && typeof value === "string" && value.trim().length >= MIN_ENV_VALUE ? [{ name, value: value.trim() }] : [],
  );
}

/**
 * Every token-like string in a JSON value, and every value of an env var whose
 * name contains TOKEN, SECRET, KEY, or ACCOUNT. An empty result means the value
 * is safe to publish by these checks.
 */
export function findSecrets(value: unknown, env: Record<string, string | undefined> = {}): SecretFinding[] {
  const envValues = sensitiveEnvValues(env);
  const out: SecretFinding[] = [];
  const check = (text: string, at: string) => {
    for (const d of DETECTORS) {
      if (d.test(text)) out.push({ at, kind: d.kind });
    }
    for (const { name, value: secret } of envValues) {
      if (text.includes(secret)) out.push({ at, kind: `value of $${name}` });
    }
  };
  const walk = (v: unknown, at: string) => {
    if (typeof v === "string") {
      check(v, at);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${at}[${i}]`));
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        check(k, `${at}.<key>`);
        walk(x, `${at}.${k}`);
      }
    }
  };
  walk(value, "$");
  return out;
}

/** Strings that still hold a local absolute path after scrubbing (should be none). */
export function findLocalPaths(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string) => {
    if (typeof v === "string") {
      if (RESIDUAL_PATH.test(v)) out.push(at);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${at}[${i}]`));
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${at}.${k}`);
    }
  };
  walk(value, "$");
  return out;
}

// ---------------------------------------------------------------------------
// Building a replay file
// ---------------------------------------------------------------------------

/** Keep only the allow-listed snapshot fields. */
export function slimSnapshot(snapshot: unknown): Record<string, unknown> | null {
  if (snapshot === null || typeof snapshot !== "object") return null;
  const source = snapshot as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SNAPSHOT_ALLOW) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  if (out.previews !== undefined) {
    const previews = readPreviews(source);
    if (previews.length > 0) out.previews = previews;
    else delete out.previews;
  }
  return out;
}

export class ReplayRefused extends Error {
  constructor(
    message: string,
    readonly findings: readonly SecretFinding[],
  ) {
    super(message);
    this.name = "ReplayRefused";
  }
}

/**
 * Turn a raw export ({changeId, messages, snapshot}) into a publishable replay
 * file: slim the snapshot, scrub paths, and refuse (throw ReplayRefused) when
 * anything token-like or any sensitive env value remains, or a local path
 * survived the scrub. The board log must be a contiguous run of seqs from 1.
 */
export function buildReplayFile(
  raw: { readonly changeId: string; readonly messages: readonly BoardMessage[]; readonly snapshot?: unknown },
  options: { readonly repoRoot?: string; readonly env?: Record<string, string | undefined> } = {},
): ReplayFile {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.changeId)) {
    throw new Error(`refusing an unsafe change id: ${JSON.stringify(raw.changeId)}`);
  }
  if (raw.messages.length === 0) {
    throw new Error(`the board of ${raw.changeId} has no messages: nothing to replay`);
  }
  raw.messages.forEach((m, i) => {
    if (m.seq !== i + 1) throw new Error(`the board log is not contiguous at index ${i} (seq ${m.seq})`);
  });
  const file: ReplayFile = scrubValue(
    { format: REPLAY_FORMAT, changeId: raw.changeId, messages: raw.messages, snapshot: slimSnapshot(raw.snapshot ?? null) },
    options.repoRoot,
  );
  const findings = findSecrets(file, options.env ?? {});
  const leftover = findLocalPaths(file).map((at) => ({ at, kind: "local absolute path" }));
  const all = [...findings, ...leftover];
  if (all.length > 0) {
    throw new ReplayRefused(
      `refusing to write ${raw.changeId}: ${all.length} finding(s): ${all
        .slice(0, 12)
        .map((f) => `${f.kind} at ${f.at}`)
        .join("; ")}${all.length > 12 ? "; ..." : ""}`,
      all,
    );
  }
  return file;
}

// ---------------------------------------------------------------------------
// Reading from a Worker
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 1000;
const MAX_PAGES = 200;

/** Page the full board log of a Change from a Worker (`GET /changes/:id/board?after=`). */
export async function fetchBoardLog(fetchFn: FetchFn, worker: string, changeId: string): Promise<BoardMessage[]> {
  const base = worker.replace(/\/+$/, "");
  const log: BoardMessage[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const after = log.length === 0 ? 0 : log[log.length - 1]!.seq;
    const res = await fetchFn(`${base}/changes/${encodeURIComponent(changeId)}/board?after=${after}&limit=${PAGE_LIMIT}`);
    if (res.status === 404) throw new Error(`no board for ${changeId} at ${base}`);
    if (!res.ok) throw new Error(`board request failed (${res.status})`);
    const body = (await res.json()) as { messages?: BoardMessage[]; hasMore?: boolean };
    const fresh = (body.messages ?? []).filter((m) => m.seq > after).sort((a, b) => a.seq - b.seq);
    log.push(...fresh);
    if (body.hasMore !== true || fresh.length === 0) return log;
  }
  throw new Error(`the board of ${changeId} has more than ${MAX_PAGES} pages`);
}

/** Read a Change's snapshot (`GET /changes/:id`); null when the Worker has none. */
export async function fetchSnapshot(fetchFn: FetchFn, worker: string, changeId: string): Promise<unknown> {
  const res = await fetchFn(`${worker.replace(/\/+$/, "")}/changes/${encodeURIComponent(changeId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`change request failed (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/** The outcome exactly as recorded: the integration verdict, else unknown. */
export function recordedOutcome(file: Pick<ReplayFile, "snapshot">): ReplayOutcome {
  const verdict = (file.snapshot?.integration as { verdict?: unknown } | null | undefined)?.verdict;
  return verdict === "verified" || verdict === "unverified" || verdict === "failed" ? verdict : "unknown";
}

/** A factual one-line description from the log (used when none is given). */
export function describeReplay(file: ReplayFile): string {
  const items = new Set<string>();
  const agents = new Set<string>();
  let revs = 0;
  let last: BoardMessage | undefined;
  for (const m of file.messages) {
    if (m.type === "item.proposed" || m.type === "item.discovered") items.add((m.payload as { item: string }).item);
    if (m.type === "agent.joined") agents.add(m.from);
    if (m.type === "integrated.rev") {
      revs += 1;
      last = m;
    }
  }
  const p = last?.payload as { n: number; gate: string; progress?: { acceptance?: { passed: number; total: number } } } | undefined;
  const lastRev = p
    ? `; last revision ${p.n}: gate ${p.gate}${p.progress?.acceptance ? `, acceptance ${p.progress.acceptance.passed}/${p.progress.acceptance.total}` : ""}`
    : "";
  return `${agents.size} agent(s), ${items.size} item(s) proposed, ${revs} integrated revision(s)${lastRev}; ${file.messages.length} board messages.`;
}

/** Insert or replace one run in the index (by id), keeping the rest in order. */
export function upsertIndex(index: ReplayIndex | null, entry: ReplayIndexEntry): ReplayIndex {
  const runs = [...(index?.runs ?? [])];
  const at = runs.findIndex((r) => r.id === entry.id);
  if (at >= 0) runs[at] = entry;
  else runs.push(entry);
  return { format: REPLAY_FORMAT, runs };
}
