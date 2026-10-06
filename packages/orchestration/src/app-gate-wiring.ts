/**
 * app-gate-wiring: decide how the per-app verification gate and the bounded
 * model-escalation ladder are wired into a real run.
 *
 * The per-app gate and the ladder in run-live are only active when the run
 * supplies `appGateCommandFor` + `verifyCommandRunner` (and, to escalate, an
 * `escalationModel`). The entrypoints (the CLI run-live command and the console
 * launcher that drives it) need a single, testable place that decides, for a
 * given target project, WHETHER the gate applies and WHAT options to pass:
 *
 *   - a real app (its package.json declares a `gate` script) runs the gate on
 *     every unit and drives the ladder;
 *   - a non-app project (no `gate` script, for example the intro change target)
 *     keeps today's behavior: no forced gate, so an honest run does not fake a
 *     gate the project does not have.
 *
 * This module is pure (no process, no fetch) and the gate command / project
 * check it exposes are deterministic, so the decision is unit-testable offline
 * under `make check` without spawning a child process or touching the network.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ChildProcessCommandRunner,
  type CommandRunner,
} from "@switchyard-change/verification";

/** The npm script name each real example app declares as its mechanical gate. */
export const APP_GATE_SCRIPT = "gate";

/** The argv that runs an app's `gate` npm script in the app project directory. */
export const APP_GATE_COMMAND: readonly string[] = ["npm", "run", APP_GATE_SCRIPT];

/**
 * Read a project's package.json and report whether it declares a `gate` npm
 * script. A real example app does; the intro change target (and any plain
 * project) does not. A missing or unreadable package.json is simply "no gate",
 * so a non-app project is never forced through a gate it does not have.
 */
export async function projectHasGateScript(projectDir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(projectDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const script = parsed.scripts?.[APP_GATE_SCRIPT];
    return typeof script === "string" && script.trim() !== "";
  } catch {
    return false;
  }
}

/** The inputs the gate-wiring decision needs, independent of process/fetch. */
export interface AppGateWiringInput {
  /** True when the target project declares a `gate` npm script (a real app). */
  readonly projectHasGate: boolean;
  /**
   * The gate toggle: `true` forces the gate on, `false` forces it off, and
   * `undefined` means "default" (on when the project has a gate script). The
   * CLI maps --gate/--no-gate to this; the console leaves it undefined so the
   * auto-enable-on-gate-script default applies.
   */
  readonly gateFlag?: boolean;
  /** True when the selected executor is a real inference path (Workers AI). */
  readonly executorLive: boolean;
  /** The verify-fail escalation model id (from the environment). */
  readonly escalationModel: string;
  /**
   * The ORDERED escalation model ladder (from the environment): each retry round
   * uses the next entry. Optional; when omitted the wiring falls back to a
   * one-element list built from `escalationModel`, so existing callers are
   * unchanged.
   */
  readonly escalationModels?: readonly string[];
  /** The base model id (informational, recorded on the base verify attempt). */
  readonly baseModel: string;
  /** The bounded max RETRY attempts past the base attempt (default 1). */
  readonly maxModelRetries: number;
  /**
   * The command runner the gate runs through. Defaults to the verification
   * package's real child-process runner on the live path; a test injects a
   * deterministic fake so the decision stays offline.
   */
  readonly commandRunner?: CommandRunner;
}

/**
 * The gate-related subset of run-live options this decision produces. These are
 * spread into the runFullLive options object by the entrypoint. When the gate
 * does not apply the whole shape is empty, so run-live keeps today's behavior
 * (no gate, no ladder) for a non-app project.
 */
export interface AppGateWiring {
  /** True when the gate applies to this run (a real app with the gate enabled). */
  readonly enabled: boolean;
  /** The per-unit gate command resolver (the same per-app command every unit). */
  readonly appGateCommandFor?: (unitId: string) => readonly string[] | undefined;
  /** The injectable command runner the gate and final verify run through. */
  readonly verifyCommandRunner?: CommandRunner;
  /** The model a verify-fail retry escalates to (only on a live executor). */
  readonly escalationModel?: string;
  /**
   * The ORDERED escalation model ladder (only on a live executor): each retry
   * round steps to the next entry. Empty off the live path.
   */
  readonly escalationModels?: readonly string[];
  /** The base model recorded on the base verify attempt (only on a live executor). */
  readonly baseModel?: string;
  /** The bounded max retries dial for the ladder. */
  readonly maxModelRetries?: number;
}

/**
 * Decide the gate wiring for a run. The gate is enabled when the project has a
 * `gate` script and the toggle does not force it off, OR when the toggle forces
 * it on. When enabled, every unit of the app shares the one per-app gate command
 * (the gate verifies the whole app, not one unit), the real command runner is
 * used unless a fake is injected, and the escalation/base model ids are passed
 * only when the executor is a live inference path (the deterministic noop has no
 * models to escalate between). When disabled, the result is empty so run-live
 * runs with no gate and no ladder.
 */
export function buildAppGateWiring(input: AppGateWiringInput): AppGateWiring {
  const enabled = input.gateFlag ?? input.projectHasGate;
  if (!enabled) {
    return { enabled: false };
  }
  const runner = input.commandRunner ?? new ChildProcessCommandRunner();
  // The gate is per-app (the whole app), so the same gate command applies to
  // every unit of that app. It runs in the unit's cloned worktree, which is a
  // seeded copy of the app project (package.json + gate/ live there), so
  // `npm run gate` resolves exactly as it does in the app directory.
  const appGateCommandFor = (_unitId: string): readonly string[] | undefined => APP_GATE_COMMAND;
  const escalationModel = input.executorLive ? input.escalationModel : "";
  // The ordered ladder travels alongside the single escalation model: prefer the
  // explicit list, else fall back to a one-element list built from the single
  // model so existing callers are unchanged. Empty off the live path.
  const escalationModels = input.executorLive
    ? input.escalationModels && input.escalationModels.length > 0
      ? input.escalationModels
      : escalationModel !== ""
        ? [escalationModel]
        : []
    : [];
  const baseModel = input.executorLive ? input.baseModel : "";
  return {
    enabled: true,
    appGateCommandFor,
    verifyCommandRunner: runner,
    escalationModel,
    escalationModels,
    baseModel,
    maxModelRetries: input.maxModelRetries,
  };
}
