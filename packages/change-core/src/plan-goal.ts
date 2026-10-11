/**
 * plan-goal: the inference-backed, schema-constrained planner pass that makes
 * decomposition goal-driven over the deterministic structural backbone, while
 * keeping the offline heuristic as the default everywhere it is not configured.
 *
 * Where this sits
 * ---------------
 * The pure `decompose` path (goal.ts + decompose.ts + blueprint.ts) stays the
 * offline default: it reduces a goal to generic features and shapes the work
 * from how those features meet the repo's structure, with no inference. That is
 * what `make check`, the demo, and the anti-puppet substrate all run, so none of
 * it is touched here.
 *
 * This module adds an OPT-IN pass that a caller selects only when inference is
 * configured. It asks a schema-constrained planner (a plan transport that
 * returns a strict plan object) to decide, WITHIN the real structural backbone:
 * which modules are in scope, each unit's objective, how many agents (= unit
 * count), and the dependency order. The planner is handed the goal text plus the
 * structural module map derived from `deriveCohesionBlueprint` (the modules,
 * their files and exports, the shared frozen contracts, and the import-graph
 * dependency edges), so it reasons over the real structure and may not invent a
 * path outside the snapshot.
 *
 * Honesty and the fall-back
 * -------------------------
 * A planner reply is validated against the json_schema SHAPE by the transport,
 * then against REALITY here: every unit path must exist in the snapshot, every
 * contract must be a real frozen seam, and no unit may own a contract (the
 * single-writer + frozen-contract backbone that preserves the cohesion
 * guarantee). On an invalid or unusable plan the pass escalates through the
 * bounded, ORDERED model ladder (the same ladder the executor uses), and if the
 * ladder is exhausted and still invalid it FALLS BACK to the deterministic
 * heuristic `decompose`, so a run never ships a broken plan. The recorded plan
 * (how the Change was decomposed) is returned so a later stage can back a
 * planner graph node with it.
 */

import { decompose, type DecomposeOptions, type DecomposeResult } from "./decompose.ts";
import { buildRepoSnapshot, type RepoFile, type RepoSnapshot } from "./repo-snapshot.ts";
import { deriveCohesionBlueprint, type CohesionBlueprint } from "./blueprint.ts";
import { normalizeChange } from "./loader.ts";
import type { AssuranceLevel, Change, ChangeBlueprint } from "./types.ts";

/** A single unit the planner proposed (the minimal plan shape). */
export interface PlannedUnit {
  readonly id: string;
  readonly objective: string;
  readonly paths: readonly string[];
  readonly dependsOn: readonly string[];
}

/** The whole plan the planner proposed, before it is projected onto a Change. */
export interface PlannedShape {
  readonly units: readonly PlannedUnit[];
  readonly contracts: readonly string[];
  /**
   * A short, optional explanation the model may return of WHY it decomposed the
   * goal this way. Optional and empty-safe: a plan without it still projects. It
   * is purely explanatory (never a credential, never drives a decision) and is
   * surfaced in the console's planner detail panel when present.
   */
  readonly rationale?: string;
}

/**
 * The plan transport the planner pass calls. It is the exact shape of the
 * model-adapters `PlannerInvoke`, declared here so change-core carries no
 * dependency on the adapter package: a caller injects a concrete transport
 * (the live AI Gateway plan transport, or a deterministic fake in tests).
 */
export type PlanTransport = (request: {
  readonly model: string;
  readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
}) => Promise<PlannedShape>;

/** How the recorded plan was produced, so a later stage can back a planner node. */
export type PlanSource = "planner" | "heuristic-fallback";

/**
 * The typed-decision transport the plan-review juncture calls. It is the exact
 * shape of the model-adapters `AskJev`, declared here so change-core carries no
 * dependency on the adapter package: a caller injects a concrete transport (the
 * live gateway decision call, or a deterministic fake in tests). When it is
 * absent the plan-review juncture is skipped entirely, so the offline path is
 * unchanged.
 */
export type JevTransport = (
  state: string,
  questions: Readonly<
    Record<
      string,
      {
        readonly type: "noul" | "choice" | "score";
        readonly instructions: string;
        readonly criteria?: readonly string[];
      }
    >
  >,
) => Promise<
  Readonly<
    Record<
      string,
      {
        readonly type: "noul" | "choice" | "score";
        readonly noul?: "yes" | "no" | "unsure";
        readonly choice?: string;
        readonly score?: number;
        readonly confidence: number;
        readonly probabilities?: Readonly<Record<string, number>>;
      }
    >
  >
>;

/**
 * The recorded plan-review decision the plan-review juncture produced, carried
 * on the RecordedPlan so a later stage can post it as a JevDecision and back a
 * jev graph node. It names the question asked, the typed noul answer, the
 * calibrated confidence, and whether the plan was ACCEPTED (confident-yes at or
 * above the threshold) or ESCALATED (low-confidence or confident-no). Present
 * only when a Jev transport was injected and ran; absent on the offline path.
 */
