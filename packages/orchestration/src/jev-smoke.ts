/**
 * jev-smoke: one live call per decision question type (noul, choice, score)
 * against the configured decision model, reporting pass or fail for each, so
 * an API drift (for example a changed criteria shape) is caught by running one
 * command instead of being discovered as silently skipped decisions. Opt-in
 * (`make jev-smoke`); never part of `make check`.
 */

import { jevErrorReason, type AskJev, type JevAnswer } from "@switchyard-change/model-adapters";

/** One question type's smoke result. */
export interface JevSmokeResult {
  readonly type: "noul" | "choice" | "score";
  readonly ok: boolean;
  /** The answer in brief, or the failure reason (credential-free). */
  readonly detail: string;
}

function brief(answer: JevAnswer): string {
  const value = answer.type === "noul" ? answer.noul : answer.type === "choice" ? answer.choice : String(answer.score);
  return `${answer.type} ${value} (confidence ${answer.confidence.toFixed(2)})`;
}

/** Ask each question type once and report whether a well-formed answer came back. */
export async function runJevSmoke(ask: AskJev): Promise<readonly JevSmokeResult[]> {
  const state = "A smoke test of the decision model. The change adds input validation to a users module; its gate passes.";
  const cases: { type: JevSmokeResult["type"]; question: Parameters<AskJev>[1][string] }[] = [
    { type: "noul", question: { type: "noul", instructions: "Does the change satisfy its goal?" } },
    {
      type: "choice",
      question: {
        type: "choice",
        instructions: "Which module did the change touch?",
        criteria: ["users", "orders"],
        descriptions: { users: "the users module", orders: "the orders module" },
      },
    },
    { type: "score", question: { type: "score", instructions: "How complete is the change?", criteria: ["completeness", "correctness"] } },
  ];
  const out: JevSmokeResult[] = [];
  for (const c of cases) {
    try {
      const answer = (await ask(state, { smoke: c.question }))["smoke"];
      out.push(
        answer && answer.type === c.type
          ? { type: c.type, ok: true, detail: brief(answer) }
          : { type: c.type, ok: false, detail: `no ${c.type} answer in the reply` },
      );
    } catch (error) {
      out.push({ type: c.type, ok: false, detail: jevErrorReason(error) });
    }
  }
  return out;
}
