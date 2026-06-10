// geocode.js — turn a raw coordinate into a REAL-WORLD zone.
//
// Instead of an arbitrary 1km grid, a "zone" is now an actual place boundary:
// the suburb you're standing in (or, where there's no named suburb, the postcode
// or town). Cross from one suburb into the next and you cross into a new song.
//
// Provider: we use a free OSM reverse-geocoder. The default is Komoot's **Photon**
// because — unlike the public Nominatim instance, which blocks datacenter IPs and
// so silently fails when this runs on a cloud host (Render) — Photon serves server
// traffic and still gives suburb-level detail with postcodes. Nominatim is kept as
// a secondary (it works fine from a home IP, so local dev/tests still exercise it),
// and 'mock' is a deterministic offline provider for hermetic tests.
//
// We stay polite: one request at a time, >= 1.1s apart, a descriptive User-Agent,
// and a persistent DB cache so any ~150m cell is looked up at most once. If every
// provider is unavailable (offline, mid-ocean, all blocked) we fall back to a
// coarse grid so the app still works everywhere — but we DO NOT cache that fallback,
// so a momentary outage can never poison a cell permanently.

const CONTACT = process.env.GEOCODE_CONTACT || 'worldsong self-host';
const PHOTON_ENDPOINT = process.env.GEOCODE_PHOTON || 'https://photon.komoot.io/reverse';
const NOMINATIM_ENDPOINT = process.env.GEOCODE_ENDPOINT || 'https://nominatim.openstreetmap.org/reverse';
// If GEOCODE_PROVIDER is set, use exactly that one; otherwise try this chain in order.
const CHAIN = process.env.GEOCODE_PROVIDER ? [process.env.GEOCODE_PROVIDER] : ['photon', 'nominatim'];
const DEBUG = process.env.GEOCODE_DEBUG !== '0'; // log a one-liner per resolve unless silenced

// Fine cache cell (~150m): keeps suburb boundaries crisp while collapsing GPS jitter.
// The version prefix lets us invalidate every cached cell at once just by bumping it
// (e.g. after a provider change) without touching the database.
const CACHE_VERSION = 'p1';
const CACHE_GRID = 0.0015;
function cacheCell(lat, lon) {
  const a = Math.round(lat / CACHE_GRID) * CACHE_GRID;
  const o = Math.round(lon / CACHE_GRID) * CACHE_GRID;
  return `${CACHE_VERSION}:${a.toFixed(4)}_${o.toFixed(4)}`;
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

// ---- assemble a zone descriptor from normalised place parts ---------------
// Shared by every provider so they all produce identical zone ids/labels.
// Tiers: a named suburb wins; else the postcode area; else the town/city.
function assembleZone({ cc, suburb, locality, postcode, land, lat, lon }) {
  cc = cc || 'xx';
  if (suburb) {
    const id = `sub_${cc}_${slug(locality)}_${slug(suburb)}`.replace(/_+/g, '_');
    const label = [postcode, locality, land].filter(Boolean).join(' · ');
    return { id, name: titleCase(suburb), label, lat, lon, kind: 'suburb' };
  }
  if (postcode) {
    const id = `pc_${cc}_${slug(postcode)}`;
    const label = [locality, land].filter(Boolean).join(' · ') || 'Postcode area';
    const name = `${locality ? titleCase(locality) + ' ' : ''}${postcode}`.trim();
    return { id, name, label, lat, lon, kind: 'postcode' };
  }
  if (locality) {
    return { id: `loc_${cc}_${slug(locality)}`, name: titleCase(locality), label: land || '', lat, lon, kind: 'locality' };
  }
  return null;
}

// ---- map each provider's raw response onto assembleZone() -----------------
function zoneFromNominatim(addr, lat, lon, country) {
  const cc = (addr.country_code || '').toUpperCase();
  const suburb = addr.suburb || addr.neighbourhood || addr.city_district
    || addr.quarter || addr.borough || addr.village || addr.town || addr.hamlet;
  const locality = addr.city || addr.town || addr.municipality
    || addr.county || addr.state_district || addr.state;
  return assembleZone({ cc, suburb, locality, postcode: addr.postcode, land: country || addr.country, lat, lon });
}

function zoneFromPhoton(p, lat, lon) {
  const cc = (p.countrycode || '').toUpperCase();
  const placeName = (p.osm_key === 'place'
    && /^(suburb|neighbourhood|quarter|village|hamlet|town|locality|city_block)$/.test(p.osm_value || ''))
    ? p.name : undefined;
  const suburb = p.suburb || p.district || p.locality || p.neighbourhood || p.quarter || placeName;
  const locality = p.city || p.town || p.village || p.county || p.state;
  return assembleZone({ cc, suburb, locality, postcode: p.postcode, land: p.country, lat, lon });
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

// ---- shared serial, rate-limited request queue (>= 1.1s apart) ------------
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

const UA = `Worldsong/1.0 (${CONTACT})`;

// ---- Photon (primary): OSM data, works from datacenters -------------------
async function photonResolve(lat, lon) {
  const u = new URL(PHOTON_ENDPOINT);
  u.searchParams.set('lat', String(lat));
  u.searchParams.set('lon', String(lon));
  const res = await schedule(() => fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } }));
  if (!res.ok) throw new Error('photon ' + res.status);
  const j = await res.json();
  const f = j && Array.isArray(j.features) && j.features[0];
  if (!f || !f.properties) return null;
  // Centre the zone on the place's extent if we have one, else the matched point.
  let clat = lat, clon = lon;
  const ext = f.properties.extent;
  if (Array.isArray(ext) && ext.length === 4 && ext.every((n) => Number.isFinite(Number(n)))) {
    clon = (Number(ext[0]) + Number(ext[2])) / 2;
    clat = (Number(ext[1]) + Number(ext[3])) / 2;
  } else if (f.geometry && Array.isArray(f.geometry.coordinates)) {
    clon = Number(f.geometry.coordinates[0]);
    clat = Number(f.geometry.coordinates[1]);
  }
  return zoneFromPhoton(f.properties, clat, clon);
}

