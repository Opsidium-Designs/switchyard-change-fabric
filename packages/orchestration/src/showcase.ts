/**
 * showcase: publish an example app in two versions for the static replay page,
 * the ORIGINAL (broken) code and the code FIXED by a recorded run, side by side.
 *
 * One Worker per app, `switchyard-showcase-<app>`, deliberately outside the
 * `switchyard-change-fabric-*` names that `make infra-down` deletes, so the
 * public demo survives an infra teardown (`make showcase-down` removes it).
 * The production deploy serves the original, and two Worker VERSIONS are
 * uploaded under preview aliases: `before` (examples/apps/<app> at the repo's
 * HEAD commit) and `after-<run tag>-r<n>` (the fixed commit of a passing
 * recorded run; the alias names the run, so two runs of one app never share
 * an alias and a link always opens the run it is shown on).
 *
 * Honesty: the fixed commit is uploaded only when it provably is the run's
 * passing revision: its tree equals the gated commit's tree recorded in the
 * replay (`integrated.rev`), or, when that commit is not in the source, it is
 * the promoted commit the replay recorded (`revision.promoted`) for that same
 * revision. Anything else is refused before any upload. Each source is copied
 * into a temporary directory and given a showcase-only wrangler config (the
 * Worker name, the app's own main and compatibility date, workers_dev and
 * preview_urls on), so nothing under examples/apps is ever changed.
 *
 * Nothing here touches the network: wrangler is an injected function (the CLI
 * passes the real one; tests pass a fake), and every git call is local.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { runGit } from "@switchyard-change/artifact-workspace/git-transport";

import { stableAppWorkerName } from "./app-deploy.ts";
import { commitExists, locateAppInTree, parsePreviewReplay, parseWranglerConfig, type PreviewReplayFile } from "./preview-replay.ts";
import { parsePreviewAliasUrl, previewAlias } from "./revision-preview.ts";

const exec = promisify(execFile);

/** Every showcase Worker's name starts with this (never the infra-down pattern). */
export const SHOWCASE_WORKER_PREFIX = "switchyard-showcase-";

/** The preview alias of the original code. */
export const BEFORE_ALIAS = "before";

/** What the original's index entry records as its commit when the repo has none to name. */
export const ORIGINAL_COMMIT = "original";

/** A workers.dev hostname label is at most 63 characters: `<alias>-<worker>` must fit. */
const MAX_HOST_LABEL = 63;

const APP_NAME = /^[a-z0-9][a-z0-9-]*$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

/** The showcase Worker of an app: `switchyard-showcase-<app>`. */
export function showcaseWorkerName(app: string): string {
  if (!APP_NAME.test(app)) {
    throw new Error("--app must be an app directory name under examples/apps (lowercase letters, digits, dashes)");
  }
  const worker = `${SHOWCASE_WORKER_PREFIX}${app}`;
  if (`${BEFORE_ALIAS}-${worker}`.length > MAX_HOST_LABEL) {
    throw new Error(`the app name ${JSON.stringify(app)} is too long for a showcase preview alias`);
  }
  return worker;
}

/**
 * The fixed version's preview alias: `after-<run tag>-r<n>` (the run id's last
 * meaningful part, as revision previews name it), fitting one hostname label
 * with the worker name.
 */
export function afterAlias(runId: string, rev: number, worker: string): string {
  // Passing the worker with the "after-" prefix reserves its room in the label.
  return `after-${previewAlias(runId, rev, `after-${worker}`)}`;
}

/** A git ref this tool accepts after `@` (no option-like or path-escaping text). */
export function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock");
}

/**
 * `--fixed <git dir or bundle>[@ref]`: the source path and the ref (HEAD when
 * none is given). With `exists`, a spec that is itself an existing path while
 * the part before its last `@` is not (a directory named `me@work`) is the path.
 */
