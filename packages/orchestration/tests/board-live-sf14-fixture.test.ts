/**
 * The failed storefront run board-live-sf14 (fixtures/board-live-sf14.log.json,
 * its 127 board messages; work-root paths scrubbed, no credential, no local
 * path): each agent has ONE repo for every item it holds. agent-4 held
 * unit-billing-invoices (src/billing/invoices.ts; its push was recorded as a
 * ratchet regressor), unit-orders-cart (src/orders/cart.ts), and the seam item
 * seam-agent-4-contract-1 (src/store.ts). Its seam pushes announced
 * src/store.ts, but its repo head also carried its invoices edits, so every
 * seam push was excluded: "path-scope: changed 1 path(s) outside declared
 * scope: src/billing/invoices.ts" (seq 101, 106, 111, 120). The seam change
 * (`user` on Ctx) never landed and unit-orders-history failed typecheck
 * forever.
 *
 * Replayed to seq 100 (the first seam push pending) with agent-4's recorded
 * commits remapped onto a real local repo of the same shape: the plan now
 * yields the invoices file (agent-4 still holds that item; it rides with that
 * item's own push) and applies each pending item's files from its own push
 * commit. The seam push that was excluded before is applied after, and a
 * leave-one-out candidate without agent-4 removes exactly its paths.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { foldBoard, planBoardIntegration, reduceBoard, type BoardIntegrationUnitPlan, type BoardMessage } from "@switchyard-change/change-core";
import { ChangeVerification, type CompletedWorkUnit } from "@switchyard-change/verification";

import { completedFromPlan, type IntegrateBoardOptions } from "../src/run-board.ts";
import { createIntegrationWorkspace } from "../src/run-live.ts";
import { gateCandidateTree, type CandidateContext } from "../src/speculative-integration.ts";

const git = promisify(execFile);
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "board-live-sf14.log.json");
const RAW = await readFile(FIXTURE, "utf8");
const log = JSON.parse(RAW) as BoardMessage[];
const IDENTITY = { name: "Fixture", email: "fixture@test.local" };

/** agent-4's recorded commits: its invoices push, its cart push, its first seam push. */
const INVOICES = "22b19bfb210283e4fad3c5dc86145c7da9017eeb";
const CART = "8a93c50110ce9bb629bccaaae853a5379760a892";
const SEAM = "945ae8236420bb58e162da2a33cd697fb41b4544";
/** agent-2's unit-billing-tax and unit-orders-history pushes (both pending at seq 100). */
const TAX = "088f19e5148434d6826642cfdf9a82062a282b6e";
const HISTORY = "65ecdca85766d14a31aa5584af542bd3e3382218";

const BASELINE: Record<string, string> = {
  "package.json": '{"name":"storefront"}\n',
  "src/store.ts": "export interface Ctx { readonly id: string }\n",
  "src/billing/invoices.ts": "export const invoices = 0;\n",
  "src/orders/cart.ts": "export const cart = 0;\n",
  "src/orders/history.ts": "export const history = 0;\n",
  "src/billing/tax.ts": "export const tax = 0;\n",
};

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git("git", ["-C", dir, "add", "-A"]);
  await git("git", ["-C", dir, "-c", "user.name=A", "-c", "user.email=a@x", "commit", "-q", "-m", message]);
  return (await git("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
}

/** An agent's overlay repo: one commit per entry (its files), in order. */
async function agentRepo(dir: string, commits: readonly Record<string, string>[]): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  await git("git", ["-C", dir, "init", "-q", "--initial-branch=main"]);
  const out: string[] = [];
  for (const [i, files] of commits.entries()) {
    await writeFiles(dir, files);
    out.push(await commitAll(dir, `push ${i + 1}`));
  }
  return out;
}

