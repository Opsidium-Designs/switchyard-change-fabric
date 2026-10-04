// metrics-dashboard latency metric.
//
// FABRIC-FOLLOWUP: average() has no empty-series guard and no rounding, so an
// empty series yields NaN and a populated one yields a long float tail. The fix
// returns 0 for an empty series and a rounded number otherwise. The same pattern
// is planted across the sibling metric handlers, so fixing this reveals the rest.

export const latency = {
  samples: [120, 95, 143, 101, 88],
  average() {
    // The planted bug: raw average, no empty guard, no rounding.
    const sum = this.samples.reduce((a, b) => a + b, 0);
    return sum / this.samples.length;
  },
};
