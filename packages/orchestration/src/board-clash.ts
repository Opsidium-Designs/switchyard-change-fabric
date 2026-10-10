/**
 * board-clash: clash alerts from real code for a board run's continuous
 * integrator (advisory, never a gate).
 *
 * When two or more agents have PENDING pushes (announced, not yet gated), the
 * integrator predicts, before it builds the next revision, which pairs of
 * their pinned heads would conflict if merged: `predictClashes` (git
 * merge-tree, read-only) over the integration branch head (the current
 * integrated commit, or the baseline before any revision), with the board's
 * shared seams as the shared paths. Each pair the board has not seen is
 * recorded through the engine-record route as `clash.predicted`:
 *   - conflict: the conflicting paths that at least one side's integration
 *     unit applies (a file neither side ships cannot clash in the gated tree)
 *     and that BOTH heads changed from the goal's baseline (a head that merely
 *     lacks what another revision integrated is stale, not a clash; agents'
 *     repos share no history, so blobs are compared), scoped shared or local;
 *   - unknown (a pair could not be decided) or unavailable (no prediction
 *     could run, a push could not be read), with the reason: never clean;
 *   - a clean pair is not recorded.
 * Nothing here orders, holds, or blocks integration: a failure only records
 * an unavailable prediction. The gate on the integrated tree decides.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { clashKey, entryWithin, intentPath, planBoardIntegration, type BoardClashHead, type BoardMessage, type BoardState } from "@switchyard-change/change-core";
import { runGit } from "@switchyard-change/artifact-workspace/git-transport";
import { predictClashes } from "@switchyard-change/verification";

import type { BoardPostOutcome } from "./board-client.ts";
import { redactSecrets } from "./redact.ts";

/** What recording pending clashes needs (the operator's board calls and read access). */
export interface PendingClashInput {
  readonly operator: {
    log(): Promise<{ readonly messages: readonly BoardMessage[]; readonly state: BoardState }>;
    recordEngine(type: string, payload: Record<string, unknown>): Promise<BoardPostOutcome>;
  };
  /** A fetchable remote for the integration repo (its branch head is the prediction's base). */
  readonly integrationRemote: string;
  readonly integrationBranch: string;
  /** A fetchable remote for an agent's repo (read with operator credentials). */
  readonly readRemote: (agent: string) => Promise<string>;
  readonly workRoot: string;
  readonly scrub?: (text: string) => string;
  /** Pair keys already predicted by this run (never predicted twice). */
  readonly seen: Set<string>;
}

/** What one prediction pass did. */
export interface PendingClashResult {
  /** Pairs of pending pushes considered (new ones only). */
  readonly pairs: number;
  /** Records the board accepted. */
  readonly recorded: number;
  readonly conflicts: number;
}

/**
 * Did `head` change `path` from the BASELINE (the goal's recorded baseline
 * commit)? Compared by blob, since agents' repos are seeded separately and
 * share no history with each other; a file the head lacks was never touched
 * (an agent's repo holds only what it wrote). Undefined when it cannot be read.
 */
async function changedFromBaseline(dir: string, baseline: string, head: string, path: string): Promise<boolean | undefined> {
  const blob = async (rev: string) => (await runGit(["-C", dir, "rev-parse", "-q", "--verify", `${rev}:${path}`]).catch(() => ({ stdout: "" }))).stdout.trim();
  try {
    const mine = await blob(head);
    // An agent's repo starts empty and holds only what it wrote: a file it
    // lacks is one it never touched, not a deletion.
    return mine !== "" && mine !== (await blob(baseline));
  } catch {
    return undefined;
  }
}

