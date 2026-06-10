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
  tempo: ['60', '72', '84', '96', '110', '124', '138', '150', '165', '174'], // BPM buckets (strings = arm ids)
  lead: ['sine_pluck', 'triangle_lead', 'saw_lead', 'square_arp', 'bell', 'fm_bell', 'super_saw', 'screech', 'none'],
  pad: ['warm_pad', 'glass_pad', 'strings', 'choir', 'stab', 'none'],
  bass: ['sub', 'saw_bass', 'pulse_bass', 'wobble_bass', 'growl_bass', 'reese_bass', 'none'],
  drums: ['none', 'soft_kick', 'four_floor', 'downtempo', 'trip_hop', 'dnb', 'breakbeat', 'half_time'],
  density: ['sparse', 'medium', 'busy'],
  reverb: ['dry', 'room', 'hall', 'cathedral'],
  brightness: ['dark', 'neutral', 'bright'],
};

export const DIMENSION_KEYS = Object.keys(DIMENSIONS);

// ---------------------------------------------------------------------------
// House style prior: "Redline Dash" (Skrillex). A fresh zone starts every arm
// at the uniform Beta(1,1) prior, which would make its first tracks a random
// grab-bag. To give the whole app a deliberate sonic identity, we add an alpha
// head-start to the arms that make up an aggressive, fast, distorted bass-music
// sound: detuned/wobble/Reese basses, drum-and-bass + breakbeat drums, 150-174
// BPM, screaming saw/screech leads, dark scales, tight (dry) space, bright tone.
//
// This is a PRIOR, not a lock: it just makes Thompson sampling reach for these
// arms first. Real votes still accumulate on top, so a zone whose listeners hate
// the wobble can still drift somewhere else over time. Bumping/clearing this
// object re-styles the planet without touching any stored votes.
// ---------------------------------------------------------------------------
export const STYLE_PRIOR = {
  scale:      { phrygian: 3, minor: 3, harmonic_minor: 2 },
  root:       { E: 2, D: 1, G: 1 },
  tempo:      { '174': 4, '165': 4, '150': 3, '138': 1 },
  lead:       { super_saw: 4, screech: 3, saw_lead: 2 },
  pad:        { none: 3, stab: 2 },
  bass:       { reese_bass: 4, growl_bass: 4, wobble_bass: 3 },
  drums:      { dnb: 4, breakbeat: 4, half_time: 3 },
  density:    { busy: 3, medium: 1 },
  reverb:     { dry: 3, room: 2 },
  brightness: { bright: 3, neutral: 1 },
};

// The Beta prior for an arm before any votes: 1 + its style head-start.
export function defaultStat(dim, arm) {
  const boost = (STYLE_PRIOR[dim] && STYLE_PRIOR[dim][arm]) || 0;
  return { alpha: 1 + boost, beta: 1 };
}

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
