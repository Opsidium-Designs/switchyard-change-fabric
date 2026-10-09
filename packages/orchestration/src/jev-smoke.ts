/**
 * jev-smoke: one live call per decision question type (noul, choice, score),
 * plus the contract-triage question exactly as a board run asks it (its
 * question and a delimited, scrubbed state built by the same code), against
 * the configured decision model, reporting pass or fail for each, so
 * an API drift (for example a changed criteria shape) is caught by running one
 * command instead of being discovered as silently skipped decisions. Opt-in
 * (`make jev-smoke`); never part of `make check`.
 */

import { jevErrorReason, type AskJev, type JevAnswer } from "@switchyard-change/model-adapters";

import { buildContractTriageState, CONTRACT_TRIAGE_KEY, CONTRACT_TRIAGE_QUESTIONS } from "./contract-triage.ts";

/** One question type's smoke result. */
export interface JevSmokeResult {
  /** The question type, or "contract-triage" for the triage-shaped choice. */
  readonly type: "noul" | "choice" | "score" | "contract-triage";
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
  // The contract-triage question with a synthetic, triage-shaped state.
  const triageState = buildContractTriageState({
    changeId: "smoke",
    contract: "smoke-contract-1",
    kind: "modify",
    target: "tests/users.test.ts",
    item: "validation",
    goal: "Add input validation to the users module.",
    itemObjective: "validate the users module's inputs",
    proposer: "agent-1",
    rationale: "The existing test asserts that an empty name is accepted; the goal makes it an error, so the expectation must change.",
    failingEvidence: "not ok 3 - accepts an empty name\n# expected 201, got 400",
    targetExcerpt: "test('accepts an empty name', async () => {\n  expect((await post({ name: '' })).status).toBe(201);\n});",
  });
  try {
    const answer = (await ask(triageState, CONTRACT_TRIAGE_QUESTIONS))[CONTRACT_TRIAGE_KEY];
    out.push(
      answer && answer.type === "choice" && (answer.choice === "accept" || answer.choice === "reject")
        ? { type: "contract-triage", ok: true, detail: brief(answer) }
        : { type: "contract-triage", ok: false, detail: "no accept/reject choice in the reply" },
    );
  } catch (error) {
    out.push({ type: "contract-triage", ok: false, detail: jevErrorReason(error) });
  }
  return out;
}
