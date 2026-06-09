// Worldsong API + static server. Zero external deps: node:http, node:sqlite,
// node:fs only.
//
// Flow:
//   GET  /api/zone?lat=&lon=   -> the zone you're standing in + its current track
//   POST /api/vote             -> up/down vote (and next/previous), which trains
//                                 the per-zone bandit and may change the track
//   GET  /api/profile?zoneId=  -> the location's learned sound profile
//   GET  /api/world            -> all known zones for the world map
//
// "AI-generated music" = the genome (musical parameters) the bandit chooses;
// the browser synthesizes the actual audio from {seed, genome} deterministically.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

import { hashStringToSeed, mulberry32 } from './rng.js';
import { zoneIdFor, zoneGeometry, zoneName, GRID_DEG } from './zones.js';
import { sampleGenome, applyVote, profile, maturity } from './bandit.js';
import { isValidGenome, DIMENSIONS } from './dimensions.js';
import * as store from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');
const DB_PATH = process.env.WORLDSONG_DB || join(ROOT, 'data', 'worldsong.db');
const PORT = Number(process.env.PORT) || 7080;

store.openDb(DB_PATH);

const HISTORY_CAP = 25;

// ---- track selection -------------------------------------------------------

let selectionCounter = 0;
function newTrackSeed(zoneId, playCount) {
  // Unpredictable enough to vary exploration, but recorded so all clients agree.
  const base = (Date.now() >>> 0) ^ Math.imul(playCount + (++selectionCounter), 2654435761) ^ hashStringToSeed(zoneId);
  return base >>> 0;
}

function newTrack(zoneId, playCount, posteriors) {
  const seed = newTrackSeed(zoneId, playCount);
  const genome = sampleGenome(mulberry32(seed), posteriors);
  return { seed, genome };
}

// Build the public stats blob for a zone.
function zoneStats(zoneId, posteriors, row) {
  return {
    plays: row.play_count,
    votes: row.vote_count,
    maturity: maturity(posteriors),
    profile: profile(posteriors),
  };
}

// Get-or-create a zone and guarantee it has a current track.
function ensureZone(lat, lon) {
  const zoneId = zoneIdFor(lat, lon);
  let row = store.getZone(zoneId);
  const geo = zoneGeometry(zoneId);
  if (!row) {
    row = store.createZone(zoneId, zoneName(zoneId), geo.center.lat, geo.center.lon, Date.now());
  }
  const posteriors = store.loadPosteriors(zoneId);
  if (!row.current_genome) {
    const t = newTrack(zoneId, row.play_count, posteriors);
    store.setCurrent(zoneId, t.seed, t.genome, []);
    row = store.getZone(zoneId);
  }
  return { zoneId, row, geo, posteriors };
}

function currentTrackOf(row) {
  return { seed: row.current_seed, genome: JSON.parse(row.current_genome) };
}

