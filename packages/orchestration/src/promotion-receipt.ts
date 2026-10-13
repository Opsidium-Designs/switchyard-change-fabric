/**
 * promotion-receipt: the text of the git note a board run attaches to the
 * commit it promoted (under `refs/notes/switchyard`), as a pure function of
 * the proof bundle (itself a pure function of the board log). So the receipt
 * states only recorded facts, nothing inferred: the change, the goal, the
 * revision and its gated commit, the gate command and verdict, the parsed test
 * counts (advisory: the gate's exit decides), the items integrated and their
 * agents, the pushes merged, the approved contract changes, the promotion
 * branch, and when the receipt was written.
 *
 * The note has two parts: a short human-readable receipt, then a
 * machine-readable JSON block after a fixed marker line, so a tool can read
 * the facts back without parsing prose.
 */

import type { ProofBundle, ProofCount } from "./proof-bundle.ts";

/** The line that separates the readable receipt from its JSON block. */
export const RECEIPT_JSON_MARKER = "--- switchyard receipt v1 json ---";

/** The longest objective a receipt carries (the full goal stays on the board). */
const OBJECTIVE_CLIP = 280;

/** The machine-readable facts of a promotion receipt. */
export interface PromotionReceiptFacts {
  readonly kind: "switchyard-promotion-receipt";
  readonly version: 1;
  readonly changeId?: string;
  readonly objective?: string;
  /** True when the objective was clipped to fit the receipt. */
  readonly objectiveClipped?: boolean;
  readonly revision: { readonly n: number; readonly gatedCommit: string };
  readonly promoted: { readonly commit: string; readonly branch: string; readonly matchesGated: boolean };
  readonly gate: { readonly command?: readonly string[]; readonly verdict: "pass" | "fail" | "none"; readonly gated: boolean };
  /** Counts parsed from the gate's output: advisory, the gate's exit is the verdict. */
  readonly parsedCounts?: { readonly acceptance?: ProofCount; readonly developer?: ProofCount; readonly executed: number };
  readonly integrated: readonly { readonly item: string; readonly agents: readonly string[]; readonly pushes: number }[];
  readonly pushesMerged: number;
  /** Contract (test or gate-file) changes that were accepted, and by whom. */
  readonly approvedContracts: readonly { readonly contract: string; readonly target: string; readonly kind: string; readonly decidedBy?: string }[];
  /** The proof bundle's status at the time of the receipt, with its reasons. */
  readonly proof: { readonly status: "proven" | "not-proven"; readonly reasons: readonly string[] };
  /** ISO time the receipt was written. */
  readonly at: string;
}

/** A receipt: its readable text and the facts its JSON block carries. */
export interface PromotionReceipt {
  readonly text: string;
  readonly facts: PromotionReceiptFacts;
}

/**
 * Build the receipt for the bundle's recorded promotion. Undefined when the
 * bundle holds no promotion (nothing to write a receipt about).
 */