export interface PlanReviewDecision {
  readonly question: string;
  readonly noul: "yes" | "no" | "unsure";
  readonly confidence: number;
  readonly accepted: boolean;
  readonly probabilities?: Readonly<Record<string, number>>;
  /** Set when the decision call failed: a short, credential-free reason (the plan proceeds unreviewed). */
  readonly error?: string;
}

/** The recorded plan: the shape that drove the Change, plus its provenance. */
export interface RecordedPlan {
  /** Whether the inference planner produced this plan, or the heuristic fallback did. */
  readonly source: PlanSource;
  /** The model that produced an accepted plan (empty on the heuristic fallback). */
  readonly model: string;
  /** The planned units projected onto the Change's own unit ids. */
  readonly units: readonly PlannedUnit[];
  /** The frozen read-only contract paths the plan froze (owned by no unit). */
  readonly contracts: readonly string[];
  /**
   * A readable, secret-free summary of what the planner was ASKED: the goal plus
   * the structural module map it was handed (modules/files/exports and the frozen
   * seams), summarized. It is derived deterministically from the goal and the
   * snapshot, so it is present for a planner plan and empty-safe for the fallback
   * (where the heuristic ran rather than the planner). The console surfaces it in
   * the planner detail panel so a reader can see the real question the planner
   * answered. It never contains a credential (the structural map carries only
   * paths and symbol names).
   */
  readonly promptSummary?: string;
  /**
   * A short, optional explanation the model returned of WHY this decomposition.
   * Present only when the planner model supplied one; absent otherwise (including
   * the heuristic fallback). Purely explanatory and surfaced in the console's
   * planner detail panel.
   */
  readonly rationale?: string;
  /**
   * The recorded plan-review decision, present only when a Jev transport was
   * injected and the plan-review juncture ran. It names whether Jev judged the
   * plan to cover the goal (confident-yes -> accepted) or not (low-confidence or
   * confident-no -> escalated), so a later stage can post it as a JevDecision and
   * root a jev graph node near the planner. Absent on the offline path (no Jev
   * injected), so that path records nothing new.
   */
  readonly jevReview?: PlanReviewDecision;
  /**
   * Plan-review decisions on EARLIER plans of this pass that were not chosen
   * (in order, each with the model and units it reviewed), so every decision is
   * recorded, not only the final one.
   */
  readonly priorReviews?: readonly (PlanReviewDecision & { readonly model: string; readonly units: readonly string[] })[];
}

/** Options for an inference-backed, schema-constrained plan pass. */
export interface PlanGoalOptions {
  /** The human-stated goal (plain text intent). */
  readonly goal: string;
  /** The target repository, either a flat file list or a prebuilt snapshot. */
  readonly repo: readonly RepoFile[] | RepoSnapshot;
  /** The injected plan transport (the live gateway plan call, or a fake). */
  readonly plan: PlanTransport;
  /**
   * The ORDERED model ladder the pass escalates through on an invalid plan: the
   * base model is tried first, then each escalation model in order. The pass
   * tries at most `1 + escalationModels.length` plan calls, then falls back to
   * the heuristic. The base model is required; the escalation ladder is optional.
   */
  readonly baseModel: string;
  readonly escalationModels?: readonly string[];
  /** A stable Change id. Defaults to the heuristic decomposer's slug. */
  readonly changeId?: string;
  /** Budget to record on the Change. Defaults to 5. */
  readonly budgetUsd?: number;
  /** Assurance level to record. Defaults to "standard". */
  readonly assurance?: AssuranceLevel;
  /**
   * The injected typed-decision transport for the plan-review juncture. When
   * present, after a valid plan is projected the pass asks Jev whether the plan
   * covers the goal (a noul). A confident-yes at or above `jevThreshold` is
   * ACCEPTED and the plan proceeds; a low-confidence or confident-no answer is
   * ESCALATED, which re-runs the bounded model ladder once more for a fresh plan
   * and records the escalation. When absent (the default, offline path) the
   * juncture is skipped entirely, so the plan path is unchanged.
   */
  readonly jev?: JevTransport;
  /**
   * The accept-when-confident threshold in [0, 1] for the plan-review juncture.
   * An answer whose confidence is at or above it is used; below it the juncture
   * escalates. Defaults to 0.75 when a Jev transport is injected without one.
   */
  readonly jevThreshold?: number;
  /**
   * An optional diagnostic sink. When present, the pass reports WHY each ladder
   * model failed: a transport/schema error (the thrown message) or a reality
   * rejection (the validatePlan reason), per model, so a live run can surface
   * the specific cause of a fall-back rather than silently discarding it. It is
   * never fed a credential (only the model id and a shape/validation message),
   * and the pass behaves identically whether or not it is provided.
   */
  readonly onDiagnostic?: (diagnostic: PlanDiagnostic) => void;
}

