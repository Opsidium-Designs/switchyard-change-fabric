/**
 * Evidence grades: how much each recorded statement is worth, so a viewer can
 * tell what the engine ran from what an agent merely said.
 *
 *   checked   the engine ran it itself on the exact tree (a gate, a tool's own
 *             gate, a promotion of the gated commit): this is what decides;
 *   decided   a human ruled (a contract, a contest);
 *   recorded  board bookkeeping the engine enforced (a claim, a fix request);
 *   claimed   an agent said so: shown, never counted;
 *   advisory  a model's or a parser's reading (Jev, clash predictions, parsed
 *             test counts): context only, never a verdict.
 *
 * A grade follows the message type and its sender, never its content.
 */
import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

export type EvidenceGrade = "checked" | "decided" | "recorded" | "claimed" | "advisory";

export const GRADE_INFO: Record<EvidenceGrade, { readonly label: string; readonly meaning: string }> = {
  checked: { label: "checked", meaning: "the engine ran it itself on the exact tree; this is what decides" },
  decided: { label: "decided", meaning: "a human ruled on it" },
  recorded: { label: "recorded", meaning: "board bookkeeping the engine enforced" },
  claimed: { label: "claimed", meaning: "an agent said so; shown, never counted" },
  advisory: { label: "advisory", meaning: "a model's or a parser's reading; context only, never a verdict" },
};

const CHECKED = new Set<BoardMessage["type"]>(["integrated.rev", "item.completed", "revision.promoted", "tool.gated", "tool.published", "candidate.gated", "push.regressed", "trunk.moved"]);
const ADVISORY = new Set<BoardMessage["type"]>(["decision.recorded", "decision.resolved", "clash.predicted", "claim.overlap", "review.result"]);
const CLAIMED = new Set<BoardMessage["type"]>(["done.proposed", "help.delivered", "item.struggling"]);

/** The grade of a message, or undefined for one that states nothing worth grading (a join, a request). */
export function gradeOf(message: BoardMessage): EvidenceGrade | undefined {
  if (message.from === "human") return "decided";
  if (CHECKED.has(message.type)) return message.from === "engine" ? "checked" : "claimed";
  if (ADVISORY.has(message.type)) return "advisory";
  if (CLAIMED.has(message.type)) return "claimed";
  if (message.from === "engine") return "recorded";
  return undefined;
}
