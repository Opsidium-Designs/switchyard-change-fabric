/**
 * preview-replay: the pure and local-Git half of BACKFILLING revision previews
 * for a recorded run (a replay file exported from a Worker).
 *
 * The plan is read from the replay's recorded `integrated.rev` messages (each
 * one's revision number and integrated commit); each commit is checked to
 * exist in the run's integration repo; the app is located inside the
 * integrated tree (the directory holding wrangler.jsonc, whose Worker name
 * must be the app's stable worker name); and the uploaded previews are
 * written back into the replay's snapshot marked `backfilled: true`. The
 * upload itself (wrangler) is the CLI's; nothing here touches the network.
 */

import { runGit } from "@switchyard-change/artifact-workspace/git-transport";

import { MAX_RECORDED_PREVIEWS } from "@switchyard-change/change-core";

import { previewAlias, type RevisionPreview } from "./revision-preview.ts";

/** The replay file shape (see apps/console/scripts/replay-export.ts). */
export interface PreviewReplayFile {
  readonly format: string;
  readonly changeId: string;
  readonly messages: readonly { readonly type: string; readonly payload?: unknown }[];
  readonly snapshot: Record<string, unknown> | null;
}

/** One revision the backfill would preview. */
export interface PreviewReplayStep {
  readonly n: number;
  readonly commit: string;
  readonly alias: string;
}

/** The most previews a snapshot keeps (the Worker caps the same). */
export const MAX_PREVIEWS = MAX_RECORDED_PREVIEWS;

/** Parse and check a replay file's text (the fields the backfill needs). */
export function parsePreviewReplay(text: string): PreviewReplayFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`the replay file is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const file = raw as Partial<PreviewReplayFile> | null;
  if (file === null || typeof file !== "object" || typeof file.changeId !== "string" || file.changeId === "" || !Array.isArray(file.messages)) {
    throw new Error("the replay file has no changeId or no messages");
  }
  if (file.snapshot !== null && file.snapshot !== undefined && (typeof file.snapshot !== "object" || Array.isArray(file.snapshot))) {
    throw new Error("the replay file's snapshot is not an object");
  }
  return file as PreviewReplayFile;
}

/**
 * The backfill plan: every recorded integrated revision (fail and pass), one
 * per n (a later record of the same n wins), sorted by n, with its alias.
 */
export function previewReplayPlan(replay: PreviewReplayFile, workerName: string): PreviewReplayStep[] {
  const byN = new Map<number, string>();
  for (const message of replay.messages) {
    if (message.type !== "integrated.rev") {
      continue;
    }
    const payload = message.payload as { readonly n?: unknown; readonly commit?: unknown } | undefined;
    const n = payload?.n;
    const commit = payload?.commit;
    if (typeof n === "number" && Number.isInteger(n) && n > 0 && typeof commit === "string" && /^[0-9a-f]{7,64}$/.test(commit)) {
      byN.set(n, commit);
    }
  }
  return [...byN.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, commit]) => ({ n, commit, alias: previewAlias(replay.changeId, n, workerName) }));
}

/** Whether `commit` is a commit object in the repo at `repoDir` (a bare or a working repo). */
export async function commitExists(repoDir: string, commit: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) {
    return false;
  }
  try {
    await runGit(["-C", repoDir, "cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The Worker `name` declared in a wrangler.jsonc / wrangler.json text (comments allowed). */
export function wranglerConfigName(text: string): string | undefined {
  const parsed = parseWranglerConfig(text);
  return typeof parsed?.name === "string" ? parsed.name : undefined;
}

/**
 * A wrangler.jsonc / wrangler.json text parsed as an object (comments outside
 * strings and trailing commas allowed), or undefined when it is not one.
 */
export function parseWranglerConfig(text: string): Record<string, unknown> | undefined {
  // Drop comments outside strings, then parse.
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 1;
    } else {
      out += ch;
    }
  }
  try {
    const parsed: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locate the app inside the integrated tree at `commit`: the shallowest
 * directory holding a wrangler.jsonc (or wrangler.json), whose declared Worker
 * name must equal `workerName`. Returns its path relative to the tree root (""
 * when the app is the root). Throws, naming what was found, otherwise.
 */
export async function locateAppInTree(repoDir: string, commit: string, workerName: string): Promise<string> {
  const { stdout } = await runGit(["-C", repoDir, "ls-tree", "-r", "--name-only", commit]);
  const configs = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((path) => /(^|\/)wrangler\.jsonc?$/.test(path) && !path.split("/").includes("node_modules"))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  if (configs.length === 0) {
    throw new Error(`no wrangler.jsonc in the integrated tree at ${commit.slice(0, 12)}`);
  }
  const seen: string[] = [];
  for (const path of configs) {
    const text = (await runGit(["-C", repoDir, "show", `${commit}:${path}`])).stdout;
    const name = wranglerConfigName(text);
    if (name === workerName) {
      const slash = path.lastIndexOf("/");
      return slash === -1 ? "" : path.slice(0, slash);
    }
    seen.push(`${path} (name ${name === undefined ? "unreadable" : JSON.stringify(name)})`);
  }
  throw new Error(`no wrangler config in the integrated tree at ${commit.slice(0, 12)} declares the Worker ${JSON.stringify(workerName)}: ${seen.join(", ")}`);
}

/**
 * The replay with `previews` merged into its snapshot (created when null):
 * each marked `backfilled: true`, one per n (a new one replaces an old one),
 * sorted by n, capped at MAX_PREVIEWS. Everything else is kept as it was.
 */
export function withBackfilledPreviews(replay: PreviewReplayFile, previews: readonly RevisionPreview[]): PreviewReplayFile {
  const snapshot = replay.snapshot ?? {};
  const existing = Array.isArray(snapshot.previews) ? (snapshot.previews as RevisionPreview[]) : [];
  const byN = new Map<number, RevisionPreview>();
  for (const p of existing) {
    if (p && typeof p.n === "number") {
      byN.set(p.n, p);
    }
  }
  for (const p of previews) {
    byN.set(p.n, { n: p.n, commit: p.commit, url: p.url, alias: p.alias, at: p.at, backfilled: true });
  }
  const merged = [...byN.values()].sort((a, b) => a.n - b.n).slice(-MAX_PREVIEWS);
  return { ...replay, snapshot: { ...snapshot, previews: merged } };
}

/** A replay serialised the way the exporter writes it (compact JSON and a newline). */
export function serializePreviewReplay(replay: PreviewReplayFile): string {
  return `${JSON.stringify(replay)}\n`;
}
