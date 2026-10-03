import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { Env } from "./env.ts";

/** Parameters a ChangeWorkflow run is started with. */
export interface ChangeWorkflowParams {
  readonly changeId: string;
}

/**
 * ChangeWorkflow — durable, restartable work-graph lifecycle for a Change.
 * M0 is a stub with a single recorded step so the Workflow binding is
 * wired and schedulable; the real WorkGraph scheduling (runnable/waiting
 * transitions, verification, integration) lands in M1–M3.
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
