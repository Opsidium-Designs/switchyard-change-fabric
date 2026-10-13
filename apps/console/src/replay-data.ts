/**
 * Data for the static REPLAY page: recorded board runs, exported from a Worker
 * (apps/console/scripts/export-replay.ts) into `public/replays/`, and played
 * back in the browser with the same fold the live console uses
 * (`buildBoardGraph(log, k)`). No Worker, no launcher, no credentials, no model
 * calls: every fetch here is a static JSON file next to the page, addressed
 * RELATIVE to the page so the build works from a subpath or the root.
 *
 * Pure apart from the injected fetch, so it is tested offline.
 */

import { reduceBoard } from "@switchyard-change/orchestration/board-graph";
import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

import { isPreviewUrl } from "./previews.ts";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const REPLAY_FORMAT = "switchyard-replay/v1";

export type ReplayOutcome = "verified" | "unverified" | "failed" | "unknown";

export interface ReplayIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly app: string;
  readonly outcome: ReplayOutcome;
  readonly description: string;
  readonly messages?: number;
  /** A simulated run: the real engine offline with scripted agents (see SIMULATED_CHIP). */
  readonly simulated?: boolean;
  /** The app to try: the original and (for a passing run) the fixed code (see readShowcaseApps). */
  readonly apps?: ShowcaseApps;
}

// ---------------------------------------------------------------------------
// "Try the app": the original and the run-fixed code, live
// ---------------------------------------------------------------------------

/** The original (broken) app, as the repo holds it. */
export interface ShowcaseBefore {
  readonly url: string;
  /** The repo commit the original was uploaded from, or "original". */
  readonly commit: string;
}

/** The app as this run fixed it: the exact promoted commit of its passing revision. */
export interface ShowcaseAfter {
  readonly url: string;
  readonly commit: string;
  /** The run this fixed code belongs to (always the entry's own id). */
  readonly run: string;
  /** The passing revision's number, when recorded. */
  readonly rev?: number;
}

export interface ShowcaseApps {
  readonly before?: ShowcaseBefore;
  readonly after?: ShowcaseAfter;
}

const COMMIT_ID = /^[0-9a-f]{7,64}$/i;

/**
 * The well-formed `apps` of an index entry, or undefined. Each link must be an
 * https workers.dev URL with no credentials (the same rule as revision
 * previews); `after` must name this run and a commit id, so a fixed link is
 * never shown on a run it does not belong to. A malformed half is dropped.
 */
export function readShowcaseApps(raw: unknown, runId: string): ShowcaseApps | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as { before?: unknown; after?: unknown };
  const b = r.before as { url?: unknown; commit?: unknown } | null | undefined;
  const before =
    b !== null && typeof b === "object" && isPreviewUrl(b.url) && typeof b.commit === "string" && (b.commit === "original" || COMMIT_ID.test(b.commit))
      ? { url: b.url, commit: b.commit }
      : undefined;
  const a = r.after as { url?: unknown; commit?: unknown; run?: unknown; rev?: unknown } | null | undefined;
  const after =
    a !== null && typeof a === "object" && isPreviewUrl(a.url) && typeof a.commit === "string" && COMMIT_ID.test(a.commit) && a.run === runId
      ? { url: a.url, commit: a.commit, run: runId, ...(typeof a.rev === "number" && Number.isInteger(a.rev) && a.rev > 0 ? { rev: a.rev } : {}) }
      : undefined;
  if (before === undefined && after === undefined) return undefined;
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/** What to try on each example app's home page (from the app's README), and where to land. */
export const SHOWCASE_HINTS: Readonly<Record<string, { readonly text: string; readonly hash?: string }>> = {
  storefront: {
    text: "Each link opens the store with its health checks running: about 1 of 16 pass on the original and 16 of 16 after a correct fix. Also try an overpayment or an over-refund in the payments panel.",
    hash: "#run-checks",
  },
  "service-api": {
    text: "Press Run all checks on the home page: 6 of 18 checks are secure on the original and 18 of 18 after a correct fix.",
  },
  cityhall: {
    text: "The home page runs 46 checks on load: about 1 of 46 pass on the original and 46 of 46 after a correct fix.",
  },
};

/** The note every showcase carries: what the original is, and that no real data is held. */
export const SHOWCASE_NOTE =
  "The original is deliberately broken (for example no auth on writes, wrong money math), but it holds only demo data, in memory per isolate.";

/** A showcase link with the app's landing hash (the stored URL is already validated). */
export function showcaseHref(url: string, app: string): string {
  const hash = SHOWCASE_HINTS[app]?.hash;
  return hash !== undefined ? `${url.replace(/#.*$/, "")}${hash}` : url;
}

