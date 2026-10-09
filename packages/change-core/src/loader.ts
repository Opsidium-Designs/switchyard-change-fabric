/**
 * Parse a Change spec file into a validated Change value.
 *
 * The spec file is YAML with this shape:
 *
 *   id: change-audit-logging
 *   objective: Add organization-level audit logging
 *   baseline: HEAD
 *   budget_usd: 5.00
 *   assurance: standard
 *   work:
 *     - id: model
 *       objective: Implement audit event persistence
 *       paths:
 *         - src/audit/**
 *     - id: api
 *       objective: Add API read endpoints
 *       depends_on: [model]
 *       paths:
 *         - src/api/audit/**
 *
 * Parsing is strict: unknown shapes, missing required fields, duplicate WorkUnit
 * ids, and dependencies on unknown ids are rejected with a clear error. The
 * parsed value is a plain Change object with no I/O performed here beyond the
 * YAML parse of the provided text.
 */

import { parse as parseYaml } from "yaml";

import type {
  AssuranceLevel,
  Change,
  ChangeBlueprint,
  ChangeBlueprintContract,
  ChangeBlueprintModule,
  ChangePlan,
  ChangePlanReview,
  ChangePlanSource,
  ChangePlanUnit,
  WorkUnit,
} from "./types.ts";

/** Thrown when a Change spec is malformed or inconsistent. */
export class ChangeSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeSpecError";
  }
}

const ASSURANCE_LEVELS: readonly AssuranceLevel[] = ["none", "standard", "strict"];

/** Parse a Change spec from its YAML text. */
export function parseChangeSpec(yamlText: string): Change {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ChangeSpecError(`invalid YAML: ${detail}`);
  }
  return normalizeChange(doc);
}

/** Validate and normalize an already-parsed object into a Change. */
export function normalizeChange(doc: unknown): Change {
  if (!isRecord(doc)) {
    throw new ChangeSpecError("Change spec must be a mapping at the top level");
  }

  const id = requireString(doc, "id");
  const objective = requireString(doc, "objective");
  const baseline = optionalString(doc, "baseline") ?? "HEAD";
  const budgetUsd = optionalNumber(doc, "budget_usd") ?? 0;
  const assurance = parseAssurance(doc["assurance"]);

  const rawWork = doc["work"];
  if (!Array.isArray(rawWork) || rawWork.length === 0) {
    throw new ChangeSpecError("Change spec must declare a non-empty `work:` list");
  }

  const work: WorkUnit[] = rawWork.map((item, index) => parseWorkUnit(item, index));

  assertUniqueIds(work);
  assertKnownDependencies(work);

  const blueprint = parseBlueprint(doc["blueprint"], work);
  const plan = parsePlan(doc["plan"], work);
  return {
    id,
    objective,
    baseline,
    budgetUsd,
    assurance,
    work,
    ...(blueprint ? { blueprint } : {}),
    ...(plan ? { plan } : {}),
  };
}

/**
 * Parse the optional cohesion blueprint carried on a Change spec. The blueprint
 * is the module boundaries and the frozen read-only contracts at the seams,
 * expressed in terms of the Change's own WorkUnit ids. It is OPTIONAL: a
 * hand-authored or non-modular Change omits it, in which case this returns
 * undefined and the Change simply carries no blueprint. When present it is
 * validated so a malformed blueprint is rejected with a clear error rather than
 * silently dropped, which keeps the frozen contracts honest once they survive
 * the spec round-trip (the live run reads blueprint.contracts to tell the agents
 * which files are the frozen read-only seams).
 */
function parseBlueprint(
  value: unknown,
  work: readonly WorkUnit[],
): ChangeBlueprint | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ChangeSpecError("blueprint must be a mapping when present");
  }
  const knownUnitIds = new Set(work.map((unit) => unit.id));
  const modules = parseBlueprintModules(value["modules"], knownUnitIds);
  const contracts = parseBlueprintContracts(value["contracts"]);
  return { modules, contracts };
}

const PLAN_SOURCES: readonly ChangePlanSource[] = ["planner", "heuristic-fallback"];

