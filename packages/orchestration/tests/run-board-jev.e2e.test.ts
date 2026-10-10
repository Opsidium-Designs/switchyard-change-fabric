/**
 * The advisory typed-decision layer on a board run, offline with a fake
 * decision model (no network):
 *   - attribution accuracy: each attribution decision about a failing revision
 *     is resolved mechanically at the next passing revision (decision.resolved),
 *     checked here against an independent recomputation from the log, and
 *     tallied in the run summary next to the string-parse attribution;
 *   - contract triage: a protected contract escalated to the human is first
 *     triaged (accept or reject, with a confidence), recorded linked to the
 *     contract, and shown to the human with the escalation; the human's
 *     decision is what the board applies, and a failed call shows "no
 *     recommendation (reason)".
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import { reduceBoard, type BoardMessage } from "@switchyard-change/change-core";
import type { AskJev, ExecutionResult, ExecutorContext, ExecutorProvider, JevAnswer } from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import { formatBoardRunSummary, formatBoardTranscript, runBoard, type BoardContractDecisionRequest, type BoardRunEvent, type BoardSeed } from "../src/run-board.ts";

const GOAL = "Make every module report its status";
const SECRET = "abcdef0123456789secretvalue";

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-board-jev-"));
  for (const [rel, body] of Object.entries({
    "package.json": '{"name":"p","scripts":{}}\n',
    "src/index.ts": "export * from './core/a';\n",
    "src/core/a.ts": "export const a = 1;\n",
    "src/core/b.ts": "export const b = 2;\n",
    "src/api/handler.ts": "export const handler = () => 1;\n",
    // A credential-looking line: it must never reach the decision model.
    "tests/core.test.ts": `// tests\n// api_key = "${SECRET}"\n`,
  })) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

const seed = async (): Promise<BoardSeed> => ({
  source: "planner",
  model: "fake-planner",
  items: [
    { item: "core", objective: "report status from core", acceptance: ["gate passes"], scopeHint: ["src/core/**"] },
    { item: "api", objective: "report status from the api", acceptance: ["gate passes"], scopeHint: ["src/api/**"] },
    { item: "wiring", objective: "wire the status report", acceptance: ["gate passes"], scopeHint: ["src/**"] },
    { item: "tests", objective: "test the status report", acceptance: ["gate passes"], scopeHint: ["tests/**"] },
  ],
});

/** Writes the attempt's model into every in-scope file. */
class ModelStampingExecutor implements ExecutorProvider {
  readonly name = "model-stamping";
  private n = 0;
  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    this.n += 1;
    const written: string[] = [];
    for (const path of context.paths.filter((p) => !/[*?]/.test(p))) {
      await mkdir(dirname(join(context.worktreeDir, path)), { recursive: true });
      await writeFile(join(context.worktreeDir, path), `// ${context.workUnitId} on ${context.model ?? "base"} (${this.n})\n`);
      written.push(path);
    }
    return { status: "changed", changedPaths: written, logs: [], cost: { usd: 0 }, commitMessage: `edit ${context.workUnitId}` };
  }
}

/** Fails, naming src/api/handler.ts, until that file was written on model "m2" (two fix attempts, so a later failing revision merges several items; the baseline runs the same test). */
class NeedsApiFixGate implements CommandRunner {
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const handler = await readFile(join(cwd, "src/api/handler.ts"), "utf8");
    return handler.includes(" on m2 ")
      ? { code: 0, stdout: "ok 1 - handler\n", stderr: "" }
      : { code: 1, stdout: "not ok 1 - handler\n# src/api/handler.ts does not report status yet\n", stderr: "" };
  }
}

const of = <T extends BoardMessage["type"]>(log: readonly BoardMessage[], type: T) =>
  log.filter((m): m is Extract<BoardMessage, { type: T }> => m.type === type);

/** The criteria ids of a choice question. */
const criteriaOf = (questions: Parameters<AskJev>[1], key: string): string[] => [...(questions[key]?.criteria ?? [])];

/**
 * Independently recompute the fixed set of an attribution about revision `rev`
 * resolved at `passed`: items whose merged push commit in a revision after
 * `rev` (up to `passed`) differs from the one revision `rev` merged.
 */