/**
 * One recorded reason a ladder model did not yield an accepted plan: either a
 * thrown transport/schema error or a reality-check rejection, named with the
 * model it came from. Collected onto the result's `diagnostics` and optionally
 * streamed through `onDiagnostic`, so the cause of a heuristic fall-back is
 * observable. It carries no credential.
 */
export interface PlanDiagnostic {
  /** The model id the attempt ran on. */
  readonly model: string;
  /** Whether the attempt threw in transport/parse, or was rejected by validatePlan. */
  readonly kind: "transport-error" | "validation-rejected";
  /** The thrown error message or the validatePlan rejection reason (no secrets). */
  readonly reason: string;
}

/** The result of a plan pass: a decomposition plus the recorded plan. */
export interface PlanGoalResult extends DecomposeResult {
  /** The recorded plan that drove the Change (planner or heuristic fallback). */
  readonly plan: RecordedPlan;
  /**
   * The per-model reasons the ladder did not accept a plan, in attempt order.
   * Empty when the first model's plan was accepted; populated when a model threw
   * or was rejected (so a run can report WHY it fell back to the heuristic). It
   * carries no credential. Always present (possibly empty) so a caller can read
   * it without a guard.
   */
  readonly diagnostics: readonly PlanDiagnostic[];
}

/** The validation rejection reason handed to the next ladder model, in characters. */
const MAX_REJECTION_FEEDBACK = 500;

/**
 * Run the inference-backed, schema-constrained plan pass. It builds the
 * structural module map from the snapshot, asks the planner for a plan (trying
 * the base model then the ordered escalation ladder on an invalid plan), and
 * projects the first valid plan onto a Change. If no model returns a usable
 * plan, it FALLS BACK to the deterministic heuristic `decompose` so a run never
 * ships a broken plan. The returned result always carries a RecordedPlan naming
 * how it was produced.
 */
