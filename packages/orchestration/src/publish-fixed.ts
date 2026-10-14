/**
 * publish-fixed: upload the PROMOTED commit of a verified live run as a
 * preview version of the app's stable Worker, beside the original.
 *
 * The console's run page shows an app in two versions: the original (the
 * stable Worker's production deploy, `deploy-app`) and the code fixed by this
 * run. A board run with `--preview-passing` uploads each passing revision on
 * its own; this command is the after-the-fact path for any run (run-live or a
 * board run without previews): it uploads the run's promoted commit under the
 * same one alias, `fixed-<change tag>`, as a Worker VERSION (never a
 * production deploy), and prints its URL.
 *
 * Honesty (checked before any upload, refused otherwise):
 *   - the Worker records the run's integration verdict as verified, by a gate
 *     that ran (an ungated "verified" checked nothing);
 *   - the commit is in the run's promoted repo and is the tip of the promoted
 *     branch the run printed;
 *   - for a board run, the board's recorded promotion (`revision.promoted`)
 *     names this commit, and the commit holds the tree the gate passed on
 *     (the showcase check, `checkFixedMatchesRun`).
 * The app is located in the commit's tree by its stable Worker name, and the
 * app must already be deployed (the version needs its Worker).
 *
 * Nothing here touches the network on its own: the Worker read is an
 * injected fetch and the upload an injected uploader (the CLI passes wrangler;
 * tests pass fakes). Every git call is local.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runGit } from "@switchyard-change/artifact-workspace/git-transport";

import { readAppDeployment, stableAppWorkerName } from "./app-deploy.ts";
import { readBoardLog } from "./board-client.ts";
import { locateAppInTree } from "./preview-replay.ts";
import { checkoutIntegratedCommit, fixedAlias, isWorkersDevUrl, type PreviewUploader } from "./revision-preview.ts";
import { checkFixedMatchesRun, isSafeRef, showcaseRunFacts, type ShowcaseRunFacts } from "./showcase.ts";

const APP_NAME = /^[a-z0-9][a-z0-9-]*$/;
const CHANGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

/** What the honesty check reads about a run (from the Worker). */
export interface PublishFixedRunFacts extends ShowcaseRunFacts {
  /** Whether the run has a board (a board run records its revisions and promotion there). */
  readonly board: boolean;
}

/** The run facts from a Worker snapshot and (for a board run) its board messages. */
export function publishFixedRunFacts(
  changeId: string,
  snapshot: Record<string, unknown> | null,
  messages: readonly { readonly type: string; readonly payload?: unknown }[],
): PublishFixedRunFacts {
  const facts = showcaseRunFacts({ format: "live", changeId, messages, snapshot });
  return { ...facts, board: messages.length > 0 };
}

/**
 * Prove `commit` (as the run printed it, possibly abbreviated) is the verified
 * run's promoted commit, or throw saying why not. Returns the full commit and
 * how it was matched.
 */
export async function checkPublishFixed(input: {
  readonly repoDir: string;
  readonly commit: string;
  readonly branch: string;
  readonly facts: PublishFixedRunFacts;
}): Promise<{ readonly commit: string; readonly detail: string; readonly rev?: number }> {
  const { facts } = input;
  if (facts.verdict !== "verified") {
    throw new Error(
      `refusing: the run ${facts.runId} is not verified by a gate that ran (recorded verdict: ${facts.verdict ?? "none yet"}), so it has no fixed code to publish`,
    );
  }
  if (!COMMIT.test(input.commit)) {
    throw new Error(`refusing: ${JSON.stringify(input.commit.slice(0, 80))} is not a commit id`);
  }
  if (!isSafeRef(input.branch)) {
    throw new Error(`refusing: ${JSON.stringify(input.branch.slice(0, 80))} is not a branch name this tool accepts`);
  }
  let full: string;
  try {
    full = (await runGit(["-C", input.repoDir, "rev-parse", "--verify", "--end-of-options", `${input.commit}^{commit}`])).stdout.trim();
  } catch {
    throw new Error(`refusing: the commit ${input.commit} is not in ${input.repoDir}`);
  }
  let tip: string;
  try {
    tip = (await runGit(["-C", input.repoDir, "rev-parse", "--verify", "--end-of-options", `refs/heads/${input.branch}^{commit}`])).stdout.trim();
  } catch {
    throw new Error(`refusing: the promoted branch ${input.branch} is not in ${input.repoDir}`);
  }
  if (tip !== full) {
    throw new Error(`refusing: the commit ${full.slice(0, 12)} is not the tip of the promoted branch ${input.branch} (${tip.slice(0, 12)})`);
  }
  if (!facts.board) {
    return { commit: full, detail: `the tip of the promoted branch ${input.branch} of the verified run ${facts.runId}` };
  }
  // A board run records its promotion and its passing revision: the commit must
  // be the recorded promotion and hold the tree the gate passed on.
  if (facts.promoted === undefined || !(facts.promoted.commit === full || full.startsWith(facts.promoted.commit) || facts.promoted.commit.startsWith(full))) {
    throw new Error(
      `refusing: the board of ${facts.runId} records ${facts.promoted ? `the promotion of ${facts.promoted.commit.slice(0, 12)}` : "no promotion"}, not ${full.slice(0, 12)}`,
    );
  }
  const match = await checkFixedMatchesRun(input.repoDir, full, facts);
  return { commit: full, detail: `revision ${match.rev}: ${match.detail}`, rev: match.rev };
}

