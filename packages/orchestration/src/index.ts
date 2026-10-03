/**
 * orchestration: drive a Change end to end, deterministically and offline.
 *
 * The public surface:
 *   - runChange / describeChange: assemble orchestration, runners, verification,
 *     integration, conflict coordination, local Git promotion, and cleanup into
 *     one call, using the deterministic noop executor and the honest local
 *     fallback by default so it runs with no Cloudflare account.
 *   - LocalChangeControl: an in-process stand-in for the Worker control surface,
 *     reusing the real change-core scheduling, for Node callers (CLI, demo,
 *     tests) where the Durable Object runtime module does not resolve.
 *   - formatRunSummary / formatChangePlan / formatStateView: readable, plain-text
 *     reports that tell the coordination story.
 *   - runDoctor / formatDoctorReport: an offline-safe prerequisite readiness
 *     check.
 *
 * These are Node-side helpers (they run Git and child processes), so they live
 * outside the Cloudflare Worker.
 */

export type {
  ChangeStateView,
  CostEvent,
  LeaseRecord,
  WorkUnitView,
} from "./local-control.ts";
export { LocalChangeControl, workspaceNameFor } from "./local-control.ts";

export type {
  RunChangeOptions,
  RunChangeResult,
  RunEvent,
  UnitRunReport,
} from "./run-change.ts";
export { describeChange, runChange } from "./run-change.ts";

export { formatChangePlan, formatRunSummary, formatStateView } from "./summary.ts";

export type { CheckStatus, DoctorCheck, DoctorEnv, DoctorReport } from "./doctor.ts";
export { formatDoctorReport, runDoctor } from "./doctor.ts";
