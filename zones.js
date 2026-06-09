// zones.js — geolocation -> discrete zone, plus a deterministic poetic name.
//
// We quantize latitude/longitude onto a grid so that everyone physically near
// each other lands in the same zone and therefore shares the same evolving song.
// Default cell size ~0.01 degrees (~1.1 km of latitude) — tweakable.

export const GRID = 0.01; // degrees per cell

// Snap a coordinate to the centre of its grid cell.
function snap(x) {
  return Math.round(x / GRID) * GRID;
}

// Build the canonical zone id + representative centre for a lat/lon.
export function zoneFor(lat, lon) {
  // clamp to valid ranges
  lat = Math.max(-85, Math.min(85, Number(lat)));
  lon = ((((Number(lon) + 180) % 360) + 360) % 360) - 180;
  const clat = snap(lat);
  const clon = snap(lon);
  const id = `z_${clat.toFixed(2)}_${clon.toFixed(2)}`;
  return { id, lat: clat, lon: clon };
}

// 32-bit hash of a string (FNV-1a), used to seed deterministic naming.
export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const ADJ = [
  'Hidden', 'Amber', 'Velvet', 'Quiet', 'Electric', 'Crimson', 'Misty', 'Golden',
  'Hollow', 'Silver', 'Drifting', 'Restless', 'Frozen', 'Sunken', 'Echoing', 'Wandering',
  'Distant', 'Glowing', 'Whispering', 'Northern', 'Ancient', 'Neon', 'Tidal', 'Marble',
  'Static', 'Lunar', 'Verdant', 'Obsidian', 'Pale', 'Burning', 'Shifting', 'Wild',
];
const NOUN = [
  'Hollow', 'Harbor', 'Meadow', 'Spire', 'Drift', 'Hearth', 'Gulch', 'Terrace',
  'Quarter', 'Basin', 'Reach', 'Grove', 'Crossing', 'Expanse', 'Fold', 'Threshold',
  'Strand', 'Verge', 'Span', 'Hollow', 'Mesa', 'Lagoon', 'Causeway', 'Knoll',
  'Annex', 'Conduit', 'Bazaar', 'Atrium', 'Plateau', 'Wharf', 'Commons', 'Vault',
];

// A stable, evocative name for a zone — same coords always yield the same name.
export function zoneName(id) {
  const h = hashStr(id);
  const a = ADJ[h % ADJ.length];
  const n = NOUN[(h >>> 8) % NOUN.length];
  return `${a} ${n}`;
}