function fixedFromLog(log: readonly BoardMessage[], rev: number, passed: number): string[] {
  const itemOfCommit = new Map(of(log, "push.announced").map((p) => [p.payload.commit, p.payload.item]));
  const revs = of(log, "integrated.rev");
  const base = new Map(revs.find((r) => r.payload.n === rev)!.payload.merged.map((c) => [itemOfCommit.get(c)!, c]));
  const changed = new Set<string>();
  for (const r of revs.filter((r) => r.payload.n > rev && r.payload.n <= passed)) {
    for (const commit of r.payload.merged) {
      const item = itemOfCommit.get(commit)!;
      if (base.get(item) !== commit) {
        changed.add(item);
      }
    }
  }
  return [...changed].sort();
}

/** Run the fix loop with a fake model that picks an item per `pick` with `confidence`. */
async function attributionRun(pick: (ids: string[], state: string) => string, confidence: number) {
  const projectDir = await project();
  const asked: string[] = [];
  const jev: AskJev = async (state, questions) => {
    const out: Record<string, JevAnswer> = {};
    if (questions["attribution"]) {
      const ids = criteriaOf(questions, "attribution");
      asked.push(ids.join(","));
      out["attribution"] = { type: "choice", choice: pick(ids, state), confidence };
    }
    if (questions["triage"]) {
      out["triage"] = { type: "choice", choice: "reject", confidence: 0.9 };
    }
    if (questions["fix-confidence"]) {
      out["fix-confidence"] = { type: "noul", noul: "yes", confidence: 0.9 };
    }
    return out;
  };
  const result = await runBoardOffline({
    goal: GOAL,
    projectDir,
    seed,
    executor: new ModelStampingExecutor(),
    escalationModels: ["m1", "m2"],
    appGateCommand: ["gate"],
    verifyCommandRunner: new NeedsApiFixGate(),
    resolveContract: async () => "reject",
    jev,
  });
  return { result, asked };
}

/** Check every resolution against the independent recomputation; return the linked decisions. */
function checkResolutions(log: readonly BoardMessage[]) {
  const linked = of(log, "decision.recorded").filter((d) => d.payload.juncture === "attribution" && d.payload.rev !== undefined);
  const resolved = of(log, "decision.resolved");
  for (const r of resolved) {
    const decision = linked.find((d) => d.seq === r.payload.decisionSeq)!;
    expect(decision).toBeDefined();
    expect(r.payload.answer).toBe(decision.payload.answer);
    expect(r.payload.parsed).toEqual(decision.payload.parsed);
    expect(r.payload.fixed).toEqual(fixedFromLog(log, r.payload.rev, r.payload.passed));
    expect(r.payload.outcome).toBe(r.payload.fixed.includes(r.payload.answer) ? "in-fixed-set" : "not-in-fixed-set");
    // Resolved at the FIRST passing revision after the failing one.
    const firstPass = of(log, "integrated.rev").find((x) => x.payload.n > r.payload.rev && x.payload.gate === "pass")!;
    expect(r.payload.passed).toBe(firstPass.payload.n);
  }
  return { linked, resolved };
}

