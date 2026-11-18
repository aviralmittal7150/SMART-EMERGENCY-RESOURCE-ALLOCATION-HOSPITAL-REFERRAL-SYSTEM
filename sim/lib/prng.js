// sim/lib/prng.js
// Deterministic pseudo-random numbers for the stress harness. The same seed always produces the same
// sequence, so a scenario's workload (cases, preferences, decisions) is exactly reproducible.
// mulberry32: small, fast, well-distributed for simulation (not for cryptography).

export function createRng(seed) {
  let state = (Number(seed) >>> 0) || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** Uniform float in [0, 1). */
    next,
    /** Integer in [min, max]. */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** Pick a key of `weights` ({ key: weight }) with probability proportional to its weight. */
    weighted(weights) {
      const entries = Object.entries(weights).filter(([, w]) => w > 0);
      const total = entries.reduce((s, [, w]) => s + w, 0);
      if (!entries.length || total <= 0) throw new Error('weighted(): no positive weights');
      let r = next() * total;
      for (const [key, w] of entries) {
        r -= w;
        if (r < 0) return key;
      }
      return entries[entries.length - 1][0];
    },
    /** A new array with the items in a seeded random order (Fisher–Yates). */
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }
  };
}
