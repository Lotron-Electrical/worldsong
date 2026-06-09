// db.js — persistence layer (built-in node:sqlite, zero native deps).
//
// Holds zones, their per-arm Beta stats (the learned sound profile), the current
// shared track per zone, a small history stack (for "previous"), and a vote log.

import { DatabaseSync } from 'node:sqlite';
import { hashStr } from './zones.js';

const HISTORY_MAX = 30;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS zones (
      id            TEXT PRIMARY KEY,
      lat           REAL,
      lon           REAL,
      name          TEXT,
      created_at    INTEGER,
      updated_at    INTEGER,
      plays         INTEGER DEFAULT 0,
      upvotes       INTEGER DEFAULT 0,
      downvotes     INTEGER DEFAULT 0,
      track_counter INTEGER DEFAULT 0,
      current_seed  INTEGER,
      current_genome TEXT,
      history       TEXT DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS arms (
      zone_id TEXT,
      dim     TEXT,
      arm     TEXT,
      alpha   REAL DEFAULT 1,
      beta    REAL DEFAULT 1,
      PRIMARY KEY (zone_id, dim, arm)
    );
    CREATE TABLE IF NOT EXISTS votes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id    TEXT,
      seed       INTEGER,
      vote       INTEGER,
      genome     TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_arms_zone ON arms(zone_id);
    CREATE INDEX IF NOT EXISTS idx_votes_zone ON votes(zone_id);
  `);

  const q = {
    getZone: db.prepare('SELECT * FROM zones WHERE id = ?'),
    insZone: db.prepare(
      `INSERT INTO zones (id, lat, lon, name, created_at, updated_at, current_seed, current_genome, track_counter)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updTrack: db.prepare(
      `UPDATE zones SET current_seed = ?, current_genome = ?, history = ?, track_counter = ?, updated_at = ? WHERE id = ?`,
    ),
    bumpPlays: db.prepare('UPDATE zones SET plays = plays + 1, updated_at = ? WHERE id = ?'),
    bumpVotes: db.prepare('UPDATE zones SET upvotes = upvotes + ?, downvotes = downvotes + ?, updated_at = ? WHERE id = ?'),
    getArm: db.prepare('SELECT alpha, beta FROM arms WHERE zone_id = ? AND dim = ? AND arm = ?'),
    upsertArm: db.prepare(
      `INSERT INTO arms (zone_id, dim, arm, alpha, beta) VALUES (?, ?, ?, 1 + ?, 1 + ?)
       ON CONFLICT(zone_id, dim, arm) DO UPDATE SET alpha = alpha + ?, beta = beta + ?`,
    ),
    allArms: db.prepare('SELECT dim, arm, alpha, beta FROM arms WHERE zone_id = ?'),
    insVote: db.prepare('INSERT INTO votes (zone_id, seed, vote, genome, created_at) VALUES (?, ?, ?, ?, ?)'),
    listZones: db.prepare(
      'SELECT id, lat, lon, name, plays, upvotes, downvotes, current_genome FROM zones ORDER BY updated_at DESC LIMIT ?',
    ),
    stats: db.prepare('SELECT COUNT(*) AS zones, COALESCE(SUM(plays),0) AS plays, COALESCE(SUM(upvotes),0) AS up, COALESCE(SUM(downvotes),0) AS down FROM zones'),
    voteCount: db.prepare('SELECT COUNT(*) AS n FROM votes'),
  };

  // Build an in-memory cache of a zone's arms for fast Thompson sampling.
  function armCache(zoneId) {
    const rows = q.allArms.all(zoneId);
    const map = new Map();
    for (const r of rows) map.set(`${r.dim}|${r.arm}`, { alpha: r.alpha, beta: r.beta });
    return map;
  }

  return {
    raw: db,

    getZone(id) {
      return q.getZone.get(id) || null;
    },

    createZone(id, lat, lon, name, seed, genomeJson) {
      const now = Date.now();
      q.insZone.run(id, lat, lon, name, now, now, seed, genomeJson, 1);
      return q.getZone.get(id);
    },

    // Returns a getStat(dim,arm) closure backed by an in-memory snapshot.
    statReader(zoneId) {
      const cache = armCache(zoneId);
      return (dim, arm) => cache.get(`${dim}|${arm}`) || { alpha: 1, beta: 1 };
    },

    // Persist arm increments for a vote.
    bumpArm(zoneId, dim, arm, dAlpha, dBeta) {
      q.upsertArm.run(zoneId, dim, arm, dAlpha, dBeta, dAlpha, dBeta);
    },

    setTrack(zoneId, seed, genomeJson, history, counter) {
      q.updTrack.run(seed, genomeJson, JSON.stringify(history.slice(-HISTORY_MAX)), counter, Date.now(), zoneId);
    },

    recordPlay(zoneId) {
      q.bumpPlays.run(Date.now(), zoneId);
    },

    recordVote(zoneId, seed, vote, genomeJson) {
      q.insVote.run(zoneId, seed, vote, genomeJson, Date.now());
      q.bumpVotes.run(vote > 0 ? 1 : 0, vote < 0 ? 1 : 0, Date.now(), zoneId);
    },

    listZones(limit = 500) {
      return q.listZones.all(limit);
    },

    globalStats() {
      const s = q.stats.get();
      const v = q.voteCount.get();
      return { zones: s.zones, plays: s.plays, upvotes: s.up, downvotes: s.down, votes: v.n };
    },

    // Deterministic, unique seed per generation (no Math.random).
    seedFor(zoneId, counter) {
      return (hashStr(zoneId) ^ Math.imul(counter >>> 0, 2654435761)) >>> 0;
    },
  };
}
