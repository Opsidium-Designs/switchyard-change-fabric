/**
 * IntegrationWorkflow: integrates a board's announced pushes on Cloudflare,
 * one revision at a time per Change.
 *
 * A push.announced on the board (or a kick from the run) asks the ChangeState
 * for integration; when no Workflow is active for the Change it starts one,
 * otherwise the active one is told to look again before it finishes, so
 * pushes that land while a revision runs are coalesced into the next. Each
 * iteration is a few durable steps:
 *
 *   plan     the next revision's job from the board (idle when nothing new is
 *            pending): its key is the Change, the base commit, and the pinned
 *            commits, so a retried step never integrates anything else;
 *   run      mint short-lived Artifact tokens Worker-side (a read token per
 *            agent repo, a write token for the integration repo), run the job
 *            in the GateRunner's container under the phased egress policy,
 *            revoke the tokens; the step's timeout exceeds the job's deadline;
 *   attribute for a failing revision when the run attributes (`attribution:
 *            "driver"`), hold it for the run's advisory typed-decision choice
 *            (a bounded wait for an event; the parse alone otherwise);
 *   record   record the result on the board through the same append path as
 *            the integration revision route (idempotent by the key), with the
 *            parse attribution (and the run's choice, when it answered);
 *   advance  after a recorded pass, fast-forward the integration branch to the
 *            gated commit (a second, git-only job in the container).
 * Promotion stays with the driver: it pins and verifies the gated commit from
 * the integration repo, exactly as with the local integrator.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { INTEGRATE_JOB_VERSION } from "@switchyard-change/verification/integrate-job";

import { DRIVER_ATTRIBUTION_WAIT_MS, type CloudJobPlan, type CloudPlanOutcome, type CloudRevisionRecord, type BoardRepoRecord } from "./cloud-integration.ts";
import type { IntegrateJobResult } from "@switchyard-change/verification/integrate-job";
import type { GateRunOutcome } from "./gate-runner.ts";
import { repoHostOf, repoPathOf, DEFAULT_REGISTRY_HOST } from "./integration-egress.ts";
import { selectProvisioner, type EnvWithProvisioner } from "./workspace-provisioner.ts";

/** Parameters an IntegrationWorkflow instance is started with. */
export interface IntegrationWorkflowParams {
  readonly changeId: string;
  /** The instance id the ChangeState recorded as active. */
  readonly instanceId: string;
}

/** A planned job with what running it needs. */
export type PlannedCloudJob = CloudPlanOutcome & {
  readonly deadlineMs?: number;
  readonly registryHost?: string;
  readonly integration?: BoardRepoRecord;
};

/** What the loop talks to (the ChangeState and the GateRunner, or fakes). */
export interface IntegrationPorts {
  plan(): Promise<PlannedCloudJob>;
  /** Mint tokens, run the job in the container, revoke the tokens. */
  run(plan: CloudJobPlan, context: { readonly deadlineMs: number; readonly registryHost: string; readonly integration: BoardRepoRecord }): Promise<GateRunOutcome>;
  record(input: { readonly plan: CloudJobPlan; readonly outcome?: GateRunOutcome; readonly error?: string; readonly transient?: boolean }): Promise<CloudRevisionRecord>;
  /** Fast-forward the integration branch to `commit`. */
  advance(commit: string, context: { readonly registryHost: string; readonly integration: BoardRepoRecord }): Promise<{ readonly advanced: boolean; readonly error?: string }>;
  recordAdvance(key: string, outcome: { readonly advanced: boolean; readonly error?: string }): Promise<void>;
  /** A failing result: should the loop wait for the run's attribution? */
  requestAttribution(plan: CloudJobPlan, result: IntegrateJobResult): Promise<{ readonly waiting: boolean }>;
  finish(instanceId: string, force: boolean): Promise<{ readonly again: boolean }>;
}

/** The step API the loop uses (the Workflow's step, or a fake). */
export interface IntegrationSteps {
  /** Wait for an event of `type` (throws when the timeout passes first). */
  waitForEvent(name: string, type: string, timeoutMs: number): Promise<unknown>;
  do<T>(name: string, config: { readonly retries?: { readonly limit: number; readonly delay: number; readonly backoff?: "constant" | "linear" | "exponential" }; readonly timeout?: number }, run: () => Promise<T>): Promise<T>;
}

/** How one Workflow instance ended. */
export interface IntegrationLoopResult {
  readonly iterations: number;
  readonly recorded: readonly { readonly key: string; readonly n?: number; readonly gate?: string; readonly recorded: boolean; readonly reason?: string }[];
  readonly stop: "idle" | "max-iterations" | "failed";
}

