/**
 * change-core: portable coordination contracts and pure scheduling logic for
 * the Switchyard Change Fabric.
 *
 * The public surface:
 *   - types:  Change / WorkUnit / Dependency / WorkGraph / status enums
 *   - loader: parse and validate a Change spec from YAML text
 *   - graph:  build the WorkGraph and compute runnable/waiting status and
 *             declared path collisions, all pure and deterministic
 *
 * Everything here is free of I/O (the loader only parses text it is given), so
 * it can run unchanged in a Worker, a test, or a CLI.
 */

export type {
  AssuranceLevel,
  Change,
  Dependency,
  PathCollision,
  WorkGraph,
  WorkUnit,
  WorkUnitStatus,
} from "./types.ts";

export { ChangeSpecError, normalizeChange, parseChangeSpec } from "./loader.ts";

export {
  buildWorkGraph,
  detectPathCollisions,
  findDependencyCycle,
  findWorkUnit,
  runnableUnits,
  waitingUnits,
  workUnitStatuses,
} from "./graph.ts";

export type {
  LeaseDecision,
  LeasePlan,
  LeaseResolution,
  UnitLeaseView,
} from "./lease.ts";
export { planWriteLeases, unitLeaseViews } from "./lease.ts";

export type {
  ExportedSymbol,
  ModuleGroup,
  RepoFile,
  RepoSnapshot,
  SourceFileFacts,
} from "./repo-snapshot.ts";
export { buildRepoSnapshot, isTestPath } from "./repo-snapshot.ts";

export type { ActionFamily, GoalAnalyzer, GoalIntent } from "./goal.ts";
export { HeuristicGoalAnalyzer } from "./goal.ts";

export type { DecomposeOptions, DecomposeResult } from "./decompose.ts";
export { decompose, decomposeToChange } from "./decompose.ts";

export type { DriveOptions, DriveTrace, DriveWave } from "./scheduler.ts";
export { driveWorkGraph } from "./scheduler.ts";

export type {
  ConcurrencyDial,
  RecruitDecision,
  RecruitInput,
} from "./recruit.ts";
export { DEFAULT_DIAL, normalizeDial, recruit } from "./recruit.ts";
