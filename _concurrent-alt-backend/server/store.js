// Persistence layer on node:sqlite (built into Node >=22, no native build step).
// Holds, per zone: identity + the currently-playing track + a small history
// stack (for "previous"), and the bandit's Beta posteriors (the arms table).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensurePosteriors, PRIOR_A, PRIOR_B } from './bandit.js';

let db = null;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS zones (
      zone_id        TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      lat            REAL NOT NULL,
      lon            REAL NOT NULL,
      created_at     INTEGER NOT NULL,
      play_count     INTEGER NOT NULL DEFAULT 0,
      vote_count     INTEGER NOT NULL DEFAULT 0,
      current_seed   INTEGER,
      current_genome TEXT,
      history        TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS arms (
      zone_id   TEXT NOT NULL,
      dimension TEXT NOT NULL,
      arm       TEXT NOT NULL,
      alpha     REAL NOT NULL,
      beta      REAL NOT NULL,
      PRIMARY KEY (zone_id, dimension, arm)
    );
    CREATE INDEX IF NOT EXISTS arms_zone ON arms(zone_id);
  `);
  return db;
}

export function getZone(zoneId) {
  return db.prepare('SELECT * FROM zones WHERE zone_id = ?').get(zoneId) || null;
}

export function createZone(zoneId, name, lat, lon, createdAt) {
  db.prepare(
    `INSERT OR IGNORE INTO zones (zone_id, name, lat, lon, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(zoneId, name, lat, lon, createdAt);
  return getZone(zoneId);
}

export function setCurrent(zoneId, seed, genome, history) {
  db.prepare(
    `UPDATE zones SET current_seed = ?, current_genome = ?, history = ?,
       play_count = play_count + 1 WHERE zone_id = ?`
  ).run(seed, JSON.stringify(genome), JSON.stringify(history), zoneId);
}

export function bumpVoteCount(zoneId, n = 1) {
  db.prepare('UPDATE zones SET vote_count = vote_count + ? WHERE zone_id = ?').run(n, zoneId);
}

// Load this zone's bandit posteriors, filling unseen arms with the flat prior.
export function loadPosteriors(zoneId) {
  const rows = db.prepare('SELECT dimension, arm, alpha, beta FROM arms WHERE zone_id = ?').all(zoneId);
  const p = {};
  for (const r of rows) {
    if (!p[r.dimension]) p[r.dimension] = {};
    p[r.dimension][r.arm] = { a: r.alpha, b: r.beta };
  }
  return ensurePosteriors(p);
}

// Upsert the arms that a vote changed.
export function saveArms(zoneId, changed) {
  const stmt = db.prepare(
    `INSERT INTO arms (zone_id, dimension, arm, alpha, beta) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(zone_id, dimension, arm) DO UPDATE SET alpha = excluded.alpha, beta = excluded.beta`
  );
  for (const c of changed) stmt.run(zoneId, c.dimension, c.arm, c.a, c.b);
}

// All known zones (for the world minimap). Lightweight columns only.
export function listZones(limit = 500) {
  return db.prepare(
    `SELECT zone_id, name, lat, lon, play_count, vote_count, current_genome
     FROM zones ORDER BY vote_count DESC, play_count DESC LIMIT ?`
  ).all(limit);
}

export function zoneCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM zones').get().n;
}

export { PRIOR_A, PRIOR_B };