/** The most revisions one instance builds before handing over to a fresh one. */
export const MAX_ITERATIONS = 24;
/** The margin a run step's timeout keeps over the job's own deadline. */
export const RUN_STEP_MARGIN_MS = 2 * 60 * 1000;

const NO_RETRY = { retries: { limit: 0, delay: 1000 } } as const;

/** The loop, over its ports and steps (see the module comment). */
export async function runIntegrationLoop(ports: IntegrationPorts, steps: IntegrationSteps, instanceId: string): Promise<IntegrationLoopResult> {
  const recorded: IntegrationLoopResult["recorded"][number][] = [];
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    const planned = await steps.do(`plan-${i}`, { retries: { limit: 3, delay: 2000, backoff: "exponential" } }, () => ports.plan());
    if (planned.kind === "idle" || !planned.deadlineMs || !planned.integration) {
      const { again } = await steps.do(`finish-${i}`, NO_RETRY, () => ports.finish(instanceId, false));
      if (again) {
        continue;
      }
      return { iterations: i + 1, recorded, stop: "idle" };
    }
    const context = { deadlineMs: planned.deadlineMs, registryHost: planned.registryHost ?? DEFAULT_REGISTRY_HOST, integration: planned.integration };
    const plan = planned.plan;
    let outcome: GateRunOutcome | undefined;
    let failure: string | undefined;
    try {
      outcome = await steps.do(
        `run-${plan.key}`,
        { retries: { limit: 2, delay: 10_000, backoff: "exponential" }, timeout: context.deadlineMs + RUN_STEP_MARGIN_MS },
        async () => {
          const ran = await ports.run(plan, context);
          if (ran.result === undefined || (ran.result.kind === "integrate" && ran.result.transient === true)) {
            // A failure to run (the container, the tokens, the egress phases), never a verdict: retry the step.
            throw new Error(ran.error ?? (ran.result?.kind === "integrate" ? ran.result.error : undefined) ?? "the job produced no result");
          }
          return ran;
        },
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const failing = outcome?.result?.kind === "integrate" && outcome.result.outcome === "gated" && outcome.result.gate === "fail" ? outcome.result : undefined;
    if (failing) {
      const asked = await steps.do(`attribution-${plan.key}`, NO_RETRY, () => ports.requestAttribution(plan, failing));
      if (asked.waiting) {
        // The run's advisory choice, if it answers in time; the parse alone otherwise.
        await steps.waitForEvent(`attribution-wait-${plan.key}`, `attribution-${plan.key}`, DRIVER_ATTRIBUTION_WAIT_MS).catch(() => undefined);
      }
    }
    const record = await steps.do(`record-${plan.key}`, { retries: { limit: 3, delay: 2000, backoff: "exponential" } }, () =>
      ports.record(outcome ? { plan, outcome } : { plan, error: `the integration job could not run: ${failure ?? "unknown"}`, transient: true }),
    );
    recorded.push({ key: plan.key, ...(record.n !== undefined ? { n: record.n } : {}), ...(record.gate ? { gate: record.gate } : {}), recorded: record.recorded, ...(record.reason ? { reason: record.reason } : {}) });
    if (failure !== undefined) {
      // Hand back: the next push or kick starts a fresh instance that tries again.
      await steps.do(`finish-${i}`, NO_RETRY, () => ports.finish(instanceId, true));
      return { iterations: i + 1, recorded, stop: "failed" };
    }
    if (record.recorded && record.gate === "pass" && record.commit) {
      const commit = record.commit;
      let advanced: { readonly advanced: boolean; readonly error?: string };
      try {
        advanced = await steps.do(`advance-${plan.key}`, { retries: { limit: 2, delay: 5000, backoff: "exponential" }, timeout: 5 * 60 * 1000 }, async () => {
          const done = await ports.advance(commit, context);
          if (!done.advanced) {
            throw new Error(done.error ?? "the integration branch was not advanced");
          }
          return done;
        });
      } catch (error) {
        advanced = { advanced: false, error: error instanceof Error ? error.message : String(error) };
      }
      await steps.do(`advanced-${plan.key}`, NO_RETRY, () => ports.recordAdvance(plan.key, advanced));
    }
  }
  await steps.do(`finish-max`, NO_RETRY, () => ports.finish(instanceId, true));
  return { iterations: MAX_ITERATIONS, recorded, stop: "max-iterations" };
}

/** The real ports: the Change's ChangeState and GateRunner, and the Artifacts provisioner. */
export function workerIntegrationPorts(env: EnvWithProvisioner, changeId: string): IntegrationPorts {
  const state = () => env.CHANGE_STATE.get(env.CHANGE_STATE.idFromName(changeId));
  const runner = () => {
    if (!env.GATE_RUNNER) {
      throw new Error("this Worker has no GATE_RUNNER binding");
    }
    return env.GATE_RUNNER.get(env.GATE_RUNNER.idFromName(changeId));
  };
  const provisioner = selectProvisioner(env);
  /** Mint the tokens a job needs, run it, and always revoke them. */
  const withTokens = async <T>(
    wanted: readonly { readonly workspaceName: string; readonly gitUrl: string; readonly scope: "read" | "write" }[],
    ttlSeconds: number,
    use: (repos: Record<string, string>) => Promise<T>,
  ): Promise<T> => {
    const issued: { workspaceName: string; tokenId: string }[] = [];
    try {
      const repos: Record<string, string> = {};
      for (const w of wanted) {
        const issue = w.scope === "read" ? provisioner.issueReadToken?.bind(provisioner) : provisioner.issueWriteToken?.bind(provisioner);
        if (!issue) {
          throw new Error(`this Worker cannot issue ${w.scope} tokens`);
        }
        const token = await issue(w.workspaceName, ttlSeconds);
        issued.push({ workspaceName: w.workspaceName, tokenId: token.tokenId });
        repos[repoPathOf(w.gitUrl)] = token.token;
      }
      return await use(repos);
    } finally {
      for (const t of issued) {
        await provisioner.revoke(t.workspaceName, t.tokenId).catch(() => undefined);
      }
    }
  };
  const ttlFor = (deadlineMs: number) => Math.min(3600, Math.max(120, Math.ceil(deadlineMs / 1000) + 120));
  return {
    plan: () => state().planCloudIntegration() as Promise<PlannedCloudJob>,
    async run(plan, context) {
      const hosts = new Set([context.integration.gitUrl, ...plan.agents.map((a) => a.gitUrl)].map(repoHostOf));
      if (hosts.size !== 1) {
        return { key: plan.key, error: "the job's repos are not on one Artifacts host", phases: [] };
      }
      return withTokens(
        [
          ...plan.agents.map((a) => ({ workspaceName: a.workspaceName, gitUrl: a.gitUrl, scope: "read" as const })),
          { workspaceName: context.integration.workspaceName, gitUrl: context.integration.gitUrl, scope: "write" as const },
        ],
        ttlFor(context.deadlineMs),
        (repos) =>
          runner().runJob({
            key: plan.key,
            job: plan.job,
            artifactsHost: [...hosts][0]!,
            registryHost: context.registryHost,
            repos,
            deadlineMs: context.deadlineMs,
          }),
      );
    },
    record: (input) =>
      state().recordCloudRevision({
        plan: input.plan,
        ...(input.outcome?.result && input.outcome.result.kind === "integrate" ? { result: input.outcome.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : input.outcome?.error !== undefined ? { error: input.outcome.error } : {}),
        phases: input.outcome?.phases ?? [],
        ...(input.transient ? { transient: true } : {}),
      }),
    async advance(commit, context) {
      const deadlineMs = 3 * 60 * 1000;
      const outcome = await withTokens(
        [{ workspaceName: context.integration.workspaceName, gitUrl: context.integration.gitUrl, scope: "write" }],
        ttlFor(deadlineMs),
        (repos) =>
          runner().runJob({
            key: `advance-${commit}`,
            job: {
              version: INTEGRATE_JOB_VERSION,
              kind: "advance",
              integration: { repoUrl: context.integration.gitUrl, defaultBranch: context.integration.defaultBranch },
              commit,
            },
            artifactsHost: repoHostOf(context.integration.gitUrl),
            registryHost: context.registryHost,
            repos,
            deadlineMs,
          }),
      );
      const result = outcome.result;
      if (result?.kind === "advance") {
        return result.advanced ? { advanced: true } : { advanced: false, error: result.error ?? "not advanced" };
      }
      return { advanced: false, error: outcome.error ?? "the advance job produced no result" };
    },
    recordAdvance: (key, outcome) => state().recordCloudAdvance(key, outcome),
    requestAttribution: (plan, result) => state().requestCloudAttribution(plan, result),
    finish: (instanceId, force) => state().finishCloudIntegration(instanceId, { force }),
  };
}

export class IntegrationWorkflow extends WorkflowEntrypoint<EnvWithProvisioner, IntegrationWorkflowParams> {
  override async run(event: WorkflowEvent<IntegrationWorkflowParams>, step: WorkflowStep): Promise<IntegrationLoopResult> {
    const steps: IntegrationSteps = {
      do: (name, config, run) => step.do(name, config, run as () => Promise<never>) as Promise<never>,
      waitForEvent: (name, type, timeoutMs) => step.waitForEvent(name, { type, timeout: timeoutMs }),
    };
    return runIntegrationLoop(workerIntegrationPorts(this.env, event.payload.changeId), steps, event.payload.instanceId);
  }
}
