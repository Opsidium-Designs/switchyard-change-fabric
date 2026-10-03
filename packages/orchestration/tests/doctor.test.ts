/**
 * Deterministic unit tests for the doctor readiness check. The command runner
 * and environment are injected so no real tool is probed: the check's logic
 * (required vs optional, best-effort auth, executor modes) is tested in full
 * isolation, offline.
 */

import { describe, expect, it } from "vitest";

import { formatDoctorReport, runDoctor } from "../src/index.ts";

/** Build a fake command runner from a map of "program args..." to stdout. */
function fakeRunner(responses: Record<string, string | Error>) {
  return async (program: string, args: readonly string[]): Promise<string> => {
    const key = [program, ...args].join(" ");
    const value = responses[key];
    if (value === undefined || value instanceof Error) {
      throw value ?? new Error(`command not found: ${key}`);
    }
    return value;
  };
}

describe("doctor", () => {
  it("reports ready when Node and Git are present, even with no Cloudflare", async () => {
    const report = await runDoctor({
      env: {},
      runCommand: fakeRunner({
        "git --version": "git version 2.40.0",
        // wrangler and whoami are absent (throw).
      }),
    });

    expect(report.ready).toBe(true);
    const git = report.checks.find((c) => c.name === "Git");
    expect(git?.status).toBe("ok");
    const wrangler = report.checks.find((c) => c.name === "wrangler");
    expect(wrangler?.status).toBe("missing");
    expect(wrangler?.required).toBe(false);

    // noop executor is always available.
    const noop = report.checks.find((c) => c.name === "Executor: noop");
    expect(noop?.status).toBe("ok");

    // The report never throws and reads cleanly.
    const text = formatDoctorReport(report);
    expect(text).toContain("local readiness report");
    expect(text).toContain("Ready:");
  });

  it("is not ready when Git is missing (a required tool)", async () => {
    const report = await runDoctor({
      env: {},
      runCommand: fakeRunner({}),
    });
    expect(report.ready).toBe(false);
    expect(formatDoctorReport(report)).toContain("Not ready");
  });

  it("reports Cloudflare auth ok when logged in", async () => {
    const report = await runDoctor({
      env: {},
      runCommand: fakeRunner({
        "git --version": "git version 2.40.0",
        "npx wrangler --version": "4.0.0",
        "npx wrangler whoami": "You are logged in with account someone@example.com",
      }),
    });
    const auth = report.checks.find((c) => c.name === "Cloudflare auth");
    expect(auth?.status).toBe("ok");
  });

  it("reports the openai-compatible mode as available when a model is configured", async () => {
    const report = await runDoctor({
      env: { AI_GATEWAY_MODEL: "someprovider/some-model" },
      runCommand: fakeRunner({ "git --version": "git version 2.40.0" }),
    });
    const openai = report.checks.find((c) => c.name === "Executor: openai-compatible");
    expect(openai?.status).toBe("ok");
    expect(openai?.detail).toContain("someprovider/some-model");
  });

  it("treats the placeholder model value as not configured", async () => {
    const report = await runDoctor({
      env: { AI_GATEWAY_MODEL: "provider/model" },
      runCommand: fakeRunner({ "git --version": "git version 2.40.0" }),
    });
    const openai = report.checks.find((c) => c.name === "Executor: openai-compatible");
    expect(openai?.status).toBe("unknown");
  });
});
