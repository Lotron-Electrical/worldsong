// bandit.js — the machine-learning core of Worldsong.
//
// Each geographic zone evolves its own "sound profile" through a per-dimension
// Thompson-sampling multi-armed bandit. A track's "genome" is one chosen arm per
// musical dimension. Listeners upvote/downvote tracks; those votes update Beta
// distributions on the arms that produced the track. Over many votes a zone's
// arm distributions sharpen and the zone converges on a locally-preferred sound.
//
// No external ML libraries: this is a real online bandit implemented from scratch.

// ---------------------------------------------------------------------------
// The musical dimensions and their possible arm values.
// These map 1:1 onto knobs the generative audio engine understands.
// ---------------------------------------------------------------------------
export const DIMENSIONS = {
  scale: [
    'major', 'minor', 'dorian', 'phrygian', 'lydian',
    'mixolydian', 'pentatonic_major', 'pentatonic_minor', 'blues', 'harmonic_minor',
  ],
  root: ['C', 'D', 'Eb', 'E', 'F', 'G', 'A', 'Bb'],
  tempo: ['60', '72', '84', '96', '110', '124', '138'], // BPM buckets (strings = arm ids)
  lead: ['sine_pluck', 'triangle_lead', 'saw_lead', 'square_arp', 'bell', 'fm_bell', 'none'],
  pad: ['warm_pad', 'glass_pad', 'strings', 'choir', 'none'],
  bass: ['sub', 'saw_bass', 'pulse_bass', 'none'],
  drums: ['none', 'soft_kick', 'four_floor', 'downtempo', 'trip_hop'],
  density: ['sparse', 'medium', 'busy'],
  reverb: ['dry', 'room', 'hall', 'cathedral'],
  brightness: ['dark', 'neutral', 'bright'],
};

export const DIMENSION_KEYS = Object.keys(DIMENSIONS);

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so the same seed yields the same music for
// every listener in a zone. Math.random is avoided for reproducibility.
// ---------------------------------------------------------------------------
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

// Sample from a Gamma(k>=1) distribution (Marsaglia & Tsang), used to build Beta.
function sampleGamma(k, rng) {
  if (k < 1) {
    // boost: Gamma(k) = Gamma(k+1) * U^(1/k)
    const u = rng();
    return sampleGamma(1 + k, rng) * Math.pow(u || 1e-12, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      // Box-Muller for a standard normal
      const u1 = rng() || 1e-12;
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// Draw a Beta(alpha, beta) sample via two Gammas.
export function sampleBeta(alpha, beta, rng) {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y || 1e-12);
}

// ---------------------------------------------------------------------------
// Bandit operations. `armStats` is a Map keyed "dimension|arm" -> {alpha,beta}.
// We pass the store in so the same logic works against SQLite or the JSON store.
// ---------------------------------------------------------------------------

// Pull one arm per dimension by Thompson sampling. Returns a genome object.
// `getStat(dim, arm) -> {alpha, beta}` supplies current Beta params (defaults 1,1).
export function sampleGenome(getStat, seed) {
  const rng = mulberry32(seed);
  const genome = {};
  for (const dim of DIMENSION_KEYS) {
    let bestArm = DIMENSIONS[dim][0];
    let bestDraw = -1;
    for (const arm of DIMENSIONS[dim]) {
      const { alpha, beta } = getStat(dim, arm);
      const draw = sampleBeta(alpha, beta, rng);
      if (draw > bestDraw) {
        bestDraw = draw;
        bestArm = arm;
      }
    }
    genome[dim] = bestArm;
  }
  return genome;
}

// Apply a vote (+1 upvote / -1 downvote) to every arm in a genome.
// `bump(dim, arm, dAlpha, dBeta)` persists the increment.
export function applyVote(genome, vote, bump) {
  for (const dim of DIMENSION_KEYS) {
    const arm = genome[dim];
    if (vote > 0) bump(dim, arm, 1, 0);
    else bump(dim, arm, 0, 1);
  }
}

// Summarise a zone's learned preference: the current top arm per dimension and
// its confidence (posterior mean). Useful for the UI "sound profile" panel.
export function profileSummary(getStat) {
  const summary = {};
  for (const dim of DIMENSION_KEYS) {
    let best = null;
    for (const arm of DIMENSIONS[dim]) {
      const { alpha, beta } = getStat(dim, arm);
      const mean = alpha / (alpha + beta);
      const pulls = alpha + beta - 2; // minus the 1,1 prior
      if (!best || mean > best.mean || (mean === best.mean && pulls > best.pulls)) {
        best = { arm, mean, pulls };
      }
    }
    summary[dim] = best;
  }
  return summary;
}

// A scalar 0..1 describing how "settled" a zone is. It combines two things:
// divergence (how far the leading arms have pulled away from the uniform prior)
// and confidence (how many votes the zone has actually received). A zone needs
// both a clear preference AND enough evidence to read as "mature".
export function maturity(getStat) {
  let total = 0;
  let count = 0;
  let votes = 0;
  for (const dim of DIMENSION_KEYS) {
    let dimVotes = 0;
    const means = DIMENSIONS[dim].map((arm) => {
      const { alpha, beta } = getStat(dim, arm);
      dimVotes += alpha + beta - 2; // strip the Beta(1,1) prior
      return alpha / (alpha + beta);
    });
    const max = Math.max(...means);
    const avg = means.reduce((a, b) => a + b, 0) / means.length;
    total += max - avg; // spread between the leader and the field
    count += 1;
    votes = dimVotes; // each vote touches every dimension once, so identical per dim
  }
  const divergence = Math.min(1, (total / count) / 0.45);
  const confidence = Math.min(1, votes / 50); // ~50 votes to be fully confident
  return divergence * confidence;
}
