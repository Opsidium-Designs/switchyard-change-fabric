/**
 * Attribution outcomes: where an ADVISORY failure attribution's pick landed
 * relative to what changed before the gate next passed, decided mechanically.
 *
 * For a failing revision (or ladder round) N where the typed-decision model
 * picked item X, the outcome is known at the next PASSING revision P: the
 * items whose pushes changed between N and P are the "fixed set". The pick is
 * "in-fixed-set" or "not-in-fixed-set"; with no passing revision after N it
 * stays unresolved. The string-parse attribution of the same failure is placed
 * the same way ("none" when it attributed nothing; parsed items outside the
 * fixed set are its "extra" items).
 *
 * What this is NOT: an accuracy measure. Attribution decides whose owner is
 * asked for a fix (a confident pick is asked, together with the parse's items;
 * otherwise the parse's items alone), so the asked items tend to be the ones
 * that change. The one comparison that carries some signal is where the pick
 * DIFFERED from the parse: which of the two then landed in the fixed set. That
 * is still biased toward whichever was asked.
 *
 * Pure and deterministic; it never affects arbitration, a verdict, or promotion.
 */

/** Where a model pick landed. */
export type AttributionOutcome = "in-fixed-set" | "not-in-fixed-set";

/** Where the parse attribution landed; "none" when the parse attributed nothing. */
export type ParseAttributionOutcome = "in-fixed-set" | "not-in-fixed-set" | "none";

/**
 * When the pick differed from the parse (the parse attributed items and the
 * pick is not among them): which of the two landed in the fixed set.
 */
export type AttributionDisagreement = "pick-only" | "parse-only" | "both" | "neither";

/** The mechanical outcome of one attribution. */
export interface AttributionResolution {
  readonly outcome: AttributionOutcome;
  readonly parseOutcome: ParseAttributionOutcome;
  /** Parsed items that were NOT in the fixed set. */
  readonly parseExtra: readonly string[];
  /** Set only when the pick differed from the parse. */
  readonly disagreement?: AttributionDisagreement;
}

/** Place a model pick and a parse attribution against the fixed set. */
export function resolveAttributionOutcome(input: {
  readonly choice: string;
  readonly parsed: readonly string[];
  readonly fixed: readonly string[];
}): AttributionResolution {
  const fixed = new Set(input.fixed);
  const pickIn = fixed.has(input.choice);
  const parseIn = input.parsed.some((p) => fixed.has(p));
  const parseOutcome: ParseAttributionOutcome = input.parsed.length === 0 ? "none" : parseIn ? "in-fixed-set" : "not-in-fixed-set";
  const differed = input.parsed.length > 0 && !input.parsed.includes(input.choice);
  return {
    outcome: pickIn ? "in-fixed-set" : "not-in-fixed-set",
    parseOutcome,
    parseExtra: input.parsed.filter((p) => !fixed.has(p)),
    ...(differed ? { disagreement: pickIn && parseIn ? "both" : pickIn ? "pick-only" : parseIn ? "parse-only" : "neither" } : {}),
  };
}

/** Counts over a run's attribution decisions. */
export interface AttributionTally {
  readonly decisions: number;
  /** Picks among the items changed before the next pass. */
  readonly inFixedSet: number;
  readonly notInFixedSet: number;
  readonly unresolved: number;
  readonly parse: {
    readonly inFixedSet: number;
    readonly notInFixedSet: number;
    /** Decisions where the parse attributed nothing (it fell back to every item). */
    readonly none: number;
    /** Parsed items outside the fixed set, summed over resolved decisions. */
    readonly extra: number;
  };
  /** Resolved decisions where the pick differed from the parse, by which landed in the fixed set. */
  readonly differed: {
    readonly total: number;
    readonly pickOnly: number;
    readonly parseOnly: number;
    readonly both: number;
    readonly neither: number;
  };
}

/** Tally resolved outcomes plus the number still unresolved. */
export function tallyAttributionOutcomes(
  resolved: readonly AttributionResolution[],
  unresolved: number,
): AttributionTally {
  const count = (f: (r: AttributionResolution) => boolean) => resolved.filter(f).length;
  return {
    decisions: resolved.length + unresolved,
    inFixedSet: count((r) => r.outcome === "in-fixed-set"),
    notInFixedSet: count((r) => r.outcome === "not-in-fixed-set"),
    unresolved,
    parse: {
      inFixedSet: count((r) => r.parseOutcome === "in-fixed-set"),
      notInFixedSet: count((r) => r.parseOutcome === "not-in-fixed-set"),
      none: count((r) => r.parseOutcome === "none"),
      extra: resolved.reduce((sum, r) => sum + r.parseExtra.length, 0),
    },
    differed: {
      total: count((r) => r.disagreement !== undefined),
      pickOnly: count((r) => r.disagreement === "pick-only"),
      parseOnly: count((r) => r.disagreement === "parse-only"),
      both: count((r) => r.disagreement === "both"),
      neither: count((r) => r.disagreement === "neither"),
    },
  };
}

/**
 * The summary line. It states what is measured and nothing more: where the
 * picks landed relative to the items changed before the next pass. It is not
 * a controlled accuracy measure (the attribution chose whom to ask to fix).
 */
export function formatAttributionTally(tally: AttributionTally): string {
  const p = tally.parse;
  const d = tally.differed;
  return (
    `jev attribution: ${tally.decisions} decision(s); pick among items changed before the next pass: ${tally.inFixedSet}, ` +
    `not: ${tally.notInFixedSet}, unresolved: ${tally.unresolved} (not a controlled accuracy measure: the items asked to fix tend to change; ` +
    `parse among them: ${p.inFixedSet}, not: ${p.notInFixedSet}, unattributed: ${p.none}, extra item(s): ${p.extra}; ` +
    `pick differed from parse: ${d.total} (pick only: ${d.pickOnly}, parse only: ${d.parseOnly}, both: ${d.both}, neither: ${d.neither}), ` +
    `biased toward whichever was asked to fix)`
  );
}