/** The label a simulated run carries everywhere a viewer sees it. */
export const SIMULATED_CHIP = "SIMULATED: real board engine, scripted agents, fixture gate";

/** What a simulated run is and is not, in one line. */
export const SIMULATED_EXPLAIN =
  "The board, claims, contracts, integration, gate step, and promotion ran in the real engine (offline), but no model took part: every agent turn and edit was scripted, and the gate was the offline fixture check (it fails the first revision and passes once that file is edited again), not the app's own tests. Durations are the offline clock (one second per board message). It shows coordination at scale, not agents fixing code.";

/** The recorded integration verdict (the final, authoritative one), as the snapshot holds it. */
export interface RecordedIntegration {
  readonly verdict?: string;
  readonly integratedUnits?: readonly string[];
  readonly excludedUnits?: readonly string[];
  readonly gated?: boolean;
  readonly at?: string;
}

export interface ReplaySnapshot {
  readonly objective?: string;
  readonly status?: string;
  readonly integration?: RecordedIntegration | null;
  readonly planningFailure?: { readonly reason: string } | null;
  readonly escalations?: readonly unknown[];
}

export interface ReplayRun {
  readonly changeId: string;
  /** True when the file says it is simulated (scripted agents on the real engine). */
  readonly simulated?: boolean;
  readonly messages: readonly BoardMessage[];
  readonly snapshot: ReplaySnapshot | null;
}

/** A replay path relative to the page (never root-absolute, so a subpath deploy works). */
export function replayPath(file: string): string {
  return `replays/${encodeURIComponent(file)}`;
}

/** Load the run list (`replays/index.json`). */
export async function loadReplayIndex(fetchFn: FetchFn): Promise<ReplayIndexEntry[]> {
  const res = await fetchFn(replayPath("index.json"));
  if (!res.ok) throw new Error(`could not load the replay index (${res.status})`);
  const body = (await res.json()) as { runs?: unknown };
  if (!Array.isArray(body.runs)) throw new Error("the replay index has no runs");
  return body.runs
    .filter(
      (r): r is ReplayIndexEntry =>
        r !== null && typeof r === "object" && typeof (r as ReplayIndexEntry).id === "string" && typeof (r as ReplayIndexEntry).title === "string",
    )
    .map((r) => {
      // Only well-formed app links are kept (see readShowcaseApps).
      const { apps: raw, ...rest } = r as ReplayIndexEntry & { apps?: unknown };
      const apps = readShowcaseApps(raw, r.id);
      return apps !== undefined ? { ...rest, apps } : rest;
    });
}

/** The prefix of the error a recorded run that the board reducer refuses fails with. */
export const REPLAY_INVALID = "failed validation";

/**
 * Load one recorded run (`replays/<id>.json`) and check it is a whole board
 * log (seq 1, 2, 3, ... with no gap) that the board's own reducer accepts
 * (`reduceBoard`: every agent post legal, every engine message one arbitration
 * would derive), so the fold replays exactly what a real board recorded. A
 * file the reducer refuses is never rendered.
 */
export async function loadReplay(fetchFn: FetchFn, id: string): Promise<ReplayRun> {
  const res = await fetchFn(replayPath(`${id}.json`));
  if (!res.ok) throw new Error(`could not load the recorded run ${id} (${res.status})`);
  const body = (await res.json()) as { format?: unknown; changeId?: unknown; simulated?: unknown; messages?: unknown; snapshot?: unknown };
  if (body.format !== REPLAY_FORMAT) throw new Error(`${id} is not a ${REPLAY_FORMAT} file`);
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error(`${id} has no board messages`);
  const messages = body.messages as BoardMessage[];
  messages.forEach((m, i) => {
    if (m.seq !== i + 1) throw new Error(`${id}: the board log is not contiguous at seq ${m.seq}`);
  });
  try {
    reduceBoard(messages);
  } catch (err) {
    throw new Error(
      `${id} ${REPLAY_INVALID}: the board reducer refused it (${err instanceof Error ? err.message : String(err)}). It is not shown, because every message on this page must be one a real board accepted.`,
    );
  }
  return {
    changeId: typeof body.changeId === "string" ? body.changeId : id,
    ...(body.simulated === true ? { simulated: true } : {}),
    messages,
    snapshot: body.snapshot !== null && typeof body.snapshot === "object" ? (body.snapshot as ReplaySnapshot) : null,
  };
}

// ---------------------------------------------------------------------------
// Deep links: ?run=<id>&seq=<n>
// ---------------------------------------------------------------------------

export interface ReplayParams {
  readonly run: string | null;
  readonly seq: number | null;
  /** The right pane tab to open (`tab=tools`, for example). */
  readonly tab: "thread" | "node" | "tools" | null;
}

