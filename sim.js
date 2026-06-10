// sim.js — verification that the bandit genuinely learns from votes.
//
// We invent a hidden "crowd taste" for one zone (e.g. they love a minor,
// trip-hop, fm-bell, 84-BPM sound) and have a noisy crowd up/down-vote each
// generated track accordingly. If the ML works, the zone's learned profile
// should converge on the crowd's preferred arms and the match-rate of newly
// generated tracks should climb over time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import {
  sampleGenome, applyVote, profileSummary, maturity, mulberry32,
} from './bandit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, 'sim.db');
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch {} }

const db = openDb(TMP);
const ID = 'z_sim';
const seed0 = db.seedFor(ID, 1);
const g0 = sampleGenome(db.statReader(ID), seed0);
db.createZone(ID, 0, 0, 'Sim Zone', '', seed0, JSON.stringify(g0));

// Hidden crowd preference.
const TARGET = { scale: 'minor', tempo: '84', drums: 'trip_hop', lead: 'fm_bell', pad: 'warm_pad' };
const targetKeys = Object.keys(TARGET);

const rng = mulberry32(12345);
const N = Number(process.argv[2] || 1500);
const window = [];
let firstHalfMatch = 0, secondHalfMatch = 0;

for (let i = 0; i < N; i++) {
  const zone = db.getZone(ID);
  const genome = JSON.parse(zone.current_genome);

  // How well does this track match the crowd's taste?
  let match = 0;
  for (const k of targetKeys) if (genome[k] === TARGET[k]) match++;
  const frac = match / targetKeys.length;
  if (i < N / 2) firstHalfMatch += frac; else secondHalfMatch += frac;

  // Noisy crowd vote: more matches -> more likely an upvote.
  const pUp = 0.08 + 0.88 * frac;
  const up = rng() < pUp;

  const bump = (d, a, dA, dB) => db.bumpArm(ID, d, a, dA, dB);
  if (up) {
    applyVote(genome, +1, bump);
    db.recordVote(ID, zone.current_seed, +1, zone.current_genome);
  } else {
    applyVote(genome, -1, bump);
    db.recordVote(ID, zone.current_seed, -1, zone.current_genome);
  }

  // Generate the next track using the freshly updated stats.
  const counter = zone.track_counter + 1;
  const ns = db.seedFor(ID, counter);
  const ng = sampleGenome(db.statReader(ID), ns);
  db.setTrack(ID, ns, JSON.stringify(ng), [], counter);

  window.push(frac);
}

const getStat = db.statReader(ID);
const prof = profileSummary(getStat);

console.log(`\n=== Worldsong bandit simulation (${N} votes) ===`);
console.log('Hidden crowd taste:', TARGET);
console.log('\nLearned profile (top arm per dimension):');
let learnedHits = 0;
for (const dim of Object.keys(prof)) {
  const isTargeted = targetKeys.includes(dim);
  const want = TARGET[dim];
  const got = prof[dim].arm;
  const mark = isTargeted ? (got === want ? '  ✓ matches crowd taste' : `  ✗ wanted ${want}`) : '';
  if (isTargeted && got === want) learnedHits++;
  console.log(`  ${dim.padEnd(11)} -> ${got.padEnd(16)} (mean ${prof[dim].mean.toFixed(2)}, pulls ${Math.round(prof[dim].pulls)})${mark}`);
}

console.log(`\nTargeted dimensions learned correctly: ${learnedHits}/${targetKeys.length}`);
console.log(`Track match-rate: first half ${(firstHalfMatch / (N / 2)).toFixed(3)}  ->  second half ${(secondHalfMatch / (N / 2)).toFixed(3)}`);
console.log(`Zone maturity: ${maturity(getStat).toFixed(3)}`);

const improved = secondHalfMatch > firstHalfMatch;
const ok = learnedHits >= targetKeys.length - 1 && improved;
console.log(`\nRESULT: ${ok ? 'PASS — the zone learned the crowd preference.' : 'CHECK — convergence weak.'}`);
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch {} }
process.exit(ok ? 0 : 1);
