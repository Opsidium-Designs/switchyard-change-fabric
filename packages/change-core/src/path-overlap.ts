/**
 * Deterministic path and glob OVERLAP for board intents.
 *
 * A claim's intent lists the paths an agent will read or write. Entries may be a
 * concrete path ("src/a.ts"), a glob ("src/**", "src/*.ts"), or a symbol-scoped
 * path ("src/a.ts#parse"). Two write intents conflict when some concrete path
 * could match both entries, so this module answers "do these two globs share at
 * least one path?" exactly, not just "does this path match this glob?".
 *
 * The glob syntax and meaning mirror the verification package's path-scope
 * matcher (which change-core cannot import, since verification depends on
 * change-core):
 *   - "**"  matches any number of path segments, including none
 *     ("src/**" also matches "src" itself)
 *   - "*"   matches any run of characters within one path segment
 *   - "?"   matches a single character within one path segment
 * Any other character matches literally.
 *
 * Each glob compiles to a small nondeterministic automaton; two globs overlap
 * when the product automaton can reach both accept states. That is exact for
 * this syntax and runs in time proportional to the product of the pattern
 * lengths. No I/O, no clock, no randomness.
 *
 * Symbol-level intent (`path#symbol`) is accepted syntactically, but for overlap
 * it is treated as its path: two symbols in one file overlap.
 */

type Label =
  | { readonly kind: "lit"; readonly ch: string }
  | { readonly kind: "seg" } // any single character except "/"
  | { readonly kind: "any" }; // any single character

interface State {
  readonly eps: number[];
  readonly moves: { readonly label: Label; readonly to: number }[];
}

interface Automaton {
  readonly states: readonly State[];
  readonly start: number;
  readonly accept: number;
}

/** Strip a symbol suffix (`path#symbol` -> `path`). */
export function intentPath(entry: string): string {
  const hash = entry.indexOf("#");
  return hash === -1 ? entry : entry.slice(0, hash);
}

/** True when the entry (after stripping a symbol suffix) contains a wildcard. */
export function hasWildcard(entry: string): boolean {
  return /[*?]/.test(intentPath(entry));
}

/** The longest intent entry accepted (bounds the overlap automata). */
export const MAX_INTENT_ENTRY_LENGTH = 512;

/**
 * Normalize an intent entry: forward slashes, no leading "./". A trailing "/"
 * names a directory, so "src/" becomes "src/**" (everything under it).
 * Returns undefined for an entry that is empty, absolute, or escapes the repo
 * with a ".." segment, so callers can reject it with a clear error.
 */
export function normalizeIntentEntry(entry: string): string | undefined {
  if (typeof entry !== "string" || entry.length > MAX_INTENT_ENTRY_LENGTH) {
    return undefined;
  }
  const hash = entry.indexOf("#");
  const rawPath = hash === -1 ? entry : entry.slice(0, hash);
  const symbol = hash === -1 ? undefined : entry.slice(hash + 1);
  let path = rawPath.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  path = path.replace(/\/+/g, "/");
  if (path.endsWith("/") && path !== "/") {
    path = `${path}**`;
  }
  if (path === "" || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return undefined;
  }
  if (path.split("/").some((segment) => segment === ".." || segment === ".")) {
    return undefined;
  }
  if (symbol !== undefined) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(symbol) || hasWildcard(path)) {
      return undefined;
    }
    return `${path}#${symbol}`;
  }
  return path;
}

/** Do two intent entries (paths, globs, or `path#symbol`) share any path? */
export function entriesOverlap(a: string, b: string): boolean {
  const pa = intentPath(a);
  const pb = intentPath(b);
  if (pa === pb) {
    return true;
  }
  return automataIntersect(compile(pa), compile(pb));
}

/**
 * Every entry of `mine` that overlaps at least one entry of `theirs`, in the
 * order of `mine` with duplicates removed.
 */