export function parseReplayParams(search: string): ReplayParams {
  const params = new URLSearchParams(search);
  const run = params.get("run");
  const seqText = params.get("seq");
  const seq = seqText !== null && /^\d+$/.test(seqText) ? Number(seqText) : null;
  const tab = params.get("tab");
  return { run: run !== null && run.length > 0 ? run : null, seq, tab: tab === "thread" || tab === "node" || tab === "tools" ? tab : null };
}

/** The query string for a run at a seq (null seq: the end of the run). */
export function replaySearch(run: string | null, seq: number | null): string {
  const params = new URLSearchParams();
  if (run !== null) params.set("run", run);
  if (run !== null && seq !== null) params.set("seq", String(seq));
  const text = params.toString();
  return text.length > 0 ? `?${text}` : "";
}

// ---------------------------------------------------------------------------
// The final verdict, exactly as recorded
// ---------------------------------------------------------------------------

interface RevPayload {
  readonly n: number;
  readonly gate: "pass" | "fail";
  readonly gated?: false;
  readonly progress?: {
    readonly acceptance?: { readonly passed: number; readonly total: number };
    readonly acceptanceNotRun?: string;
    readonly passed?: number;
    readonly total?: number;
  };
}

function revsOf(log: readonly BoardMessage[]): RevPayload[] {
  return log.filter((m) => m.type === "integrated.rev").map((m) => m.payload as unknown as RevPayload);
}

function acceptanceText(rev: RevPayload): string {
  const p = rev.progress;
  if (p?.acceptance) return `acceptance ${p.acceptance.passed}/${p.acceptance.total}`;
  if (p?.acceptanceNotRun) return `acceptance did not run: ${p.acceptanceNotRun}`;
  if (p?.passed !== undefined && p.total !== undefined && p.total > 0) return `${p.passed}/${p.total} tests`;
  return "";
}

export interface FinalVerdict {
  readonly kind: "verified" | "unverified" | "failed" | "none";
  /** The verdict word as recorded (upper case for the banner). */
  readonly headline: string;
  readonly detail: string;
  readonly at?: string;
}

/**
 * The run's final verdict: the recorded integration verdict (the gate on the
 * integrated tree decides the goal), explained with the recorded revisions.
 * Never inferred: no recorded verdict reads "no verdict recorded".
 */
export function finalVerdict(run: ReplayRun): FinalVerdict {
  const integration = run.snapshot?.integration ?? null;
  const revs = revsOf(run.messages);
  const last = revs.at(-1);
  const passing = [...revs].reverse().find((r) => r.gate === "pass" && r.gated !== false);
  const best = revs.reduce<RevPayload | undefined>((b, r) => {
    const a = r.progress?.acceptance;
    if (!a) return b;
    const ba = b?.progress?.acceptance;
    return !ba || a.passed > ba.passed ? r : b;
  }, undefined);
  const at = integration?.at;
  const atField = at !== undefined ? { at } : {};
  if (run.snapshot?.planningFailure) {
    return { kind: "failed", headline: "FAILED", detail: `planning failed: ${run.snapshot.planningFailure.reason}`, ...atField };
  }
  const verdict = integration?.verdict;
  if (verdict === "verified" && integration?.gated !== false) {
    const units = integration?.integratedUnits?.length;
    const rev = passing ?? last;
    // Promotion only when the board recorded it (revision.promoted): never inferred.
    const promoted = run.messages.filter((m) => m.type === "revision.promoted").at(-1);
    const promotedText =
      promoted && promoted.type === "revision.promoted" ? `; promoted to ${promoted.payload.branch} (${promoted.payload.commit.slice(0, 10)}, the gated tree of revision ${promoted.payload.rev})` : "";
    return {
      kind: "verified",
      headline: promotedText !== "" ? "VERIFIED AND PROMOTED" : "VERIFIED",
      detail: `${rev ? `The gate passed on revision ${rev.n}${acceptanceText(rev) ? ` (${acceptanceText(rev)})` : ""}` : "The gate passed"}${
        units !== undefined ? `; ${units} item(s) integrated` : ""
      }${promotedText}.`,
      ...atField,
    };
  }
  if (verdict === "verified" || verdict === "unverified") {
    return { kind: "unverified", headline: "UNVERIFIED", detail: "No gate ran: the result was not checked.", ...atField };
  }
  if (verdict === "failed") {
    const parts = [
      passing ? `revision ${passing.n} passed the gate, but the recorded verdict is failed` : "No revision passed the gate",
      last ? `the last, revision ${last.n}, failed${acceptanceText(last) ? ` (${acceptanceText(last)})` : ""}` : "no revision was integrated",
    ];
    if (best && best !== last) parts.push(`the best was revision ${best.n} (${acceptanceText(best)})`);
    return { kind: "failed", headline: "FAILED", detail: `${parts.join("; ")}. Nothing was promoted.`, ...atField };
  }
  return { kind: "none", headline: "NO VERDICT RECORDED", detail: "This export holds no final integration verdict." };
}

