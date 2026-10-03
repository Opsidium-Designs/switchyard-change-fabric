/**
 * Deterministic path-scope matching.
 *
 * WorkUnits declare the path globs they are allowed to touch (for example
 * "src/alpha/**" or "src/index.ts"). The path-scope check compares the files a
 * WorkUnit actually changed against those globs and flags any change outside
 * scope. Matching is a pure function of its inputs: no filesystem access, no
 * clock, no randomness.
 *
 * Supported glob syntax (a small, predictable subset):
 *   - "**"  matches any number of path segments, including none
 *   - "*"   matches any run of characters within a single path segment
 *   - "?"   matches a single character within a path segment
 * Any other character matches literally. Paths are compared with forward
 * slashes.
 */

/** Returns true when `path` matches the glob `pattern`. */
export function matchesGlob(path: string, pattern: string): boolean {
  const regex = new RegExp(`^${globToRegExpSource(pattern)}$`);
  return regex.test(normalize(path));
}

/** Returns true when `path` matches at least one of the globs. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

/**
 * Partition changed paths into those that are in scope (match a declared glob)
 * and those that are out of scope. Results preserve input order so output is
 * deterministic.
 */
export function partitionByScope(
  changedPaths: readonly string[],
  declaredGlobs: readonly string[],
): { readonly inScope: readonly string[]; readonly outOfScope: readonly string[] } {
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  for (const path of changedPaths) {
    if (matchesAny(path, declaredGlobs)) {
      inScope.push(path);
    } else {
      outOfScope.push(path);
    }
  }
  return { inScope, outOfScope };
}

/** Translate a glob pattern into an anchored regular-expression source. */
function globToRegExpSource(pattern: string): string {
  const normalized = normalize(pattern);
  let out = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i] ?? "";
    // "/**" matches a slash plus any depth, OR nothing, so "src/**" also
    // matches "src" itself. Handle this sequence before the generic cases.
    if (char === "/" && normalized[i + 1] === "*" && normalized[i + 2] === "*") {
      out += "(/.*)?";
      i += 2;
      // Swallow a trailing slash after ** (for example "src/**/").
      if (normalized[i + 1] === "/") {
        i += 1;
      }
    } else if (char === "*") {
      if (normalized[i + 1] === "*") {
        // A leading or standalone "**" matches across segment boundaries.
        out += ".*";
        i += 1;
        if (normalized[i + 1] === "/") {
          i += 1;
        }
      } else {
        // A single "*" matches within one segment (no slash).
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeLiteral(char);
    }
  }
  return out;
}

/** Escape a single character for safe use in a regular expression. */
function escapeLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Normalize path separators to forward slashes. */
function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}
