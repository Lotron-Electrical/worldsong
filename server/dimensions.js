// The musical "genome": a set of independent dimensions, each with a few
// discrete options ("arms"). A track is one chosen arm per dimension.
//
// The bandit keeps a Beta(alpha,beta) posterior for every arm of every
// dimension, PER ZONE. Voting nudges these posteriors, so over time a zone
// learns "people here like minor scales, slow tempo, hall reverb" etc.
// The collection of winning arms IS that location's unique sound profile.
//
// The client (public/engine.js) knows how to synthesize each arm value, so the
// server only ever sends the chosen values, never audio.

export const DIMENSIONS = {
  scale: {
    label: 'Scale',
    arms: ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'harmonicMinor', 'pentatonic', 'blues'],
  },
  root: {
    label: 'Key',
    arms: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'],
  },
  tempo: {
    label: 'Tempo',
    // BPM buckets, from ambient-slow to driving.
    arms: ['64', '76', '88', '100', '112', '124', '136'],
  },
  lead: {
    label: 'Lead',
    arms: ['sine', 'triangle', 'square', 'saw', 'fmbell', 'pluck'],
  },
  pad: {
    label: 'Pad',
    arms: ['none', 'warm', 'glass', 'choir', 'strings'],
  },
  bass: {
    label: 'Bass',
    arms: ['none', 'sub', 'saw', 'square', 'pluck'],
  },
  drums: {
    label: 'Drums',
    arms: ['none', 'fourfloor', 'breakbeat', 'halftime', 'latin', 'trap'],
  },
  density: {
    label: 'Density',
    arms: ['sparse', 'medium', 'busy'],
  },
  reverb: {
    label: 'Space',
    arms: ['dry', 'room', 'hall', 'cathedral'],
  },
  brightness: {
    label: 'Tone',
    arms: ['dark', 'neutral', 'bright'],
  },
};

export const DIMENSION_KEYS = Object.keys(DIMENSIONS);

// Validate a genome object coming back from a client (used when applying votes
// so a malicious client can't poison arms that don't exist).
export function isValidGenome(genome) {
  if (!genome || typeof genome !== 'object') return false;
  for (const key of DIMENSION_KEYS) {
    const v = genome[key];
    if (typeof v !== 'string' || !DIMENSIONS[key].arms.includes(v)) return false;
  }
  return true;
}