export interface PublishFixedOptions {
  /** The fabric repository (where .deployments markers live). */
  readonly repoRoot: string;
  readonly workerUrl: string;
  readonly changeId: string;
  readonly app: string;
  /** The run's promoted repo (the `repo:` line of its output). */
  readonly repoDir: string;
  /** The promoted commit and branch (the `promoted:` line of its output). */
  readonly commit: string;
  readonly branch: string;
  readonly dryRun: boolean;
  readonly fetchFn: typeof fetch;
  readonly upload: PreviewUploader;
  readonly log: (line: string) => void;
  readonly tmpRoot?: string;
}

export interface PublishFixedResult {
  readonly alias: string;
  readonly commit: string;
  /** The alias URL (absent on a dry run). */
  readonly url?: string;
}

/** Check, then upload the promoted commit's app as a version under `fixed-<change tag>`. */
export async function runPublishFixed(options: PublishFixedOptions): Promise<PublishFixedResult> {
  const { app, changeId, log } = options;
  if (!APP_NAME.test(app)) {
    throw new Error("--app must be an app directory name under examples/apps");
  }
  if (!CHANGE_ID.test(changeId)) {
    throw new Error("--change-id is not a change id");
  }
  const worker = stableAppWorkerName(app);
  const alias = fixedAlias(changeId, worker);
  const repoDir = resolve(options.repoDir);

  const base = options.workerUrl.replace(/\/$/, "");
  let snapshot: Record<string, unknown> | null;
  try {
    const res = await options.fetchFn(`${base}/changes/${encodeURIComponent(changeId)}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    snapshot = (await res.json()) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`cannot read the run ${changeId} from the Worker at ${base}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let messages: readonly { readonly type: string; readonly payload?: unknown }[] = [];
  try {
    messages = (await readBoardLog(options.fetchFn, base, changeId)).messages;
  } catch {
    // A run-live Change has no board to read.
  }
  const facts = publishFixedRunFacts(changeId, snapshot, messages);
  const proved = await checkPublishFixed({ repoDir, commit: options.commit, branch: options.branch, facts });
  const appRel = await locateAppInTree(repoDir, proved.commit, worker);
  const deployed = await readAppDeployment(options.repoRoot, app);

  log(`Publish the fixed ${app} of ${changeId}${options.dryRun ? " (dry run: nothing is uploaded)" : ""}`);
  log(`  fixed: ${proved.commit.slice(0, 12)} in ${repoDir} (app at ${appRel === "" ? "the tree root" : appRel}): ${proved.detail}`);
  log(`  upload: a version of ${worker} under the preview alias ${alias} (never a production deploy)`);
  if (deployed === undefined) {
    throw new Error(`refusing: ${app} is not deployed, so ${worker} has no Worker to add a version to; deploy the original first (make deploy-app APP=${app})`);
  }
  log(`  original: ${deployed.url} (the production deploy)`);
  if (options.dryRun) {
    return { alias, commit: proved.commit };
  }

  const scratch = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "scf-publish-fixed-"));
  try {
    const tree = join(scratch, "tree");
    await checkoutIntegratedCommit({ remote: repoDir, commit: proved.commit, targetDir: tree });
    const appDir = appRel === "" ? tree : join(tree, appRel);
    const { url } = await options.upload({ appDir, appName: worker, alias });
    if (!isWorkersDevUrl(url)) {
      throw new Error(`the upload returned a URL that is not an https workers.dev URL: ${url.slice(0, 200)}`);
    }
    log(`  fixed version: ${url}`);
    return { alias, commit: proved.commit, url };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