export function overlappingEntries(mine: readonly string[], theirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of mine) {
    if (!out.includes(entry) && theirs.some((other) => entriesOverlap(entry, other))) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Is `inner` contained in `outer` (every path `inner` can name, `outer` names
 * too)? Used to check that a narrowed intent really shrinks. Containment is
 * decided exactly: the outer glob is determinized and complemented, and
 * `inner` is contained when no path is accepted by `inner` and rejected by
 * `outer`. A symbol-scoped entry is inside its own path (and any glob covering
 * it); a symbol-scoped outer entry contains only itself.
 */
export function entryWithin(inner: string, outer: string): boolean {
  if (inner === outer) {
    return true;
  }
  if (outer.includes("#")) {
    return false;
  }
  return automatonWithin(compile(intentPath(inner)), compile(outer));
}

/** Every entry of `inner` is within some entry of `outer`. */
export function intentWithin(inner: readonly string[], outer: readonly string[]): boolean {
  return inner.every((entry) => outer.some((o) => entryWithin(entry, o)));
}

/** Compile a glob into an automaton mirroring the path-scope regex translation. */
function compile(pattern: string): Automaton {
  const states: State[] = [];
  const add = (): number => {
    states.push({ eps: [], moves: [] });
    return states.length - 1;
  };
  const start = add();
  let cur = start;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? "";
    if (ch === "/" && pattern[i + 1] === "*" && pattern[i + 2] === "*") {
      // "/**" is "(/.*)?": either nothing, or a slash followed by anything.
      const inside = add();
      const end = add();
      states[cur]!.eps.push(end);
      states[cur]!.moves.push({ label: { kind: "lit", ch: "/" }, to: inside });
      states[inside]!.moves.push({ label: { kind: "any" }, to: inside });
      states[inside]!.eps.push(end);
      cur = end;
      i += 2;
      if (pattern[i + 1] === "/") {
        i += 1;
      }
    } else if (ch === "*" && pattern[i + 1] === "*") {
      // A leading or standalone "**" matches across segment boundaries.
      const loop = add();
      states[cur]!.eps.push(loop);
      states[loop]!.moves.push({ label: { kind: "any" }, to: loop });
      cur = loop;
      i += 1;
      if (pattern[i + 1] === "/") {
        i += 1;
      }
    } else if (ch === "*") {
      const loop = add();
      states[cur]!.eps.push(loop);
      states[loop]!.moves.push({ label: { kind: "seg" }, to: loop });
      cur = loop;
    } else if (ch === "?") {
      const next = add();
      states[cur]!.moves.push({ label: { kind: "seg" }, to: next });
      cur = next;
    } else {
      const next = add();
      states[cur]!.moves.push({ label: { kind: "lit", ch }, to: next });
      cur = next;
    }
  }
  return { states, start, accept: cur };
}

/** Can one character satisfy both labels? */
function labelsIntersect(a: Label, b: Label): boolean {
  if (a.kind === "lit" && b.kind === "lit") {
    return a.ch === b.ch;
  }
  if (a.kind === "lit") {
    return b.kind === "any" || a.ch !== "/";
  }
  if (b.kind === "lit") {
    return a.kind === "any" || b.ch !== "/";
  }
  return true;
}

/** Breadth-first search of the product automaton for a common accepted string. */
function automataIntersect(a: Automaton, b: Automaton): boolean {
  const seen = new Set<string>();
  const queue: [number, number][] = [[a.start, b.start]];
  for (let head = 0; head < queue.length; head += 1) {
    const [p, q] = queue[head]!;
    const key = `${p},${q}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (p === a.accept && q === b.accept) {
      return true;
    }
    const sp = a.states[p]!;
    const sq = b.states[q]!;
    for (const e of sp.eps) {
      queue.push([e, q]);
    }
    for (const e of sq.eps) {
      queue.push([p, e]);
    }
    for (const ma of sp.moves) {
      for (const mb of sq.moves) {
        if (labelsIntersect(ma.label, mb.label)) {
          queue.push([ma.to, mb.to]);
        }
      }
    }
  }
  return false;
}

/** The states reachable from `states` through epsilon moves (sorted). */
function closure(automaton: Automaton, states: readonly number[]): number[] {
  const seen = new Set<number>(states);
  const stack = [...states];
  while (stack.length > 0) {
    const state = stack.pop()!;
    for (const next of automaton.states[state]!.eps) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return [...seen].sort((x, y) => x - y);
}

/** Does a label accept a concrete character? */
function labelAccepts(label: Label, ch: string): boolean {
  if (label.kind === "lit") {
    return label.ch === ch;
  }
  return label.kind === "any" || ch !== "/";
}

/**
 * Exact containment L(inner) within L(outer). The alphabet is split into finite
 * classes: each literal character either pattern mentions, "/", and one
 * representative of every other character. The outer automaton is run as a
 * subset (deterministic) automaton alongside the inner one; a reachable pair
 * where inner accepts and the outer subset holds no accept state is a path
 * inside `inner` but outside `outer`.
 */
function automatonWithin(inner: Automaton, outer: Automaton): boolean {
  const literals = new Set<string>(["/"]);
  for (const automaton of [inner, outer]) {
    for (const state of automaton.states) {
      for (const move of state.moves) {
        if (move.label.kind === "lit") {
          literals.add(move.label.ch);
        }
      }
    }
  }
  // A character no pattern mentions (and not "/"): the "every other" class.
  let other = "\u0001";
  for (let code = 1; literals.has(other); code += 1) {
    other = String.fromCharCode(code);
  }
  const alphabet = [...literals, other];

  const step = (automaton: Automaton, states: readonly number[], ch: string): number[] => {
    const next = new Set<number>();
    for (const state of states) {
      for (const move of automaton.states[state]!.moves) {
        if (labelAccepts(move.label, ch)) {
          next.add(move.to);
        }
      }
    }
    return closure(automaton, [...next]);
  };

  const seen = new Set<string>();
  const queue: [number[], number[]][] = [[closure(inner, [inner.start]), closure(outer, [outer.start])]];
  for (let head = 0; head < queue.length; head += 1) {
    const [innerSet, outerSet] = queue[head]!;
    const key = `${innerSet.join(",")}|${outerSet.join(",")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (innerSet.includes(inner.accept) && !outerSet.includes(outer.accept)) {
      return false;
    }
    if (innerSet.length === 0) {
      continue;
    }
    for (const ch of alphabet) {
      const nextInner = step(inner, innerSet, ch);
      if (nextInner.length > 0) {
        queue.push([nextInner, step(outer, outerSet, ch)]);
      }
    }
  }
  return true;
}
