// Deterministic seeded RNG + Beta sampler.
// Same seed -> same numbers. This is what guarantees that a given track
// (zoneId + seed + genome) renders to the EXACT same music for every listener.

export function hashStringToSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

// mulberry32 PRNG -> function yielding floats in [0,1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
export const chance = (rng, p) => rng() < p;

function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Gamma(shape>=1) via Marsaglia-Tsang; shape<1 boosted+corrected.
function sampleGamma(rng, shape) {
  if (shape < 1) return sampleGamma(rng, shape + 1) * Math.pow(rng(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do { x = gaussian(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// Beta(a,b) draw = the Thompson-sampling step. Each musical option's
// "likeability" is a Beta posterior built from up/down votes; we sample it to
// decide which option to use in the next track.
export function sampleBeta(rng, a, b) {
  const x = sampleGamma(rng, Math.max(a, 1e-6));
  const y = sampleGamma(rng, Math.max(b, 1e-6));
  return x + y === 0 ? 0.5 : x / (x + y);
}