/**
 * Parse the optional recorded plan carried on a Change spec. The plan is how the
 * Change was decomposed by the inference-backed, schema-constrained planner pass
 * (or its heuristic fallback), carried so it survives the spec round-trip to the
 * Worker and backs the graph's `planner` node. It is OPTIONAL: a hand-authored or
 * plain heuristic Change omits it, in which case this returns undefined and the
 * Change carries no plan (so the graph has no planner node). When present it is
 * validated so a malformed plan is rejected with a clear error rather than
 * silently dropped, keeping the planner node honest once it survives the
 * round-trip.
 */
function parsePlan(value: unknown, work: readonly WorkUnit[]): ChangePlan | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ChangeSpecError("plan must be a mapping when present");
  }
  const rawSource = value["source"];
  if (
    typeof rawSource !== "string" ||
    !(PLAN_SOURCES as readonly string[]).includes(rawSource)
  ) {
    throw new ChangeSpecError(
      `plan.source must be one of ${PLAN_SOURCES.join(", ")}, got ${JSON.stringify(rawSource)}`,
    );
  }
  const source = rawSource as ChangePlanSource;
  // The model is empty on the heuristic fallback, so it is optional and defaults
  // to the empty string rather than being required.
  const model = optionalString(value, "model") ?? "";
  const contracts = parseStringList(value["contracts"], "plan.contracts");
  const units = parsePlanUnits(value["units"], work);
  // The prompt summary and rationale are OPTIONAL and empty-safe: a plan without
  // them still validates. Only a non-empty string is carried.
  const promptSummary = optionalNonEmptyString(value, "prompt_summary");
  const rationale = optionalNonEmptyString(value, "rationale");
  const jevReview = parsePlanReview(value["jev_review"]);
  return {
    source,
    model,
    units,
    contracts,
    ...(promptSummary !== undefined ? { promptSummary } : {}),
    ...(rationale !== undefined ? { rationale } : {}),
    ...(jevReview !== undefined ? { jevReview } : {}),
  };
}

/**
 * Parse the optional plan-review decision carried on a Change spec: the typed
 * noul verdict the Jev decision layer returned for whether the plan covers the
 * goal, its confidence, and whether the plan was accepted or escalated. OPTIONAL
 * and empty-safe: a plan with no decision omits it and this returns undefined.
 * When present it is validated so a malformed decision is rejected rather than
 * silently dropped, keeping the jev node honest once it survives the round-trip.
 */
function parsePlanReview(value: unknown): ChangePlanReview | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ChangeSpecError("plan.jev_review must be a mapping when present");
  }
  const noul = value["noul"];
  if (noul !== "yes" && noul !== "no" && noul !== "unsure") {
    throw new ChangeSpecError(
      `plan.jev_review.noul must be one of yes, no, unsure, got ${JSON.stringify(noul)}`,
    );
  }
  const confidence = value["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new ChangeSpecError("plan.jev_review.confidence must be a finite number");
  }
  const question = optionalString(value, "question") ?? "Does this plan cover the goal?";
  const accepted = value["accepted"] === true;
  const error = optionalString(value, "error");
  return { question, noul, confidence, accepted, ...(error !== undefined ? { error: error.slice(0, 300) } : {}) };
}

function parsePlanUnits(
  value: unknown,
  work: readonly WorkUnit[],
): readonly ChangePlanUnit[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ChangeSpecError("plan.units must be a list when present");
  }
  const knownUnitIds = new Set(work.map((unit) => unit.id));
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new ChangeSpecError(`plan.units[${index}] must be a mapping`);
    }
    const id = requireString(item, "id", `plan.units[${index}]`);
    if (!knownUnitIds.has(id)) {
      throw new ChangeSpecError(
        `plan.units[${index}] names unknown WorkUnit id: ${id}`,
      );
    }
    const objective = requireString(item, "objective", `plan.units[${index}] (${id})`);
    const paths = parseStringList(item["paths"], `plan.units[${index}].paths`);
    const dependsOn = parseStringList(
      item["depends_on"],
      `plan.units[${index}].depends_on`,
    );
    return { id, objective, paths, dependsOn };
  });
}

