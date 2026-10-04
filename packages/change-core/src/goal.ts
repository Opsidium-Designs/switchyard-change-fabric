/**
 * Goal analysis: turn a plain-text goal into a structured intent the decomposer
 * can reason over, without the decomposer ever branching on the goal string.
 *
 * The key move for goal-agnosticism is here: a goal is reduced to a small set of
 * generic, domain-level features (which action families it asks for, which
 * target terms it names, and whether it quantifies over "every"/"all"), and the
 * decomposer builds the work graph from those features matched against the real
 * repository, never from the literal goal text. Two different goals that reduce
 * to the same features would produce the same shape; two goals with different
 * features produce different shapes. There is no lookup table keyed on the goal.
 *
 * Analysis is pluggable. The default `HeuristicGoalAnalyzer` is deterministic
 * and offline (pure string feature extraction), which is what the test substrate
 * and `make check` use. A caller may inject an inference-backed analyzer that
 * produces the same `GoalIntent` shape for richer goals; the decomposer does not
 * care which produced it, so determinism is preserved wherever the heuristic is
 * used.
 */

/** A coarse family of change the goal is asking for. */
export type ActionFamily =
  | "add" // introduce new capability or code
  | "validate" // add guards / input validation / checks
  | "wire" // connect / integrate one piece into another
  | "test" // add or extend tests
  | "refactor" // restructure without changing behavior
  | "document"; // add or update documentation

/**
 * The structured, goal-agnostic reduction of a goal. The decomposer consumes
 * only this, so it never sees the raw goal string as a branch condition.
 */
export interface GoalIntent {
  /** The original goal text, carried only for human-readable objectives. */
  readonly text: string;
  /** Action families present in the goal, de-duplicated, in a stable order. */
  readonly actions: readonly ActionFamily[];
  /**
   * Target terms named by the goal (noun phrases and salient keywords), lower
   * case, de-duplicated. These are matched against repo structure, not compared
   * to a fixed catalog of known goals.
   */
  readonly targets: readonly string[];
  /**
   * True when the goal quantifies over the whole surface ("every"/"all"/"each"),
   * which drives a fan-out (one WorkUnit per matching file) rather than a single
   * unit. This is a property of the goal's language, not of any specific goal.
   */
  readonly isUniversal: boolean;
}

/** The pluggable analyzer seam. */
export interface GoalAnalyzer {
  analyze(goalText: string): GoalIntent;
}

/** Action keyword families. First match wins per keyword; order is stable. */
const ACTION_KEYWORDS: ReadonlyArray<readonly [ActionFamily, readonly string[]]> = [
  ["validate", ["validate", "validation", "guard", "sanitize", "check input", "assert"]],
  ["wire", ["wire", "connect", "integrate", "register", "mount", "hook up", "plug"]],
  ["test", ["test", "tests", "spec", "coverage"]],
  ["refactor", ["refactor", "restructure", "extract", "rename", "clean up"]],
  ["document", ["document", "documentation", "readme", "docs", "comment"]],
  ["add", ["add", "create", "implement", "introduce", "build", "support", "endpoint"]],
];

const ACTION_ORDER: readonly ActionFamily[] = [
  "add",
  "validate",
  "wire",
  "test",
  "refactor",
  "document",
];

const UNIVERSAL_WORDS = ["every", "all", "each"];

/**
 * Common English words to drop when extracting target terms, so the targets are
 * salient nouns ("validation", "endpoint", "router", "function") rather than
 * filler. This is a generic stop list, not goal-specific tuning.
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "and",
  "or",
  "for",
  "into",
  "in",
  "on",
  "with",
  "every",
  "all",
  "each",
  "that",
  "this",
  "it",
  "its",
  "add",
  "create",
  "implement",
  "introduce",
  "build",
  "wire",
  "connect",
  "integrate",
  "register",
  "mount",
  "plug",
  "validate",
  "test",
  "tests",
  "refactor",
  "document",
  "then",
  "also",
  "please",
  "new",
  "existing",
]);

/**
 * The default deterministic, offline goal analyzer. It lower-cases the goal,
 * detects action families and the universal quantifier by keyword, and extracts
 * salient target terms by dropping stop words and action verbs. Pure and
 * reproducible: the same goal text always yields the same intent.
 */
export class HeuristicGoalAnalyzer implements GoalAnalyzer {
  analyze(goalText: string): GoalIntent {
    const text = goalText.trim();
    const lower = text.toLowerCase();

    const actionsFound = new Set<ActionFamily>();
    for (const [family, keywords] of ACTION_KEYWORDS) {
      if (keywords.some((kw) => lower.includes(kw))) {
        actionsFound.add(family);
      }
    }
    // Every goal does at least something additive if it names no other action.
    if (actionsFound.size === 0) {
      actionsFound.add("add");
    }
    const actions = ACTION_ORDER.filter((family) => actionsFound.has(family));

    const isUniversal = UNIVERSAL_WORDS.some((word) =>
      new RegExp(`\\b${word}\\b`).test(lower),
    );

    const targets = extractTargets(lower);

    return { text, actions, targets, isUniversal };
  }
}

/** Extract salient, de-duplicated target terms from a lower-cased goal. */
function extractTargets(lower: string): readonly string[] {
  const words = lower
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

  const seen = new Set<string>();
  const targets: string[] = [];
  for (const word of words) {
    const normalized = singularize(word);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      targets.push(normalized);
    }
  }
  return targets;
}

/** A tiny deterministic singularizer so "functions" and "function" match. */
function singularize(word: string): string {
  if (word.endsWith("ies") && word.length > 3) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.endsWith("ses") && word.length > 3) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) {
    return word.slice(0, -1);
  }
  return word;
}
