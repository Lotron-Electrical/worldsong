// btest.mjs — prove the RuneScape-flavoured house-style prior makes a FRESH zone
// (no votes yet) reliably sample the calm medieval/fantasy arms.
import { sampleGenome, defaultStat, DIMENSION_KEYS } from './bandit.js';

const FANTASY = {
  scale: ['major', 'dorian', 'lydian', 'mixolydian', 'pentatonic_major'],
  lead: ['flute', 'recorder', 'harp', 'pizzicato', 'glockenspiel'],
  pad: ['warm_pad', 'strings', 'choir'],
  bass: ['sub', 'pluck_bass'],
  drums: ['hand_drum', 'soft_kick', 'tambourine', 'light_perc', 'none'],
  tempo: ['72', '84', '96', '110'],
  reverb: ['room', 'hall', 'cathedral'],
  density: ['sparse', 'medium'],
};

const N = 2000;
const hit = {};
for (const k of Object.keys(FANTASY)) hit[k] = 0;
const tally = {}; // per-dimension arm counts, to eyeball the spread
for (const k of DIMENSION_KEYS) tally[k] = {};

for (let i = 0; i < N; i++) {
  // A brand-new zone: every arm is at its style prior, nothing voted yet.
  const genome = sampleGenome(defaultStat, (i * 2654435761) >>> 0);
  for (const k of DIMENSION_KEYS) tally[k][genome[k]] = (tally[k][genome[k]] || 0) + 1;
  for (const k of Object.keys(FANTASY)) if (FANTASY[k].includes(genome[k])) hit[k]++;
}

console.log(`Fresh-zone genome over ${N} seeds — share landing on the fantasy arms:`);
for (const k of Object.keys(FANTASY)) {
  const pct = ((hit[k] / N) * 100).toFixed(1);
  console.log(`  ${k.padEnd(11)} ${pct}%   ${FANTASY[k].join(', ')}`);
}
console.log('\nTop arm per key:');
for (const k of DIMENSION_KEYS) {
  const top = Object.entries(tally[k]).sort((a, b) => b[1] - a[1])[0];
  console.log(`  ${k.padEnd(11)} ${top[0]} (${((top[1] / N) * 100).toFixed(0)}%)`);
}
