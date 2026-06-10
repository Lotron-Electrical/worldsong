// server.js — Worldsong backend. Pure Node built-ins (http + node:sqlite).
//
// Serves the static client from ./public and exposes the JSON API:
//   GET  /api/zone?lat=&lon=     -> current shared track + learned profile for a zone
//   POST /api/vote               -> {zoneId, action:'next'|'prev'|'like'|'dislike'}
//   GET  /api/world              -> known zones + global stats (for the minimap)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from './db.js';
import { resolveZone } from './geocode.js';
import {
  sampleGenome, applyVote, profileSummary, maturity, DIMENSIONS,
} from './bandit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 5577;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'worldsong.db');

const db = openDb(DB_PATH);

// ---- helpers --------------------------------------------------------------

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(data);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.png': 'image/png',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// Generate the next track for a zone using its *current* learned arm stats.
function regenerate(zone) {
  const counter = (zone.track_counter || 0) + 1;
  const seed = db.seedFor(zone.id, counter);
  const getStat = db.statReader(zone.id);
  const genome = sampleGenome(getStat, seed);
  return { counter, seed, genome };
}

// Ensure a zone row exists; create with an initial track if not.
// `z` is a resolved descriptor from geocode.js: { id, name, label, lat, lon }.
function ensureZone(z) {
  const existing = db.getZone(z.id);
  if (existing) return existing;
  const seed = db.seedFor(z.id, 1);
  const getStat = db.statReader(z.id); // all priors -> exploratory first track
  const genome = sampleGenome(getStat, seed);
  return db.createZone(z.id, z.lat, z.lon, z.name, z.label, seed, JSON.stringify(genome));
}

function zonePayload(zone) {
  const getStat = db.statReader(zone.id);
  return {
    zoneId: zone.id,
    name: zone.name,
    label: zone.label || '',
    center: { lat: zone.lat, lon: zone.lon },
    currentTrack: { seed: zone.current_seed, genome: JSON.parse(zone.current_genome) },
    stats: {
      plays: zone.plays,
      upvotes: zone.upvotes,
      downvotes: zone.downvotes,
    },
    profile: profileSummary(getStat),
    maturity: maturity(getStat),
    global: db.globalStats(),
  };
}

// ---- routes ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // CORS — lets a standalone (Capacitor/EAS) build call this API from a
    // different origin. The in-WebView app is same-origin so it doesn't need it.
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }

    if (url.pathname === '/api/zone' && req.method === 'GET') {
      const lat = parseFloat(url.searchParams.get('lat'));
      const lon = parseFloat(url.searchParams.get('lon'));
      if (Number.isNaN(lat) || Number.isNaN(lon)) return send(res, 400, { error: 'lat/lon required' });
      const z = await resolveZone(db, lat, lon); // -> real suburb / postcode boundary
      ensureZone(z);
      db.recordPlay(z.id);
      return send(res, 200, zonePayload(db.getZone(z.id)));
    }

    if (url.pathname === '/api/vote' && req.method === 'POST') {
      const body = await readBody(req);
      const { zoneId, action } = body;
      const zone = db.getZone(zoneId);
      if (!zone) return send(res, 404, { error: 'unknown zone' });

      const history = JSON.parse(zone.history || '[]');
      const currentGenome = JSON.parse(zone.current_genome);
      const bump = (dim, arm, dA, dB) => db.bumpArm(zoneId, dim, arm, dA, dB);

      if (action === 'like') {
        // upvote, keep the current track playing
        applyVote(currentGenome, +1, bump);
        db.recordVote(zoneId, zone.current_seed, +1, zone.current_genome);
      } else if (action === 'next') {
        // forward = UPVOTE the current track, then advance to a fresh one
        applyVote(currentGenome, +1, bump);
        db.recordVote(zoneId, zone.current_seed, +1, zone.current_genome);
        history.push({ seed: zone.current_seed, genome: currentGenome });
        const ng = regenerate(zone); // reads stats AFTER the upvote -> biased toward it
        db.setTrack(zoneId, ng.seed, JSON.stringify(ng.genome), history, ng.counter);
      } else if (action === 'dislike') {
        // explicit downvote + skip to a fresh track
        applyVote(currentGenome, -1, bump);
        db.recordVote(zoneId, zone.current_seed, -1, zone.current_genome);
        history.push({ seed: zone.current_seed, genome: currentGenome });
        const ng = regenerate(zone);
        db.setTrack(zoneId, ng.seed, JSON.stringify(ng.genome), history, ng.counter);
      } else if (action === 'prev') {
        // back = DOWNVOTE the current track, then return to the previous one
        applyVote(currentGenome, -1, bump);
        db.recordVote(zoneId, zone.current_seed, -1, zone.current_genome);
        if (history.length) {
          const prev = history.pop();
          db.setTrack(zoneId, prev.seed, JSON.stringify(prev.genome), history, zone.track_counter);
        } else {
          // nothing earlier to go back to — downvote stands; advance to a fresh track
          const ng = regenerate(zone);
          db.setTrack(zoneId, ng.seed, JSON.stringify(ng.genome), history, ng.counter);
        }
      } else {
        return send(res, 400, { error: 'bad action' });
      }

      return send(res, 200, zonePayload(db.getZone(zoneId)));
    }

    if (url.pathname === '/api/world' && req.method === 'GET') {
      const zones = db.listZones(800).map((z) => ({
        id: z.id,
        lat: z.lat,
        lon: z.lon,
        name: z.name,
        plays: z.plays,
        score: (z.upvotes || 0) - (z.downvotes || 0),
        genome: z.current_genome ? JSON.parse(z.current_genome) : null,
      }));
      return send(res, 200, { zones, global: db.globalStats() });
    }

    if (url.pathname === '/api/dimensions' && req.method === 'GET') {
      return send(res, 200, DIMENSIONS);
    }

    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'no route' });

    return serveStatic(req, res);
  } catch (e) {
    return send(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`Worldsong listening on http://localhost:${PORT}  (db: ${DB_PATH})`);
});
