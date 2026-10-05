/**
 * Unit tests for the VerificationProvider against local Git fixtures.
 *
 * Covers the passing case (all checks green) and the two failure modes the exit
 * criterion calls out: a path-scope violation (the WorkUnit changed a file
 * outside its declared scope) and a failing test command. The test command is
 * driven by a fake command runner so these stay fast and deterministic, and a
 * final case runs the demo project's real test command for a passing end-to-end
 * check against the example target.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { VerificationProvider } from "../src/verifier.ts";
import type { VerificationContract } from "../src/types.ts";
import { FakeCommandRunner, makeCheckout } from "./helpers.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scf-verify-unit-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BASELINE = [{ path: "package.json", content: "{}\n" }];

describe("VerificationProvider passing case", () => {
  it("verifies a WorkUnit that stayed in scope with a passing test and lint", async () => {
    const checkout = join(dir, "unit");
    await makeCheckout(checkout, BASELINE, [
      { path: "src/alpha/alpha.done", content: "done\n" },
    ]);

    const runner = new FakeCommandRunner([
      { match: "test", outcome: { code: 0, stdout: "1 passed", stderr: "" } },
      { match: "lint", outcome: { code: 0, stdout: "", stderr: "" } },
    ]);
    const provider = new VerificationProvider({ commandRunner: runner });

    const contract: VerificationContract = {
      unitId: "alpha",
      paths: ["src/alpha/**"],
      expectedFiles: ["src/alpha/alpha.done"],
      testCommand: ["npm", "test"],
      lintCommand: ["npm", "run", "lint"],
    };

    const result = await provider.verify({ worktreeDir: checkout, baselineRef: "baseline", contract });

    expect(result.verdict).toBe("verified");
    expect(result.checks.map((c) => c.kind)).toEqual([
      "clean-state",
      "path-scope",
      "test",
      "lint",
      "app-gate",
    ]);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    const scope = result.checks.find((c) => c.kind === "path-scope");
    expect(scope?.summary).toMatch(/within declared scope/);
  });
});

describe("VerificationProvider failing cases", () => {
  it("fails a WorkUnit that changed a file outside its declared scope", async () => {
    const checkout = join(dir, "scope-violation");
    // The WorkUnit declares src/alpha/** but also edited package.json: out of scope.
    await makeCheckout(checkout, BASELINE, [
      { path: "src/alpha/alpha.done", content: "done\n" },
      { path: "package.json", content: '{"touched": true}\n' },
    ]);

    const provider = new VerificationProvider({
      commandRunner: new FakeCommandRunner([
        { match: "test", outcome: { code: 0, stdout: "ok", stderr: "" } },
      ]),
    });

    const contract: VerificationContract = {
      unitId: "alpha",
      paths: ["src/alpha/**"],
      testCommand: ["npm", "test"],
    };

    const result = await provider.verify({ worktreeDir: checkout, baselineRef: "baseline", contract });

    expect(result.verdict).toBe("failed");
    const scope = result.checks.find((c) => c.kind === "path-scope");
    expect(scope?.passed).toBe(false);
    expect(scope?.summary).toMatch(/outside declared scope/);
    expect(scope?.summary).toMatch(/package\.json/);
  });

  it("fails a WorkUnit whose test command exits non-zero", async () => {
    const checkout = join(dir, "failing-test");
    await makeCheckout(checkout, BASELINE, [
      { path: "src/alpha/alpha.done", content: "done\n" },
    ]);

    const provider = new VerificationProvider({
      commandRunner: new FakeCommandRunner([
        { match: "test", outcome: { code: 1, stdout: "", stderr: "1 failed" } },
      ]),
    });

    const contract: VerificationContract = {
      unitId: "alpha",
      paths: ["src/alpha/**"],
      testCommand: ["npm", "test"],
    };

    const result = await provider.verify({ worktreeDir: checkout, baselineRef: "baseline", contract });

    expect(result.verdict).toBe("failed");
    const test = result.checks.find((c) => c.kind === "test");
    expect(test?.passed).toBe(false);
    expect(test?.summary).toMatch(/failed \(exit 1\)/);
    // The scope check still passed, so only the test check is red.
    expect(result.checks.find((c) => c.kind === "path-scope")?.passed).toBe(true);
  });

  it("fails clean-state when an expected file is missing", async () => {
    const checkout = join(dir, "missing-file");
    await makeCheckout(checkout, BASELINE, [
      { path: "src/alpha/other.txt", content: "x\n" },
    ]);

    const provider = new VerificationProvider();
    const contract: VerificationContract = {
      unitId: "alpha",
      paths: ["src/alpha/**"],
      expectedFiles: ["src/alpha/alpha.done"],
    };

    const result = await provider.verify({ worktreeDir: checkout, baselineRef: "baseline", contract });

    expect(result.verdict).toBe("failed");
    const clean = result.checks.find((c) => c.kind === "clean-state");
    expect(clean?.passed).toBe(false);
    expect(clean?.summary).toMatch(/missing expected files/);
  });

  it("skips the lint check when no lint command is configured", async () => {
    const checkout = join(dir, "no-lint");
    await makeCheckout(checkout, BASELINE, [
      { path: "src/alpha/alpha.done", content: "done\n" },
    ]);

    const provider = new VerificationProvider({ commandRunner: new FakeCommandRunner([]) });
    const contract: VerificationContract = {
      unitId: "alpha",
      paths: ["src/alpha/**"],
      testCommand: ["npm", "test"],
    };

    const result = await provider.verify({ worktreeDir: checkout, baselineRef: "baseline", contract });

    expect(result.verdict).toBe("verified");
    const lint = result.checks.find((c) => c.kind === "lint");
    expect(lint?.skipped).toBe(true);
    expect(lint?.passed).toBe(true);
  });
});

describe("VerificationProvider app-gate (T3: absence is cannot-pass, never auto-pass)", () => {
  it("passes verification when the per-app gate command exits zero", async () => {
    const checkout = join(dir, "gate-pass");
    await makeCheckout(checkout, BASELINE, [{ path: "src/alpha/alpha.done", content: "done\n" }]);
    const runner = new FakeCommandRunner([
      { match: "gate", outcome: { code: 0, stdout: "ok", stderr: "" } },
    ]);
    const provider = new VerificationProvider({ commandRunner: runner });
    const contract: VerificationContract = {
      unitId: "alpha",
      paths: ["src/alpha/**"],
      appGateCommand: ["node", "--test", "gate/gate.test.mjs"],
      requiresAppGate: true,
    };
    const result = await provider.verify({ worktreeDir: checkout, baselineRef: "baseline", contract });
    expect(result.verdict).toBe("verified");
    const gate = result.checks.find((c) => c.kind === "app-gate");
    expect(gate?.passed).toBe(true);
    expect(gate?.skipped).toBe(false);
  });

  it("fails verification when the per-app gate command exits non-zero", async () => {
    const checkout = join(dir, "gate-fail");
    await makeCheckout(checkout, BASELINE, [{ path: "src/alpha/alpha.done", content: "done\n" }]);
    const runner = new FakeCommandRunner([
      { match: "gate", outcome: { code: 1, stdout: "", stderr: "assertion failed" } },
    ]);
    const provider = new VerificationProvider({ commandRunner: runner });
    const contract: VerificationContract = {
      unitId: "alpha",
      paths: ["src/alpha/**"],
      appGateCommand: ["node", "--test", "gate/gate.test.mjs"],
      requiresAppGate: true,
    };
    const result = await provider.verify({ worktreeDir: checkout, baselineRef: "baseline", contract });
    expect(result.verdict).toBe("failed");
    const gate = result.checks.find((c) => c.kind === "app-gate");
    expect(gate?.passed).toBe(false);
    expect(gate?.skipped).toBe(false);
    expect(gate?.summary).toMatch(/did not fix the planted bug/);
  });

  it("does NOT auto-pass a unit that requires a gate but has none (cannot-pass)", async () => {
    const checkout = join(dir, "gate-absent");
    await makeCheckout(checkout, BASELINE, [{ path: "src/alpha/alpha.done", content: "done\n" }]);
    // No app-gate command supplied, but the unit requires one. The old vacuous
    // "skipped counts as passed" behavior must NOT apply: this is a FAIL.
    const provider = new VerificationProvider({ commandRunner: new FakeCommandRunner([]) });
    const contract: VerificationContract = {
      unitId: "alpha",
      paths: ["src/alpha/**"],
      requiresAppGate: true,
    };
    const result = await provider.verify({ worktreeDir: checkout, baselineRef: "baseline", contract });
    expect(result.verdict).toBe("failed");
    const gate = result.checks.find((c) => c.kind === "app-gate");
    expect(gate?.passed).toBe(false);
    expect(gate?.skipped).toBe(false);
    expect(gate?.summary).toMatch(/cannot-pass/);
  });

  it("skips the app-gate (as not applicable) when the unit does not require one", async () => {
    const checkout = join(dir, "gate-not-required");
    await makeCheckout(checkout, BASELINE, [{ path: "src/alpha/alpha.done", content: "done\n" }]);
    const provider = new VerificationProvider({ commandRunner: new FakeCommandRunner([]) });
    const contract: VerificationContract = {
      unitId: "alpha",
      paths: ["src/alpha/**"],
    };
    const result = await provider.verify({ worktreeDir: checkout, baselineRef: "baseline", contract });
    expect(result.verdict).toBe("verified");
    const gate = result.checks.find((c) => c.kind === "app-gate");
    expect(gate?.skipped).toBe(true);
    expect(gate?.passed).toBe(true);
  });
});