export function buildPromotionReceipt(bundle: ProofBundle, input: { readonly at: string }): PromotionReceipt | undefined {
  const promotion = bundle.promotion;
  if (promotion === undefined) {
    return undefined;
  }
  const objective = bundle.goal?.objective.replace(/\s+/g, " ").trim();
  const clipped = objective !== undefined && objective.length > OBJECTIVE_CLIP;
  const final = bundle.inventory.final;
  const facts: PromotionReceiptFacts = {
    kind: "switchyard-promotion-receipt",
    version: 1,
    ...(bundle.changeId !== undefined ? { changeId: bundle.changeId } : {}),
    ...(objective !== undefined ? { objective: clipped ? `${objective.slice(0, OBJECTIVE_CLIP - 3)}...` : objective } : {}),
    ...(clipped ? { objectiveClipped: true } : {}),
    revision: { n: promotion.rev, gatedCommit: promotion.gatedCommit },
    promoted: { commit: promotion.commit, branch: promotion.branch, matchesGated: promotion.matchesGated },
    gate: { ...(bundle.gate.command !== undefined ? { command: [...bundle.gate.command] } : {}), verdict: bundle.gate.verdict, gated: bundle.gate.gated },
    ...(final !== undefined
      ? {
          parsedCounts: {
            ...(final.acceptance ? { acceptance: final.acceptance } : {}),
            ...(final.developer ? { developer: final.developer } : {}),
            executed: final.executed,
          },
        }
      : {}),
    integrated: bundle.contributions.items.filter((i) => i.pushes > 0).map((i) => ({ item: i.item, agents: [...i.agents], pushes: i.pushes })),
    pushesMerged: bundle.contributions.pushesMerged,
    approvedContracts: bundle.contracts
      .filter((c) => c.status === "accepted")
      .map((c) => ({ contract: c.contract, target: c.target, kind: c.kind, ...(c.decidedBy !== undefined ? { decidedBy: c.decidedBy } : {}) })),
    proof: { status: bundle.status, reasons: [...bundle.reasons] },
    at: input.at,
  };
  return { text: formatReceipt(facts), facts };
}

const count = (label: string, c: ProofCount): string => `${label} ${c.passed}/${c.total}`;

/** The readable receipt followed by its JSON block. */
function formatReceipt(f: PromotionReceiptFacts): string {
  const lines: string[] = [];
  lines.push(`Switchyard receipt: change ${f.changeId ?? "(unnamed)"}, revision ${f.revision.n}`);
  lines.push("");
  if (f.objective !== undefined) {
    lines.push(`Goal: ${f.objective}`);
  }
  const verdict = !f.gate.gated ? "no gate ran (unverified: nothing was checked)" : f.gate.verdict;
  lines.push(`Gate: ${f.gate.command?.join(" ") ?? "(no command recorded)"} -> ${verdict}`);
  lines.push(`Gated commit: ${f.revision.gatedCommit} (revision ${f.revision.n})`);
  if (f.parsedCounts !== undefined) {
    const parts = [
      ...(f.parsedCounts.acceptance ? [count("acceptance", f.parsedCounts.acceptance)] : []),
      ...(f.parsedCounts.developer ? [count("developer", f.parsedCounts.developer)] : []),
      `${f.parsedCounts.executed} executed`,
    ];
    lines.push(`Test counts (parsed from the gate output, advisory): ${parts.join(", ")}`);
  }
  lines.push(`Integrated (${f.integrated.length} item(s), ${f.pushesMerged} push(es) merged):`);
  for (const i of f.integrated) {
    lines.push(`  - ${i.item} by ${i.agents.join(", ") || "(agent not recorded)"} (${i.pushes} push(es))`);
  }
  if (f.integrated.length === 0) {
    lines.push("  (none recorded)");
  }
  if (f.approvedContracts.length > 0) {
    lines.push("Approved contract changes:");
    for (const c of f.approvedContracts) {
      lines.push(`  - ${c.contract}: ${c.kind} ${c.target}, decided by ${c.decidedBy ?? "(not recorded)"}`);
    }
  }
  lines.push(`Promoted to: ${f.promoted.branch} (${f.promoted.matchesGated ? "the gated tree" : "NOT the gated tree"})`);
  lines.push(`Proof: ${f.proof.status}${f.proof.reasons.length > 0 ? ` (${f.proof.reasons.join("; ")})` : ""}`);
  lines.push(`Written: ${f.at}`);
  lines.push("");
  lines.push(RECEIPT_JSON_MARKER);
  lines.push(JSON.stringify(f, null, 2));
  return `${lines.join("\n")}\n`;
}

/** Read the facts back out of a receipt note (undefined when it has no JSON block). */
export function parsePromotionReceipt(note: string): PromotionReceiptFacts | undefined {
  const at = note.indexOf(RECEIPT_JSON_MARKER);
  if (at < 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(note.slice(at + RECEIPT_JSON_MARKER.length)) as PromotionReceiptFacts;
    return parsed.kind === "switchyard-promotion-receipt" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
