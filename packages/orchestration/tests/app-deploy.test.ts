/**
 * The per-app deployment registry: the stable worker name scheme and the
 * per-app marker a manual deploy writes, a run reads to decide whether to
 * redeploy in place, and teardown clears. Pure filesystem, no network.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearAppDeployment,
  markerPath,
  readAppDeployment,
  recordAppDeployment,
  stableAppWorkerName,
} from "../src/app-deploy.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scf-appdeploy-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("per-app deployment registry (M8.4)", () => {
  it("derives a STABLE worker name from the app, not a run id", () => {
    expect(stableAppWorkerName("todo-api")).toBe("switchyard-change-fabric-todo-api");
    // Deterministic: the same app always maps to the same name, so the broken
    // deploy and the post-fix redeploy share one URL.
    expect(stableAppWorkerName("todo-api")).toBe(stableAppWorkerName("todo-api"));
    expect(markerPath(root, "todo-api")).toContain(".deployments");
  });

  it("reads undefined before a manual deploy (so the run deploys nothing)", async () => {
    expect(await readAppDeployment(root, "todo-api")).toBeUndefined();
  });

  it("records a manual deploy and reads it back (so the run redeploys in place)", async () => {
    const marker = await recordAppDeployment(
      root,
      "todo-api",
      "https://switchyard-change-fabric-todo-api.example.workers.dev",
    );
    expect(marker.workerName).toBe("switchyard-change-fabric-todo-api");
    expect(marker.url).toBe("https://switchyard-change-fabric-todo-api.example.workers.dev");

    const readBack = await readAppDeployment(root, "todo-api");
    expect(readBack?.url).toBe("https://switchyard-change-fabric-todo-api.example.workers.dev");
    expect(readBack?.workerName).toBe("switchyard-change-fabric-todo-api");
  });

  it("clears the marker on teardown (so a later run sees the app as undeployed)", async () => {
    await recordAppDeployment(root, "todo-api", "https://x.example.workers.dev");
    expect(await readAppDeployment(root, "todo-api")).toBeDefined();

    await clearAppDeployment(root, "todo-api");
    expect(await readAppDeployment(root, "todo-api")).toBeUndefined();
    // Clearing an already-missing marker is a safe no-op.
    await clearAppDeployment(root, "todo-api");
  });
});
