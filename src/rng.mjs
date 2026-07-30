// Determinism lives here. Every random decision in a run — which mutator fires,
// which element gets clicked, which junk value gets typed, how long a step
// sleeps — is drawn from a single integer seed, so `--seed N` replays the walk.

/** mulberry32: 32-bit, seedable, no dependencies, identical across Node versions. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Per-step PRNG derived from (seed, routeIndex, stepNumber).
 *
 * WHY this exists rather than one shared stream: a mutator's draw COUNT depends
 * on the live DOM — an empty candidate list means zero draws, a danger hit means
 * two. If mutators drew from the master stream, one extra draw on step 3 would
 * shift every subsequent mutator choice and the "same seed" replay would walk a
 * different path. Giving each step its own stream makes the master stream (which
 * only sequences mutators and inter-step sleeps) immune to what the page did.
 *
 * The two constants are the golden-ratio and xxhash mixing primes; any odd
 * 32-bit constants would do, these just spread adjacent (page, step) pairs well.
 */
export function deriveStepRng(seed, routeIndex, stepNumber) {
  return mulberry32((seed ^ ((routeIndex + 1) * 0x9e3779b9) ^ (stepNumber * 0x85ebca6b)) >>> 0);
}

export const pickFrom = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/** entries: [[name, weight], …] — returns a name. */
export function pickWeighted(rng, entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [name, w] of entries) {
    r -= w;
    if (r <= 0) return name;
  }
  return entries[entries.length - 1][0];
}
