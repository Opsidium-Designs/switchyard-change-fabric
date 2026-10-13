/**
 * Revision previews: the running app at an integrated revision, uploaded as a
 * Worker version (never a production deploy) from that revision's commit.
 *
 * A preview is shown only when it is backed: the board log holds an
 * `integrated.rev` with the same number AND the same commit. A preview whose
 * commit does not match what the gate judged is dropped, so a link always
 * opens the exact tree the timeline says it does. Previews are visual and
 * advisory: the gate verdict stays the only verdict.
 */
import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

export interface RevisionPreview {
  readonly n: number;
  readonly commit: string;
  readonly url: string;
  readonly alias: string;
  readonly at: string;
  /** Uploaded after the run from the recorded revision commits. */
  readonly backfilled?: true;
}

/** A preview URL must be an https workers.dev URL with no credentials in it. */
function isPreviewUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname.endsWith(".workers.dev") && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/** The well-formed previews in a snapshot's `previews` field (anything malformed is skipped). */
export function readPreviews(snapshot: unknown): RevisionPreview[] {
  const raw = (snapshot as { previews?: unknown } | null | undefined)?.previews;
  if (!Array.isArray(raw)) return [];
  const out: RevisionPreview[] = [];
  for (const p of raw as unknown[]) {
    if (typeof p !== "object" || p === null) continue;
    const r = p as Record<string, unknown>;
    if (typeof r.n !== "number" || !Number.isInteger(r.n) || r.n < 1) continue;
    if (typeof r.commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(r.commit)) continue;
    if (!isPreviewUrl(r.url)) continue;
    out.push({
      n: r.n,
      commit: r.commit,
      url: r.url,
      alias: typeof r.alias === "string" ? r.alias : `r${r.n}`,
      at: typeof r.at === "string" ? r.at : "",
      ...(r.backfilled === true ? { backfilled: true as const } : {}),
    });
  }
  return out;
}

/** The backed previews by revision number: only those whose commit matches the log's `integrated.rev`. */
export function backedPreviews(log: readonly BoardMessage[], previews: readonly RevisionPreview[]): Map<number, RevisionPreview> {
  const commits = new Map<number, string>();
  for (const m of log) if (m.type === "integrated.rev") commits.set(m.payload.n, m.payload.commit);
  const out = new Map<number, RevisionPreview>();
  for (const p of previews) {
    const commit = commits.get(p.n);
    if (commit !== undefined && commit.toLowerCase() === p.commit.toLowerCase()) out.set(p.n, p);
  }
  return out;
}

/**
 * The preview of the LATEST revision whose gate passed (a gate actually ran:
 * an ungated "pass" checked nothing), and only when that preview is backed by
 * the log's commit for it. This is the fixed app a human can open; undefined
 * when no passing revision has a backed preview.
 */
export function latestPassingPreview(
  log: readonly BoardMessage[],
  previews: readonly RevisionPreview[],
): RevisionPreview | undefined {
  const backed = backedPreviews(log, previews);
  let best: RevisionPreview | undefined;
  for (const m of log) {
    if (m.type !== "integrated.rev" || m.payload.gate !== "pass" || m.payload.gated === false) continue;
    const p = backed.get(m.payload.n);
    if (p !== undefined && (best === undefined || p.n > best.n)) best = p;
  }
  return best;
}

/** How a preview link describes itself (hover text). */
export function previewTitle(p: RevisionPreview, gate: string): string {
  return `The app running revision ${p.n} (commit ${p.commit.slice(0, 10)}), a Worker version uploaded from that exact commit${p.backfilled ? " after the run" : ""}. Its gate said ${gate}; the preview is only a look, the gate decides.`;
}
