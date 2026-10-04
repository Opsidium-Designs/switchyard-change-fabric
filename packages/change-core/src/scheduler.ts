/**
 * The pure driver kernel: how a WorkGraph is advanced to completion, wave by
 * wave, as a reproducible sequence of transitions.
 *
 * The durable ChangeWorkflow in the Worker drives a Change by repeatedly asking
 * its Durable Object to advance one scheduling wave; the Durable Object computes
 * each wave with `runnableUnits` and records the transitions. That is live,
 * stateful, and runs under `wrangler dev`. This module is the same logic as a
 * pure function over a Change, with no I/O and no state, so the exact
 * wave-by-wave behavior the Workflow produces can be computed and asserted
 * deterministically in `make check` without the Workflow runtime.
 *
 * Keeping one definition of "how the graph is driven" here means the offline
 * substrate and the durable loop cannot drift in their scheduling semantics:
 * both step the same runnable sets in the same order to completion.
 */

import { runnableUnits } from "./graph.ts";
import type { Change } from "./types.ts";

/** One advanced scheduling wave: the units that ran together, in order. */
export interface DriveWave {
  /** The WorkUnit ids advanced in this wave (schedule order). */
  readonly units: readonly string[];
}

/** The full record of driving a WorkGraph to completion. */
export interface DriveTrace {
  /** The scheduling waves, in the order the driver advanced them. */
  readonly waves: readonly DriveWave[];
  /** Every WorkUnit id, in the order it completed. */
  readonly completionOrder: readonly string[];
  /** True when every WorkUnit completed (the graph fully drained). */
  readonly done: boolean;
}

/** Options for driving a WorkGraph. */
export interface DriveOptions {
  /**
   * Safety bound on the number of waves, matching the Workflow's own bound so a
   * malformed graph cannot loop forever. Defaults to 64.
   */
  readonly maxWaves?: number;
}

const DEFAULT_MAX_WAVES = 64;

/**
 * Drive a Change's WorkGraph to completion the same way the durable Workflow
 * does: each wave takes every currently-runnable unit, completes it (so its
 * dependents become runnable), and repeats until nothing is runnable. Returns
 * the trace. `done` is false if the graph stalled (a cycle or malformed graph);
 * callers should check `findDependencyCycle` first for a precise diagnosis.
 */
export function driveWorkGraph(change: Change, options: DriveOptions = {}): DriveTrace {
  const maxWaves = options.maxWaves ?? DEFAULT_MAX_WAVES;
  const completed = new Set<string>();
  const waves: DriveWave[] = [];
  const completionOrder: string[] = [];

  for (let i = 0; i < maxWaves; i += 1) {
    const runnable = runnableUnits(change, completed);
    if (runnable.length === 0) {
      break;
    }
    for (const unitId of runnable) {
      completed.add(unitId);
      completionOrder.push(unitId);
    }
    waves.push({ units: [...runnable] });
    if (completed.size >= change.work.length) {
      break;
    }
  }

  return {
    waves,
    completionOrder,
    done: completed.size >= change.work.length,
  };
}
