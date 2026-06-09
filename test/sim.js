// Simulation: prove the per-zone bandit LEARNS from voting.
// A simulated crowd at one location consistently likes 'minor' scale + 'halftime'
// drums and dislikes everything else. After many votes the zone's profile should
// converge so 'minor' and 'halftime' dominate with high posterior means.

const BASE = process.env.BASE || 'http://localhost:7080';
const LAT = 35.0 + Math.random() * 0.001; // a fresh, unused cell each run
const LON = 139.0 + Math.random() * 0.001;
const LIKE_SCALE = 'minor';
const LIKE_DRUMS = 'halftime';
const ROUNDS = 400;

async function getZone(lat, lon) {
  const r = await fetch(`${BASE}/api/zone?lat=${lat}&lon=${lon}`);
  return r.json();
}
async function vote(zoneId, seed, genome, vote, action) {
  const r = await fetch(`${BASE}/api/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zoneId, seed, genome, vote, action }),
  });
  return r.json();
}

const z0 = await getZone(LAT, LON);
const zoneId = z0.zoneId;
console.log('zone', zoneId, z0.name);
let cur = z0.currentTrack;

for (let i = 0; i < ROUNDS; i++) {
  const likeIt = cur.genome.scale === LIKE_SCALE && cur.genome.drums === LIKE_DRUMS;
  let resp;
  if (likeIt) {
    // love it: thumbs up, keep playing it, then move on with a neutral next
    await vote(zoneId, cur.seed, cur.genome, 'up', 'none');
    resp = await vote(zoneId, cur.seed, cur.genome, 'up', 'next'); // still positive but advance to explore
  } else if (cur.genome.scale === LIKE_SCALE || cur.genome.drums === LIKE_DRUMS) {
    // half right: mild upvote then advance
    resp = await vote(zoneId, cur.seed, cur.genome, 'up', 'next');
  } else {
    // hate it: skip (downvote + next)
    resp = await vote(zoneId, cur.seed, cur.genome, 'down', 'next');
  }
  cur = resp.currentTrack;
}

const prof = (await fetch(`${BASE}/api/profile?zoneId=${zoneId}`).then((r) => r.json())).stats.profile;
function top3(dim) {
  return prof[dim].distribution.slice(0, 3).map((d) => `${d.arm}:${d.mean.toFixed(2)}(n=${d.evidence})`).join('  ');
}
console.log(`\nAfter ${ROUNDS} rounds of voting:`);
console.log('SCALE  dominant:', prof.scale.dominant, '| top3:', top3('scale'));
console.log('DRUMS  dominant:', prof.drums.dominant, '| top3:', top3('drums'));
console.log('TEMPO  dominant:', prof.tempo.dominant, '| top3:', top3('tempo'));

const pass = prof.scale.dominant === LIKE_SCALE && prof.drums.dominant === LIKE_DRUMS;
console.log('\nLEARNED THE CROWD\'S TASTE:', pass ? 'YES ✓' : 'NO ✗');
process.exit(pass ? 0 : 1);
