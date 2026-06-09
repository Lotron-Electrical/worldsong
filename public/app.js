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

// ---------------------------------------------------------------- location/zones
// Client-side copy of the server's grid quantization (zones.js). Lets us detect
// when we've crossed into a NEW zone cell without hitting the API on every GPS tick.
const GRID = 0.01;
function localZoneId(lat, lon) {
  lat = Math.max(-85, Math.min(85, Number(lat)));
  lon = ((((Number(lon) + 180) % 360) + 360) % 360) - 180;
  const clat = Math.round(lat / GRID) * GRID;
  const clon = Math.round(lon / GRID) * GRID;
  return `z_${clat.toFixed(2)}_${clon.toFixed(2)}`;
}

let currentZoneId = null; // the zone we're currently sitting in
let liveTracking = false;
let watchId = null;

// ---------------------------------------------------------------- actions
async function loadZone(lat, lon, opts = {}) {
  const p = await api(`/api/zone?lat=${lat}&lon=${lon}`);
  const changed = p.zoneId !== currentZoneId;
  currentZoneId = p.zoneId;
  renderZone(p);
  // Auto-transitions (travelling) cross-fade; manual loads while playing also
  // cross-fade; when stopped we just preload the track.
  if (playing) engine.transition(p.currentTrack.genome, p.currentTrack.seed);
  else engine.swap(p.currentTrack.genome, p.currentTrack.seed);
  refreshWorld();
  if (changed && opts.announce) toast(`📍 Entered ${p.name}`);
  return p;
}

// Only re-load when the user has actually crossed into a different zone cell.
async function enterIfChanged(lat, lon, announce = false) {
  const zid = localZoneId(lat, lon);
  if (zid === currentZoneId) return; // same cell — leave the music alone
  await loadZone(lat, lon, { announce }).catch((e) => toast('Server error: ' + e.message));
}

// ---- live GPS tracking: music follows you as you travel ----
function updateFollowBtn() {
  const b = $('followBtn');
  if (!b) return;
  b.classList.toggle('active', liveTracking);
  b.textContent = liveTracking ? '📍 Following' : '📍 Follow';
}

function startTracking() {
  if (!navigator.geolocation) { toast('Geolocation not available here.'); return; }
  liveTracking = true;
  updateFollowBtn();
  if (watchId == null) {
    watchId = navigator.geolocation.watchPosition(
      (pos) => { if (liveTracking) enterIfChanged(pos.coords.latitude, pos.coords.longitude, true); },
      () => {},
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 },
    );
  }
  toast('Following your location — the music will change as you travel.');
}

function stopTracking() {
  liveTracking = false;
  updateFollowBtn();
}

// ---- guided tour: simulate travelling between places (for desktop testing) ----
const TOUR = [
  { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  { name: 'Paris', lat: 48.8566, lon: 2.3522 },
  { name: 'New York', lat: 40.7128, lon: -74.006 },
  { name: 'Cairo', lat: 30.0444, lon: 31.2357 },
  { name: 'Rio de Janeiro', lat: -22.9068, lon: -43.1729 },
  { name: 'Reykjavik', lat: 64.1466, lon: -21.9426 },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
];
let tourTimer = null;
let tourIdx = 0;
function updateTourBtn() {
  const b = $('tourBtn');
  if (b) { b.classList.toggle('active', !!tourTimer); b.textContent = tourTimer ? '🧭 Stop tour' : '🧭 Tour'; }
}
function toggleTour() {
  if (tourTimer) { clearInterval(tourTimer); tourTimer = null; updateTourBtn(); toast('Tour stopped.'); return; }
  stopTracking();
  if (!playing) toast('Press ▶ to hear the music change as the tour travels.');
  tourIdx = 0;
  const step = () => {
    const s = TOUR[tourIdx % TOUR.length];
    tourIdx++;
    loadZone(s.lat, s.lon, { announce: true }).catch((e) => toast('Server error: ' + e.message));
  };
  step();
  tourTimer = setInterval(step, 7000);
  updateTourBtn();
}

// dev/testing hook: simulate a GPS reading from the console or an automated test.
window.__simPos = (lat, lon) => enterIfChanged(lat, lon, true);

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
  stopTracking(); // manual jump — stop following real GPS
  loadZone(lat.toFixed(4), lon.toFixed(4), { announce: true }).then(() => toast('Flew to a new place on Earth.'));
});

// ---------------------------------------------------------------- wiring
$('playBtn').addEventListener('click', togglePlay);
$('nextBtn').addEventListener('click', () => vote('next'));
$('prevBtn').addEventListener('click', () => vote('prev'));
$('likeBtn').addEventListener('click', () => vote('like'));
$('dislikeBtn').addEventListener('click', () => vote('dislike'));
$('exploreBtn').addEventListener('click', () => {
  stopTracking(); // manual jump — stop following real GPS
  const lat = (Math.random() * 120 - 60);
  const lon = (Math.random() * 360 - 180);
  loadZone(lat.toFixed(4), lon.toFixed(4), { announce: true }).then(() => toast('Exploring a random corner of the world.'));
});
$('followBtn').addEventListener('click', () => {
  if (liveTracking) { stopTracking(); toast('Stopped following your location.'); }
  else startTracking();
});
$('tourBtn').addEventListener('click', toggleTour);

// ---------------------------------------------------------------- boot
function boot() {
  const fallback = () => loadZone(-37.8136, 144.9631, { announce: false }).then(() => {
    $('hint').textContent = 'Location unavailable — dropped you in Melbourne. Use 🧭 Tour, ✈ Explore, or the map to travel.';
  }).catch((e) => toast('Server error: ' + e.message));

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        enterIfChanged(pos.coords.latitude, pos.coords.longitude, false)
          .then(() => startTracking()); // begin following as the user travels
      },
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