// ---- HTTP helpers ----------------------------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = normalize(join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await readFile(full);
    const ext = full.slice(full.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

// ---- API handlers ----------------------------------------------------------

function handleZone(res, q) {
  const lat = Number(q.get('lat'));
  const lon = Number(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return sendJson(res, 400, { error: 'lat/lon required and must be valid coordinates' });
  }
  const { zoneId, row, geo, posteriors } = ensureZone(lat, lon);
  sendJson(res, 200, {
    zoneId,
    name: row.name,
    gridDeg: GRID_DEG,
    center: geo.center,
    bbox: geo.bbox,
    currentTrack: currentTrackOf(row),
    stats: zoneStats(zoneId, posteriors, row),
  });
}

async function handleVote(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }

  const { zoneId, seed } = body;
  const action = body.action || 'none';        // 'next' | 'previous' | 'none'
  let vote = body.vote || null;                 // 'up' | 'down' | null

  if (!zoneId || typeof zoneId !== 'string') return sendJson(res, 400, { error: 'zoneId required' });
  let row = store.getZone(zoneId);
  if (!row || !row.current_genome) return sendJson(res, 404, { error: 'unknown zone (request /api/zone first)' });

  const posteriors = store.loadPosteriors(zoneId);
  const current = currentTrackOf(row);
  let history = [];
  try { history = JSON.parse(row.history) || []; } catch { history = []; }

  // Which genome are we voting on? Trust the server's current track; accept a
  // client-supplied genome only as a fallback if it's valid and the seed lines up.
  let votedGenome = current.genome;
  if (Number(seed) !== Number(current.current_seed) && isValidGenome(body.genome)) {
    votedGenome = body.genome;
  }

  let changed = [];
  let votesCast = 0;

  if (action === 'next') {
    // Skip = a (weak) downvote on what was playing, then explore a fresh track.
    if (vote == null) vote = 'down';
    changed = applyVote(posteriors, current.genome, vote === 'up' ? 1 : -1, 1);
    votesCast = 1;
    history.push(current);
    if (history.length > HISTORY_CAP) history.shift();
    const t = newTrack(zoneId, row.play_count, posteriors);
    store.saveArms(zoneId, changed);
    store.setCurrent(zoneId, t.seed, t.genome, history);
  } else if (action === 'previous') {
    // Going back = you preferred the prior track -> upvote it and restore it.
    if (vote == null) vote = 'up';
    if (history.length > 0) {
      const prev = history.pop();
      changed = applyVote(posteriors, prev.genome, vote === 'down' ? -1 : 1, 1);
      votesCast = 1;
      store.saveArms(zoneId, changed);
      store.setCurrent(zoneId, prev.seed, prev.genome, history);
    } else {
      // Nothing before this — treat as a like on the current track, keep playing it.
      changed = applyVote(posteriors, current.genome, vote === 'down' ? -1 : 1, 1);
      votesCast = 1;
      store.saveArms(zoneId, changed);
    }
  } else {
    // Explicit thumb with no track change. Stronger signal -> weight 2.
    if (vote !== 'up' && vote !== 'down') return sendJson(res, 400, { error: 'vote must be up or down for action=none' });
    changed = applyVote(posteriors, votedGenome, vote === 'up' ? 1 : -1, 2);
    votesCast = 1;
    store.saveArms(zoneId, changed);
  }

  if (votesCast) store.bumpVoteCount(zoneId, votesCast);
  row = store.getZone(zoneId);

  sendJson(res, 200, {
    zoneId,
    name: row.name,
    currentTrack: currentTrackOf(row),
    changed,
    stats: zoneStats(zoneId, posteriors, row),
  });
}

function handleProfile(res, q) {
  const zoneId = q.get('zoneId');
  if (!zoneId) return sendJson(res, 400, { error: 'zoneId required' });
  const row = store.getZone(zoneId);
  if (!row) return sendJson(res, 404, { error: 'unknown zone' });
  const posteriors = store.loadPosteriors(zoneId);
  const geo = zoneGeometry(zoneId);
  sendJson(res, 200, {
    zoneId,
    name: row.name,
    center: geo.center,
    bbox: geo.bbox,
    currentTrack: row.current_genome ? currentTrackOf(row) : null,
    stats: zoneStats(zoneId, posteriors, row),
  });
}

function handleWorld(res) {
  const zones = store.listZones(800).map((z) => {
    let genome = null;
    try { genome = z.current_genome ? JSON.parse(z.current_genome) : null; } catch {}
    const geo = zoneGeometry(z.zone_id);
    return {
      zoneId: z.zone_id,
      name: z.name,
      center: geo.center,
      plays: z.play_count,
      votes: z.vote_count,
      sound: genome ? { scale: genome.scale, root: genome.root, tempo: genome.tempo, drums: genome.drums } : null,
    };
  });
  sendJson(res, 200, { gridDeg: GRID_DEG, count: zones.length, zones });
}

// ---- router ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      return res.end();
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === '/api/zone' && req.method === 'GET') return handleZone(res, url.searchParams);
    if (path === '/api/vote' && req.method === 'POST') return handleVote(req, res);
    if (path === '/api/profile' && req.method === 'GET') return handleProfile(res, url.searchParams);
    if (path === '/api/world' && req.method === 'GET') return handleWorld(res);
    if (path === '/api/dimensions' && req.method === 'GET') return sendJson(res, 200, { dimensions: DIMENSIONS });
    if (path === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, zones: store.zoneCount() });

    if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });
    return serveStatic(req, res, path);
  } catch (err) {
    console.error('request error:', err);
    sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`Worldsong listening on http://localhost:${PORT}  (db: ${DB_PATH})`);
});
