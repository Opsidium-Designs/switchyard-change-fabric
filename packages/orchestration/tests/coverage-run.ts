/**
 * A scripted end-to-end board run that exercises the engine's newer message
 * types together, offline and deterministic: real local Git, the offline
 * local control (fixed clock), the real continuous integrator (speculative
 * batch gating, clash prediction), and a real promotion. Agents post through
 * their own board clients in a fixed order (no model, no policy), so the log
 * is the same every time:
 *
 *   - a warm-up pass, then a speculative round: x lands, y's push (it also
 *     changed a file outside its write intent) is recorded `push.excluded` to
 *     its holder, z is blamed; x and y's pushes are predicted to clash
 *     (`clash.predicted`) and every candidate is `candidate.gated`;
 *   - z's fix fails again, its budget is spent, and the lead re-plans it
 *     (`item.replanned`); the replacement lands;
 *   - y's holder never answers the exclusion, so its lease runs and lapses
 *     (`claim.lapsed`); the lead extends x's deadline once (`claim.extended`);
 *     another agent takes y and lands it;
 *   - the last passing revision is promoted (`revision.promoted`).
 *
 * The fixture generated from it lives in fixtures/board-coverage-run.log.json
 * (see board-coverage-fixture.test.ts). Not a replay of a live run: the
 * console's public replays hold real recorded runs only.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { BoardMessage } from "@switchyard-change/change-core";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { BoardAgentClient, BoardOperatorClient } from "../src/board-client.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { ContinuousBoardIntegrator } from "../src/run-board.ts";
import { createIntegrationWorkspace, promoteVerifiedIntegration } from "../src/run-live.ts";

const git = promisify(execFile);
const ID = "change-coverage";
const BASE = "http://local-control";
const IDENTITY = { name: "Coverage Integrator", email: "integrator@coverage.local" };
const EPOCH = "2026-01-01T00:00:00.000Z";

/** A gate that fails while src/z/c.ts carries "BAD", naming that file. */
class MarkerGate implements CommandRunner {
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const z = await readFile(join(cwd, "src/z/c.ts"), "utf8").catch(() => "");
    return z.includes("BAD")
      ? { code: 1, stdout: "not ok 1 - z\n# src/z/c.ts:1:1 AssertionError\n", stderr: "" }
      : { code: 0, stdout: "ok 1 - all\n", stderr: "" };
  }
}

