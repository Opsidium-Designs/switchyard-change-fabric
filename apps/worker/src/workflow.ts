import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { Env } from "./env.ts";

/** Parameters a ChangeWorkflow run is started with. */
export interface ChangeWorkflowParams {
  readonly changeId: string;
  /**
   * Safety bound on the number of scheduling waves to drive, so a malformed or
   * stuck graph can never loop forever inside the Workflow. Defaults to a value
   * comfortably above any reasonable WorkGraph depth.
   */
  readonly maxWaves?: number;
}

/** The terminal result of a ChangeWorkflow run. */
export interface ChangeWorkflowResult {
  readonly changeId: string;
  readonly status: "completed" | "stalled";
  /** The number of scheduling waves the loop drove. */
  readonly waves: number;
  /** The WorkUnit ids completed, in completion order. */
  readonly completed: readonly string[];
}

const DEFAULT_MAX_WAVES = 64;

/**
 * ChangeWorkflow: the durable, restartable run loop that drives a Change's
 * WorkGraph to completion.
 *
 * The live scheduling state lives in the ChangeState Durable Object, which owns
 * the parsed Change, the completed set, and the lease/cost bookkeeping, and
 * derives runnable/waiting status with the pure change-core scheduling kernel.
 * This Workflow is the engine that advances that state wave by wave:
 *
 *   1. a startup step confirms the Change is initialized in the DO;
 *   2. then, in a bounded loop, each iteration is one `step.do` boundary that
 *      asks the DO to advance exactly one scheduling wave (lease every currently
 *      runnable WorkUnit, record it running, then record it complete so its
 *      dependents become runnable);
 *   3. the loop ends when the DO reports the graph is complete (no runnable and
 *      no waiting units remain), and a final step records the terminal status.
 *
 * Restartability / idempotency: every mutation is inside a `step.do`, so the
 * Workflow runtime records each step's result and never re-runs a committed
 * step on resume. The DO advance is itself idempotent (completing an
 * already-completed unit is a no-op and advancing a complete graph returns
 * done), so even a step that re-executes before its result was durably recorded
 * cannot double-advance or corrupt the graph. This is the "deterministic
 * in-process driver that advances the graph" bar for this milestone; live agent
 * recruitment and the event-driven waves are a later milestone and are not
 * required here.
 */
export class ChangeWorkflow extends WorkflowEntrypoint<Env, ChangeWorkflowParams> {
  override async run(
    event: WorkflowEvent<ChangeWorkflowParams>,
    step: WorkflowStep,
  ): Promise<ChangeWorkflowResult> {
    const { changeId } = event.payload;
    const maxWaves = event.payload.maxWaves ?? DEFAULT_MAX_WAVES;

    const stub = this.changeState(changeId);

    // 1. Confirm the Change exists before driving it. A missing Change is a hard
    //    failure the caller must fix (it must POST the spec first).
    await step.do("confirm-change-initialized", async () => {
      if (!(await stub.isInitialized())) {
        throw new Error(`ChangeWorkflow started for uninitialized Change: ${changeId}`);
      }
      return "initialized" as const;
    });

    // 2. Drive the graph one wave per durable step until it is complete.
    let waves = 0;
    for (let i = 0; i < maxWaves; i += 1) {
      const outcome = await step.do(`advance-wave-${i + 1}`, async () => {
        return stub.advanceWave();
      });
      if (outcome.advanced > 0) {
        waves += 1;
      }
      if (outcome.done) {
        break;
      }
      if (outcome.advanced === 0) {
        // No progress and not done: a stuck graph. Stop rather than spin.
        return this.finish(step, changeId, "stalled", waves, stub);
      }
    }

    return this.finish(step, changeId, "completed", waves, stub);
  }

  /** Record the terminal status as a final durable step and return the result. */
  private async finish(
    step: WorkflowStep,
    changeId: string,
    status: "completed" | "stalled",
    waves: number,
    stub: ReturnType<ChangeWorkflow["changeState"]>,
  ): Promise<ChangeWorkflowResult> {
    const completed = await step.do("finalize", async () => {
      const state = await stub.getState();
      return state.completed;
    });
    return { changeId, status, waves, completed };
  }

  /** The ChangeState Durable Object stub addressed by Change id. */
  private changeState(changeId: string) {
    const id = this.env.CHANGE_STATE.idFromName(changeId);
    return this.env.CHANGE_STATE.get(id);
  }
}