describe("attribution outcomes on a board run (advisory, mechanical, not an accuracy measure)", () => {
  it("places a pick of the item that changed before the gate passed in the fixed set, and the parse alongside", async () => {
    const { result, asked } = await attributionRun((ids, state) => ids.find((id) => state.includes(`src/${id}/`)) ?? ids[0]!, 0.9);
    expect(asked.length).toBeGreaterThan(0);
    const { linked, resolved } = checkResolutions(result.log);
    expect(linked.length).toBeGreaterThan(0);
    expect(resolved.length).toBe(linked.length);
    expect(resolved.every((r) => r.payload.answer === "api" && r.payload.outcome === "in-fixed-set")).toBe(true);
    // The parse named the same file, so it landed there too (and the two agreed).
    expect(resolved.every((r) => r.payload.parseOutcome === "in-fixed-set")).toBe(true);
    // Linked AFTER its revision, and the verdict is the gate's.
    for (const d of linked) {
      const rev = of(result.log, "integrated.rev").find((r) => r.payload.n === d.payload.rev)!;
      expect(d.seq).toBeGreaterThan(rev.seq);
      expect(rev.payload.gate).toBe("fail");
    }
    expect(result.verdict).toBe("verified");
    expect(formatBoardRunSummary(result)).toContain(
      `jev attribution: ${linked.length} decision(s); pick among items changed before the next pass: ${linked.length}, not: 0, unresolved: 0 ` +
        `(not a controlled accuracy measure: the items asked to fix tend to change; parse among them: ${linked.length}, not: 0, unattributed: 0, extra item(s): 0; ` +
        `pick differed from parse: 0 (pick only: 0, parse only: 0, both: 0, neither: 0), biased toward whichever was asked to fix)`,
    );
    expect(formatBoardTranscript(result.log)).toMatch(/decision\.resolved\s+#\d+ picked api for revision \d+: in-fixed-set at revision \d+ \(changed: [a-z, ]*\bapi\b[a-z, ]*; parse in-fixed-set\) \(advisory\)/);
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("a low-confidence pick that differed from the parse lands outside the fixed set; it neither narrows the fix nor changes the verdict", async () => {
    const { result } = await attributionRun((ids) => ids.find((id) => id !== "api")!, 0.3);
    const { linked, resolved } = checkResolutions(result.log);
    expect(resolved.length).toBe(linked.length);
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.every((r) => r.payload.outcome === "not-in-fixed-set" && !r.payload.fixed.includes(r.payload.answer))).toBe(true);
    // The pick differed from the parse, and only the parse's item (the one asked to fix) changed.
    expect(resolved.every((r) => r.payload.parseOutcome === "in-fixed-set")).toBe(true);
    // Not confident: the parse alone chose whom to ask.
    expect(result.revisions.filter((r) => r.implicated).every((r) => r.implicated!.source === "parse")).toBe(true);
    expect(result.verdict).toBe("verified");
    const summary = formatBoardRunSummary(result);
    expect(summary).toContain(`jev attribution: ${linked.length} decision(s); pick among items changed before the next pass: 0, not: ${linked.length}, unresolved: 0`);
    expect(summary).toContain(`pick differed from parse: ${linked.length} (pick only: 0, parse only: ${linked.length}, both: 0, neither: 0)`);
  });
});

/** The attribution fix loop on a local control whose decision route fails per `fail` (status, and whether it appended first). */
async function attributionWithFlakyDecisions(fail: (linkedPosts: number) => { readonly status: number; readonly appendFirst: boolean } | undefined) {
  const projectDir = await project();
  const root = await mkdtemp(join(tmpdir(), "scf-board-flaky-"));
  const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }));
  const inner = control.fetch as unknown as typeof fetch;
  let linkedPosts = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { rev?: number }) : {};
    if (String(input).endsWith("/board/decision") && init?.method === "POST" && body.rev !== undefined) {
      linkedPosts += 1;
      const failure = fail(linkedPosts);
      if (failure) {
        if (failure.appendFirst) {
          await inner(input, init); // appended, but the response is lost
        }
        return new Response(JSON.stringify({ error: "upstream" }), { status: failure.status });
      }
    }
    return inner(input, init);
  }) as typeof fetch;
  let asked = 0;
  const jev: AskJev = async (_state, questions): Promise<Record<string, JevAnswer>> => {
    if (questions["attribution"]) {
      asked += 1;
      return { attribution: { type: "choice", choice: "api", confidence: 0.9 } };
    }
    return {};
  };
  const result = await runBoard({
    goal: GOAL,
    projectDir,
    changeId: "change-board-flaky",
    workerUrl: "http://local-control",
    fetchFn,
    dial: { minConcurrency: 1, maxConcurrency: 3 },
    transport: createGenericBoardPolicy(),
    seed,
    executor: new ModelStampingExecutor(),
    escalationModels: ["m1", "m2"],
    appGateCommand: ["gate"],
    verifyCommandRunner: new NeedsApiFixGate(),
    resolveContract: async () => "reject",
    jev,
    workRoot: join(root, "work"),
  });
  const attributions = of(result.log, "decision.recorded").filter((d) => d.payload.juncture === "attribution");
  return { result, asked, attributions, linkedPosts };
}