// ---- Nominatim (secondary): great data, but blocks datacenter IPs ---------
async function nominatimResolve(lat, lon) {
  const u = new URL(NOMINATIM_ENDPOINT);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('lat', String(lat));
  u.searchParams.set('lon', String(lon));
  u.searchParams.set('zoom', '14'); // ~suburb level
  u.searchParams.set('addressdetails', '1');
  const res = await schedule(() => fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } }));
  if (!res.ok) throw new Error('nominatim ' + res.status);
  const j = await res.json();
  if (!j || !j.address) return null;
  let clat = lat, clon = lon;
  const bb = Array.isArray(j.boundingbox) ? j.boundingbox.map(Number) : null;
  if (bb && bb.length === 4 && bb.every((n) => Number.isFinite(n))) {
    clat = (bb[0] + bb[1]) / 2;
    clon = (bb[2] + bb[3]) / 2;
  }
  return zoneFromNominatim(j.address, clat, clon, j.address.country);
}

const PROVIDERS = { photon: photonResolve, nominatim: nominatimResolve, mock: mockResolve };

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
  let why = '';
  for (const name of CHAIN) {
    const fn = PROVIDERS[name];
    if (!fn) continue;
    try {
      zone = await fn(lat, lon); // mockResolve is sync; awaiting a plain value is fine
      if (zone) { why = name; break; }
      why = `${name}:empty`;
    } catch (e) {
      why = `${name}:${(e && e.message) || e}`;
    }
  }
  if (!zone) zone = fallbackZone(lat, lon);

  if (DEBUG) {
    console.log(`[geocode] ${lat.toFixed(4)},${lon.toFixed(4)} -> ${zone.name} (${zone.kind}) via ${why || 'fallback'}`);
  }

  // Never cache the coarse fallback: a transient provider outage must not lock a
  // real place to "Uncharted". Only persist a genuinely resolved place.
  if (zone.kind !== 'grid') db.putGeocache(cell, zone);
  return zone;
}

export const _internals = { zoneFromNominatim, zoneFromPhoton, assembleZone, fallbackZone, slug, cacheCell };
