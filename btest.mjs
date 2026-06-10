// btest.mjs — prove the "Redline Dash" house-style prior makes a FRESH zone
// (no votes yet) reliably sample the aggressive bass-music arms.
import { sampleGenome, defaultStat, DIMENSION_KEYS } from './bandit.js';

const AGG = {
  bass: ['wobble_bass', 'growl_bass', 'reese_bass'],
  drums: ['dnb', 'breakbeat', 'half_time'],
  tempo: ['150', '165', '174'],
  lead: ['super_saw', 'screech', 'saw_lead'],
  brightness: ['bright', 'neutral'],
  density: ['busy', 'medium'],
  reverb: ['dry', 'room'],
};

const N = 2000;
const hit = {};
for (const k of Object.keys(AGG)) hit[k] = 0;
const tally = {}; // per-dimension arm counts, to eyeball the spread
for (const k of DIMENSION_KEYS) tally[k] = {};

for (let i = 0; i < N; i++) {
  // A brand-new zone: every arm is at its style prior, nothing voted yet.
  const genome = sampleGenome(defaultStat, (i * 2654435761) >>> 0);
  for (const k of DIMENSION_KEYS) tally[k][genome[k]] = (tally[k][genome[k]] || 0) + 1;
  for (const k of Object.keys(AGG)) if (AGG[k].includes(genome[k])) hit[k]++;
}

console.log(`Fresh-zone genome over ${N} seeds — share landing on the aggressive arms:`);
for (const k of Object.keys(AGG)) {
  const pct = ((hit[k] / N) * 100).toFixed(1);
  console.log(`  ${k.padEnd(11)} ${pct}%   ${AGG[k].join(', ')}`);
}
console.log('\nTop arm per key:');
for (const k of DIMENSION_KEYS) {
  const top = Object.entries(tally[k]).sort((a, b) => b[1] - a[1])[0];
  console.log(`  ${k.padEnd(11)} ${top[0]} (${((top[1] / N) * 100).toFixed(0)}%)`);
}