describe("recording an attribution decision: a transport error is not a refusal", () => {
  it("retries the linked recording after a 5xx that appended nothing, and never posts an unlinked second copy", async () => {
    const { result, asked, attributions, linkedPosts } = await attributionWithFlakyDecisions((k) => (k === 1 ? { status: 503, appendFirst: false } : undefined));
    expect(asked).toBeGreaterThan(0);
    expect(linkedPosts).toBe(asked + 1); // one retry
    expect(attributions).toHaveLength(asked);
    expect(attributions.every((d) => d.payload.rev !== undefined)).toBe(true);
    expect(of(result.log, "decision.resolved")).toHaveLength(asked);
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("a lost response after the append is found on the board, so the decision is neither re-posted nor counted twice", async () => {
    const { result, asked, attributions, linkedPosts } = await attributionWithFlakyDecisions((k) => (k === 1 ? { status: 502, appendFirst: true } : undefined));
    expect(linkedPosts).toBe(asked); // no retry: the board already had it
    expect(attributions).toHaveLength(asked);
    expect(attributions.every((d) => d.payload.rev !== undefined)).toBe(true);
    expect(result.state.decisions.calls).toBe(of(result.log, "decision.recorded").length);
  });

  it("a definite refusal (4xx) records the decision once, unlinked, so it stays visible", async () => {
    const { result, asked, attributions } = await attributionWithFlakyDecisions(() => ({ status: 409, appendFirst: false }));
    expect(attributions).toHaveLength(asked);
    expect(attributions.every((d) => d.payload.rev === undefined)).toBe(true);
    expect(of(result.log, "decision.resolved")).toHaveLength(0);
  });
});

/** A direct run on a local control, so the escalation records can be read. */
async function contractRun(jev: AskJev | undefined, resolve?: (request: BoardContractDecisionRequest) => Promise<"accept" | "reject">) {
  const projectDir = await project();
  const root = await mkdtemp(join(tmpdir(), "scf-board-triage-"));
  const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }));
  const events: BoardRunEvent[] = [];
  const changeId = "change-board-triage";
  const result = await runBoard({
    goal: GOAL,
    projectDir,
    changeId,
    workerUrl: "http://local-control",
    fetchFn: control.fetch as unknown as typeof fetch,
    dial: { minConcurrency: 1, maxConcurrency: 3 },
    transport: createGenericBoardPolicy(),
    seed,
    workRoot: join(root, "work"),
    ...(resolve ? { resolveContract: resolve } : {}),
    ...(jev ? { jev } : {}),
    onEvent: (e) => events.push(e),
  });
  const res = await (control.fetch as unknown as typeof fetch)(`http://local-control/changes/${changeId}/escalations`);
  const escalations = ((await res.json()) as { escalations: { boardContract?: string; question: string; recommendation?: string; status: string; decision?: string }[] }).escalations;
  return { result, events, escalations };
}

describe("typed decisions are metered", () => {
  it("every decision call is counted on the run's meter, labelled with the decision model, and an unpriced one under a spend cap is a visible warning", async () => {
    const projectDir = await project();
    let asks = 0;
    const jev: AskJev = async (_state, questions) => {
      asks += 1;
      const out: Record<string, JevAnswer> = {};
      for (const key of Object.keys(questions)) {
        out[key] = key === "fix-confidence" ? { type: "noul", noul: "yes", confidence: 0.9 } : { type: "choice", choice: criteriaOf(questions, key)[0]!, confidence: 0.1 };
      }
      return out;
    };
    const base = { goal: GOAL, projectDir, seed, executor: new ModelStampingExecutor(), escalationModels: ["m1", "m2"], appGateCommand: ["gate"], resolveContract: async () => "reject" as const };
    const without = await runBoardOffline({ ...base, verifyCommandRunner: new NeedsApiFixGate() });
    const metered = await runBoardOffline({ ...base, verifyCommandRunner: new NeedsApiFixGate(), jev, jevModel: "typesafe/jev", caps: { maxSpendUsd: 1000 } });
    expect(asks).toBeGreaterThan(0);
    // The same deterministic run plus exactly one counted call per decision ask.
    expect(metered.usage!.calls - without.usage!.calls).toBe(asks);
    expect(metered.usage!.warnings).toContainEqual(expect.stringContaining("an unpriced model call (typesafe/jev) under the 1000 USD spend cap"));
    expect(formatBoardRunSummary(metered)).toContain("meter warning: an unpriced model call (typesafe/jev)");
  });
});