// ---------------------------------------------------------------------------
// Key moments (jump targets)
// ---------------------------------------------------------------------------

export type MomentKind = "claim" | "contest" | "contract" | "help" | "tool" | "gate-pass" | "gate-fail" | "done" | "trouble";

export interface KeyMoment {
  readonly seq: number;
  readonly kind: MomentKind;
  readonly label: string;
}

export const MOMENT_GROUPS: readonly { readonly kind: MomentKind; readonly title: string }[] = [
  { kind: "gate-pass", title: "Gate passed" },
  { kind: "gate-fail", title: "Gate failed" },
  { kind: "claim", title: "Claims" },
  { kind: "contest", title: "Contests" },
  { kind: "contract", title: "Contracts (seams)" },
  { kind: "help", title: "Help and handoffs" },
  { kind: "tool", title: "Tools" },
  { kind: "done", title: "Items completed" },
  { kind: "trouble", title: "Fix budget spent, stalls, lapses, re-plans, caps" },
];

function field(m: BoardMessage, key: string): string {
  const v = (m.payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** The moments worth jumping to, in seq order. Every one is a recorded message. */
export function keyMoments(log: readonly BoardMessage[]): KeyMoment[] {
  const out: KeyMoment[] = [];
  for (const m of log) {
    const push = (kind: MomentKind, label: string) => out.push({ seq: m.seq, kind, label });
    switch (m.type) {
      case "claim.granted":
        push("claim", `${field(m, "agent")} claims ${field(m, "item")}`);
        break;
      case "claim.contested":
      case "claim.escalated":
      case "claim.resolved":
        push("contest", `${m.type.replace("claim.", "contest ")} ${field(m, "contest")}`);
        break;
      case "contract.proposed":
        push("contract", `${m.from} proposes a contract change to ${field(m, "target")}`);
        break;
      case "contract.escalated":
        push("contract", `contract ${field(m, "contract")} goes to a human`);
        break;
      case "contract.accepted":
      case "contract.rejected":
        push("contract", `${m.from} ${m.type === "contract.accepted" ? "accepts" : "rejects"} ${field(m, "contract")}`);
        break;
      case "help.requested":
        push("help", `${m.from} asks for help on ${field(m, "item")}`);
        break;
      case "help.volunteered":
      case "help.offered":
        push("help", `${m.from} volunteers${field(m, "item") ? ` on ${field(m, "item")}` : ""}`);
        break;
      case "handoff":
        push("help", `${m.from} hands ${field(m, "item")} to ${field(m, "to")}`);
        break;
      case "tool.published":
        push("tool", `tool ${field(m, "capability")} published (passed its own gate)`);
        break;
      case "integrated.rev": {
        const rev = m.payload as unknown as RevPayload;
        const acc = acceptanceText(rev);
        if (rev.gate === "pass" && rev.gated !== false) push("gate-pass", `revision ${rev.n}: gate PASS${acc ? `, ${acc}` : ""}`);
        else if (rev.gate === "pass") push("gate-fail", `revision ${rev.n}: no gate ran (nothing checked)`);
        else push("gate-fail", `revision ${rev.n}: gate FAIL${acc ? `, ${acc}` : ""}`);
        break;
      }
      case "item.completed":
        push("done", `${field(m, "item")} completed${field(m, "closedBy") === "engine" ? " (closed by the engine: its push passed, the owner did not propose done)" : ""}`);
        break;
      case "revision.promoted":
        push("gate-pass", `revision ${field(m, "rev")} promoted to ${field(m, "branch")}`);
        break;
      case "run.capped":
        push("trouble", `${field(m, "kind")} cap reached`);
        break;
      case "fix.exhausted":
        push("trouble", `${field(m, "item")}: fix budget spent`);
        break;
      case "seam.stalled":
        push("trouble", `seam ${field(m, "item")} stalled`);
        break;
      case "item.replanned":
        push("trouble", `lead re-planned ${field(m, "item")} (${field(m, "action")})`);
        break;
      case "item.escalated":
        push("trouble", `${field(m, "item")} failed again after a re-plan: a human decides`);
        break;
      case "claim.lapsed":
        push("trouble", `${field(m, "agent")}'s claim on ${field(m, "item")} lapsed (${field(m, "reason")})`);
        break;
      default:
        break;
    }
  }
  return out;
}