/** Run the scripted scenario in a fresh scratch root; returns the recorded board log. */
export async function runCoverageScenario(): Promise<readonly BoardMessage[]> {
  const saved = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE };
  process.env.GIT_AUTHOR_DATE = EPOCH;
  process.env.GIT_COMMITTER_DATE = EPOCH;
  try {
    return await scenario();
  } finally {
    for (const [key, value] of [
      ["GIT_AUTHOR_DATE", saved.author],
      ["GIT_COMMITTER_DATE", saved.committer],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function scenario(): Promise<readonly BoardMessage[]> {
  const root = await mkdtemp(join(tmpdir(), "scf-coverage-"));
  const projectDir = join(root, "project");
  for (const [rel, body] of Object.entries({
    "package.json": '{"name":"p"}\n',
    "src/common.ts": "export const common = 0;\n",
    "src/w/d.ts": "export const d = 0;\n",
    "src/x/a.ts": "export const a = 0;\n",
    "src/y/b.ts": "export const b = 0;\n",
    "src/z/c.ts": "export const c = 0;\n",
  })) {
    await mkdir(dirname(join(projectDir, rel)), { recursive: true });
    await writeFile(join(projectDir, rel), body);
  }
  let tick = 0;
  const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }), {
    now: () => new Date(Date.parse(EPOCH) + 1000 * tick++),
  });
  const fetchFn = control.fetch as unknown as typeof fetch;
  const operator = new BoardOperatorClient(fetchFn, BASE, ID);
  const created = await fetchFn(`${BASE}/changes/planning`, { method: "POST", body: JSON.stringify({ id: ID, objective: "o" }) });
  if (created.status !== 201) {
    throw new Error(`the change could not be created (HTTP ${created.status})`);
  }
  const integration = await createIntegrationWorkspace(join(root, "work"), projectDir, ID, IDENTITY);
  const baseline = (await git("git", ["ls-remote", integration.integrationRef.gitUrl, `refs/heads/${integration.integrationRef.defaultBranch}`])).stdout.split(/\s+/)[0]!;
  const ok = (what: string, outcome: { ok: boolean; code?: string; error?: string }): void => {
    if (!outcome.ok) {
      throw new Error(`${what} refused: ${outcome.code} ${outcome.error}`);
    }
  };
  const human = async (draft: unknown) => ok("human", await operator.postAsHuman(draft));
  await human({
    type: "goal.posted",
    payload: {
      objective: "o",
      protected: ["package.json"],
      baseline,
      rules: { speculate: 3, arbitration: 2, maxFixAttempts: 1, claimLeaseMessages: 12, claimDeadlineMessages: 400, claimOverlap: true },
    },
  });
  const scopes: Record<string, string[]> = { w: ["src/w/**"], x: ["src/x/**", "src/common.ts"], y: ["src/y/**"], z: ["src/z/**"] };
  for (const item of Object.keys(scopes)) {
    await human({ type: "item.proposed", payload: { item, objective: `do ${item}`, scopeHint: scopes[item] } });
  }
  const agents = new Map<string, { client: BoardAgentClient; gitUrl: string; branch: string; dir: string }>();
  const leadJoin = await operator.join("lead", { role: "lead", workspaceTtlSeconds: 600 });
  if (!leadJoin.ok) {
    throw new Error("the lead could not join");
  }
  const lead = new BoardAgentClient(fetchFn, BASE, ID, "lead", leadJoin.token);
  for (const id of ["a0", "a1", "a2", "a3"]) {
    const joined = await operator.join(id, { workspaceTtlSeconds: 600 });
    if (!joined.ok || !joined.workspace) {
      throw new Error(`join failed for ${id}`);
    }
    const dir = join(root, "agents", id);
    await git("git", ["clone", "-q", joined.workspace.gitUrl, dir]);
    agents.set(id, { client: new BoardAgentClient(fetchFn, BASE, ID, id, joined.token), gitUrl: joined.workspace.gitUrl, branch: joined.workspace.defaultBranch, dir });
  }
  const agent = (id: string) => agents.get(id)!;
  const post = async (id: string, draft: unknown) => ok(id, await (id === "lead" ? lead : agent(id).client).post(draft));
  const claim = (id: string, item: string, write: string[]) => post(id, { type: "item.claimed", payload: { item, intent: { read: [], write } } });
  /** Commit files in the agent's repo, push, and announce `announced` for the item. */
  const push = async (id: string, item: string, files: Record<string, string>, announced: string[]): Promise<string> => {
    const { dir, gitUrl, branch } = agent(id);
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    await git("git", ["-C", dir, "add", "-A"]);
    await git("git", ["-C", dir, "-c", `user.name=${id}`, "-c", `user.email=${id}@coverage.local`, "commit", "-q", "-m", `work on ${item}`]);
    await git("git", ["-C", dir, "push", "-q", gitUrl, `HEAD:refs/heads/${branch}`]);
    const sha = (await git("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
    await post(id, { type: "push.announced", payload: { item, commit: sha, paths: announced } });
    return sha;
  };
  const worktreeRoot = join(root, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });
  const integrator = new ContinuousBoardIntegrator({
    operator,
    change: { id: ID, objective: "o" },
    agentRepos: new Map([...agents.entries()].map(([id, a]) => [id, { gitUrl: a.gitUrl, defaultBranch: a.branch }])),
    readRemote: async (id) => agent(id).gitUrl,
    integration,
    worktreeRoot,
    identity: IDENTITY,
    contract: { restore: [], jsonKeys: [] },
    appGateCommand: ["gate"],
    verifyCommandRunner: new MarkerGate(),
    speculate: 3,
    candidateConcurrency: 1,
  });
  const integrate = async () => {
    integrator.kick();
    await integrator.idle();
  };

  // 1. The warm-up: w lands alone (no passing head yet: one revision).
  await claim("a0", "w", ["src/w/**"]);
  await push("a0", "w", { "src/w/d.ts": "export const d = 1;\n" }, ["src/w/d.ts"]);
  await post("a0", { type: "done.proposed", payload: { item: "w" } });
  await integrate();

  // 2. A speculative round: x good, y strays outside its intent (and touches
  //    x's src/common.ts), z bad. Clashes are predicted before the round.
  await claim("a1", "x", ["src/x/**", "src/common.ts"]);
  await claim("a2", "y", ["src/y/**"]);
  await claim("a3", "z", ["src/z/**"]);
  await push("a1", "x", { "src/x/a.ts": "export const a = 1;\n", "src/common.ts": "export const common = 1;\n" }, ["src/x/a.ts", "src/common.ts"]);
  await push("a2", "y", { "src/y/b.ts": "export const b = 1;\n", "src/common.ts": "export const common = 2;\n" }, ["src/y/b.ts"]);
  await push("a3", "z", { "src/z/c.ts": "export const c = 'BAD';\n" }, ["src/z/c.ts"]);
  await post("a1", { type: "done.proposed", payload: { item: "x" } });
  await integrate();

  // 3. z's fix fails again: its budget (1 attempt) is spent and it reopens.
  await push("a3", "z", { "src/z/c.ts": "export const c = 'BAD again';\n" }, ["src/z/c.ts"]);
  await integrate();

  // 4. The lead re-plans z (its budget was spent) into one replacement, which a0 lands.
  await post("lead", {
    type: "item.replanned",
    payload: { item: "z", reason: "fix-budget-exhausted", action: "rescope", children: [{ item: "z.r1", objective: "make z pass", scopeHint: ["src/z/**"] }] },
  });
  await claim("a0", "z.r1", ["src/z/**"]);
  await push("a0", "z.r1", { "src/z/c.ts": "export const c = 3;\n" }, ["src/z/c.ts"]);
  await post("a0", { type: "done.proposed", payload: { item: "z.r1" } });
  await integrate();

  // 5. The lead extends a deadline once; y's holder never answers its
  //    exclusion, so participant messages run its lease out (it lapses).
  await post("lead", { type: "claim.extended", payload: { item: "y", reason: "its holder was told why its push was left out" } });
  for (let k = 0; k < 12; k += 1) {
    await post("lead", { type: "item.proposed", payload: { item: `note-${k}`, objective: `a note ${k}`, acceptance: [], scopeHint: [`docs/note-${k}.md`] } });
  }

  // 6. a1 takes y and lands it; the last passing revision is promoted.
  await claim("a1", "y", ["src/y/**"]);
  await push("a1", "y", { "src/y/b.ts": "export const b = 4;\n" }, ["src/y/b.ts"]);
  await post("a1", { type: "done.proposed", payload: { item: "y" } });
  await integrate();
  const last = integrator.revisions.at(-1);
  if (last === undefined || last.gate !== "pass" || integrator.lastEvidence === undefined) {
    throw new Error(`the scenario's last revision did not pass: ${JSON.stringify(integrator.failures)}`);
  }
  const promoted = await promoteVerifiedIntegration({
    change: { id: ID, objective: "o" },
    evidence: integrator.lastEvidence,
    integrationRef: integration.integrationRef,
    projectDir,
    workRoot: join(root, "promote"),
    worktreeRoot,
    identity: IDENTITY,
    requiresIntegrationGate: true,
    emit: () => undefined,
  });
  if (!promoted.promotion.committed) {
    throw new Error(`the scenario's promotion did not commit: ${promoted.promotion.refusedReason ?? "nothing to commit"}`);
  }
  ok(
    "revision.promoted",
    await operator.recordEngine("revision.promoted", { rev: last.n, gatedCommit: last.commit, commit: promoted.promotion.commit, branch: promoted.promotion.branch }),
  );
  return (await operator.log()).messages;
}
