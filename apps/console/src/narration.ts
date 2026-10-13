/**
 * The story layer of mission control: one plain sentence for each board
 * message, and the run split into chapters (plan, build, one chapter per
 * integrated revision, promotion).
 *
 * Everything here is read from the recorded log and nothing else. A sentence
 * names only what its message (or a message it cites) says; a cause is cited
 * only when the log links the two messages (a reply, a revision number, a
 * contract id, a request id, a commit); a message with no recorded cause
 * cites none, and the line says so rather than guessing. A chapter's result is
 * shown only once the replay has reached it.
 */
import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

export interface Narration {
  readonly seq: number;
  readonly type: BoardMessage["type"];
  readonly text: string;
  /** Seqs of the earlier messages the log links this one to (its recorded causes). */
  readonly causes: readonly number[];
}

type Payload = Record<string, unknown>;

function str(p: Payload, key: string): string {
  const v = p[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function list(p: Payload, key: string): readonly string[] {
  const v = p[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function files(paths: readonly string[]): string {
  if (paths.length === 0) return "no files";
  if (paths.length === 1) return paths[0]!;
  return `${paths.length} files`;
}

/** The acceptance count a revision recorded (advisory, parsed from the gate's output), as "103/129". */
export function revAcceptance(payload: Payload): string | undefined {
  const progress = payload.progress as { acceptance?: { passed: number; total: number }; passed?: number; total?: number } | undefined;
  if (progress?.acceptance) return `${progress.acceptance.passed}/${progress.acceptance.total}`;
  if (progress?.passed !== undefined && progress.total !== undefined && progress.total > 0) return `${progress.passed}/${progress.total}`;
  return undefined;
}

/** "pass", "fail", or "no-gate" for an integrated.rev payload. */
export function revOutcome(payload: Payload): "pass" | "fail" | "no-gate" {
  if (payload.gated === false) return "no-gate";
  return payload.gate === "pass" ? "pass" : "fail";
}

const STRUGGLE_REASON: Record<string, string> = {
  "failing-revision": "its change keeps failing the gate",
  "failed-edits": "its edits keep failing to apply",
  "turn-budget": "it has used most of its turns",
};

/**
 * Index the log once for cause lookups: the latest message before a seq that
 * matches a predicate.
 */
class LogIndex {
  constructor(private readonly log: readonly BoardMessage[]) {}

  latestBefore(seq: number, match: (m: BoardMessage, p: Payload) => boolean): BoardMessage | undefined {
    for (let i = this.log.length - 1; i >= 0; i -= 1) {
      const m = this.log[i]!;
      if (m.seq >= seq) continue;
      if (match(m, m.payload as Payload)) return m;
    }
    return undefined;
  }

  all(before: number, match: (m: BoardMessage, p: Payload) => boolean): BoardMessage[] {
    return this.log.filter((m) => m.seq < before && match(m, m.payload as Payload));
  }
}

function revSeq(index: LogIndex, before: number, n: string): number | undefined {
  return index.latestBefore(before, (m, p) => m.type === "integrated.rev" && str(p, "n") === n)?.seq;
}

/**
 * The sentence for one message, with its recorded causes. `fallback` renders a
 * message type this module has no sentence for (the typed one-line summary).
 */
export function narrateMessage(message: BoardMessage, log: readonly BoardMessage[], fallback: (m: BoardMessage) => string): Narration {
  const index = new LogIndex(log);
  const p = message.payload as Payload;
  const from = message.from;
  const causes: number[] = [];
  const cite = (seq: number | undefined) => {
    if (seq !== undefined && seq < message.seq && !causes.includes(seq)) causes.push(seq);
  };
  if (message.inReplyTo !== undefined) cite(message.inReplyTo);
  const item = str(p, "item");
  let text: string;
  switch (message.type) {
    case "goal.posted":
      text = "A human posts the goal. The lead will break it into work items.";
      break;
    case "agent.joined":
      text = str(p, "role") === "lead" ? "The lead joins and starts planning." : `${from} joins the board, ready to claim work.`;
      break;
    case "agent.left":
      text = `${from} leaves the board.`;
      break;
    case "item.proposed":
    case "item.discovered":
      text = `${from === "lead" ? "The lead" : from} proposes the item "${item}": ${clip(str(p, "objective"), 110)}`;
      break;
    case "item.claimed": {
      const intent = (p.intent ?? {}) as Payload;
      text = `${from} asks to work on ${item}, writing ${files(list(intent, "write"))}.`;
      break;
    }
    case "claim.granted":
      cite(index.latestBefore(message.seq, (m, q) => m.type === "item.claimed" && str(q, "item") === item)?.seq);
      text = `The board gives ${item} to ${str(p, "agent")}. No other agent may write its files now.`;
      break;
    case "push.announced": {
      cite(index.latestBefore(message.seq, (m, q) => m.type === "claim.granted" && str(q, "item") === item)?.seq);
      cite(index.latestBefore(message.seq, (m, q) => m.type === "fix.requested" && str(q, "item") === item)?.seq);
      text = `${from} pushes a change for ${item} (${files(list(p, "paths"))}). It waits for the next revision.`;
      break;
    }
    case "integrated.rev": {
      const merged = list(p, "merged");
      for (const commit of merged) {
        cite(index.latestBefore(message.seq, (m, q) => (m.type === "push.announced" || m.type === "help.delivered") && str(q, "commit") === commit)?.seq);
      }
      const outcome = revOutcome(p);
      const acc = revAcceptance(p);
      const pushes = `${merged.length} push${merged.length === 1 ? "" : "es"}`;
      if (outcome === "no-gate") {
        text = `Revision ${str(p, "n")} merges ${pushes}. No gate ran, so nothing was checked.`;
      } else if (outcome === "pass") {
        text = `Revision ${str(p, "n")} merges ${pushes} and the gate passes${acc ? ` (acceptance ${acc})` : ""}.`;
      } else {
        const failing = (p.failing ?? {}) as Payload;
        const first = str(failing, "output").split("\n").find((l) => l.trim() !== "") ?? "";
        text = `Revision ${str(p, "n")} merges ${pushes} and the gate fails${acc ? ` (acceptance ${acc})` : ""}.${first ? ` First failure: ${clip(first, 90)}` : ""}`;
      }
      break;
    }
    case "fix.requested":
      cite(revSeq(index, message.seq, str(p, "n")));
      text = `The failure in revision ${str(p, "n")} is blamed on ${item}; its owner is asked to fix it (attempt ${str(p, "attempt")}).`;
      break;
    case "fix.exhausted":
      cite(revSeq(index, message.seq, str(p, "n")));
      text = `${item} has used its whole fix budget (${str(p, "attempts")} attempt(s)).`;
      break;
    case "item.struggling": {
      cite(index.latestBefore(message.seq, (m, q) => m.type === "fix.requested" && str(q, "item") === item)?.seq);
      const reason = STRUGGLE_REASON[str(p, "reason")] ?? str(p, "reason");
      text = `${from} reports ${item} is going badly: ${reason}. Idle agents may offer help.`;
      break;
    }
    case "done.proposed": {
      const commit = str(p, "commit");
      if (commit) cite(index.latestBefore(message.seq, (m, q) => m.type === "push.announced" && str(q, "commit") === commit)?.seq);
      text = `${from} says ${item} is done. It counts only once a passing revision includes it.`;
      break;
    }
    case "item.completed":
      if (str(p, "via") === "tool") {
        text = `${item} is done: its tool passed its own gate and was published.`;
      } else {
        cite(revSeq(index, message.seq, str(p, "n")));
        text = `${item} is done: revision ${str(p, "n")} passed with its change in it.`;
      }
      break;
    case "contract.proposed":
      text = `${from} asks to ${str(p, "kind")} the protected file ${str(p, "target")}. A protected file changes only with a human's approval.`;
      break;
    case "contract.escalated":
    case "contract.accepted":
    case "contract.rejected": {
      const contract = str(p, "contract");
      const proposal = index.latestBefore(message.seq, (m, q) => m.type === "contract.proposed" && str(q, "contract") === contract);
      cite(proposal?.seq);
      const target = proposal ? str(proposal.payload as Payload, "target") : contract;
      text =
        message.type === "contract.escalated"
          ? `The request to change ${target} goes to a human to decide.`
          : message.type === "contract.accepted"
            ? `${from === "human" ? "A human" : from} approves the change to ${target}; its item may now write it.`
            : `${from === "human" ? "A human" : from} rejects the change to ${target}; it stays as it is.`;
      break;
    }
    case "help.requested":
      text = `${from} asks for help on ${item}.`;
      break;
    case "help.offered": {
      const request = str(p, "request");
      const asked = index.latestBefore(message.seq, (m, q) => m.type === "help.requested" && str(q, "request") === request);
      cite(asked?.seq);
      text = `${from} offers help${asked ? ` to ${asked.from} on ${str(asked.payload as Payload, "item")}` : ""}.`;
      break;
    }
    case "rebase.needed":
      cite(revSeq(index, message.seq, str(p, "n")));
      text = `${str(p, "agent")} must rebase onto revision ${str(p, "n")} before pushing again.`;
      break;
    case "revision.promoted":
      cite(revSeq(index, message.seq, str(p, "rev")));
      text = `Revision ${str(p, "rev")} is promoted to ${str(p, "branch")}: the exact tree the gate passed.`;
      break;
    case "push.regressed":
      text = `${item}'s push made revision ${str(p, "rev")} worse, so it is held back until ${str(p, "agent")} pushes again.`;
      break;
    case "decision.recorded":
      text = `Advisory model (Jev) on ${str(p, "juncture")}: ${p.error !== undefined ? "the call failed" : str(p, "answer") || "no answer"}. Advice only; it cannot change a verdict.`;
      break;
    default:
      text = `${from}: ${fallback(message)}`;
  }
  return { seq: message.seq, type: message.type, text: text.charAt(0).toUpperCase() + text.slice(1), causes };
}

/** The narration for the message at seq K (the last message at or before K), or null before the first. */
export function narrateAt(log: readonly BoardMessage[], k: number, fallback: (m: BoardMessage) => string): Narration | null {
  let at: BoardMessage | undefined;
  for (const m of log) {
    if (m.seq > k) break;
    at = m;
  }
  return at ? narrateMessage(at, log, fallback) : null;
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

export type ChapterKind = "plan" | "build" | "fix" | "promote" | "after";

export interface Chapter {
  readonly kind: ChapterKind;
  readonly title: string;
  readonly startSeq: number;
  readonly endSeq: number;
  /** The revision that closes this chapter (build and fix chapters). */
  readonly rev?: { readonly n: number; readonly seq: number; readonly outcome: "pass" | "fail" | "no-gate"; readonly acceptance?: string };
  /** Wall-clock length from the recorded timestamps, in milliseconds, when both ends have one. */
  readonly durationMs?: number;
}

function elapsed(log: readonly BoardMessage[], startSeq: number, endSeq: number): number | undefined {
  const start = log.find((m) => m.seq === startSeq)?.at;
  const end = log.find((m) => m.seq === endSeq)?.at;
  if (!start || !end) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * The run as chapters, from the FULL log (so the strip does not move while
 * scrubbing): planning until the first claim, then one chapter per integrated
 * revision (the work that led to it, ending at its gate), then promotion or
 * whatever followed the last revision.
 */
export function chapters(log: readonly BoardMessage[]): Chapter[] {
  if (log.length === 0) return [];
  const first = log[0]!.seq;
  const last = log[log.length - 1]!.seq;
  const out: Chapter[] = [];
  const add = (c: Omit<Chapter, "durationMs">) => {
    if (c.endSeq < c.startSeq) return;
    const durationMs = elapsed(log, c.startSeq, c.endSeq);
    out.push(durationMs !== undefined ? { ...c, durationMs } : c);
  };
  const firstClaim = log.find((m) => m.type === "item.claimed" || m.type === "claim.granted")?.seq;
  const revs = log.filter((m) => m.type === "integrated.rev");
  const planEnd = firstClaim !== undefined ? firstClaim - 1 : revs.length > 0 ? revs[0]!.seq - 1 : last;
  add({ kind: "plan", title: "Plan", startSeq: first, endSeq: planEnd });
  let cursor = planEnd + 1;
  revs.forEach((m, i) => {
    const p = m.payload as Payload;
    const acceptance = revAcceptance(p);
    const n = Number(str(p, "n"));
    add({
      kind: i === 0 ? "build" : "fix",
      title: i === 0 ? "Build" : `Fix round ${i}`,
      startSeq: Math.min(cursor, m.seq),
      endSeq: m.seq,
      rev: { n, seq: m.seq, outcome: revOutcome(p), ...(acceptance !== undefined ? { acceptance } : {}) },
    });
    cursor = m.seq + 1;
  });
  if (cursor <= last) {
    const promoted = log.some((m) => m.seq >= cursor && m.type === "revision.promoted");
    add({ kind: promoted ? "promote" : "after", title: promoted ? "Promote" : revs.length > 0 ? "After the last revision" : "Work", startSeq: cursor, endSeq: last });
  }
  return out;
}

/** "42 s", "12 min", "1 h 05 min". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}