function parseBlueprintModules(
  value: unknown,
  knownUnitIds: ReadonlySet<string>,
): readonly ChangeBlueprintModule[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ChangeSpecError("blueprint.modules must be a list when present");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new ChangeSpecError(`blueprint.modules[${index}] must be a mapping`);
    }
    const unitId = requireString(item, "unit_id", `blueprint.modules[${index}]`);
    if (!knownUnitIds.has(unitId)) {
      throw new ChangeSpecError(
        `blueprint.modules[${index}] names unknown WorkUnit id: ${unitId}`,
      );
    }
    const paths = parseStringList(item["paths"], `blueprint.modules[${index}].paths`);
    const dependsOn = parseStringList(
      item["depends_on"],
      `blueprint.modules[${index}].depends_on`,
    );
    const exports = parseStringList(
      item["exports"],
      `blueprint.modules[${index}].exports`,
    );
    return { unitId, paths, dependsOn, exports };
  });
}

function parseBlueprintContracts(value: unknown): readonly ChangeBlueprintContract[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ChangeSpecError("blueprint.contracts must be a list when present");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new ChangeSpecError(`blueprint.contracts[${index}] must be a mapping`);
    }
    const path = requireString(item, "path", `blueprint.contracts[${index}]`);
    const importedByCount = optionalNumber(item, "imported_by_count") ?? 0;
    return { path, importedByCount };
  });
}

function parseWorkUnit(item: unknown, index: number): WorkUnit {
  if (!isRecord(item)) {
    throw new ChangeSpecError(`work[${index}] must be a mapping`);
  }
  const id = requireString(item, "id", `work[${index}]`);
  const objective = requireString(item, "objective", `work[${index}] (${id})`);
  const dependsOn = parseStringList(item["depends_on"], `work[${index}] (${id}).depends_on`);
  const paths = parseStringList(item["paths"], `work[${index}] (${id}).paths`);
  return { id, objective, dependsOn, paths };
}

function parseAssurance(value: unknown): AssuranceLevel {
  if (value === undefined || value === null) {
    return "standard";
  }
  if (typeof value === "string" && (ASSURANCE_LEVELS as readonly string[]).includes(value)) {
    return value as AssuranceLevel;
  }
  throw new ChangeSpecError(
    `assurance must be one of ${ASSURANCE_LEVELS.join(", ")}, got ${JSON.stringify(value)}`,
  );
}

function parseStringList(value: unknown, where: string): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ChangeSpecError(`${where} must be a list of strings`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ChangeSpecError(`${where}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

function assertUniqueIds(work: readonly WorkUnit[]): void {
  const seen = new Set<string>();
  for (const unit of work) {
    if (seen.has(unit.id)) {
      throw new ChangeSpecError(`duplicate WorkUnit id: ${unit.id}`);
    }
    seen.add(unit.id);
  }
}

function assertKnownDependencies(work: readonly WorkUnit[]): void {
  const ids = new Set(work.map((unit) => unit.id));
  for (const unit of work) {
    for (const dep of unit.dependsOn) {
      if (!ids.has(dep)) {
        throw new ChangeSpecError(
          `WorkUnit ${unit.id} depends on unknown WorkUnit id: ${dep}`,
        );
      }
      if (dep === unit.id) {
        throw new ChangeSpecError(`WorkUnit ${unit.id} cannot depend on itself`);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, where = "Change spec"): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ChangeSpecError(`${where} is missing required string field: ${key}`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ChangeSpecError(`field ${key} must be a string when present`);
  }
  return value;
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ChangeSpecError(`field ${key} must be a number when present`);
  }
  return value;
}

/**
 * Read an optional string field, returning undefined when it is absent, null, or
 * an empty/blank string. Used for the plan's optional, empty-safe explanatory
 * fields (prompt summary, rationale) so a plan without them still validates and
 * an empty one is treated as absent rather than carried as a blank.
 */
function optionalNonEmptyString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ChangeSpecError(`field ${key} must be a string when present`);
  }
  return value.trim() === "" ? undefined : value;
}
