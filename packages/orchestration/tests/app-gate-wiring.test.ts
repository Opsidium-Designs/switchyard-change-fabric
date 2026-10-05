/**
 * Prove the REAL run path wires the per-app verification gate and the bounded
 * model-escalation ladder for a real-app project, and does NOT for a no-gate
 * project. This is the regression guard for the diagnosed bug: the gate and the
 * ladder were implemented in run-live but never wired into the entrypoints, so
 * every real run skipped them. buildAppGateWiring is the single decision the CLI
 * run-live command and the console-driven run use to build those run options, so
 * asserting on it proves the real path threads appGateCommandFor +
 * verifyCommandRunner + escalationModel for a real app and leaves them off for a
 * project with no gate.
 *
 * It also exercises projectHasGateScript against the real example app and the
 * real intro change target on disk, so the honest "a real app has a gate, the
 * intro change target does not" split is checked against the shipped fixtures,
 * not a hand-waved boolean. Everything here is pure/offline (no spawn, no fetch,
 * no inference), so it runs under `make check`.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  APP_GATE_COMMAND,
  buildAppGateWiring,
  projectHasGateScript,
} from "../src/app-gate-wiring.ts";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

/** The repo root, four levels up from packages/orchestration/tests. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A deterministic command runner fake, so the decision stays offline. */
class FakeRunner implements CommandRunner {
  async run(): Promise<CommandOutcome> {
    return { code: 0, stdout: "", stderr: "" };
  }
}

describe("buildAppGateWiring", () => {
  it("wires the gate, command runner, and escalation model for a real-app project on the live executor", () => {
    const runner = new FakeRunner();
    const wiring = buildAppGateWiring({
      projectHasGate: true,
      executorLive: true,
      escalationModel: "@cf/zai-org/glm-5.3",
      baseModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      maxModelRetries: 1,
      commandRunner: runner,
    });

    expect(wiring.enabled).toBe(true);
    // The gate command is the per-app `npm run gate`, and the SAME command
    // applies to every unit of the app (the gate verifies the whole app).
    expect(wiring.appGateCommandFor).toBeTypeOf("function");
    expect(wiring.appGateCommandFor?.("unit-a")).toEqual(APP_GATE_COMMAND);
    expect(wiring.appGateCommandFor?.("unit-b")).toEqual(APP_GATE_COMMAND);
    // The real command runner is threaded through (here the injected fake).
    expect(wiring.verifyCommandRunner).toBe(runner);
    // On a live executor the escalation + base model ids drive the ladder.
    expect(wiring.escalationModel).toBe("@cf/zai-org/glm-5.3");
    expect(wiring.baseModel).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(wiring.maxModelRetries).toBe(1);
  });

  it("does NOT wire the gate or ladder for a project with no gate script", () => {
    const wiring = buildAppGateWiring({
      projectHasGate: false,
      executorLive: true,
      escalationModel: "@cf/zai-org/glm-5.3",
      baseModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      maxModelRetries: 1,
      commandRunner: new FakeRunner(),
    });

    // A non-app project keeps today's behavior: no forced gate, no ladder.
    expect(wiring.enabled).toBe(false);
    expect(wiring.appGateCommandFor).toBeUndefined();
    expect(wiring.verifyCommandRunner).toBeUndefined();
    expect(wiring.escalationModel).toBeUndefined();
    expect(wiring.baseModel).toBeUndefined();
    expect(wiring.maxModelRetries).toBeUndefined();
  });

  it("suppresses the escalation and base model ids on the deterministic noop executor", () => {
    const wiring = buildAppGateWiring({
      projectHasGate: true,
      executorLive: false,
      escalationModel: "@cf/zai-org/glm-5.3",
      baseModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      maxModelRetries: 2,
      commandRunner: new FakeRunner(),
    });

    // The gate still runs (mechanical ground truth), but a noop executor has no
    // models to escalate between, so the escalation/base ids are empty: the
    // ladder cannot escalate and the base gate verdict is terminal.
    expect(wiring.enabled).toBe(true);
    expect(wiring.appGateCommandFor?.("u")).toEqual(APP_GATE_COMMAND);
    expect(wiring.escalationModel).toBe("");
    expect(wiring.baseModel).toBe("");
    expect(wiring.maxModelRetries).toBe(2);
  });

  it("honors --gate / --no-gate overrides regardless of the project's gate script", () => {
    const forcedOn = buildAppGateWiring({
      projectHasGate: false,
      gateFlag: true,
      executorLive: false,
      escalationModel: "",
      baseModel: "",
      maxModelRetries: 1,
      commandRunner: new FakeRunner(),
    });
    expect(forcedOn.enabled).toBe(true);
    expect(forcedOn.appGateCommandFor?.("u")).toEqual(APP_GATE_COMMAND);

    const forcedOff = buildAppGateWiring({
      projectHasGate: true,
      gateFlag: false,
      executorLive: true,
      escalationModel: "@cf/zai-org/glm-5.3",
      baseModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      maxModelRetries: 1,
      commandRunner: new FakeRunner(),
    });
    expect(forcedOff.enabled).toBe(false);
    expect(forcedOff.appGateCommandFor).toBeUndefined();
  });
});

describe("projectHasGateScript (real shipped fixtures)", () => {
  it("reports a gate script for a real example app and none for the intro change target", async () => {
    // A real app (service-api) declares a `gate` script, so a run against it is
    // gated; the intro change target (demo-project) does not, so a run against
    // it is NOT forced through a gate it does not have (honest cannot-pass vs
    // auto-pass split).
    const realApp = resolve(REPO_ROOT, "examples/apps/service-api");
    const introTarget = resolve(REPO_ROOT, "examples/demo-project");

    expect(await projectHasGateScript(realApp)).toBe(true);
    expect(await projectHasGateScript(introTarget)).toBe(false);
    // A directory with no package.json is simply "no gate".
    expect(await projectHasGateScript(resolve(REPO_ROOT, "examples/goals"))).toBe(false);
  });
});
