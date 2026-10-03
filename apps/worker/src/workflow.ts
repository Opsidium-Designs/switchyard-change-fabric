import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { Env } from "./env.ts";

/** Parameters a ChangeWorkflow run is started with. */
export interface ChangeWorkflowParams {
  readonly changeId: string;
}

/**
 * ChangeWorkflow: durable, restartable work-graph lifecycle for a Change.
 *
 * The live runnable/waiting scheduling state now lives in the ChangeState
 * Durable Object. This Workflow stays a wired, schedulable stub with a single
 * recorded step; it takes over the durable run loop (leasing runnable WorkUnits
 * to a runner, recording verification, and integration) in a later milestone.
 */
export class ChangeWorkflow extends WorkflowEntrypoint<Env, ChangeWorkflowParams> {
  override async run(
    event: WorkflowEvent<ChangeWorkflowParams>,
    step: WorkflowStep,
  ): Promise<{ changeId: string; status: string }> {
    const { changeId } = event.payload;

    const status = await step.do("acknowledge-change", async () => {
      return "acknowledged" as const;
    });

    return { changeId, status };
  }
}