async function scenario() {
  const root = await mkdtemp(join(tmpdir(), "scf-sf14-"));
  const projectDir = join(root, "project");
  await writeFiles(projectDir, BASELINE);
  // agent-4's repo: invoices push, then cart, then the seam push (its head carries all three).
  const a4 = join(root, "agent-4");
  const [inv, cart, seam] = await agentRepo(a4, [
    { "src/billing/invoices.ts": "export const invoices = 'agent-4 invoices work';\n" },
    { "src/orders/cart.ts": "export const cart = 'agent-4 cart';\n" },
    { "src/store.ts": "export interface Ctx { readonly id: string; readonly user?: { readonly id: string } }\n" },
  ]);
  const a2 = join(root, "agent-2");
  const [tax, history] = await agentRepo(a2, [
    { "src/billing/tax.ts": "export const tax = 'agent-2 tax';\n" },
    { "src/orders/history.ts": "export const history = 'needs ctx.user';\n" },
  ]);
  // The recorded log with agent-4's and agent-2's commits remapped onto the real ones.
  const remapped = JSON.parse(
    RAW.replaceAll(INVOICES, inv!).replaceAll(CART, cart!).replaceAll(SEAM, seam!).replaceAll(TAX, tax!).replaceAll(HISTORY, history!),
  ) as BoardMessage[];
  const upTo = remapped.filter((m) => m.seq <= 100);
  const state = foldBoard(remapped, 100);
  const plan = planBoardIntegration(upTo, state);
  const integration = await createIntegrationWorkspace(join(root, "work"), projectDir, "board-live-sf14", IDENTITY);
  const worktreeRoot = join(root, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });
  const unit = (agent: string): BoardIntegrationUnitPlan => plan.units.find((u) => u.agent === agent)!;
  const verify = (completed: CompletedWorkUnit[], units: readonly BoardIntegrationUnitPlan[]) =>
    new ChangeVerification(integration.workspaces).verifyAndIntegrate({
      change: {
        id: "board-live-sf14",
        objective: "o",
        baseline: "HEAD",
        budgetUsd: 0,
        assurance: "standard",
        work: units.map((u) => ({ id: u.agent, objective: u.agent, dependsOn: [], paths: [...u.scope] })),
      },
      completed,
      integrationRef: integration.integrationRef,
      integrationToken: integration.integrationToken,
      deferIntegrationPush: true,
      workRoot: worktreeRoot,
      identity: IDENTITY,
    });
  const fileAt = async (commit: string, rel: string): Promise<string | undefined> => {
    const dir = await mkdtemp(join(root, "check-"));
    await git("git", ["clone", "-q", integration.integrationRef.gitUrl, dir]);
    await git("git", ["-C", dir, "fetch", "-q", "origin", `refs/switchyard/gated/${commit}:refs/check`]).catch(() => undefined);
    return git("git", ["-C", dir, "show", `${commit}:${rel}`]).then(
      (r) => r.stdout,
      () => undefined,
    );
  };
  return { a2, a4, inv: inv!, cart: cart!, seam: seam!, history: history!, plan, unit, verify, fileAt, integration, worktreeRoot };
}

