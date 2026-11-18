// sim/lib/stats.js
// Small, dependency-free statistics for latency samples (milliseconds) and run-to-run spread.

/** Nearest-rank percentile (p in (0, 100]) of numeric samples; null when there are none. */
export function percentile(samples, p) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const round = (value, digits = 2) => (value === null ? null : Number(value.toFixed(digits)));

/** Summary of latency samples. */
export function summarize(samples) {
  if (!samples.length) return { count: 0, mean: null, p50: null, p95: null, p99: null, max: null };
  const sum = samples.reduce((s, v) => s + v, 0);
  return {
    count: samples.length,
    mean: round(sum / samples.length),
    p50: round(percentile(samples, 50)),
    p95: round(percentile(samples, 95)),
    p99: round(percentile(samples, 99)),
    max: round(Math.max(...samples))
  };
}

/** min / median / max of one numeric metric across repeated runs. */
export function spread(values) {
  const present = values.filter(v => v !== null && v !== undefined);
  if (!present.length) return { min: null, median: null, max: null };
  return { min: round(Math.min(...present)), median: round(percentile(present, 50)), max: round(Math.max(...present)) };
}
