// geocode.js — turn a raw coordinate into a REAL-WORLD zone.
//
// Instead of an arbitrary 1km grid, a "zone" is now an actual place boundary:
// the suburb you're standing in (or, where there's no named suburb, the postcode
// or town). Cross from one suburb into the next and you cross into a new song.
//
// We use OpenStreetMap's free Nominatim reverse-geocoder — no API key. We are a
// polite citizen of that service:
//   * one request at a time, >= 1.1s apart (its usage policy is ~1 req/sec),
//   * a descriptive User-Agent,
//   * a persistent cache (in the DB) so any given ~150m cell is looked up at most
//     once, ever — neighbours in the same suburb reuse it instantly.
// If geocoding is unavailable (offline, rate-limited, middle of the ocean) we fall
// back to a coarse grid so the app still works literally everywhere on Earth.

const PROVIDER = process.env.GEOCODE_PROVIDER || 'nominatim'; // 'nominatim' | 'mock'
const CONTACT = process.env.GEOCODE_CONTACT || 'worldsong self-host';
const ENDPOINT = process.env.GEOCODE_ENDPOINT || 'https://nominatim.openstreetmap.org/reverse';

// Fine cache cell (~150m): keeps suburb boundaries crisp while collapsing GPS jitter.
const CACHE_GRID = 0.0015;
function cacheCell(lat, lon) {
  const a = Math.round(lat / CACHE_GRID) * CACHE_GRID;
  const o = Math.round(lon / CACHE_GRID) * CACHE_GRID;
  return `${a.toFixed(4)}_${o.toFixed(4)}`;
}

function slug(s) {
  return String(s || '')
    .toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
function titleCase(s) {
  return String(s || '').replace(/[^\s-]+/g, (w) => w[0].toUpperCase() + w.slice(1));
}

// ---- coarse-grid fallback (ocean / offline / unnamed place) ---------------
const FB_GRID = 0.05; // ~5km cells when we genuinely can't name a place
function fallbackZone(lat, lon) {
  const a = Math.round(lat / FB_GRID) * FB_GRID;
  const o = Math.round(lon / FB_GRID) * FB_GRID;
  return {
    id: `geo_${a.toFixed(2)}_${o.toFixed(2)}`,
    name: 'Uncharted',
    label: `${a.toFixed(2)}, ${o.toFixed(2)} · open water or wilderness`,
    lat: a, lon: o, kind: 'grid',
  };
}

// ---- build a zone descriptor from a Nominatim address object --------------
function zoneFromAddress(addr, lat, lon, country) {
  const cc = (addr.country_code || '').toUpperCase();
  const suburb = addr.suburb || addr.neighbourhood || addr.city_district
    || addr.quarter || addr.borough || addr.village || addr.town || addr.hamlet;
  const locality = addr.city || addr.town || addr.municipality
    || addr.county || addr.state_district || addr.state;
  const postcode = addr.postcode;
  const land = country || addr.country;

  if (suburb) {
    const id = `sub_${cc || 'xx'}_${slug(locality)}_${slug(suburb)}`.replace(/_+/g, '_');
    const label = [postcode && `${postcode}`, locality, land].filter(Boolean).join(' · ');
    return { id, name: titleCase(suburb), label, lat, lon, kind: 'suburb' };
  }
  if (postcode) {
    const id = `pc_${cc || 'xx'}_${slug(postcode)}`;
    const label = [locality, land].filter(Boolean).join(' · ') || 'Postcode area';
    const name = `${locality ? titleCase(locality) + ' ' : ''}${postcode}`.trim();
    return { id, name, label, lat, lon, kind: 'postcode' };
  }
  if (locality) {
    return { id: `loc_${cc || 'xx'}_${slug(locality)}`, name: titleCase(locality), label: land || '', lat, lon, kind: 'locality' };
  }
  return null;
}

// ---- deterministic mock provider (for hermetic tests, no network) ---------
function mockResolve(lat, lon) {
  const G = 0.05; // ~5km fake "suburbs"
  const a = Math.round(lat / G) * G;
  const o = Math.round(lon / G) * G;
  const h = Math.abs(Math.round((a * 1000 + o) * 7)) % 100000;
  const pc = String(10000 + (h % 89999));
  return { id: `sub_mk_${a.toFixed(2)}_${o.toFixed(2)}`, name: `Mock ${pc}`, label: `${pc} · Mockville · Testland`, lat: a, lon: o, kind: 'suburb' };
}

// ---- nominatim provider: serial, rate-limited queue -----------------------
let lastCall = 0;
let chain = Promise.resolve();
function schedule(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => {}); // keep the queue alive even if one call fails
  return run;
}

async function nominatimResolve(lat, lon) {
  const u = new URL(ENDPOINT);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('lat', String(lat));
  u.searchParams.set('lon', String(lon));
  u.searchParams.set('zoom', '14'); // ~suburb level
  u.searchParams.set('addressdetails', '1');

  const res = await schedule(() => fetch(u, {
    headers: { 'User-Agent': `Worldsong/1.0 (${CONTACT})`, Accept: 'application/json' },
  }));
  if (!res.ok) throw new Error('nominatim ' + res.status);
  const j = await res.json();
  if (!j || !j.address) return null;

  // Prefer the place's bounding-box centroid as the zone centre (so the map dot
  // sits on the suburb, not wherever the first visitor happened to stand).
  let clat = lat;
  let clon = lon;
  const bb = Array.isArray(j.boundingbox) ? j.boundingbox.map(Number) : null;
  if (bb && bb.length === 4 && bb.every((n) => Number.isFinite(n))) {
    clat = (bb[0] + bb[1]) / 2;
    clon = (bb[2] + bb[3]) / 2;
  }
  return zoneFromAddress(j.address, clat, clon, j.address.country);
}

// ---- public API -----------------------------------------------------------
// resolveZone(db, lat, lon) -> { id, name, label, lat, lon, kind }
// db must expose getGeocache(cell) / putGeocache(cell, payload).
export async function resolveZone(db, lat, lon) {
  lat = Math.max(-85, Math.min(85, Number(lat)));
  lon = ((((Number(lon) + 180) % 360) + 360) % 360) - 180;
  const cell = cacheCell(lat, lon);

  const cached = db.getGeocache(cell);
  if (cached) return cached;

  let zone = null;
  try {
    zone = PROVIDER === 'mock' ? mockResolve(lat, lon) : await nominatimResolve(lat, lon);
  } catch {
    zone = null; // network / rate-limit / offline -> fall through to the grid
  }
  if (!zone) zone = fallbackZone(lat, lon);

  db.putGeocache(cell, zone);
  return zone;
}

export const _internals = { zoneFromAddress, fallbackZone, slug, cacheCell };