export async function planGoal(options: PlanGoalOptions): Promise<PlanGoalResult> {
  const snapshot = isSnapshot(options.repo)
    ? options.repo
    : buildRepoSnapshot(options.repo);
  const blueprint = deriveCohesionBlueprint(snapshot);

  const ladder = [options.baseModel, ...(options.escalationModels ?? [])].filter(
    (model) => model.trim() !== "",
  );
  const messages = buildPlannerMessages(options.goal, snapshot, blueprint);
  // A readable, secret-free summary of what the planner was asked: the goal plus
  // the structural module map it was handed. Derived deterministically from the
  // goal and the snapshot (the same inputs the prompt was built from), so a
  // planner plan always carries it and no credential can leak into it.
  const promptSummary = summarizePlannerPrompt(options.goal, snapshot, blueprint);

  // The plan-review juncture threshold (accept-when-confident). Only used when a
  // Jev transport is injected; defaults to 0.75 to match the orchestration env.
  const jevThreshold =
    options.jevThreshold !== undefined ? options.jevThreshold : 0.75;
  // The last valid projected plan carrying an ESCALATED plan-review decision,
  // kept so that when the bounded ladder yields no confident-yes plan the run
  // still proceeds with the best plan it got (plans never block), recording that
  // Jev escalated rather than accepted. Null until a valid plan is reviewed.
  let escalatedCandidate: PlanGoalResult | null = null;

  // The per-model reasons the ladder did not accept a plan, collected in attempt
  // order so a run can report WHY it fell back. Recording is diagnostic only; the
  // control flow is identical to before.
  const diagnostics: PlanDiagnostic[] = [];
  const record = (diagnostic: PlanDiagnostic): void => {
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  // When a review is not accepted, the NEXT attempt carries the doubt as
  // feedback (once): the next ladder model, or the last model again when the
  // ladder is spent. Every review is kept; the best-reviewed plan proceeds.
  const attempts = [...ladder];
  let feedback: string | undefined;
  let replanned = false;
  const reviewed: { result: PlanGoalResult; review: PlanReviewDecision; model: string; units: string[] }[] = [];
  const score = (r: PlanReviewDecision): number =>
    r.accepted ? 2 + r.confidence : r.noul === "yes" ? r.confidence : r.noul === "unsure" ? 0 : -r.confidence;

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const model = attempts[attempt]!;
    const asked = feedback !== undefined ? [...messages, { role: "user" as const, content: feedback }] : messages;
    feedback = undefined;
    let proposed: PlannedShape;
    try {
      proposed = await options.plan({ model, messages: asked });
    } catch (error) {
      // A transport/schema error on this model: record WHY, then try the next
      // model in the ordered ladder rather than failing the whole pass. The
      // message is the thrown error's text (no credential), so a live run can
      // distinguish a transport error from a validation rejection.
      record({
        model,
        kind: "transport-error",
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const validation = validatePlan(proposed, snapshot, blueprint);
    if (!validation.ok) {
      // A schema-conforming but unreal plan (invented path, a unit owning a
      // contract, a bad dependency): record the specific rejection reason, then
      // escalate to the next model.
      record({ model, kind: "validation-rejected", reason: validation.reason });
      // The next ladder model is told why (one shot): without the reason it
      // tends to repeat the same unreal plan.
      feedback = [
        `A previous plan for this goal was REJECTED by the repository check: ${validation.reason.slice(0, MAX_REJECTION_FEEDBACK)}`,
        "Fix exactly this problem and return the full plan: every path must exist in the structural map, each path is owned by one unit, no unit owns a frozen contract, and every dependency names a unit of the plan.",
      ].join("\n");
      continue;
    }
    const projected = withDiagnostics(
      projectPlanToChange({
        plan: validation.plan,
        snapshot,
        model,
        changeId: options.changeId,
        goal: options.goal,
        budgetUsd: options.budgetUsd,
        assurance: options.assurance,
        promptSummary,
        ...(proposed.rationale !== undefined ? { rationale: proposed.rationale } : {}),
      }),
      diagnostics,
    );

    // The PLAN-REVIEW juncture: when a Jev transport is injected, ask whether
    // the projected plan covers the goal (a noul). A confident-yes at or above
    // the threshold is ACCEPTED and the plan proceeds; a low-confidence or
    // confident-no answer is ESCALATED, so the bounded ladder tries the next
    // model for a better plan. When no later model yields an accepted plan, the
    // last escalated candidate still proceeds (plans never block), recording the
    // escalation honestly. When no Jev transport is injected the juncture is
    // skipped and the first valid plan proceeds exactly as before.
    if (options.jev) {
      const review = await reviewPlan(
        options.jev,
        options.goal,
        validation.plan,
        promptSummary,
        jevThreshold,
      );
      const withReview: PlanGoalResult = review
        ? attachJevReview(projected, review)
        : projected;
      // A failed decision call is recorded on the plan but never escalates it
      // (the plan proceeds unreviewed, as before).
      if (!review || review.accepted || review.error !== undefined) {
        return withPriorReviews(withReview, reviewed);
      }
      // Escalated: remember this candidate and re-plan with the doubt as
      // feedback, once (the next model, or the last one again).
      reviewed.push({ result: withReview, review, model, units: validation.plan.units.map((u) => u.id) });
      if (!replanned) {
        replanned = true;
        feedback = [
          `A reviewer was not confident (answer "${review.noul}", confidence ${review.confidence.toFixed(2)}) that the previous plan covers the WHOLE goal.`,
          `Previous plan units: ${validation.plan.units.map((u) => `${u.id} [${u.paths.join(", ")}]`).join("; ")}.`,
          "Re-plan: list each requirement of the goal and the unit covering it, and cover every feature group of the structural map the goal concerns. Return the full plan.",
        ].join("\n");
        if (attempt === attempts.length - 1) {
          attempts.push(model);
        }
      }
      escalatedCandidate = null;
      continue;
    }

    return projected;
  }

  // A Jev-reviewed run that never got a confident-yes plan still proceeds with
  // its BEST-reviewed valid candidate rather than discarding a usable plan; the
  // other reviews are recorded with it.
  if (reviewed.length > 0) {
    const best = reviewed.reduce((a, b) => (score(b.review) > score(a.review) ? b : a));
    return withPriorReviews(best.result, reviewed.filter((r) => r !== best));
  }
  if (escalatedCandidate) {
    return escalatedCandidate;
  }

  // The ladder is exhausted with no usable plan: fall back to the deterministic
  // heuristic decomposition so the run proceeds with an honest, backbone-true
  // Change rather than a broken plan.
  return withDiagnostics(heuristicFallback(options, snapshot), diagnostics);
}

/** Carry the reviews of plans not chosen onto the chosen plan (recorded with it). */
function withPriorReviews(
  result: PlanGoalResult,
  others: readonly { readonly review: PlanReviewDecision; readonly model: string; readonly units: readonly string[] }[],
): PlanGoalResult {
  if (others.length === 0) {
    return result;
  }
  const priorReviews = others.map((o) => ({ ...o.review, model: o.model, units: [...o.units] }));
  const plan: RecordedPlan = { ...result.plan, priorReviews };
  const change: Change = { ...result.change, ...(result.change.plan ? { plan: { ...result.change.plan, priorReviews } } : {}) };
  return { ...result, plan, change };
}

/** Attach the collected per-model diagnostics onto a plan result. */
function withDiagnostics(
  result: PlanGoalResult,
  diagnostics: readonly PlanDiagnostic[],
): PlanGoalResult {
  return { ...result, diagnostics: [...diagnostics] };
}

/**
 * The plan-review juncture: ask the injected typed-decision transport whether a
 * projected plan covers the goal (a noul question), and classify the answer as
 * ACCEPTED (confident-yes at or above the threshold) or ESCALATED (low-confidence
 * or confident-no). Returns the recorded decision, or null when the transport
 * throws (a transport error must not fail the whole plan pass; the plan simply
 * proceeds unreviewed). The state summary is the readable prompt summary plus the
 * planned unit ids, so it is secret-free and deterministic given its inputs.
 */
async function reviewPlan(
  jev: JevTransport,
  goal: string,
  plan: PlannedShape,
  promptSummary: string,
  threshold: number,
): Promise<PlanReviewDecision | null> {
  const question = "Does this plan cover the goal?";
  const state = [
    `Goal: ${goal}`,
    "",
    promptSummary,
    "",
    `Planned units: ${plan.units.map((unit) => unit.id).join(", ") || "(none)"}`,
    `Frozen contracts: ${plan.contracts.join(", ") || "(none)"}`,
  ].join("\n");
  let answers: Awaited<ReturnType<JevTransport>>;
  try {
    answers = await jev(state, { "plan-review": { type: "noul", instructions: question } });
  } catch (error) {
    // A failed call never fails the plan, but it is RECORDED (never silent).
    return { question, noul: "unsure", confidence: 0, accepted: false, error: shortReason(error) };
  }
  const answer = answers["plan-review"];
  if (!answer || answer.type !== "noul" || answer.noul === undefined) {
    return { question, noul: "unsure", confidence: 0, accepted: false, error: "the decision reply carried no plan-review answer" };
  }
  const confident = answer.confidence >= threshold;
  // Accepted only when the plan is a CONFIDENT YES. A confident "no", an
  // "unsure", or any low-confidence answer escalates.
  const accepted = confident && answer.noul === "yes";
  return {
    question,
    noul: answer.noul,
    confidence: answer.confidence,
    accepted,
    ...(answer.probabilities !== undefined ? { probabilities: answer.probabilities } : {}),
  };
}

/** A short, credential-free reason for a failed decision call (first line, bounded). */
function shortReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "decision call failed";
  return line.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@").slice(0, 200);
}

/** Carry a recorded plan-review decision onto a plan result's RecordedPlan. */
function attachJevReview(result: PlanGoalResult, review: PlanReviewDecision): PlanGoalResult {
  const plan: RecordedPlan = { ...result.plan, jevReview: review };
  const change: Change = { ...result.change, plan: toChangePlan(plan, result.change) };
  return { ...result, change, plan };
}

/**
 * Project the RecordedPlan onto the Change's ChangePlan field, carrying the
 * plan-review decision through so it survives the spec round-trip. The ChangePlan
 * is the structural twin of RecordedPlan, so the fields assign directly; the
 * jevReview is carried on the ChangePlan too so the state views can expose it.
 */
function toChangePlan(plan: RecordedPlan, change: Change): Change["plan"] {
  const existing = change.plan;
  if (!existing) {
    return undefined;
  }
  return {
    ...existing,
    ...(plan.jevReview !== undefined ? { jevReview: plan.jevReview } : {}),
  };
}

/** Whether a validated plan is usable, or why it is not. */
type PlanValidation =
  | { readonly ok: true; readonly plan: PlannedShape }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate a schema-conforming plan against REALITY: the backbone the heuristic
 * also honors. Every unit path must be a real source file in the snapshot; every
 * contract must be a real frozen seam (a derived contract when a blueprint
 * exists); no unit may own a contract path (contracts are read-only, owned by no
 * unit); unit ids are unique and non-empty; and every dependency names another
 * unit in the plan (not itself). A plan that fails any check is rejected so the
 * caller escalates or falls back rather than shipping it.
 */
export function validatePlan(
  plan: PlannedShape,
  snapshot: RepoSnapshot,
  blueprint: CohesionBlueprint | undefined,
): PlanValidation {
  if (plan.units.length === 0) {
    return { ok: false, reason: "plan has no units" };
  }

  const knownPaths = new Set(snapshot.sourceFiles.map((f) => f.path));
  // The real frozen seams: the blueprint's contracts when it exists. The plan may
  // only freeze a seam the structural backbone actually identified, so it cannot
  // invent a contract or freeze an owner module.
  const realContracts = new Set((blueprint?.contracts ?? []).map((c) => c.path));

  // Every declared contract must be a real frozen seam.
  for (const contract of plan.contracts) {
    if (!realContracts.has(contract)) {
      return { ok: false, reason: `contract ${contract} is not a real frozen seam` };
    }
  }
  const frozen = new Set(plan.contracts);

  const seenIds = new Set<string>();
  const ownedPaths = new Set<string>();
  for (const unit of plan.units) {
    if (seenIds.has(unit.id)) {
      return { ok: false, reason: `duplicate unit id ${unit.id}` };
    }
    seenIds.add(unit.id);
    if (unit.paths.length === 0) {
      return { ok: false, reason: `unit ${unit.id} owns no paths` };
    }
    for (const path of unit.paths) {
      if (!knownPaths.has(path)) {
        return { ok: false, reason: `unit ${unit.id} owns unknown path ${path}` };
      }
      if (frozen.has(path)) {
        return { ok: false, reason: `unit ${unit.id} owns frozen contract ${path}` };
      }
      if (ownedPaths.has(path)) {
        return { ok: false, reason: `path ${path} is owned by more than one unit` };
      }
      ownedPaths.add(path);
    }
  }

  // Dependencies must name another unit in the plan, never themselves.
  for (const unit of plan.units) {
    for (const dep of unit.dependsOn) {
      if (dep === unit.id) {
        return { ok: false, reason: `unit ${unit.id} depends on itself` };
      }
      if (!seenIds.has(dep)) {
        return { ok: false, reason: `unit ${unit.id} depends on unknown unit ${dep}` };
      }
    }
  }

  return { ok: true, plan };
}

/**
 * Project a validated plan onto a Change, carrying the frozen contracts and each
 * owner's exported interface the SAME way the heuristic decomposer does, so the
 * planned Change reaches the Worker/run exactly like a heuristic Change: the
 * blueprint rides the spec round-trip, so frozenContracts and requiredExports
 * still reach the agent prompts. The projection also builds the recorded plan so
 * a later stage can back a planner graph node with it.
 */
function projectPlanToChange(input: {
  readonly plan: PlannedShape;
  readonly snapshot: RepoSnapshot;
  readonly model: string;
  readonly changeId?: string;
  readonly goal: string;
  readonly budgetUsd?: number;
  readonly assurance?: AssuranceLevel;
  /** The readable summary of what the planner was asked (goal + structural map). */
  readonly promptSummary?: string;
  /** The model's optional explanation of why this decomposition. */
  readonly rationale?: string;
}): PlanGoalResult {
  const { plan, snapshot, model } = input;
  const byPath = new Map(snapshot.sourceFiles.map((f) => [f.path, f] as const));

  const change: Change = normalizeChange({
    id: input.changeId ?? slug(input.goal),
    objective: input.goal,
    baseline: "HEAD",
    budget_usd: input.budgetUsd ?? 5,
    assurance: input.assurance ?? "standard",
    work: plan.units.map((unit) => ({
      id: unit.id,
      objective: unit.objective,
      depends_on: [...unit.dependsOn],
      paths: [...unit.paths],
    })),
  });

  // Carry the blueprint from the plan's own ownership: one carried module per
  // planned unit (its owned paths, its dependency order, and the union of its
  // files' exported symbols), plus the frozen contracts with their real import
  // in-degree. This is the same blueprint carry the heuristic decomposer uses,
  // built from the plan rather than the heuristic's structural pass, so the
  // planned Change round-trips with frozen contracts and required exports intact.
  const modules = plan.units.map((unit) => ({
    unitId: unit.id,
    paths: [...unit.paths],
    dependsOn: [...unit.dependsOn],
    exports: moduleExports(unit.paths, byPath),
  }));
  const contracts = plan.contracts.map((path) => ({
    path,
    importedByCount: byPath.get(path)?.importedByCount ?? 0,
  }));
  const changeBlueprint: ChangeBlueprint = { modules, contracts };

  const recordedPlan: RecordedPlan = {
    source: "planner",
    model,
    units: change.work.map((unit) => ({
      id: unit.id,
      objective: unit.objective,
      paths: [...unit.paths],
      dependsOn: [...unit.dependsOn],
    })),
    contracts: [...plan.contracts],
    ...(input.promptSummary !== undefined ? { promptSummary: input.promptSummary } : {}),
    ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
  };

  // Carry the recorded plan ON the Change so it survives the spec YAML
  // round-trip to the Worker and reaches the state views; the graph projection
  // reads it to root a real planner node. RecordedPlan is the structural twin of
  // the Change's ChangePlan field, so it assigns directly.
  const planned: Change = {
    ...change,
    blueprint: changeBlueprint,
    plan: recordedPlan,
  };

  // Produce the same shape DecomposeResult carries so a caller can treat a
  // planned decomposition identically to a heuristic one. The intent is derived
  // from the goal text for the readable report; the structural decisions came
  // from the planner, not the intent.
  const heuristic = decompose({
    goal: input.goal,
    repo: snapshot,
    ...(input.changeId ? { changeId: input.changeId } : {}),
  });

  const blueprint = deriveCohesionBlueprint(snapshot);
  return {
    change: planned,
    intent: heuristic.intent,
    snapshot,
    ...(blueprint ? { blueprint } : {}),
    plan: recordedPlan,
    // Default empty: the loop replaces this with the collected diagnostics via
    // withDiagnostics so a reader always has the field present.
    diagnostics: [],
  };
}

/**
 * The heuristic fall-back: run the deterministic `decompose` and record the plan
 * as a heuristic fallback, so a planner node backed by this plan is honest about
 * how the Change was produced. The Change is exactly the heuristic Change, so the
 * run is unchanged from the offline path.
 */
function heuristicFallback(
  options: PlanGoalOptions,
  snapshot: RepoSnapshot,
): PlanGoalResult {
  const decomposeOptions: DecomposeOptions = {
    goal: options.goal,
    repo: snapshot,
    ...(options.changeId ? { changeId: options.changeId } : {}),
    ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
    ...(options.assurance ? { assurance: options.assurance } : {}),
  };
  const result = decompose(decomposeOptions);
  const recordedPlan: RecordedPlan = {
    source: "heuristic-fallback",
    model: "",
    units: result.change.work.map((unit) => ({
      id: unit.id,
      objective: unit.objective,
      paths: [...unit.paths],
      dependsOn: [...unit.dependsOn],
    })),
    contracts: (result.change.blueprint?.contracts ?? []).map((c) => c.path),
  };
  // Carry the recorded plan ON the Change so the planner-pass provenance survives
  // the spec round-trip even on the fallback: a configured planner that could not
  // get a usable plan still ran the pass, so its graph shows a planner node that
  // is honest about being the heuristic fallback. The plain offline path (no
  // planner injected) never enters this module, so it still carries no plan.
  const change: Change = { ...result.change, plan: recordedPlan };
  return { ...result, change, plan: recordedPlan, diagnostics: [] };
}

/**
 * Build the planner prompt: a system message stating the hard rules (reason over
 * the real structure only, never invent a path, never let a unit own a frozen
 * contract) and a user message carrying the goal plus the structural module map
 * the planner reasons over. The map is derived from the blueprint when the repo
 * is modular, else from the snapshot's source files, so a non-modular repo still
 * gets a sensible plan surface. Pure and deterministic given its inputs.
 */
export function buildPlannerMessages(
  goal: string,
  snapshot: RepoSnapshot,
  blueprint: CohesionBlueprint | undefined,
): readonly { readonly role: "system" | "user"; readonly content: string }[] {
  const structure = structuralMap(snapshot, blueprint);
  // The exact frozen-contract paths the plan MUST copy verbatim into contracts
  // and MUST NOT place on any unit. Enumerated here so the model is never tempted
  // to let a unit own a seam (which validatePlan rejects) or to omit/rename one.
  const frozenPaths = (blueprint?.contracts ?? []).map((c) => c.path);
  const frozenRules =
    frozenPaths.length > 0
      ? [
          `- The frozen contracts are EXACTLY these read-only seam paths: ${frozenPaths.join(", ")}.`,
          "- Copy every one of those paths VERBATIM into the top-level contracts array, and list no other path there.",
          "- NO unit may own, edit, or list a frozen contract path. If the goal asks to 'require auth' or similar, a unit SATISFIES it by CALLING the exported function from the frozen contract (for example requireAuth), never by owning or rewriting the contract. The resources HONOR the frozen contracts, they do not rewrite them.",
        ]
      : [
          "- There are no frozen contracts in this repository; the contracts array is empty.",
        ];
  const system = [
    "You are a planner that decomposes a software goal into a work plan over a REAL repository.",
    "You are given the goal and a structural map of the repository: its modules, each module's files and exported symbols, the shared frozen contracts, and the import-graph dependency edges.",
    "Decide which modules are in scope, one objective per unit, how many units, and the dependency order WITHIN the real structure.",
    "Use the EXACT module file paths from the structural map verbatim; never paraphrase, normalize, or invent a path.",
    "Hard rules you must obey:",
    "- Every path you put on a unit MUST be a real source file path copied verbatim from the structural map. Never invent a path.",
    ...frozenRules,
    "- Each real source file is owned by at most one unit (single writer).",
    "- A unit's dependsOn must reference other unit ids in your plan, following the import order in the structural map.",
    "- Coverage: a goal often spans SEVERAL feature groups (feature_groups in the map). Go through every requirement of the goal and every feature group it concerns; a module whose behavior the goal changes needs a unit, in every group, not only the first one you notice.",
    "Return only the plan object the schema describes.",
  ].join("\n");
  const user = [
    `Goal: ${goal}`,
    "",
    "Structural map of the repository:",
    structure,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Build a readable, secret-free summary of what the planner was ASKED: the goal
 * plus a compact description of the structural module map it was handed (how
 * many modules/files it could place, each module's owned files, and the frozen
 * read-only seams). It is derived deterministically from the goal and the
 * snapshot (the same inputs the prompt was built from), so it is reproducible
 * and carries only paths and symbol names, never a credential. Bounded so a very
 * large repo's map does not produce an unbounded summary. Surfaced in the
 * console's planner detail panel so a reader sees the real question the planner
 * answered.
 */
export function summarizePlannerPrompt(
  goal: string,
  snapshot: RepoSnapshot,
  blueprint: CohesionBlueprint | undefined,
): string {
  const lines: string[] = [];
  lines.push(`Goal: ${goal}`);
  lines.push("");
  if (blueprint && blueprint.modules.length > 0) {
    lines.push(
      `Structural module map: ${blueprint.modules.length} module(s), ${blueprint.contracts.length} frozen contract(s).`,
    );
    lines.push("Modules the planner could place:");
    for (const module of blueprint.modules.slice(0, MAX_SUMMARY_ITEMS)) {
      const deps =
        module.dependsOn.length > 0 ? ` (depends on ${module.dependsOn.join(", ")})` : "";
      lines.push(`  - ${module.label}: ${module.paths.join(", ")}${deps}`);
    }
    if (blueprint.modules.length > MAX_SUMMARY_ITEMS) {
      lines.push(`  - ...and ${blueprint.modules.length - MAX_SUMMARY_ITEMS} more`);
    }
    if ((blueprint.groups ?? []).length > 0) {
      lines.push(`Feature groups: ${(blueprint.groups ?? []).map((g) => `${g.dir || "."} (${g.modules.length})`).join(", ")}`);
    }
    if (blueprint.contracts.length > 0) {
      lines.push("Frozen read-only contracts (owned by no unit):");
      for (const contract of blueprint.contracts.slice(0, MAX_SUMMARY_ITEMS)) {
        lines.push(`  - ${contract.path}`);
      }
      if (blueprint.contracts.length > MAX_SUMMARY_ITEMS) {
        lines.push(`  - ...and ${blueprint.contracts.length - MAX_SUMMARY_ITEMS} more`);
      }
    }
  } else {
    lines.push(
      `Structural file map: ${snapshot.sourceFiles.length} source file(s), no frozen contracts (non-modular repo).`,
    );
    lines.push("Source files the planner could place:");
    for (const file of snapshot.sourceFiles.slice(0, MAX_SUMMARY_ITEMS)) {
      lines.push(`  - ${file.path}`);
    }
    if (snapshot.sourceFiles.length > MAX_SUMMARY_ITEMS) {
      lines.push(`  - ...and ${snapshot.sourceFiles.length - MAX_SUMMARY_ITEMS} more`);
    }
  }
  return lines.join("\n");
}

/** The maximum number of modules/files/contracts a prompt summary lists. */
const MAX_SUMMARY_ITEMS = 20;

/** Render the structural map the planner reasons over as a compact text block. */
function structuralMap(
  snapshot: RepoSnapshot,
  blueprint: CohesionBlueprint | undefined,
): string {
  const lines: string[] = [];
  if (blueprint && blueprint.modules.length > 0) {
    lines.push("modules:");
    for (const module of blueprint.modules) {
      const deps = module.dependsOn.length > 0 ? ` depends_on: ${module.dependsOn.join(", ")}` : "";
      const exports = module.exports.length > 0 ? ` exports: ${module.exports.join(", ")}` : "";
      lines.push(`  - ${module.label}: paths ${module.paths.join(", ")}${deps}${exports}`);
    }
    lines.push("frozen_contracts:");
    for (const contract of blueprint.contracts) {
      lines.push(`  - ${contract.path} (imported_by_count ${contract.importedByCount})`);
    }
    if ((blueprint.groups ?? []).length > 0) {
      lines.push("feature_groups:");
      for (const group of blueprint.groups ?? []) {
        lines.push(`  - ${group.dir || "."}: modules ${group.modules.join(", ")}; seams ${group.contracts.join(", ") || "(none)"}`);
      }
    }
  } else {
    lines.push("source_files:");
    for (const file of snapshot.sourceFiles) {
      const exports = file.exports.length > 0
        ? ` exports: ${file.exports.map((e) => e.name).join(", ")}`
        : "";
      lines.push(`  - ${file.path}${exports}`);
    }
    lines.push("frozen_contracts: (none)");
  }
  return lines.join("\n");
}

/**
 * The exported interface of a planned unit: the union of its files' exported
 * symbol names from the snapshot, sorted and de-duplicated. Mirrors the
 * blueprint's structural read so the planned Change carries the same exports a
 * heuristic Change does. A unit whose files export nothing carries an empty list.
 */
function moduleExports(
  paths: readonly string[],
  byPath: ReadonlyMap<string, { readonly exports: readonly { readonly name: string }[] }>,
): readonly string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const file = byPath.get(path);
    if (!file) {
      continue;
    }
    for (const symbol of file.exports) {
      if (symbol.name !== "") {
        names.add(symbol.name);
      }
    }
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A slug for a Change id derived from the goal text (mirrors the decomposer). */
function slug(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `change-${base || "goal"}`;
}

function isSnapshot(repo: readonly RepoFile[] | RepoSnapshot): repo is RepoSnapshot {
  return !Array.isArray(repo) && "sourceFiles" in (repo as RepoSnapshot);
}
