/**
 * integration-progress: the integrator's PROGRESS on the board, so a round
 * that spends minutes fetching, merging, installing, and gating is visible
 * instead of silent.
 *
 * A round is recorded as `integration.started {kind, pushes, agents, items,
 * candidates?}` once it has read the pushes it will gate, then as coarse
 * `integration.phase {started, phase, detail?, elapsedMs?}` records (fetch,
 * merge, install, gate, candidate), at most MAX_INTEGRATION_PHASES per round.
 * It ends with what it records (integrated.rev, candidate.gated,
 * push.regressed); a round that records no revision ends with one
 * `integration.phase {phase: "ended"}` saying why, so nothing stays "in
 * progress" that is not.
 *
 * Progress only: each record is an engine fact that changes no board state
 * (see the board's integration.started), so it decides nothing, never gates
 * a verdict, and a refused or failed record is ignored. Nothing is recorded
 * once the attempt is abandoned. A board that refuses the records (one whose
 * clocks count engine records) simply shows no progress.
 */

import type { BoardItem } from "@switchyard-change/change-core";
import type { IntegrationPhase } from "@switchyard-change/verification";

import type { BoardOperatorClient } from "./board-client.ts";

/** Phase records one round may post (its started and ended records aside). */
export const MAX_INTEGRATION_PHASES = 12;
/** The longest phase detail recorded (the board's bound). */
export const MAX_PHASE_DETAIL = 160;

/** A recorded round phase: the integrator's own phases plus a candidate tree and the end of a round that recorded nothing. */
export type RoundPhase = IntegrationPhase | "candidate" | "ended";

/** What a round reads before it gates anything. */
export interface IntegrationRoundStart {
  readonly kind: "integrate" | "leave-one-out" | "speculative";
  /** The units it will gate: each agent and the items its pinned push carries. */
  readonly units: readonly { readonly agent: string; readonly items: readonly BoardItem[] }[];
  /** Speculative: how many prefix candidates the round builds at most. */
  readonly candidates?: number;
}

/** The progress of one integration attempt (one or more rounds, in order). */
export interface IntegrationProgress {
  /** Record a round beginning (awaited: its seq anchors the phases). */
  start(round: IntegrationRoundStart): Promise<void>;
  /** Record a coarse phase change of the open round (queued; bounded; a repeat is dropped). */
  phase(phase: RoundPhase, detail?: string): void;
  /** The open round recorded what it ends with (a revision): no `ended` record follows. */
  closed(): void;
  /** Wait for every queued record (before the round records its revision, so the order holds). */
  flush(): Promise<void>;
  /** The attempt is over: an open round that recorded nothing ends with `ended` (why). */
  end(reason: string): Promise<void>;
}

/** Cut a line to the board's detail bound, on one line. */
export function phaseDetail(text: string, max = MAX_PHASE_DETAIL): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** "agent-1, agent-2 and 3 more", bounded. */
export function agentList(agents: readonly string[], max = 3): string {
  if (agents.length <= max) {
    return agents.join(", ");
  }
  return `${agents.slice(0, max).join(", ")} and ${agents.length - max} more`;
}

/**
 * Progress for one integration attempt, recorded through the operator's
 * engine-record route. `enabled: false` records nothing (a board that would
 * refuse the records).
 */
export function createIntegrationProgress(
  operator: Pick<BoardOperatorClient, "recordEngine">,
  options: {
    readonly enabled: boolean;
    readonly abandoned?: () => boolean;
    /** The clock of `elapsedMs` (default Date.now); null records no elapsed time. */
    readonly now?: (() => number) | null;
    readonly maxPhases?: number;
  },
): IntegrationProgress {
  const now = options.now === undefined ? Date.now : options.now;
  const elapsed = (): { elapsedMs?: number } => (now === null ? {} : { elapsedMs: Math.max(0, Math.round(now() - startedAt)) });
  const maxPhases = options.maxPhases ?? MAX_INTEGRATION_PHASES;
  let chain: Promise<void> = Promise.resolve();
  let started: number | undefined;
  let startedAt = 0;
  let open = false;
  let phases = 0;
  let last = "";
  const live = (): boolean => options.enabled && options.abandoned?.() !== true;
  const record = (payload: Record<string, unknown>): void => {
    chain = chain.then(async () => {
      if (!live()) {
        return;
      }
      await operator.recordEngine("integration.phase", payload).catch(() => undefined);
    });
  };
  return {
    async start(round) {
      await chain;
      open = false;
      started = undefined;
      phases = 0;
      last = "";
      const units = round.units.filter((u) => u.items.some((i) => i.lastPush !== undefined));
      if (!live() || units.length === 0) {
        return;
      }
      const items = units.flatMap((u) => u.items.filter((i) => i.lastPush !== undefined));
      const outcome = await operator
        .recordEngine("integration.started", {
          kind: round.kind,
          pushes: [...new Set(items.map((i) => i.lastPush!.seq))].sort((a, b) => a - b),
          agents: [...new Set(units.map((u) => u.agent))],
          items: [...new Set(items.map((i) => i.id))],
          ...(round.candidates !== undefined ? { candidates: round.candidates } : {}),
        })
        .catch(() => undefined);
      const seq = outcome?.ok ? outcome.appended.find((m) => m.type === "integration.started")?.seq : undefined;
      if (seq !== undefined) {
        started = seq;
        startedAt = now === null ? 0 : now();
        open = true;
      }
    },
    phase(phase, detail) {
      if (!open || started === undefined || phase === "ended") {
        return;
      }
      const text = detail !== undefined && detail.trim() !== "" ? phaseDetail(detail) : undefined;
      const key = `${phase}\0${text ?? ""}`;
      if (key === last || phases >= maxPhases) {
        return;
      }
      last = key;
      phases += 1;
      record({ started, phase, ...(text !== undefined ? { detail: text } : {}), ...elapsed() });
    },
    closed() {
      open = false;
    },
    flush() {
      return chain;
    },
    async end(reason) {
      if (open && started !== undefined) {
        open = false;
        record({ started, phase: "ended", detail: phaseDetail(`nothing recorded: ${reason}`), ...elapsed() });
      }
      await chain;
    },
  };
}
