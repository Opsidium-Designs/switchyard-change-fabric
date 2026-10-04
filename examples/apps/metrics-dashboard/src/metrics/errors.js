// metrics-dashboard errors metric.
//
// FABRIC-FOLLOWUP: average() has the same raw-average bug and, with an EMPTY
// series, divides by zero and yields NaN (which serializes to null). The fix is
// the identical empty-guard-and-round the other metric handlers need, revealed
// once the first metric is fixed.

export const errors = {
  samples: [],
  average() {
    const sum = this.samples.reduce((a, b) => a + b, 0);
    return sum / this.samples.length;
  },
};
