/**
 * Speculative batch gating on the offline demo board run (no network,
 * deterministic):
 *   - with speculation off (K = 1) the recorded board log is byte-for-byte
 *     the log the run recorded before speculation existed (a golden fixture
 *     captured from that code);
 *   - with the default K the run still verifies, and its proof bundle names
 *     the speculative round that landed the final revision: the landed
 *     candidate's commit IS the revision's gated commit IS the promoted one.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { formatProofSummary } from "../src/proof-bundle.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

/** The demo-board run of the audit-logging goal, as `make demo-board` runs it. */
async function demo(speculate?: number) {
  const goal = (await readFile(join(REPO_ROOT, "examples", "goals", "audit-logging.goal.txt"), "utf8")).trim();
  return runBoardOffline({
    goal,
    projectDir: join(REPO_ROOT, "examples", "demo-project"),
    dial: { minConcurrency: 1, maxConcurrency: 3 },
    scaleDial: true,
    fixtureGate: true,
    replacesDeclaredGate: ["npm", "run", "gate"],
    resolveContract: async () => "reject",
    ...(speculate !== undefined ? { speculate } : {}),
  });
}

describe("speculative batch gating on the offline demo board", () => {
  it("K = 1 records exactly the board log of the run before speculation", async () => {
    const golden = JSON.parse(await readFile(join(HERE, "fixtures", "board-audit-speculate1.log.json"), "utf8")) as unknown[];
    const result = await demo(1);
    expect(result.verdict).toBe("verified");
    expect(JSON.parse(JSON.stringify(result.log))).toEqual(golden);
    expect(result.speculation).toBeUndefined();
    expect(result.log.some((m) => m.type === "candidate.gated")).toBe(false);
    expect(result.log.find((m) => m.type === "goal.posted")!.payload).not.toHaveProperty("rules.speculate");
  }, 120_000);

  it("the default K still verifies; the proof ties the landed candidate to the gated and promoted commit", async () => {
    const result = await demo();
    expect(result.verdict).toBe("verified");
    expect(result.speculation?.speculate).toBe(3);
    const goal = result.log.find((m) => m.type === "goal.posted")!;
    expect(goal.type === "goal.posted" && goal.payload.rules.speculate).toBe(3);
    const proof = result.proof!;
    expect(proof.status).toBe("proven");
    const landed = proof.speculation!.landed!;
    expect(landed.outcome).toBe("landed");
    expect(landed.rev).toBe(proof.revision!.n);
    expect(landed.commit).toBe(proof.revision!.commit);
    expect(landed.commit).toBe(proof.promotion!.gatedCommit);
    expect(landed.matchesRevision).toBe(true);
    expect(landed.matchesPromoted).toBe(true);
    // Every candidate of that round is listed, backed by its own record.
    for (const c of proof.speculation!.candidates) {
      const record = result.log.find((m) => m.seq === c.seq);
      expect(record?.type).toBe("candidate.gated");
    }
    expect(formatProofSummary(proof).some((l) => /^ {2}speculation: round \d+, .*C\d+ [0-9a-f]{10} pass \(landed as rev \d+ \(its gated commit\), promoted\)/.test(l))).toBe(true);
  }, 120_000);
});
