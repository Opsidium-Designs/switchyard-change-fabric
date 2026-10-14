/**
 * revision-preview: a running preview of the app at every integrated board
 * revision, failing ones included.
 *
 * Each integrated revision's app tree is uploaded as a Cloudflare Worker
 * VERSION with a preview alias (`wrangler versions upload --preview-alias`):
 * a version is never deployed to the Worker's production URL, so the live app
 * is untouched; the alias URL serves exactly that revision. Previews of
 * failing revisions are intentional: a viewer can open the app as it was when
 * the gate failed. In "passing" mode (`--preview-passing`) only revisions
 * whose gate ran and passed are uploaded, all under ONE alias
 * (`fixed-<change tag>`), so the run has exactly a before (the production
 * deploy of the original) and an after (the latest passing revision).
 *
 * ADVISORY and visual only: a preview never gates, never changes a verdict,
 * and never blocks the run loop. Uploads run one at a time on a serial queue
 * off the integrator's path; a failure is reported as a skipped preview and
 * swallowed. The live uploader (wrangler) lives in the CLI; tests inject a
 * fake, so `make check` never touches the network.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGit } from "@switchyard-change/artifact-workspace/git-transport";
import type { RevisionPreview } from "@switchyard-change/change-core";
import { GATED_REF_PREFIX } from "@switchyard-change/verification";

/** One integrated revision's preview (the shared record; see change-core). */
export type { RevisionPreview };

/** Uploads an app directory as a Worker version under a preview alias and returns the alias URL. */
export type PreviewUploader = (input: { readonly appDir: string; readonly appName: string; readonly alias: string }) => Promise<{ readonly url: string }>;

/** What the previewer reports (board run events). */
export type RevisionPreviewEvent =
  | { readonly kind: "revision-previewed"; readonly n: number; readonly url: string; readonly alias: string; readonly commit: string; readonly unrecorded?: string }
  | { readonly kind: "revision-preview-skipped"; readonly n: number; readonly reason: string };

/** The longest preview alias (the Worker route validates the same bound). */
export const MAX_PREVIEW_ALIAS = 40;

/** A workers.dev hostname label is at most 63 characters: `<alias>-<worker>` must fit. */
const MAX_HOST_LABEL = 63;

/** A short, stable, lowercase base-36 hash (FNV-1a, 32 bit). */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0").slice(0, 7);
}

/**
 * The preview alias for revision `n` of a Change: `${tag}-r${n}`, where the tag
 * is the LAST meaningful dash-separated part of the Change id ("board-live-sf21"
 * gives "sf21"), lowercase [a-z0-9] only, or a short stable hash of the id when
 * nothing is left. The tag starts with a letter ("c" is prefixed otherwise) and
 * is truncated so `${alias}-${workerName}` fits one 63-character hostname label
 * and the alias fits MAX_PREVIEW_ALIAS. Throws when even a one-character tag
 * cannot fit (a worker name too long for any preview alias).
 */
export function previewAlias(changeId: string, n: number, workerName: string): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`a preview alias needs a positive integer revision number (got ${n})`);
  }
  return aliasWithTag(changeId, "", `-r${n}`, workerName, `revision ${n}`);
}

/**
 * The ONE preview alias a run's passing revisions share (`--preview-passing`):
 * `fixed-${tag}`, the tag as in previewAlias. Each later passing revision is
 * uploaded again under it, so the alias always serves the latest revision
 * whose gate passed; failing revisions are never uploaded under it.
 */
export function fixedAlias(changeId: string, workerName: string): string {
  return aliasWithTag(changeId, "fixed-", "", workerName, "the fixed version");
}

/** `${prefix}${tag}${suffix}`, the tag truncated so the alias fits the bounds above. */
function aliasWithTag(changeId: string, prefix: string, suffix: string, workerName: string, what: string): string {
  const parts = changeId
    .toLowerCase()
    .split("-")
    .map((p) => p.replace(/[^a-z0-9]/g, ""))
    .filter((p) => p !== "");
  let tag = parts.at(-1) ?? "";
  if (tag === "") {
    tag = `c${shortHash(changeId)}`;
  } else if (!/^[a-z]/.test(tag)) {
    tag = `c${tag}`;
  }
  const room = Math.min(MAX_PREVIEW_ALIAS, MAX_HOST_LABEL - 1 - workerName.length) - suffix.length - prefix.length;
  if (room < 1) {
    throw new Error(`the worker name ${JSON.stringify(workerName)} is too long for a preview alias of ${what}`);
  }
  return `${prefix}${tag.slice(0, room)}${suffix}`;
}

/** Whether a URL is an https workers.dev URL (what a preview alias URL must be). */
export function isWorkersDevUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".workers.dev");
  } catch {
    return false;
  }
}

/**
 * The preview alias URL in `wrangler versions upload --preview-alias` output.
 * wrangler prints "Version Preview Alias URL: https://<alias>-<worker>.<sub>.workers.dev"
 * (beside the per-version "Version Preview URL"). Preferred: a URL on a line
 * naming the alias URL; else any https workers.dev URL whose host starts with
 * `${alias}-`. Undefined when neither is printed.
 */
