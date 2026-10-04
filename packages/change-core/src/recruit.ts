/**
 * The pure recruitment policy: how many agents to recruit this wave, and which
 * runnable WorkUnits they take, given a min/max concurrency dial and the set of
 * agents already in flight.
 *
 * This is deliberately a policy over the runnable set and the dial, not a
 * hardcoded count and not one-agent-per-named-unit. The engine never decides to
 * run "the three units it knows about"; it decides to run "as many runnable
 * units as the dial currently allows, up to how many are runnable". Raising the
 * maximum of the dial widens the recruited slice through this one function, so
 * the dial is the only thing that changes concurrency, by the same code path.
 *
 * It is free of I/O and state so both the live Durable Object and the offline
 * substrate call exactly this function to compute each wave's recruitment. The
 * two cannot drift in how the dial governs concurrency because there is one
 * definition of it here.
 */

/** The min/max concurrency dial that bounds recruitment each wave. */
export interface ConcurrencyDial {
  /**
   * The floor on how many agents to recruit when there is runnable work. The
   * engine recruits at least this many runnable units when at least this many
   * are runnable (fewer only when fewer are runnable). A min of zero means the
   * engine only recruits what the max and the runnable set allow.
   */
  readonly minConcurrency: number;
  /**
   * The ceiling on how many agents may be in flight at once. Recruitment never
   * pushes the number of in-flight agents above this. Raising it is the single
   * lever that widens concurrency.
   */
  readonly maxConcurrency: number;
}

/** The default dial: a conservative floor of one, a ceiling of three. */
export const DEFAULT_DIAL: ConcurrencyDial = {
  minConcurrency: 1,
  maxConcurrency: 3,
};

/** The input a recruitment decision is computed from. */
export interface RecruitInput {
  /** The WorkUnit ids that are runnable right now, in schedule order. */
  readonly runnable: readonly string[];
  /** The number of recruited agents currently in flight (leased, not complete). */
  readonly inFlight: number;
  /** The active concurrency dial. */
  readonly dial: ConcurrencyDial;
}

/** The outcome of a recruitment decision for one wave. */
export interface RecruitDecision {
  /** The runnable WorkUnit ids to recruit an agent for this wave, in order. */
  readonly recruit: readonly string[];
  /**
   * The number of in-flight slots the dial leaves open after this recruitment,
   * surfaced so the caller can show why it recruited the number it did.
   */
  readonly openSlotsAfter: number;
  /** The effective ceiling used (the dial max, clamped to be sane). */
  readonly ceiling: number;
}

/**
 * Normalize a possibly-partial or out-of-range dial into a sane one: the max is
 * at least one, and the min is clamped into `[0, max]`. This keeps a bad config
 * (a zero or inverted max, a min above the max) from stalling or over-recruiting
 * instead of failing obscurely later.
 */
export function normalizeDial(dial: Partial<ConcurrencyDial> | undefined): ConcurrencyDial {
  const maxRaw = dial?.maxConcurrency;
  const minRaw = dial?.minConcurrency;
  const max = Number.isFinite(maxRaw) && (maxRaw as number) >= 1 ? Math.floor(maxRaw as number) : DEFAULT_DIAL.maxConcurrency;
  const minCandidate = Number.isFinite(minRaw) && (minRaw as number) >= 0 ? Math.floor(minRaw as number) : DEFAULT_DIAL.minConcurrency;
  const min = Math.min(minCandidate, max);
  return { minConcurrency: min, maxConcurrency: max };
}

/**
 * Decide which runnable WorkUnits to recruit this wave.
 *
 * The rule, in one place:
 *   1. the ceiling is the dial's max; the number of open in-flight slots is
 *      `ceiling - inFlight` (never negative);
 *   2. recruit as many of the runnable units as fit in the open slots, in
 *      schedule order (a greedy fill up to the ceiling);
 *   3. the dial's min is the guaranteed floor: when there is at least that much
 *      runnable work and the ceiling allows it, at least `min` agents run. The
 *      greedy fill in step 2 already honors this whenever `min <= max`, so the
 *      min is validated here rather than needing a second code path. A `min`
 *      above the open slots or the runnable count cannot be honored this wave
 *      and simply recruits everything available (reported via `openSlotsAfter`).
 *
 * The returned slice is a prefix of `runnable`, so recruitment is a bounded
 * window over the runnable set. With `maxConcurrency = N`, at most N agents are
 * ever in flight; raising N widens the window through this one function, with no
 * other change anywhere.
 */
export function recruit(input: RecruitInput): RecruitDecision {
  const dial = normalizeDial(input.dial);
  const ceiling = dial.maxConcurrency;
  const openSlots = Math.max(0, ceiling - Math.max(0, input.inFlight));

  // Greedy fill: take as many runnable units as the open slots (the ceiling
  // minus what is already in flight) allow, in schedule order. This both
  // honors the max as a hard ceiling and, whenever `min <= max` and enough work
  // is runnable, satisfies the min floor without a separate branch.
  const count = Math.min(input.runnable.length, openSlots);

  const recruited = input.runnable.slice(0, count);
  return {
    recruit: recruited,
    openSlotsAfter: Math.max(0, openSlots - recruited.length),
    ceiling,
  };
}
