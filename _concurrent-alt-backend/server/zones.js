// Geolocation -> zone. We quantize lat/lon to a fixed grid; everyone whose
// coordinates fall in the same cell shares one zone (one evolving soundtrack).
// GRID_DEG = 0.01 deg ~ 1.1km cells (a neighborhood) — comparable to the music
// radius you'd expect "walking into a new area" in a video game.

import { hashStringToSeed, mulberry32, pick } from './rng.js';

export const GRID_DEG = 0.01;

export function cellFor(lat, lon) {
  const latCell = Math.floor(lat / GRID_DEG);
  const lonCell = Math.floor(lon / GRID_DEG);
  return { latCell, lonCell };
}

export function zoneIdFor(lat, lon) {
  const { latCell, lonCell } = cellFor(lat, lon);
  return `z_${latCell}_${lonCell}`;
}

// Parse a zoneId back into its grid cell + geographic center/bbox (for the map).
export function zoneGeometry(zoneId) {
  const m = /^z_(-?\d+)_(-?\d+)$/.exec(zoneId);
  if (!m) throw new Error('bad zoneId: ' + zoneId);
  const latCell = parseInt(m[1], 10);
  const lonCell = parseInt(m[2], 10);
  const center = {
    lat: (latCell + 0.5) * GRID_DEG,
    lon: (lonCell + 0.5) * GRID_DEG,
  };
  const bbox = {
    latMin: latCell * GRID_DEG,
    latMax: (latCell + 1) * GRID_DEG,
    lonMin: lonCell * GRID_DEG,
    lonMax: (lonCell + 1) * GRID_DEG,
  };
  return { latCell, lonCell, center, bbox };
}

// Stable, human-friendly place name for a zone (like a real place, it doesn't
// change as the music evolves). Seeded purely by zoneId so it's identical for
// everyone, forever.
const ADJ = [
  'Amber', 'Cobalt', 'Hollow', 'Crimson', 'Velvet', 'Iron', 'Silver', 'Dusk',
  'Ember', 'Glass', 'Hush', 'Indigo', 'Jade', 'Lantern', 'Marble', 'Neon',
  'Opal', 'Pale', 'Quiet', 'Russet', 'Slate', 'Tidal', 'Umbra', 'Verdant',
  'Whisper', 'Argent', 'Bronze', 'Coral', 'Drift', 'Echo', 'Frost', 'Gilt',
];
const NOUN = [
  'Hollow', 'Reach', 'Quarter', 'Mile', 'Bazaar', 'Harbor', 'Terrace', 'Span',
  'Commons', 'Grove', 'Crossing', 'Court', 'Wharf', 'Heights', 'Run', 'Bend',
  'Junction', 'Yard', 'Lane', 'Gate', 'Spire', 'Flats', 'Banks', 'Verge',
  'Walk', 'Loop', 'Steps', 'Arches', 'Mews', 'Row', 'Square', 'Quay',
];

export function zoneName(zoneId) {
  const seed = hashStringToSeed(zoneId);
  const rng = mulberry32(seed);
  return `${pick(rng, ADJ)} ${pick(rng, NOUN)}`;
}
