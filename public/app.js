// app.js — Worldsong client. Geolocation -> zone -> generative music + voting.
import { WorldsongEngine } from './audio-engine.js';

const $ = (id) => document.getElementById(id);
const engine = new WorldsongEngine();

let zone = null;       // last /api/zone payload
let playing = false;

// ---------------------------------------------------------------- helpers
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
}

function fmtCoord(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(3)}°${ns}  ${Math.abs(lon).toFixed(3)}°${ew}`;
}

// A colour for a genome — hue from scale, brightness from the brightness arm.
const SCALE_HUE = {
  major: 45, lydian: 60, mixolydian: 30, pentatonic_major: 90, blues: 15,
  minor: 265, dorian: 200, phrygian: 300, pentatonic_minor: 230, harmonic_minor: 330,
};
function genomeColor(g, alpha = 1) {
  if (!g) return `rgba(140,140,170,${alpha})`;
  const hue = SCALE_HUE[g.scale] ?? 220;
  const light = { dark: 42, neutral: 58, bright: 70 }[g.brightness] ?? 56;
  return `hsla(${hue}, 80%, ${light}%, ${alpha})`;
}

// ---------------------------------------------------------------- UI render
function renderZone(p) {
  zone = p;
  $('zoneName').textContent = p.name;
  $('profileZone').textContent = p.name;
  $('coords').textContent = `${p.zoneId}   ·   ${fmtCoord(p.center.lat, p.center.lon)}`;
  $('upCount').textContent = p.stats.upvotes;
  $('downCount').textContent = p.stats.downvotes;
  $('matFill').style.width = `${Math.round(p.maturity * 100)}%`;
  if (p.global) {
    $('globalStats').innerHTML =
      `<span>${p.global.zones} zones</span><span>${p.global.votes} votes</span>`;
  }
  renderProfile(p.profile);
}

const DIM_LABELS = {
  scale: 'scale', root: 'key', tempo: 'tempo', lead: 'lead', pad: 'pad',
  bass: 'bass', drums: 'drums', density: 'density', reverb: 'space', brightness: 'tone',
};
function renderProfile(profile) {
  const wrap = $('profileChips');
  wrap.innerHTML = '';
  for (const dim of Object.keys(profile)) {
    const best = profile[dim];
    const conf = Math.max(0, Math.min(1, (best.mean - 0.5) * 2)); // 0.5 prior -> 0
    const val = dim === 'tempo' ? `${best.arm} bpm` : best.arm.replace(/_/g, ' ');
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML =
      `<div class="k">${DIM_LABELS[dim] || dim}</div>` +
      `<div class="v">${val}</div>` +
      `<div class="conf"><i style="width:${Math.round(conf * 100)}%"></i></div>`;
    wrap.appendChild(chip);
  }
}

// ---------------------------------------------------------------- actions
async function loadZone(lat, lon) {
  const p = await api(`/api/zone?lat=${lat}&lon=${lon}`);
  renderZone(p);
  engine.swap(p.currentTrack.genome, p.currentTrack.seed);
  refreshWorld();
  return p;
}

async function vote(action) {
  if (!zone) return;
  const p = await api('/api/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zoneId: zone.zoneId, action }),
  });
  renderZone(p);
  // next / prev / dislike change the track; like keeps it.
  if (action !== 'like') engine.swap(p.currentTrack.genome, p.currentTrack.seed);
  const msg = {
    next: 'Upvoted — moving forward to a new track in this vein.',
    dislike: 'Downvoted — skipping to a new direction…',
    prev: 'Downvoted — going back to the previous track.',
    like: 'Upvoted — reinforcing this sound here.',
  }[action];
  toast(msg);
  refreshWorld();
}

async function togglePlay() {
  if (!playing) {
    await engine.start();
    playing = true;
    $('playBtn').textContent = '⏸';
    drawViz();
  } else {
    engine.stop();
    playing = false;
    $('playBtn').textContent = '▶';
  }
}

// ---------------------------------------------------------------- visualizer
function drawViz() {
  const c = $('viz');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  const analyser = engine.analyser;
  const bins = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  const wave = analyser ? new Uint8Array(analyser.fftSize) : null;

  function frame() {
    if (!playing) { ctx.clearRect(0, 0, W, H); return; }
    requestAnimationFrame(frame);
    analyser.getByteFrequencyData(bins);
    analyser.getByteTimeDomainData(wave);
    ctx.clearRect(0, 0, W, H);

    // frequency bars
    const n = 64;
    const step = Math.floor(bins.length / n);
    const bw = W / n;
    const col = genomeColor(zone && zone.currentTrack.genome, 1);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let j = 0; j < step; j++) v += bins[i * step + j];
      v = v / step / 255;
      const h = Math.pow(v, 1.4) * H * 0.92;
      const x = i * bw;
      const grad = ctx.createLinearGradient(0, H, 0, H - h);
      grad.addColorStop(0, genomeColor(zone && zone.currentTrack.genome, 0.15));
      grad.addColorStop(1, col);
      ctx.fillStyle = grad;
      ctx.fillRect(x + 1, H - h, bw - 2, h);
    }
    // waveform line on top
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    for (let i = 0; i < wave.length; i++) {
      const x = (i / wave.length) * W;
      const y = (wave[i] / 255) * H;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  frame();
}

// ---------------------------------------------------------------- world map
let worldZones = [];
async function refreshWorld() {
  try {
    const w = await api('/api/world');
    worldZones = w.zones;
    drawWorld();
  } catch {}
}

function drawWorld() {
  const c = $('worldmap');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);

  // graticule
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = ((lon + 180) / 360) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let lat = -90; lat <= 90; lat += 30) {
    const y = ((90 - lat) / 180) * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  // equator
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  const ey = H / 2;
  ctx.beginPath(); ctx.moveTo(0, ey); ctx.lineTo(W, ey); ctx.stroke();

  for (const z of worldZones) {
    const x = ((z.lon + 180) / 360) * W;
    const y = ((90 - z.lat) / 180) * H;
    const r = 3 + Math.min(10, Math.log2(1 + (z.plays || 1)) * 1.5);
    const isHere = zone && z.id === zone.zoneId;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = genomeColor(z.genome, 0.85);
    ctx.fill();
    if (isHere) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1; ctx.stroke();
    }
  }
}

$('worldmap').addEventListener('click', (e) => {
  const c = $('worldmap');
  const rect = c.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width;
  const fy = (e.clientY - rect.top) / rect.height;
  const lon = fx * 360 - 180;
  const lat = 90 - fy * 180;
  loadZone(lat.toFixed(4), lon.toFixed(4)).then(() => toast('Flew to a new place on Earth.'));
});

// ---------------------------------------------------------------- wiring
$('playBtn').addEventListener('click', togglePlay);
$('nextBtn').addEventListener('click', () => vote('next'));
$('prevBtn').addEventListener('click', () => vote('prev'));
$('likeBtn').addEventListener('click', () => vote('like'));
$('dislikeBtn').addEventListener('click', () => vote('dislike'));
$('exploreBtn').addEventListener('click', () => {
  // bias toward populated latitudes for nicer exploration
  const lat = (Math.random() * 120 - 60);
  const lon = (Math.random() * 360 - 180);
  loadZone(lat.toFixed(4), lon.toFixed(4)).then(() => toast('Exploring a random corner of the world.'));
});

// ---------------------------------------------------------------- boot
function boot() {
  const fallback = () => loadZone(-37.8136, 144.9631).then(() => {
    $('hint').textContent = 'Location unavailable — dropped you in Melbourne. Use ✈ Explore to travel.';
  }).catch((e) => toast('Server error: ' + e.message));

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => loadZone(pos.coords.latitude, pos.coords.longitude).catch((e) => toast('Server error: ' + e.message)),
      () => fallback(),
      { timeout: 6000 },
    );
  } else {
    fallback();
  }
  refreshWorld();
}
boot();
window.addEventListener('resize', drawWorld);
