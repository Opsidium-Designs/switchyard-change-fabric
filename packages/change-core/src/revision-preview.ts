/**
 * The revision preview record: a running preview of the app at one integrated
 * board revision, uploaded as a Cloudflare Worker VERSION under a preview alias
 * (never a production deploy). Advisory and visual only: it never gates and
 * never changes a verdict.
 *
 * Shared by the Worker's previews route (and its Durable Object) and the
 * in-process local control, so both validate and keep previews the same way.
 * Pure: no Node or Worker APIs.
 */

/** One integrated revision's preview. */
export interface RevisionPreview {
  /** The integrated revision number. */
  readonly n: number;
  /** The integrated.rev commit (full sha) the preview was built from. */
  readonly commit: string;
  /** https://<alias>-<worker>.<subdomain>.workers.dev (the alias URL). */
  readonly url: string;
  /** For example "sf21-r3". */
  readonly alias: string;
  /** ISO time the upload finished. */
  readonly at: string;
  /** Set only when uploaded AFTER the run from recorded commits. */
  readonly backfilled?: true;
}

/** The most previews one Change keeps (the lowest revisions are dropped past it). */
export const MAX_RECORDED_PREVIEWS = 200;

/**
 * Validate a posted preview body: `n` a positive integer, `commit` 7 to 64 hex
 * characters, `alias` [a-z0-9-]{1,40}, `url` an https URL on a `.workers.dev`
 * host, `at` an ISO time (optional: `now()` when absent), `backfilled`
 * optional and only `true`. Returns the normalised record or why it is refused.
 */
export function parseRevisionPreview(
  body: unknown,
  now: () => string,
): { readonly ok: true; readonly preview: RevisionPreview } | { readonly ok: false; readonly error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "a preview must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.n !== "number" || !Number.isInteger(b.n) || b.n < 1) {
    return { ok: false, error: "preview n must be a positive integer" };
  }
  if (typeof b.commit !== "string" || !/^[0-9a-f]{7,64}$/.test(b.commit)) {
    return { ok: false, error: "preview commit must be 7 to 64 lowercase hex characters" };
  }
  if (typeof b.alias !== "string" || !/^[a-z0-9-]{1,40}$/.test(b.alias)) {
    return { ok: false, error: "preview alias must be 1 to 40 characters of [a-z0-9-]" };
  }
  if (typeof b.url !== "string" || b.url.length > 300) {
    return { ok: false, error: "preview url must be an https workers.dev URL" };
  }
  // Parsed without the URL global (this module has no DOM or Node types): an
  // https scheme, a plain hostname (no credentials), an optional port and path.
  const parsed = /^https:\/\/([a-z0-9.-]+)(?::[0-9]{1,5})?(?:[/?#][^\s]*)?$/i.exec(b.url);
  const host = parsed?.[1]?.toLowerCase() ?? "";
  if (!host.endsWith(".workers.dev") || host.startsWith(".") || host.includes("..")) {
    return { ok: false, error: "preview url must be an https workers.dev URL" };
  }
  let at: string;
  if (b.at === undefined) {
    at = now();
  } else if (typeof b.at === "string" && b.at.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(b.at) && !Number.isNaN(Date.parse(b.at))) {
    at = b.at;
  } else {
    return { ok: false, error: "preview at must be an ISO time" };
  }
  if (b.backfilled !== undefined && b.backfilled !== true) {
    return { ok: false, error: "preview backfilled may only be true" };
  }
  return {
    ok: true,
    preview: { n: b.n, commit: b.commit, url: b.url, alias: b.alias, at, ...(b.backfilled === true ? { backfilled: true as const } : {}) },
  };
}

/**
 * The previews with `preview` added: one per n (a later write for the same n
 * replaces the earlier one), sorted by n, at most MAX_RECORDED_PREVIEWS (the
 * lowest revisions are dropped first).
 */
export function mergeRevisionPreview(previews: readonly RevisionPreview[], preview: RevisionPreview): RevisionPreview[] {
  const byN = new Map<number, RevisionPreview>();
  for (const p of previews) {
    byN.set(p.n, p);
  }
  byN.set(preview.n, preview);
  return [...byN.values()].sort((a, b) => a.n - b.n).slice(-MAX_RECORDED_PREVIEWS);
}
