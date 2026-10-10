/**
 * Bounded, deterministic Artifact repo names.
 *
 * Every repo the fabric provisions is named from ids it already has
 * (`<changeId>--<unitId>`, `<changeId>--board-<agent>`, ...). Artifacts caps a
 * repo name at 63 characters, and a long Change id plus a long agent or unit id
 * can exceed that. This keeps names readable and stable:
 *   - a name that fits is returned unchanged (only sanitized, as before), so
 *     every existing short name stays byte-identical;
 *   - a longer name keeps a readable prefix and ends with `-<8 hex>`, a hash of
 *     the FULL sanitized name, so two long names that share a prefix never
 *     collide on the truncation.
 * Pure TypeScript (no node:crypto), so it runs in a Worker and in Node alike.
 */

/** The longest repo name the Artifacts service accepts. */
export const ARTIFACT_REPO_NAME_MAX = 63;

/** Length of the hash suffix (hex characters) a truncated name ends with. */
const HASH_HEX = 8;

/** Reduce a raw name to the repo-name alphabet (runs of anything else become one `-`). */
export function sanitizeRepoName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * The bounded repo name for `raw`: sanitized, unchanged when it fits in `max`
 * characters, otherwise a readable prefix plus `-` and an 8-hex hash of the
 * whole sanitized name. Deterministic: the same input always yields the same
 * name, on every substrate.
 */
export function boundedRepoName(raw: string, max: number = ARTIFACT_REPO_NAME_MAX): string {
  const name = sanitizeRepoName(raw);
  if (name.length <= max) {
    return name;
  }
  if (!Number.isInteger(max) || max < HASH_HEX + 2) {
    throw new Error(`a repo name limit must be an integer of at least ${HASH_HEX + 2}`);
  }
  // Drop trailing separators from the cut so the result never reads `x--<hash>`.
  const readable = name.slice(0, max - HASH_HEX - 1).replace(/[-.]+$/, "");
  return `${readable}-${fnv1a32Hex(name)}`;
}

/** 32-bit FNV-1a over the UTF-16 code units of `text`, as 8 lowercase hex chars. */
function fnv1a32Hex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(HASH_HEX, "0");
}
