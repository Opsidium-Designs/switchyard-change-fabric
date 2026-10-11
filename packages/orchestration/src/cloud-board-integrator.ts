/**
 * The driver's side of integration on Cloudflare (`run-board --integrator
 * cloud`): the driver does NOT integrate. It provisions the integration repo
 * as an Artifact repo through the Worker, seeds it with the project baseline,
 * posts the configuration (the gate, the contract, the baseline inventory, the
 * timeouts), and then follows the revisions the integration Workflow records
 * on the board, exactly where the local continuous integrator would have
 * recorded them. Promotion stays local: it pins and verifies the gated commit
 * from the integration repo, as with the local integrator.
 *
 * Differences from the local integrator (stated, not hidden): failure
 * attribution on this path is the honest fallback (every item a failing
 * revision merged is implicated); the parse narrowing and the advisory typed
 * decision run only with the local integrator.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { pendingPushKey, type BoardState, type ImplicationSource } from "@switchyard-change/change-core";
import type { WorkspaceRef } from "@switchyard-change/artifact-workspace";
import { runGit } from "@switchyard-change/artifact-workspace/git-transport";
import { authenticatedRemote, type GitIdentity } from "@switchyard-change/local-runner";
import type { EvidenceSummary, TestInventory } from "@switchyard-change/verification";

import type { BoardDecisionRecord, BoardRevision, RecordBoardDecision } from "./run-board.ts";
import { cloneProjectForPromotion } from "./run-live.ts";
import { withWorkerAuth } from "./worker-auth.ts";

/** The integration repo provisioned through the Worker (the token is shown once). */
export interface CloudIntegrationWorkspace {
  readonly integrationRef: WorkspaceRef;
  /** A write token for the run (seeding, the agents' rebases); revoked at cleanup. */
  readonly integrationToken: string;
  readonly tokenId: string;
  readonly workspaceName: string;
}

