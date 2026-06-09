// Per-zone, per-dimension Thompson-sampling multi-armed bandit.
//
// State shape (a plain object the store loads/saves):
//   posteriors = { scale: { major:{a,b}, minor:{a,b}, ... }, root:{...}, ... }
// where {a,b} are Beta(alpha,beta) parameters. a counts "likes", b "dislikes".
//
// To build a new track we Thompson-sample: draw one value per arm from its Beta
// posterior and keep the best arm for each dimension. Early on (flat priors)
// this is near-random exploration; as votes accumulate the zone's taste sharpens
// into a stable, unique sound. Voting up bumps `a` on the playing track's arms;
// voting down bumps `b`.

import { DIMENSIONS, DIMENSION_KEYS } from './dimensions.js';
import { sampleBeta } from './rng.js';

export const PRIOR_A = 1;
export const PRIOR_B = 1;

// Ensure every dimension/arm exists in the posteriors object (fills priors).
export function ensurePosteriors(posteriors) {
  const p = posteriors || {};
  for (const key of DIMENSION_KEYS) {
    if (!p[key]) p[key] = {};
    for (const arm of DIMENSIONS[key].arms) {
      if (!p[key][arm]) p[key][arm] = { a: PRIOR_A, b: PRIOR_B };
    }
  }
  return p;
}

// Thompson-sample a full genome from the zone's posteriors.
export function sampleGenome(rng, posteriors) {
  const p = ensurePosteriors(posteriors);
  const genome = {};
  for (const key of DIMENSION_KEYS) {
    let bestArm = null, bestDraw = -1;
    for (const arm of DIMENSIONS[key].arms) {
      const { a, b } = p[key][arm];
      const draw = sampleBeta(rng, a, b);
      if (draw > bestDraw) { bestDraw = draw; bestArm = arm; }
    }
    genome[key] = bestArm;
  }
  return genome;
}

// Apply a vote to the arms a genome used. vote: +1 (up) or -1 (down).
// `weight` lets a strong signal (explicit thumbs-down) count more than an
// implicit skip. Mutates posteriors and returns the changed cells for persisting.
export function applyVote(posteriors, genome, vote, weight = 1) {
  const p = ensurePosteriors(posteriors);
  const changed = [];
  for (const key of DIMENSION_KEYS) {
    const arm = genome[key];
    if (!arm || !p[key][arm]) continue;
    if (vote > 0) p[key][arm].a += weight;
    else p[key][arm].b += weight;
    changed.push({ dimension: key, arm, a: p[key][arm].a, b: p[key][arm].b });
  }
  return changed;
}

// Summarize a zone's learned taste: for each dimension, the dominant arm, its
// posterior mean (expected likeability), a confidence (total evidence), and the
// full ranked distribution. This is the location's "sound profile".
export function profile(posteriors) {
  const p = ensurePosteriors(posteriors);
  const out = {};
  for (const key of DIMENSION_KEYS) {
    const dist = DIMENSIONS[key].arms.map((arm) => {
      const { a, b } = p[key][arm];
      const mean = a / (a + b);
      const evidence = a + b - (PRIOR_A + PRIOR_B); // votes beyond the prior
      return { arm, mean, evidence, a, b };
    }).sort((x, y) => y.mean - x.mean);
    const top = dist[0];
    const totalEvidence = dist.reduce((s, d) => s + Math.max(0, d.evidence), 0);
    out[key] = {
      label: DIMENSIONS[key].label,
      dominant: top.arm,
      mean: top.mean,
      evidence: totalEvidence,
      distribution: dist,
    };
  }
  return out;
}

// A single "maturity" number for a zone: how much total voting evidence it has
// accumulated across all dimensions. Drives the "how evolved is this place" UI.
export function maturity(posteriors) {
  const p = ensurePosteriors(posteriors);
  let total = 0;
  for (const key of DIMENSION_KEYS) {
    for (const arm of DIMENSIONS[key].arms) {
      total += (p[key][arm].a - PRIOR_A) + (p[key][arm].b - PRIOR_B);
    }
  }
  return total; // total up+down votes ever cast in this zone
}