/** Predict and record clashes among the pending pushes (see the module comment). Never throws. */
export async function recordPendingClashes(input: PendingClashInput): Promise<PendingClashResult> {
  const scrub = input.scrub ?? redactSecrets;
  let board: { readonly messages: readonly BoardMessage[]; readonly state: BoardState };
  try {
    board = await input.operator.log();
  } catch {
    return { pairs: 0, recorded: 0, conflicts: 0 };
  }
  const state = board.state;
  const units = planBoardIntegration(board.messages, state).units;
  if (units.length < 2) {
    return { pairs: 0, recorded: 0, conflicts: 0 };
  }
  const heads: (BoardClashHead & { readonly scope: readonly string[] })[] = units.map((u) => ({
    agent: u.agent,
    item: u.items.at(-1)!.id,
    sha: u.commit,
    scope: u.scope,
  }));
  const known = new Set((state.clashes ?? []).map((c) => c.key));
  const fresh: [number, number][] = [];
  for (let i = 0; i < heads.length; i += 1) {
    for (let j = i + 1; j < heads.length; j += 1) {
      const key = clashKey(heads[i]!.sha, heads[j]!.sha);
      if (!known.has(key) && !input.seen.has(key)) {
        fresh.push([i, j]);
      }
    }
  }
  if (fresh.length === 0) {
    return { pairs: 0, recorded: 0, conflicts: 0 };
  }
  let recorded = 0;
  let conflicts = 0;
  const record = async (a: number, b: number, outcome: Record<string, unknown>): Promise<void> => {
    const strip = ({ scope: _scope, ...head }: (typeof heads)[number]) => head;
    const posted = await input.operator.recordEngine("clash.predicted", { a: strip(heads[a]!), b: strip(heads[b]!), ...outcome }).catch(() => undefined);
    if (posted?.ok) {
      recorded += 1;
    }
  };
  for (const [a, b] of fresh) {
    input.seen.add(clashKey(heads[a]!.sha, heads[b]!.sha));
  }

  await mkdir(input.workRoot, { recursive: true });
  const dir = await mkdtemp(join(input.workRoot, "clash-"));
  try {
    let base: string;
    const unreadable = new Map<number, string>();
    try {
      await runGit(["init", "-q", "--bare", dir]);
      await runGit(["-C", dir, "fetch", "-q", input.integrationRemote, `+refs/heads/${input.integrationBranch}:refs/clash/base`]);
      base = (await runGit(["-C", dir, "rev-parse", "--verify", "-q", "refs/clash/base^{commit}"])).stdout.trim();
      for (const [index, head] of heads.entries()) {
        try {
          await runGit(["-C", dir, "fetch", "-q", await input.readRemote(head.agent), head.sha]);
        } catch (error) {
          unreadable.set(index, scrub(`could not read ${head.agent}'s push: ${error instanceof Error ? error.message : String(error)}`).slice(0, 300));
        }
      }
    } catch (error) {
      const reason = scrub(`no prediction: the integration base could not be read (${error instanceof Error ? error.message : String(error)})`).slice(0, 300);
      for (const [a, b] of fresh) {
        await record(a, b, { status: "unavailable", reason });
      }
      return { pairs: fresh.length, recorded, conflicts };
    }
    const readable = heads.map((_, i) => i).filter((i) => !unreadable.has(i));
    // The baseline the goal recorded (in the integration branch's history): what "changed" is measured from.
    const baselineKnown =
      state.baseline !== undefined && (await runGit(["-C", dir, "cat-file", "-e", `${state.baseline}^{commit}`]).then(() => true, () => false));
    const seams = new Set((state.seams ?? []).map((seam) => seam.path));
    const prediction = await predictClashes({
      repoDir: dir,
      base,
      heads: readable.map((i) => ({ agent: heads[i]!.agent, item: heads[i]!.item, sha: heads[i]!.sha })),
      isSharedPath: (path) => seams.has(path),
    });
    const applies = (index: number, path: string) => heads[index]!.scope.some((entry) => entryWithin(path, intentPath(entry)));
    for (const [a, b] of fresh) {
      const why = unreadable.get(a) ?? unreadable.get(b);
      if (why !== undefined) {
        await record(a, b, { status: "unknown", reason: why });
        continue;
      }
      if (prediction.status === "unavailable") {
        await record(a, b, { status: "unavailable", reason: scrub(prediction.reason).slice(0, 300) });
        continue;
      }
      const pair = prediction.pairs.find(
        (p) => (p.a.sha === heads[a]!.sha && p.b.sha === heads[b]!.sha) || (p.a.sha === heads[b]!.sha && p.b.sha === heads[a]!.sha),
      );
      if (pair === undefined || pair.outcome.kind === "unknown") {
        await record(a, b, { status: "unknown", reason: scrub(pair?.outcome.kind === "unknown" ? pair.outcome.reason : "the pair was not predicted").slice(0, 300) });
        continue;
      }
      if (pair.outcome.kind === "clean") {
        continue;
      }
      // Only what a side ships can clash in the gated tree, and only work both
      // sides really did: a path each head changed since their common ancestor
      // (a head that merely lacks a file another revision integrated is stale,
      // not a clash).
      const paths: string[] = [];
      for (const path of pair.outcome.paths) {
        if (!(applies(a, path) || applies(b, path))) {
          continue;
        }
        if (baselineKnown) {
          const [changedA, changedB] = await Promise.all([changedFromBaseline(dir, state.baseline!, heads[a]!.sha, path), changedFromBaseline(dir, state.baseline!, heads[b]!.sha, path)]);
          if (changedA === false || changedB === false) {
            continue;
          }
        }
        paths.push(path);
      }
      paths.splice(64);
      if (paths.length === 0) {
        continue;
      }
      conflicts += 1;
      await record(a, b, { status: "conflict", paths, scope: paths.some((path) => seams.has(path)) ? "shared" : "local" });
    }
    return { pairs: fresh.length, recorded, conflicts };
  } catch (error) {
    const reason = scrub(`no prediction: ${error instanceof Error ? error.message : String(error)}`).slice(0, 300);
    for (const [a, b] of fresh) {
      await record(a, b, { status: "unavailable", reason });
    }
    return { pairs: fresh.length, recorded, conflicts };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