describe("contract triage for the human (advisory)", () => {
  it("records a triage linked to the contract, shows it with the escalation, and the human's opposite decision is what applies", async () => {
    const states: string[] = [];
    const jev: AskJev = async (state, questions): Promise<Record<string, JevAnswer>> => {
      if (questions["triage"]) {
        states.push(state);
        expect(questions["triage"]).toMatchObject({ type: "choice", criteria: ["accept", "reject"] });
        return { triage: { type: "choice", choice: "accept", confidence: 0.9 } };
      }
      return {};
    };
    const requests: BoardContractDecisionRequest[] = [];
    const { result, escalations } = await contractRun(jev, async (request) => {
      requests.push(request);
      return "reject";
    });
    const escalated = of(result.log, "contract.escalated")[0]!;
    const triage = of(result.log, "decision.recorded").filter((d) => d.payload.juncture === "contract-triage");
    expect(triage[0]!.payload).toMatchObject({ contract: escalated.payload.contract, answer: "accept", confidence: 0.9, accepted: true });
    // Asked before the human, and the human saw the recommendation.
    expect(requests[0]).toMatchObject({ contract: escalated.payload.contract, recommendation: "accept (confidence 0.90)" });
    expect(requests[0]!.question).toMatch(/Advisory triage \(a typed decision; the human decides\): accept \(confidence 0\.90\)$/);
    const record = escalations.find((e) => e.boardContract === escalated.payload.contract)!;
    expect(record).toMatchObject({ status: "resolved", decision: "reject", recommendation: "accept (confidence 0.90)" });
    expect(record.question).toContain("Advisory triage");
    // The human's reject is what the board applied (the advice never decides).
    expect(of(result.log, "contract.rejected").map((m) => [m.from, m.payload.contract])).toContainEqual(["human", escalated.payload.contract]);
    expect(of(result.log, "contract.accepted")).toHaveLength(0);
    // The state is delimited untrusted data, bounded, with the excerpt scrubbed of credentials.
    expect(states[0]).toContain("<<<UNTRUSTED DATA: an excerpt of tests/core.test.ts as it is now");
    expect(states[0]).toContain("<<<UNTRUSTED DATA: the item's objective");
    expect(states[0]).toContain("test the status report");
    expect(states[0]).toContain("// tests");
    expect(states[0]).not.toContain(SECRET);
    expect(states[0]).toContain("[redacted]");
    expect(states[0]!.length).toBeLessThanOrEqual(10_000);
    expect(formatBoardTranscript(result.log)).toMatch(/decision\.recorded\s+contract \S+ contract-triage: accept \(confidence 0\.90\), accepted \(advisory\)/);
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("a failed triage call is recorded and shown as no recommendation (reason); the human still decides", async () => {
    const jev: AskJev = async (_state, questions) => {
      if (questions["triage"]) {
        throw new Error("AI Gateway decision call failed for typesafe/jev (HTTP 500): upstream unavailable");
      }
      return {};
    };
    const requests: BoardContractDecisionRequest[] = [];
    const { result, escalations } = await contractRun(jev, async (request) => {
      requests.push(request);
      return "reject";
    });
    const triage = of(result.log, "decision.recorded").find((d) => d.payload.juncture === "contract-triage")!;
    expect(triage.payload).toMatchObject({ accepted: false, error: "AI Gateway decision call failed for typesafe/jev (HTTP 500): upstream unavailable" });
    expect(requests[0]!.recommendation).toBe("no recommendation (AI Gateway decision call failed for typesafe/jev (HTTP 500): upstream unavailable)");
    expect(escalations[0]!.recommendation).toBe(requests[0]!.recommendation);
    expect(of(result.log, "contract.rejected").every((m) => m.from === "human")).toBe(true);
    expect(result.state.decisions.errors).toBeGreaterThan(0);
  });

  it("without a resolver the waiting escalation carries the recommendation; without a decision model there is none", async () => {
    const jev: AskJev = async (_state, questions): Promise<Record<string, JevAnswer>> =>
      questions["triage"] ? { triage: { type: "choice", choice: "reject", confidence: 0.4 } } : {};
    const waiting = await contractRun(jev);
    const event = waiting.events.find((e) => e.kind === "contract-awaiting-human");
    expect(event).toMatchObject({ recommendation: "no recommendation (low confidence: leaning reject (confidence 0.40))" });
    expect(waiting.escalations.find((e) => e.status === "pending")!.recommendation).toBe("no recommendation (low confidence: leaning reject (confidence 0.40))");
    const plain = await contractRun(undefined);
    expect(plain.escalations[0]!.recommendation).toBeUndefined();
    expect(of(plain.result.log, "decision.recorded")).toHaveLength(0);
  });
});
