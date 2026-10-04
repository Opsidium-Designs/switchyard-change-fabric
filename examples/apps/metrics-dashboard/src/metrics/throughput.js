// metrics-dashboard throughput metric.
//
// FABRIC-FOLLOWUP: average() has the same raw-average bug as latency (no empty
// guard, no rounding). The fix is the identical guard-and-round the latency
// handler needs, revealed once the first metric is fixed.

export const throughput = {
  samples: [1200, 1340, 1180, 1420],
  average() {
    const sum = this.samples.reduce((a, b) => a + b, 0);
    return sum / this.samples.length;
  },
};
