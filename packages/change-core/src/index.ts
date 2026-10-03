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