async function postJson(fetchFn: typeof fetch, url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await withWorkerAuth(fetchFn)(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    parsed = { error: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

/** Provision the integration Artifact repo and seed it with the project baseline. */
export async function createCloudIntegrationWorkspace(input: {
  readonly fetchFn: typeof fetch;
  readonly base: string;
  readonly changeId: string;
  readonly projectDir: string;
  readonly workRoot: string;
  readonly ttlSeconds: number;
  readonly identity: GitIdentity;
}): Promise<CloudIntegrationWorkspace> {
  const route = `${input.base}/changes/${encodeURIComponent(input.changeId)}/integration/cloud/workspace`;
  const res = await postJson(input.fetchFn, route, { ttlSeconds: input.ttlSeconds });
  const b = res.body;
  if (res.status !== 201 || typeof b.gitUrl !== "string" || typeof b.token !== "string" || typeof b.workspaceName !== "string") {
    throw new Error(`could not provision the integration repo (HTTP ${res.status}): ${String(b.error ?? "no workspace")}`);
  }
  if (!b.gitUrl.startsWith("https://") || b.fallback === true) {
    throw new Error(
      `integration on Cloudflare needs a real Artifact repo, but the Worker provisioned ${String(b.backend ?? "a fallback")} (${b.gitUrl.split("/")[0]}//...): authenticate the Worker's Artifacts binding`,
    );
  }
  const integrationRef: WorkspaceRef = {
    id: String(b.workspaceId ?? ""),
    name: b.workspaceName,
    gitUrl: b.gitUrl,
    defaultBranch: typeof b.defaultBranch === "string" ? b.defaultBranch : "main",
    backend: "cloudflare-artifacts",
    fallback: false,
  };
  // Seed: the project baseline as the branch head (the token travels as a header).
  const tokenId = String(b.tokenId ?? "");
  let work: string | undefined;
  try {
    work = await mkdtemp(join(input.workRoot, "cloud-seed-"));
    await cloneProjectForPromotion(input.projectDir, work);
    await runGit(["-C", work, "push", "-q", authenticatedRemote(integrationRef.gitUrl, b.token), `HEAD:refs/heads/${integrationRef.defaultBranch}`]);
  } catch (error) {
    // A repo that could not be seeded is never left behind with a live write
    // token: revoke the token, archive the repo, then report the seed failure.
    await discardCloudIntegrationWorkspace(input.fetchFn, input.base, input.changeId, b.workspaceName, tokenId);
    throw error;
  } finally {
    if (work !== undefined) {
      await rm(work, { recursive: true, force: true });
    }
  }
  return { integrationRef, integrationToken: b.token, tokenId, workspaceName: b.workspaceName };
}

/** Revoke the integration repo's write token and archive the repo (best effort, each step independent). */
async function discardCloudIntegrationWorkspace(fetchFn: typeof fetch, base: string, changeId: string, workspaceName: string, tokenId: string): Promise<void> {
  if (tokenId !== "") {
    await postJson(fetchFn, `${base}/changes/${encodeURIComponent(changeId)}/integration/cloud/token/revoke`, { tokenId }).catch(() => undefined);
  }
  await withWorkerAuth(fetchFn)(`${base}/workspaces/${encodeURIComponent(workspaceName)}`, { method: "DELETE" })
    .then((res) => res.text())
    .catch(() => undefined);
}

/**
 * The shared gate files beside an app (top-level `.mjs` siblings of the app
 * directory, the same files the local run materializes into its worktree
 * root), bounded.
 */
export async function gateSupportFilesFor(projectDir: string): Promise<{ name: string; content: string }[]> {
  const app = resolve(projectDir);
  const parent = dirname(app);
  if (parent === app) {
    return [];
  }
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const files: { name: string; content: string }[] = [];
  let total = 0;
  for (const entry of entries.filter((e) => e.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const content = await readFile(join(parent, entry.name), "utf8").catch(() => undefined);
    if (content === undefined || total + content.length > 512 * 1024 || files.length >= 16) {
      continue;
    }
    total += content.length;
    files.push({ name: entry.name, content });
  }
  return files;
}

/** Post the integration configuration for the Change. */
export async function configureCloudIntegration(input: {
  readonly fetchFn: typeof fetch;
  readonly base: string;
  readonly changeId: string;
  readonly workspace: CloudIntegrationWorkspace;
  readonly gateCommand?: readonly string[];
  readonly requireGate: boolean;
  readonly protectedPaths: readonly string[];
  readonly protectedJsonKeys: readonly { readonly file: string; readonly keys: readonly (readonly string[])[] }[];
  readonly testInventory?: TestInventory;
  readonly gateSupportFiles: readonly { readonly name: string; readonly content: string }[];
  readonly timeouts: { readonly installMs: number; readonly gateMs: number };
  readonly identity: GitIdentity;
  /** "driver" when this run offers its advisory typed-decision attribution (the Workflow waits for it). */
  readonly attribution?: "engine" | "driver";
}): Promise<void> {
  const res = await postJson(input.fetchFn, `${input.base}/changes/${encodeURIComponent(input.changeId)}/integration/cloud`, {
    integration: { workspaceName: input.workspace.workspaceName, gitUrl: input.workspace.integrationRef.gitUrl, defaultBranch: input.workspace.integrationRef.defaultBranch },
    ...(input.gateCommand && input.gateCommand.length > 0 ? { gateCommand: input.gateCommand } : {}),
    requireGate: input.requireGate,
    protectedPaths: input.protectedPaths,
    protectedJsonKeys: input.protectedJsonKeys,
    ...(input.testInventory ? { testInventory: input.testInventory } : {}),
    ...(input.gateSupportFiles.length > 0 ? { gateSupportFiles: input.gateSupportFiles } : {}),
    timeouts: input.timeouts,
    identity: input.identity,
    ...(input.attribution ? { attribution: input.attribution } : {}),
  });
  if (res.status !== 201) {
    throw new Error(`the Worker refused the integration configuration (HTTP ${res.status}): ${String(res.body.error ?? "")}`);
  }
}

/** A fresh short-lived token for the integration repo (for promotion), and its revoke. */
export async function integrationRepoToken(input: {
  readonly fetchFn: typeof fetch;
  readonly base: string;
  readonly changeId: string;
  readonly scope: "read" | "write";
  readonly ttlSeconds: number;
}): Promise<{ readonly token: string; revoke(): Promise<void> }> {
  const route = `${input.base}/changes/${encodeURIComponent(input.changeId)}/integration/cloud/token`;
  const res = await postJson(input.fetchFn, route, { scope: input.scope, ttlSeconds: input.ttlSeconds });
  if (res.status !== 201 || typeof res.body.token !== "string") {
    throw new Error(`no integration repo token (HTTP ${res.status}): ${String(res.body.error ?? "")}`);
  }
  const tokenId = String(res.body.tokenId ?? "");
  return {
    token: res.body.token,
    revoke: async () => {
      await postJson(input.fetchFn, `${route}/revoke`, { tokenId }).catch(() => undefined);
    },
  };
}

/** One attempt as the Worker's open view reports it. */
interface CloudAttempt {
  readonly key: string;
  readonly pendingKey: string;
  readonly at: string;
  readonly recorded: boolean;
  readonly reason?: string;
  readonly stale?: boolean;
  readonly transient?: boolean;
  readonly n?: number;
  readonly gate?: "pass" | "fail";
  readonly gated?: boolean;
  readonly commit?: string;
  readonly merged?: readonly string[];
  readonly integratedItems?: readonly string[];
  readonly excludedItems?: readonly string[];
  readonly excludedAgents?: readonly { readonly agent: string; readonly reason: string }[];
  readonly completedItems?: readonly string[];
  readonly implicated?: { readonly items: readonly string[]; readonly source: "parse" | "jev" | "all" };
  readonly parsed?: readonly string[];
  readonly failure?: string;
  readonly fixRequested?: readonly string[];
  readonly fixExhausted?: readonly string[];
  readonly install?: BoardRevision["install"];
  readonly inventoryNote?: string;
  readonly phases?: readonly { readonly phase: string; readonly egress: string; readonly at: string }[];
  readonly evidence?: EvidenceSummary;
  readonly advanced?: boolean;
  readonly advanceError?: string;
}

/** A failing revision the Workflow holds for this run's advisory attribution. */
export interface CloudAttributionRequest {
  readonly key: string;
  readonly items: readonly { readonly id: string; readonly objective: string; readonly paths: readonly string[] }[];
  readonly output: string;
  readonly parsed: readonly string[];
}

interface CloudView {
  readonly configured: boolean;
  readonly active?: { readonly instanceId: string; readonly startedAt: string };
  readonly kicked: boolean;
  readonly pendingAttribution?: CloudAttributionRequest;
  readonly revisions: readonly CloudAttempt[];
}

/** The integrator surface runBoard drives (the local ContinuousBoardIntegrator has the same). */
export interface BoardIntegratorLike {
  readonly revisions: BoardRevision[];
  readonly failures: string[];
  readonly lastEvidence: EvidenceSummary | undefined;
  readonly lastRequiresGate: boolean;
  readonly busy: boolean;
  wants(state: BoardState): boolean;
  kick(): void;
  idle(): Promise<void>;
  /** Stop starting attempts (an interrupted run); the attempt in flight still finishes. */
  halt?(): void;
}

/** Follows the revisions the integration Workflow records (it never integrates itself). */
export class CloudBoardIntegrator implements BoardIntegratorLike {
  readonly revisions: BoardRevision[] = [];
  readonly failures: string[] = [];
  lastEvidence: EvidenceSummary | undefined;
  /** The egress phases of each recorded revision's job, by revision number. */
  readonly phasesByRevision = new Map<number, readonly { readonly phase: string; readonly egress: string; readonly at: string }[]>();
  private view: CloudView | undefined;
  private readonly seen = new Set<string>();
  private readonly settledPending = new Set<string>();
  private readonly kicksByPending = new Map<string, number>();
  private lastKick = 0;
  private lastKickKey = "";
  /** Attribution requests this run answered, and the advisory decisions to record once their revision is. */
  private readonly attributed = new Map<string, readonly BoardDecisionRecord[]>();

  constructor(
    private readonly options: {
      readonly fetchFn: typeof fetch;
      readonly base: string;
      readonly changeId: string;
      readonly requiresGate: boolean;
      readonly readState: () => Promise<BoardState>;
      readonly onRevision?: (revision: BoardRevision) => void;
      readonly onFailure?: (reason: string) => void;
      readonly scrub?: (text: string) => string;
      /** How often idle() reads the Worker (default 2 s). */
      readonly pollMs?: number;
      /** How long idle() waits for the Workflow to settle (default 30 minutes). */
      readonly settleTimeoutMs?: number;
      /** Kicks per pending-push set when the Workflow ended with pushes pending (default 3). */
      readonly maxKicks?: number;
      /**
       * The run's advisory attribution of a failing revision the Workflow holds
       * (the parse plus a confident typed decision, as the local integrator
       * does). Only the typed decision's confident PICK is sent (the Workflow
       * combines it with its own parse exactly as the local integrator does);
       * otherwise "no choice".
       */
      readonly attribute?: (request: CloudAttributionRequest) => Promise<{
        readonly items: readonly string[];
        readonly source: ImplicationSource;
        /** The confident typed-decision pick, when there was one. */
        readonly pick?: string;
        readonly decisions: readonly BoardDecisionRecord[];
      }>;
      /** Records the advisory decisions on the board (linked to the revision once it is recorded). */
      readonly recordDecision?: RecordBoardDecision;
    },
  ) {}

  get lastRequiresGate(): boolean {
    return this.options.requiresGate;
  }

  /** True while the Change's integration Workflow is active (as last read). */
  get busy(): boolean {
    return this.view?.active !== undefined;
  }

  /** Is there a pending-push set the Workflow has not settled yet? */
  wants(state: BoardState): boolean {
    const key = pendingPushKey(state);
    return key !== "" && !this.settledPending.has(key);
  }

  /** Ask the Worker to integrate now (it already reacts to every announced push; this only recovers). */
  kick(): void {
    void this.poll().catch(() => undefined);
    const now = Date.now();
    void this.options.readState().then(
      (state) => {
        const key = pendingPushKey(state);
        if (key === "" || (key === this.lastKickKey && now - this.lastKick < 10_000)) {
          return;
        }
        this.lastKick = now;
        this.lastKickKey = key;
        void postJson(this.options.fetchFn, `${this.route()}/kick`, {}).catch(() => undefined);
      },
      () => undefined,
    );
  }

  /** Wait until the Workflow is not active and every pending-push set is settled (bounded). */
  async idle(): Promise<void> {
    const started = Date.now();
    const timeout = this.options.settleTimeoutMs ?? 30 * 60 * 1000;
    for (;;) {
      await this.poll();
      const state = await this.options.readState();
      const key = pendingPushKey(state);
      const pending = this.wants(state);
      if (!this.busy && !pending) {
        return;
      }
      if (!this.busy && pending) {
        // The Workflow ended (or never started) with pushes pending: ask again, bounded.
        const used = this.kicksByPending.get(key) ?? 0;
        if (used >= (this.options.maxKicks ?? 3)) {
          this.fail(`the integration Workflow did not integrate the pending pushes after ${used} request(s)`);
          this.settledPending.add(key);
          return;
        }
        this.kicksByPending.set(key, used + 1);
        await postJson(this.options.fetchFn, `${this.route()}/kick`, {}).catch(() => undefined);
      }
      if (Date.now() - started > timeout) {
        this.fail(`the integration Workflow did not settle within ${Math.round(timeout / 1000)} s`);
        return;
      }
      await new Promise((r) => setTimeout(r, this.options.pollMs ?? 2000));
    }
  }

  /** Read the Worker's view and report what is new. */
  async poll(): Promise<void> {
    const res = await withWorkerAuth(this.options.fetchFn)(this.route());
    if (res.status >= 400) {
      throw new Error(`the integration view is unreadable (HTTP ${res.status})`);
    }
    const view = (await res.json()) as CloudView;
    this.view = view;
    const pending = view.pendingAttribution;
    if (pending && this.options.attribute && !this.attributed.has(pending.key)) {
      this.attributed.set(pending.key, []);
      await this.answer(pending).catch((error: unknown) => this.fail(`attribution not answered: ${error instanceof Error ? error.message : String(error)}`));
    }
    for (const attempt of view.revisions) {
      const id = `${attempt.key}@${attempt.at}`;
      if (this.seen.has(id)) {
        continue;
      }
      this.seen.add(id);
      if (attempt.recorded && attempt.n !== undefined && attempt.commit !== undefined && attempt.gate !== undefined) {
        this.settledPending.add(attempt.pendingKey);
        const revision: BoardRevision = {
          n: attempt.n,
          gate: attempt.gate,
          gated: attempt.gated !== false,
          ...(attempt.install ? { install: attempt.install } : {}),
          commit: attempt.commit,
          merged: attempt.merged ?? [],
          integratedItems: attempt.integratedItems ?? [],
          excludedItems: attempt.excludedItems ?? [],
          excludedAgents: [
            ...(attempt.excludedAgents ?? []),
            ...(attempt.gate === "pass" && attempt.advanced === false
              ? [{ agent: "(integration)", reason: this.scrub(`recorded, but the integration branch could not be advanced: ${attempt.advanceError ?? "unknown"}`) }]
              : []),
          ],
          completedItems: attempt.completedItems ?? [],
          ...(attempt.implicated ? { implicated: attempt.implicated } : {}),
          ...(attempt.failure !== undefined ? { failure: this.scrub(attempt.failure) } : {}),
          ...(attempt.inventoryNote !== undefined ? { inventoryNote: attempt.inventoryNote } : {}),
          ...(attempt.gate === "fail" ? { fixRequested: attempt.fixRequested ?? [], fixExhausted: attempt.fixExhausted ?? [] } : {}),
        };
        this.revisions.push(revision);
        this.revisions.sort((a, b) => a.n - b.n);
        if (attempt.phases) {
          this.phasesByRevision.set(attempt.n, attempt.phases);
        }
        await this.flushDecisions(attempt.key, attempt.n, attempt.parsed ?? []);
        if (this.revisions.at(-1) === revision) {
          this.lastEvidence = attempt.evidence;
        }
        this.options.onRevision?.(revision);
      } else {
        if (!attempt.transient) {
          // Nothing recorded: the advisory decisions stay visible, unlinked.
          await this.flushDecisions(attempt.key, undefined, []);
        }
        if (!attempt.stale) {
          if (!attempt.transient) {
            this.settledPending.add(attempt.pendingKey);
          }
          this.fail(`${attempt.transient ? "integration did not run" : "integration not recorded"}: ${attempt.reason ?? "unknown"}`);
        }
      }
    }
  }

  /** Whether the last recorded passing revision's branch advance is still pending (for promotion). */
  get lastAdvanced(): boolean | undefined {
    const last = [...(this.view?.revisions ?? [])].filter((r) => r.recorded).sort((a, b) => (a.n ?? 0) - (b.n ?? 0)).at(-1);
    return last?.advanced;
  }

  /** Attribute a held failing revision and send the choice (or "no choice") to the Worker. */
  private async answer(request: CloudAttributionRequest): Promise<void> {
    const attributed = await this.options.attribute!(request);
    this.attributed.set(request.key, attributed.decisions);
    // The pick alone: sending the driver's union would let the Workflow union
    // it again with an unattributed ("all") parse.
    const items = attributed.pick !== undefined ? [attributed.pick] : [];
    const res = await postJson(this.options.fetchFn, `${this.route()}/attribution`, { key: request.key, items });
    if (res.status !== 201 && res.status !== 409) {
      throw new Error(`HTTP ${res.status}: ${String(res.body.error ?? "")}`);
    }
  }

  /** Record the advisory decisions of an answered attribution: linked to revision `n` when it was recorded. */
  private async flushDecisions(key: string, n: number | undefined, parsed: readonly string[]): Promise<void> {
    const decisions = this.attributed.get(key);
    if (!decisions || decisions.length === 0 || !this.options.recordDecision) {
      return;
    }
    this.attributed.set(key, []);
    for (const decision of decisions) {
      const { parsed: _own, ...unlinked } = decision;
      await this.options
        .recordDecision(n === undefined || decision.error !== undefined ? unlinked : { ...unlinked, rev: n, parsed })
        .catch(() => undefined);
    }
  }

  private fail(reason: string): void {
    const text = this.scrub(reason);
    this.failures.push(text);
    this.options.onFailure?.(text);
  }

  private scrub(text: string): string {
    return this.options.scrub ? this.options.scrub(text) : text;
  }

  private route(): string {
    return `${this.options.base}/changes/${encodeURIComponent(this.options.changeId)}/integration/cloud`;
  }
}
