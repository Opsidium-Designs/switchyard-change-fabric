/** The opt-in decision-model smoke check reports each question type's pass or fail (offline, faked transport). */
import { describe, expect, it } from "vitest";

import type { AskJev, JevAnswer } from "@switchyard-change/model-adapters";

import { runJevSmoke } from "../src/jev-smoke.ts";

describe("runJevSmoke", () => {
  it("passes well-formed answers and reports a failed call or a wrong-shaped reply as FAIL with its reason", async () => {
    const asked: string[] = [];
    const ask: AskJev = async (_state, questions): Promise<Record<string, JevAnswer>> => {
      if (questions["triage"]) {
        asked.push("triage");
        expect(_state).toContain("<<<UNTRUSTED DATA: the proposing agent's rationale");
        return { triage: { type: "choice", choice: "accept", confidence: 0.8 } };
      }
      const q = questions["smoke"]!;
      asked.push(q.type);
      if (q.type === "noul") {
        return { smoke: { type: "noul", noul: "yes", confidence: 0.9 } };
      }
      if (q.type === "choice") {
        throw new Error("AI Gateway decision call failed for typesafe/jev (HTTP 400): Invalid value at questions.smoke.criteria: expected record, received array");
      }
      return { smoke: { type: "noul", noul: "no", confidence: 1 } };
    };
    const results = await runJevSmoke(ask);
    expect(asked).toEqual(["noul", "choice", "score", "triage"]);
    expect(results).toEqual([
      { type: "noul", ok: true, detail: "noul yes (confidence 0.90)" },
      { type: "choice", ok: false, detail: "AI Gateway decision call failed for typesafe/jev (HTTP 400): Invalid value at questions.smoke.criteria: expected record, received array" },
      { type: "score", ok: false, detail: "no score answer in the reply" },
      { type: "contract-triage", ok: true, detail: "choice accept (confidence 0.80)" },
    ]);
  });
});