export function parsePreviewAliasUrl(output: string, alias: string): string | undefined {
  const urls = (line: string): string[] => (line.match(/https:\/\/[^\s"'<>]+/g) ?? []).map((u) => u.replace(/[).,;:]+$/, ""));
  const forAlias = (url: string): boolean => {
    if (!isWorkersDevUrl(url)) {
      return false;
    }
    return new URL(url).hostname.startsWith(`${alias}-`);
  };
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    if (/alias/i.test(line)) {
      const found = urls(line).find(forAlias);
      if (found) {
        return found;
      }
    }
  }
  for (const line of lines) {
    const found = urls(line).find(forAlias);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * The app directory's position inside the project tree, relative ("" when the
 * app is the project root). Throws when the app lies outside the project (it
 * could not be found in a tree cloned from the project).
 */
export function appPathInProject(projectDir: string, deployAppDir: string): string {
  const appRel = relative(resolve(projectDir), resolve(deployAppDir));
  if (appRel.startsWith("..") || isAbsolute(appRel)) {
    throw new Error("the app directory is outside the project, so it cannot be found in the integrated tree");
  }
  return appRel;
}

/**
 * Check out `commit` of the integration repo into a FRESH `targetDir` and drop
 * the checkout's `.git` so only the tree remains.
 *
 * A LOCAL repo (a path or a file:// URL, the local integrator's) is read
 * straight from its object store (the checkout borrows it as an alternate), so
 * a failing revision's commit is found even after its gated ref was pruned
 * (a later passing revision prunes every candidate ref). A remote (the cloud
 * integrator's Artifact repo; a token in the URL is sent as a header, never
 * stored) is cloned with its gated refs, so a failing revision's commit is
 * reachable while its ref is still there.
 */
export async function checkoutIntegratedCommit(input: { readonly remote: string; readonly commit: string; readonly targetDir: string }): Promise<void> {
  if (!/^[0-9a-f]{7,64}$/.test(input.commit)) {
    throw new Error(`not a commit id: ${JSON.stringify(input.commit.slice(0, 80))}`);
  }
  const local = input.remote.startsWith("file://") ? fileURLToPath(input.remote) : /^[a-z][a-z0-9+.-]*:\/\//i.test(input.remote) ? undefined : input.remote;
  if (local !== undefined) {
    const gitDir = (await runGit(["-C", resolve(local), "rev-parse", "--absolute-git-dir"])).stdout.trim();
    await mkdir(input.targetDir, { recursive: true });
    await runGit(["init", "-q", input.targetDir]);
    await writeFile(join(input.targetDir, ".git", "objects", "info", "alternates"), `${join(gitDir, "objects")}\n`);
  } else {
    await runGit(["clone", "-q", "--no-checkout", input.remote, input.targetDir]);
    await runGit(["-C", input.targetDir, "fetch", "-q", input.remote, `+${GATED_REF_PREFIX}*:${GATED_REF_PREFIX}*`]).catch(() => undefined);
  }
  await runGit(["-C", input.targetDir, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", input.commit]);
  await rm(join(input.targetDir, ".git"), { recursive: true, force: true });
}

/** Options for the serial revision previewer. */
export interface RevisionPreviewerOptions {
  readonly changeId: string;
  /** The app's Worker name (the stable worker name the preview versions are uploaded to). */
  readonly appName: string;
  /** The project the integration repo was seeded from, and the app directory within it. */
  readonly projectDir: string;
  readonly deployAppDir: string;
  /** Temporary trees are made (and removed) under `${workRoot}/previews`. */
  readonly workRoot: string;
  /**
   * Materialise the integrated tree at `commit` into the fresh `targetDir`.
   * Started as soon as the revision is enqueued (before its upload's turn),
   * so the commit is read while the integration repo still has it.
   */
  readonly materialise: (commit: string, targetDir: string) => Promise<void>;
  readonly upload: PreviewUploader;
  /** Record the preview (the Worker's previews route); a failure is reported, never thrown. */
  readonly record: (preview: RevisionPreview) => Promise<void>;
  readonly emit: (event: RevisionPreviewEvent) => void;
  /**
   * The alias revision `n` is uploaded under (default: previewAlias, one per
   * revision). `--preview-passing` gives every passing revision one alias.
   */
  readonly aliasFor?: (n: number) => string;
  readonly now?: () => Date;
  /** Scrubs failure text before it is reported (credentials, local paths). */
  readonly scrub?: (text: string) => string;
}

/** The serial previewer a run enqueues each integrated revision on. */
export interface RevisionPreviewer {
  /** Queue a preview of revision `n` at `commit` (ignored once drained). */
  enqueue(n: number, commit: string): void;
  /**
   * Wait (at most `timeoutMs`) for the queued uploads, then close the queue:
   * what did not finish is reported skipped and never recorded. Returns every
   * preview that was uploaded, one per n, sorted by n.
   */
  drain(timeoutMs: number): Promise<RevisionPreview[]>;
  /** The previews uploaded so far, sorted by n. */
  readonly previews: readonly RevisionPreview[];
}

/**
 * Create the serial revision previewer: each revision's tree is materialised
 * when it is enqueued, and uploads run one at a time in order. Never throws
 * into the run.
 */
export function createRevisionPreviewer(options: RevisionPreviewerOptions): RevisionPreviewer {
  const scrub = options.scrub ?? ((text: string) => text);
  const now = options.now ?? (() => new Date());
  const done = new Map<number, RevisionPreview>();
  type Prepared = { readonly tmp?: string; readonly tree?: string; readonly error?: unknown };
  type Job = { readonly n: number; readonly commit: string; readonly prepared: Promise<Prepared> };
  const queue: Job[] = [];
  let running: Promise<void> | undefined;
  let current: { n: number; abandoned: boolean } | undefined;
  let closed = false;
  const reason = (error: unknown): string => scrub(error instanceof Error ? error.message : String(error)).slice(0, 500);

  const sorted = (): RevisionPreview[] => [...done.values()].sort((a, b) => a.n - b.n);

  const prepare = async (n: number, commit: string): Promise<Prepared> => {
    let tmp: string | undefined;
    try {
      const root = join(options.workRoot, "previews");
      await mkdir(root, { recursive: true });
      tmp = await mkdtemp(join(root, `rev-${n}-`));
      const tree = join(tmp, "tree");
      await options.materialise(commit, tree);
      return { tmp, tree };
    } catch (error) {
      return { ...(tmp !== undefined ? { tmp } : {}), error };
    }
  };
  const discard = (prepared: Promise<Prepared>): void => {
    void prepared.then((p) => (p.tmp !== undefined ? rm(p.tmp, { recursive: true, force: true }) : undefined)).catch(() => undefined);
  };

  const runOne = async (job: Job, state: { n: number; abandoned: boolean }): Promise<void> => {
    let tmp: string | undefined;
    try {
      const prepared = await job.prepared;
      tmp = prepared.tmp;
      if (prepared.error !== undefined || prepared.tree === undefined) {
        throw prepared.error ?? new Error("the revision's tree was not materialised");
      }
      const appRel = appPathInProject(options.projectDir, options.deployAppDir);
      const alias = options.aliasFor ? options.aliasFor(job.n) : previewAlias(options.changeId, job.n, options.appName);
      const tree = prepared.tree;
      const appDir = appRel === "" ? tree : join(tree, appRel);
      const { url } = await options.upload({ appDir, appName: options.appName, alias });
      if (!isWorkersDevUrl(url)) {
        throw new Error(`the uploader returned a URL that is not an https workers.dev URL: ${url.slice(0, 200)}`);
      }
      if (state.abandoned) {
        return;
      }
      const preview: RevisionPreview = { n: job.n, commit: job.commit, url, alias, at: now().toISOString() };
      done.set(job.n, preview);
      let unrecorded: string | undefined;
      try {
        await options.record(preview);
      } catch (error) {
        unrecorded = reason(error);
      }
      options.emit({ kind: "revision-previewed", n: job.n, url, alias, commit: job.commit, ...(unrecorded !== undefined ? { unrecorded } : {}) });
    } catch (error) {
      if (!state.abandoned) {
        options.emit({ kind: "revision-preview-skipped", n: job.n, reason: reason(error) });
      }
    } finally {
      if (tmp !== undefined) {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };

  const pump = (): void => {
    if (running !== undefined) {
      return;
    }
    running = (async () => {
      while (!closed && queue.length > 0) {
        const job = queue.shift()!;
        current = { n: job.n, abandoned: false };
        await runOne(job, current);
        current = undefined;
      }
    })().finally(() => {
      running = undefined;
      if (!closed && queue.length > 0) {
        pump();
      }
    });
  };

  return {
    enqueue(n, commit) {
      if (closed) {
        options.emit({ kind: "revision-preview-skipped", n, reason: "the run had already finished its previews" });
        return;
      }
      queue.push({ n, commit, prepared: prepare(n, commit) });
      pump();
    },
    async drain(timeoutMs) {
      if (!closed) {
        const settled = (async () => {
          while (running !== undefined) {
            await running;
          }
        })();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          settled.then(() => false),
          new Promise<boolean>((r) => {
            timer = setTimeout(() => r(true), Math.max(0, timeoutMs));
          }),
        ]);
        clearTimeout(timer);
        closed = true;
        if (timedOut) {
          if (current !== undefined) {
            current.abandoned = true;
            options.emit({ kind: "revision-preview-skipped", n: current.n, reason: `the upload did not finish within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`} of the run's end` });
          }
          for (const job of queue.splice(0)) {
            discard(job.prepared);
            options.emit({ kind: "revision-preview-skipped", n: job.n, reason: "the run ended before its upload started" });
          }
        }
      }
      return sorted();
    },
    get previews() {
      return sorted();
    },
  };
}