export function parseFixedSource(spec: string, exists?: (path: string) => boolean): { readonly path: string; readonly ref: string } {
  if (spec.trim() === "") {
    throw new Error("--fixed needs a git directory or a bundle, optionally with @<ref>");
  }
  const at = spec.lastIndexOf("@");
  if (at > 0) {
    const ref = spec.slice(at + 1);
    if (exists !== undefined && exists(spec) && !exists(spec.slice(0, at))) {
      return { path: spec, ref: "HEAD" };
    }
    if (isSafeRef(ref)) {
      return { path: spec.slice(0, at), ref };
    }
    if (ref !== "" && !ref.includes("/")) {
      throw new Error(`--fixed: ${JSON.stringify(ref.slice(0, 80))} is not a ref this tool accepts (letters, digits, . _ / -)`);
    }
  }
  return { path: spec, ref: "HEAD" };
}

/** The parts of an app's wrangler config the showcase config keeps. */
export interface ShowcaseAppConfig {
  readonly main: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[];
}

/** Read `main`, `compatibility_date`, and `compatibility_flags` from an app's wrangler config text. */
export function readAppWranglerConfig(text: string, where: string): ShowcaseAppConfig {
  const parsed = parseWranglerConfig(text);
  if (parsed === undefined) {
    throw new Error(`${where}: the wrangler config is not a JSON object`);
  }
  const main = parsed.main;
  if (typeof main !== "string" || main === "" || main.startsWith("/") || main.split(/[\\/]/).includes("..")) {
    throw new Error(`${where}: the wrangler config has no usable "main" (a relative path inside the app)`);
  }
  const date = parsed.compatibility_date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${where}: the wrangler config has no "compatibility_date" (YYYY-MM-DD)`);
  }
  const flags = parsed.compatibility_flags;
  if (flags !== undefined && (!Array.isArray(flags) || !flags.every((f) => typeof f === "string" && /^[a-z0-9_]+$/.test(f)))) {
    throw new Error(`${where}: "compatibility_flags" is not a list of flag names`);
  }
  return { main, compatibilityDate: date, ...(Array.isArray(flags) && flags.length > 0 ? { compatibilityFlags: flags as string[] } : {}) };
}

/** The wrangler.jsonc written into a temporary copy of a source for one showcase upload. */
export function showcaseWranglerConfig(worker: string, config: ShowcaseAppConfig): string {
  const body = {
    name: worker,
    main: config.main,
    compatibility_date: config.compatibilityDate,
    ...(config.compatibilityFlags !== undefined ? { compatibility_flags: config.compatibilityFlags } : {}),
    workers_dev: true,
    preview_urls: true,
  };
  return `// Written by switchyard-change showcase-app into a temporary copy for one upload; not the app's own config.\n${JSON.stringify(body, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// What a recorded run proves about its fixed code
// ---------------------------------------------------------------------------

/** The facts the honesty check reads from a replay. */
export interface ShowcaseRunFacts {
  readonly runId: string;
  /** The recorded integration verdict ("verified", "failed", ...), if any. */
  readonly verdict?: string;
  /** The last integrated revision that passed a gate that ran. */
  readonly passing?: { readonly n: number; readonly commit: string };
  /** The last recorded promotion. */
  readonly promoted?: { readonly rev: number; readonly commit: string };
}

/** Read the passing revision and the promotion from a replay's recorded messages. */
export function showcaseRunFacts(replay: PreviewReplayFile): ShowcaseRunFacts {
  let passing: { n: number; commit: string } | undefined;
  let promoted: { rev: number; commit: string } | undefined;
  for (const message of replay.messages) {
    const p = (message.payload ?? {}) as Record<string, unknown>;
    if (message.type === "integrated.rev") {
      if (p.gate === "pass" && p.gated !== false && typeof p.n === "number" && Number.isInteger(p.n) && p.n > 0 && typeof p.commit === "string" && COMMIT.test(p.commit)) {
        passing = { n: p.n, commit: p.commit };
      }
    } else if (message.type === "revision.promoted") {
      if (typeof p.rev === "number" && Number.isInteger(p.rev) && typeof p.commit === "string" && COMMIT.test(p.commit)) {
        promoted = { rev: p.rev, commit: p.commit };
      }
    }
  }
  const integration = (replay.snapshot?.integration ?? null) as { verdict?: unknown; gated?: unknown } | null;
  const verdict = typeof integration?.verdict === "string" ? (integration.gated === false ? "ungated" : integration.verdict) : undefined;
  return { runId: replay.changeId, ...(verdict !== undefined ? { verdict } : {}), ...(passing ? { passing } : {}), ...(promoted ? { promoted } : {}) };
}

/** How the fixed commit was matched to the run. */
export interface ShowcaseMatch {
  /** The passing revision's number. */
  readonly rev: number;
  readonly via: "gated" | "promoted";
  readonly detail: string;
}

async function treeOf(repoDir: string, commit: string): Promise<string> {
  return (await runGit(["-C", repoDir, "rev-parse", "--verify", `${commit}^{tree}`])).stdout.trim();
}

/**
 * Prove `fixedCommit` (in `repoDir`) is the run's passing revision, or throw
 * saying why not: the run must be verified with a gated passing revision;
 * when that revision's gated commit is in the source, the trees must be equal;
 * otherwise the replay must record a promotion of that revision whose commit is
 * the fixed commit (or has its exact tree).
 */
export async function checkFixedMatchesRun(repoDir: string, fixedCommit: string, facts: ShowcaseRunFacts): Promise<ShowcaseMatch> {
  const short = (c: string) => c.slice(0, 12);
  if (facts.verdict !== "verified" || facts.passing === undefined) {
    throw new Error(
      `the run ${facts.runId} has no verified revision that passed a gate that ran (recorded verdict: ${facts.verdict ?? "none"}), so it has no fixed code to show; use --before-only`,
    );
  }
  const { n, commit: gated } = facts.passing;
  const fixedTree = await treeOf(repoDir, fixedCommit);
  if (await commitExists(repoDir, gated)) {
    const gatedTree = await treeOf(repoDir, gated);
    if (gatedTree !== fixedTree) {
      throw new Error(
        `refusing: the fixed commit ${short(fixedCommit)} does not hold the tree the gate passed on revision ${n} of ${facts.runId} (gated commit ${short(gated)}: tree ${short(gatedTree)}, fixed: tree ${short(fixedTree)})`,
      );
    }
    return { rev: n, via: "gated", detail: `its tree equals the gated commit ${short(gated)} of revision ${n}` };
  }
  const promoted = facts.promoted;
  if (promoted === undefined) {
    throw new Error(
      `refusing: cannot prove the fixed commit ${short(fixedCommit)} is revision ${n} of ${facts.runId}: the gated commit ${short(gated)} is not in the source and the replay records no promotion. Pass a source that holds the gated commit (the run's integration repo).`,
    );
  }
  if (promoted.rev !== n) {
    throw new Error(`refusing: the replay of ${facts.runId} records a promotion of revision ${promoted.rev}, not of the passing revision ${n}`);
  }
  if (promoted.commit === fixedCommit) {
    return { rev: n, via: "promoted", detail: `it is the promoted commit the replay records for revision ${n} (the gated commit ${short(gated)} is not in the source)` };
  }
  if ((await commitExists(repoDir, promoted.commit)) && (await treeOf(repoDir, promoted.commit)) === fixedTree) {
    return { rev: n, via: "promoted", detail: `its tree equals the promoted commit ${short(promoted.commit)} the replay records for revision ${n}` };
  }
  throw new Error(
    `refusing: the fixed commit ${short(fixedCommit)} is neither the gated commit ${short(gated)} nor the promoted commit ${short(promoted.commit)} of revision ${n} of ${facts.runId} (nor has either's tree)`,
  );
}

// ---------------------------------------------------------------------------
// The replay index record
// ---------------------------------------------------------------------------

/** The original's link on a run. */
export interface ShowcaseBefore {
  readonly url: string;
  /** The repo commit examples/apps/<app> was taken from, else "original". */
  readonly commit: string;
}

/** The fixed version's link on a run. */
export interface ShowcaseAfter {
  readonly url: string;
  /** The fixed commit uploaded (the run's promoted commit, or one with the gated tree). */
  readonly commit: string;
  /** The replay id this fixed code belongs to (always the entry's own id). */
  readonly run: string;
  /** The passing revision's number. */
  readonly rev: number;
}

/** A replay index entry's `apps` field. */
export interface ShowcaseApps {
  readonly before?: ShowcaseBefore;
  readonly after?: ShowcaseAfter;
}

/** An https workers.dev URL with no credentials (what a showcase link must be). */
export function isShowcaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname.endsWith(".workers.dev") && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/**
 * The replay index with `apps` set on each run in `runIds`: `before` replaced,
 * `after` replaced when given and otherwise kept as it was (a before-only
 * refresh never drops a proven fixed link). Every run must be in the index and
 * be of `app`; every URL must be an https workers.dev URL. Throws otherwise.
 */
export function withShowcaseApps(
  index: unknown,
  app: string,
  runIds: readonly string[],
  update: { readonly before: ShowcaseBefore; readonly after?: ShowcaseAfter },
): { readonly format?: unknown; readonly runs: readonly Record<string, unknown>[] } {
  const body = index as { format?: unknown; runs?: unknown } | null;
  if (body === null || typeof body !== "object" || !Array.isArray(body.runs)) {
    throw new Error("the replay index has no runs");
  }
  if (!isShowcaseUrl(update.before.url) || (update.after !== undefined && !isShowcaseUrl(update.after.url))) {
    throw new Error("refusing to record a link that is not an https workers.dev URL");
  }
  if (update.after !== undefined && (runIds.length !== 1 || update.after.run !== runIds[0])) {
    throw new Error("a fixed link is recorded on exactly the one run it belongs to");
  }
  const runs = body.runs.map((r) => (r !== null && typeof r === "object" ? { ...(r as Record<string, unknown>) } : r)) as Record<string, unknown>[];
  for (const id of runIds) {
    const entry = runs.find((r) => r !== null && typeof r === "object" && r.id === id);
    if (entry === undefined) {
      throw new Error(`the run ${id} is not in the replay index`);
    }
    if (entry.app !== app) {
      throw new Error(`the run ${id} is of the app ${JSON.stringify(entry.app)}, not ${JSON.stringify(app)}`);
    }
    const existing = (entry.apps ?? {}) as { after?: ShowcaseAfter };
    const after = update.after ?? (existing.after !== undefined && existing.after.run === id ? existing.after : undefined);
    entry.apps = { before: { ...update.before }, ...(after !== undefined ? { after: { ...after } } : {}) };
  }
  return { ...body, runs };
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/** One wrangler call, run in the temporary copy of the original (`before`) or the fixed code (`after`). */
export interface ShowcaseCommand {
  readonly dir: "before" | "after";
  readonly args: readonly string[];
  /** The preview alias whose URL this call prints (an upload). */
  readonly alias?: string;
}

/**
 * The wrangler calls, in order: the production deploy of the original (so the
 * Worker exists and its production URL serves the original), the `before`
 * version, then (unless before-only) the fixed version under its run alias.
 */
export function showcaseCommands(input: {
  readonly app: string;
  readonly beforeCommit: string;
  readonly after?: { readonly runId: string; readonly rev: number; readonly commit: string; readonly alias: string };
}): ShowcaseCommand[] {
  const commands: ShowcaseCommand[] = [
    { dir: "before", args: ["deploy", "--message", `showcase ${input.app}: original ${input.beforeCommit.slice(0, 10)}`] },
    {
      dir: "before",
      args: ["versions", "upload", "--preview-alias", BEFORE_ALIAS, "--message", `showcase ${input.app}: original ${input.beforeCommit.slice(0, 10)}`],
      alias: BEFORE_ALIAS,
    },
  ];
  if (input.after !== undefined) {
    const a = input.after;
    commands.push({
      dir: "after",
      args: ["versions", "upload", "--preview-alias", a.alias, "--message", `showcase ${input.app}: ${a.runId} r${a.rev} ${a.commit.slice(0, 10)}`],
      alias: a.alias,
    });
  }
  return commands;
}

/** One argument quoted for a POSIX shell when it needs it. */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9._/:=@,+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A command as a copy-pasteable line: `(cd <dir> && wrangler <args>)`. */
export function formatShowcaseCommand(command: ShowcaseCommand, dirs: { readonly before: string; readonly after?: string }): string {
  const dir = command.dir === "before" ? dirs.before : (dirs.after ?? "<after>");
  return `(cd ${shellQuote(dir)} && wrangler ${command.args.map(shellQuote).join(" ")})`;
}

// ---------------------------------------------------------------------------
// The whole command
// ---------------------------------------------------------------------------

/** Runs wrangler with `args` in `cwd` and returns what it printed; throws on failure. */
export type ShowcaseWrangler = (args: readonly string[], cwd: string) => Promise<string>;

export interface ShowcaseAppOptions {
  /** The fabric repository (examples/apps/<app> is read from its HEAD commit). */
  readonly repoRoot: string;
  readonly app: string;
  /** `<git dir or bundle>[@ref]`: the fixed code. Required unless beforeOnly. */
  readonly fixed?: string;
  /** The replay ids to record on (exactly one with `fixed`). */
  readonly runs: readonly string[];
  readonly beforeOnly: boolean;
  readonly dryRun: boolean;
  /** Where the replays and index.json live (apps/console/public/replays). */
  readonly replaysDir: string;
  readonly wrangler: ShowcaseWrangler;
  readonly log: (line: string) => void;
  /** Where temporary copies are made (the system temp directory by default). */
  readonly tmpRoot?: string;
}

export interface ShowcaseAppResult {
  readonly worker: string;
  readonly before?: ShowcaseBefore;
  readonly after?: ShowcaseAfter;
  /** The run ids whose index entries were written. */
  readonly recorded: readonly string[];
}

/** The fixed source, resolved to a local repository and a commit. */
interface FixedSource {
  readonly repoDir: string;
  readonly commit: string;
  readonly appRel: string;
  readonly config: ShowcaseAppConfig;
  readonly match: ShowcaseMatch;
  readonly runId: string;
  readonly alias: string;
}

/** The wrangler config text at `<commit>:<dir>/wrangler.jsonc` (or .json). */
async function configAt(repoDir: string, commit: string, dir: string): Promise<{ text: string; path: string }> {
  for (const file of ["wrangler.jsonc", "wrangler.json"]) {
    const path = dir === "" ? file : `${dir}/${file}`;
    try {
      return { text: (await runGit(["-C", repoDir, "show", `${commit}:${path}`])).stdout, path };
    } catch {
      // try the next name
    }
  }
  throw new Error(`no wrangler.jsonc at ${commit.slice(0, 12)}:${dir === "" ? "." : dir}`);
}

/** Write the tree at `treeish` of `repoDir` into the fresh directory `target` (git archive, then tar). */
async function exportTree(repoDir: string, treeish: string, target: string, scratch: string): Promise<void> {
  const tar = join(scratch, `export-${Math.random().toString(36).slice(2)}.tar`);
  await runGit(["-C", repoDir, "archive", "--format=tar", "-o", tar, treeish]);
  await mkdir(target, { recursive: true });
  await exec("tar", ["-xf", tar, "-C", target]);
  await rm(tar, { force: true });
  // Local wrangler dev state a source may carry is never part of an upload.
  await rm(join(target, ".wrangler"), { recursive: true, force: true });
}

async function writeShowcaseConfig(dir: string, worker: string, config: ShowcaseAppConfig): Promise<void> {
  await rm(join(dir, "wrangler.json"), { force: true });
  await writeFile(join(dir, "wrangler.jsonc"), showcaseWranglerConfig(worker, config));
}

/**
 * Publish the original and (unless before-only) the fixed code of `app` on
 * its showcase Worker, and record the links in the replay index. Every check
 * (arguments, the replay, the index entry, the honesty of the fixed commit)
 * runs before the first wrangler call; a dry run stops there and prints the
 * exact commands and config. Throws with the reason on any failure; nothing
 * is recorded unless every call succeeded.
 */
export async function runShowcaseApp(options: ShowcaseAppOptions): Promise<ShowcaseAppResult> {
  const { app, log } = options;
  const worker = showcaseWorkerName(app);
  if (options.beforeOnly && options.fixed !== undefined) {
    throw new Error("--before-only and --fixed do not go together");
  }
  if (!options.beforeOnly && options.fixed === undefined) {
    throw new Error("pass --fixed <git dir or bundle>[@ref] with --run <replay id>, or --before-only for the original alone");
  }
  if (options.fixed !== undefined && options.runs.length !== 1) {
    throw new Error("--fixed needs exactly one --run <replay id>: the run whose fixed code it is (the honesty check reads its replay)");
  }
  for (const id of options.runs) {
    if (!RUN_ID.test(id)) {
      throw new Error(`--run ${JSON.stringify(id.slice(0, 80))} is not a replay id`);
    }
  }
  if (new Set(options.runs).size !== options.runs.length) {
    throw new Error("a --run is given more than once");
  }

  // The original: examples/apps/<app> at the repo's HEAD commit.
  const repoRoot = resolve(options.repoRoot);
  const appPath = `examples/apps/${app}`;
  let beforeCommit: string;
  try {
    beforeCommit = (await runGit(["-C", repoRoot, "rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    await runGit(["-C", repoRoot, "cat-file", "-e", `${beforeCommit}:${appPath}`]);
  } catch {
    throw new Error(`${appPath} is not in the repository's HEAD commit`);
  }
  const beforeConfigText = await configAt(repoRoot, beforeCommit, appPath);
  const beforeConfig = readAppWranglerConfig(beforeConfigText.text, `${appPath} at ${beforeCommit.slice(0, 12)}`);
  const dirty = (await runGit(["-C", repoRoot, "status", "--porcelain", "--", appPath])).stdout.trim();
  if (dirty !== "") {
    log(`  note: ${appPath} has uncommitted changes; they are NOT uploaded (the original is the committed tree at HEAD)`);
  }

  // The runs and the index entries they are recorded on.
  const replaysDir = resolve(options.replaysDir);
  const indexPath = join(replaysDir, "index.json");
  let index: unknown;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the replay index ${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const probe: ShowcaseBefore = { url: "https://probe.workers.dev", commit: beforeCommit };
  withShowcaseApps(index, app, options.runs, { before: probe });
  const replays = new Map<string, PreviewReplayFile>();
  for (const id of options.runs) {
    let text: string;
    try {
      text = await readFile(join(replaysDir, `${id}.json`), "utf8");
    } catch {
      throw new Error(`no replay file ${id}.json in ${replaysDir}`);
    }
    const replay = parsePreviewReplay(text);
    if (replay.changeId !== id) {
      throw new Error(`the replay file ${id}.json holds the run ${replay.changeId}`);
    }
    replays.set(id, replay);
  }

  const scratch = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "scf-showcase-"));
  try {
    let fixed: FixedSource | undefined;
    if (options.fixed !== undefined) {
      const runId = options.runs[0]!;
      const source = parseFixedSource(options.fixed, (path) => existsSync(resolve(path)));
      const sourcePath = resolve(source.path);
      let info;
      try {
        info = await stat(sourcePath);
      } catch {
        throw new Error(`--fixed: ${source.path} does not exist`);
      }
      let repoDir = sourcePath;
      if (info.isFile()) {
        // A git bundle: cloned (all of its refs, its HEAD) into the scratch directory.
        repoDir = join(scratch, "fixed.git");
        try {
          await runGit(["clone", "-q", "--mirror", sourcePath, repoDir]);
        } catch (error) {
          throw new Error(`--fixed: ${source.path} is not a readable git bundle: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        }
      }
      let commit: string;
      try {
        commit = (await runGit(["-C", repoDir, "rev-parse", "--verify", "--end-of-options", `${source.ref}^{commit}`])).stdout.trim();
      } catch {
        throw new Error(`--fixed: ${source.ref} is not a commit in ${source.path}`);
      }
      const appRel = await locateAppInTree(repoDir, commit, stableAppWorkerName(app));
      const config = readAppWranglerConfig((await configAt(repoDir, commit, appRel)).text, `the fixed commit ${commit.slice(0, 12)}`);
      const match = await checkFixedMatchesRun(repoDir, commit, showcaseRunFacts(replays.get(runId)!));
      fixed = { repoDir, commit, appRel, config, match, runId, alias: afterAlias(runId, match.rev, worker) };
    }

    const commands = showcaseCommands({
      app,
      beforeCommit,
      ...(fixed !== undefined ? { after: { runId: fixed.runId, rev: fixed.match.rev, commit: fixed.commit, alias: fixed.alias } } : {}),
    });
    const dirs = { before: join(scratch, "before"), ...(fixed !== undefined ? { after: join(scratch, "after") } : {}) };

    log(`Showcase for ${app}: worker ${worker}${options.dryRun ? " (dry run: nothing is uploaded or written)" : ""}`);
    log(`  original: ${appPath} at ${beforeCommit.slice(0, 12)} (the repo's HEAD commit), alias ${BEFORE_ALIAS}, also the production deploy`);
    if (fixed !== undefined) {
      log(
        `  fixed: ${fixed.commit.slice(0, 12)} (app at ${fixed.appRel === "" ? "the tree root" : fixed.appRel}), alias ${fixed.alias}: ` +
          `revision ${fixed.match.rev} of ${fixed.runId}, ${fixed.match.detail}`,
      );
    }
    log(`  each copy gets its own wrangler.jsonc (the app's files are otherwise unchanged); the original's:`);
    for (const line of showcaseWranglerConfig(worker, beforeConfig).trimEnd().split("\n")) log(`    ${line}`);
    log(`  wrangler calls, in order:`);
    for (const command of commands) log(`    ${formatShowcaseCommand(command, dirs)}`);
    log(`  records on: ${options.runs.length > 0 ? options.runs.join(", ") : "(no run: nothing is recorded)"} in ${indexPath}`);

    if (options.dryRun) {
      return { worker, recorded: [] };
    }

    await exportTree(repoRoot, `${beforeCommit}:${appPath}`, dirs.before, scratch);
    await writeShowcaseConfig(dirs.before, worker, beforeConfig);
    if (fixed !== undefined && dirs.after !== undefined) {
      await exportTree(fixed.repoDir, fixed.appRel === "" ? fixed.commit : `${fixed.commit}:${fixed.appRel}`, dirs.after, scratch);
      await writeShowcaseConfig(dirs.after, worker, fixed.config);
    }

    const urls = new Map<string, string>();
    for (const command of commands) {
      const cwd = command.dir === "before" ? dirs.before : dirs.after!;
      let output: string;
      try {
        output = await options.wrangler(command.args, cwd);
      } catch (error) {
        throw new Error(`wrangler ${command.args.slice(0, 2).join(" ")} failed, nothing was recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (command.alias !== undefined) {
        const url = parsePreviewAliasUrl(output, command.alias);
        if (url === undefined) {
          throw new Error(`wrangler did not print a preview alias URL for ${command.alias}, nothing was recorded`);
        }
        urls.set(command.alias, url);
        log(`  ${command.alias}: ${url}`);
      } else {
        const production = (output.match(/https:\/\/[^\s"'<>]+\.workers\.dev\b/) ?? [])[0];
        log(`  production (the original): ${production ?? "deployed"}`);
      }
    }

    const before: ShowcaseBefore = { url: urls.get(BEFORE_ALIAS)!, commit: beforeCommit };
    const after: ShowcaseAfter | undefined =
      fixed !== undefined ? { url: urls.get(fixed.alias)!, commit: fixed.commit, run: fixed.runId, rev: fixed.match.rev } : undefined;
    if (options.runs.length > 0) {
      const next = withShowcaseApps(index, app, options.runs, { before, ...(after !== undefined ? { after } : {}) });
      await writeFile(indexPath, `${JSON.stringify(next, null, 2)}\n`);
      log(`Recorded the links on ${options.runs.join(", ")} in ${indexPath}.`);
    } else {
      log("No --run given: nothing was recorded in the replay index.");
    }
    return { worker, before, ...(after !== undefined ? { after } : {}), recorded: [...options.runs] };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