describe("the recorded storefront run board-live-sf14 (a seam push excluded for the agent's other item's file)", () => {
  it("replays unchanged, with no work-root or local path in it; the seam pushes were excluded for src/billing/invoices.ts", () => {
    expect(log).toHaveLength(127);
    expect(foldBoard(log)).toEqual(reduceBoard(log));
    expect(RAW).not.toMatch(/\/tmp\/scf-board-|\/home\//);
    const excluded = log.filter((m) => m.type === "push.excluded");
    expect(excluded.map((m) => m.seq)).toEqual([101, 106, 111, 120]);
    for (const m of excluded) {
      expect(m.type === "push.excluded" && m.payload).toMatchObject({
        item: "seam-agent-4-contract-1",
        reason: "failed verification (path-scope: changed 1 path(s) outside declared scope: src/billing/invoices.ts)",
      });
    }
  });

  it("at seq 100 agent-4's unit applies cart and seam each from its own push and yields the invoices file it still holds", () => {
    const state = foldBoard(log, 100);
    expect(state.items["unit-billing-invoices"]).toMatchObject({ owner: "agent-4", status: "claimed" });
    expect(state.items["unit-billing-invoices"]!.lastPush?.regressed).toBeDefined();
    const unit = planBoardIntegration(
      log.filter((m) => m.seq <= 100),
      state,
    ).units.find((u) => u.agent === "agent-4")!;
    expect(unit).toMatchObject({ commit: SEAM, includes: [CART], scope: ["src/orders/cart.ts", "src/store.ts"], yieldedScope: ["src/billing/invoices.ts"] });
    expect(unit.parts).toEqual([
      { item: "unit-orders-cart", commit: CART, baselineRef: "HEAD", scope: ["src/orders/cart.ts"] },
      { item: "seam-agent-4-contract-1", commit: SEAM, baselineRef: "HEAD", scope: ["src/store.ts"] },
    ]);
  });

  it("real local git: the seam push excluded before (whole head, no yield) is applied after; invoices stays with its own item", async () => {
    const env = await scenario();
    const u4 = env.unit("agent-4");
    // Before: the unit as a4f1f14 planned it (the whole pinned head, no yield of the held item).
    const before = await env.verify([completedFromPlan({ ...u4, yieldedScope: undefined, parts: undefined }, env.a4)], [u4]);
    expect(before.units[0]).toMatchObject({ unitId: "agent-4", verdict: "failed" });
    expect(before.units[0]!.checks.find((c) => c.kind === "path-scope")?.summary).toBe("changed 1 path(s) outside declared scope: src/billing/invoices.ts");

    // After: verified, and the gated tree is exactly cart + seam on the baseline.
    const after = await env.verify([completedFromPlan(u4, env.a4)], [u4]);
    expect(after.units[0]).toMatchObject({ unitId: "agent-4", verdict: "verified" });
    expect(after.integration.appliedUnits).toEqual([{ unitId: "agent-4", applied: ["src/orders/cart.ts", "src/store.ts"], yielded: ["src/billing/invoices.ts"] }]);
    const commit = after.integration.commit!;
    expect(await env.fileAt(commit, "src/store.ts")).toMatch(/readonly user\?/);
    expect(await env.fileAt(commit, "src/orders/cart.ts")).toBe("export const cart = 'agent-4 cart';\n");
    expect(await env.fileAt(commit, "src/billing/invoices.ts")).toBe(BASELINE["src/billing/invoices.ts"]);
  });

  it("speculative and leave-one-out candidates use the same selection: removing agent-4 removes exactly its paths", async () => {
    const env = await scenario();
    const options = {
      change: { id: "board-live-sf14", objective: "o" },
      integration: env.integration,
      worktreeRoot: env.worktreeRoot,
      identity: IDENTITY,
    } as unknown as IntegrateBoardOptions;
    const ctx: CandidateContext = { options, state: foldBoard(log, 100), scrub: (t) => t, requiresIntegrationGate: false };
    const both = [
      { unit: env.unit("agent-2"), remote: env.a2 },
      { unit: env.unit("agent-4"), remote: env.a4 },
    ];
    const whole = await gateCandidateTree(ctx, 1, both);
    expect(whole).toMatchObject({ mergedAgents: ["agent-2", "agent-4"], excludedAgents: [] });
    expect(whole.evidence!.integration.appliedUnits).toEqual([
      { unitId: "agent-2", applied: ["src/billing/tax.ts", "src/orders/history.ts"], yielded: [] },
      { unitId: "agent-4", applied: ["src/orders/cart.ts", "src/store.ts"], yielded: ["src/billing/invoices.ts"] },
    ]);
    const without = await gateCandidateTree(ctx, 2, both.slice(0, 1));
    expect(without.evidence!.integration.appliedUnits).toEqual([{ unitId: "agent-2", applied: ["src/billing/tax.ts", "src/orders/history.ts"], yielded: [] }]);
    expect(await env.fileAt(without.commit!, "src/store.ts")).toBe(BASELINE["src/store.ts"]);
    expect(await env.fileAt(without.commit!, "src/orders/cart.ts")).toBe(BASELINE["src/orders/cart.ts"]);
    expect(await env.fileAt(without.commit!, "src/orders/history.ts")).toBe("export const history = 'needs ctx.user';\n");
    expect(await env.fileAt(whole.commit!, "src/store.ts")).toMatch(/readonly user\?/);
  });
});
