import { resolveZone } from './geocode.js';
const mem = new Map();
const db = { getGeocache: (c) => mem.get(c) || null, putGeocache: (c, p) => mem.set(c, p) };
const places = [
  ['Sydney CBD', -33.8688, 151.2093],
  ['The Rocks', -33.8599, 151.2090],
  ['Bondi Beach', -33.8915, 151.2767],
  ['Melbourne CBD', -37.8136, 144.9631],
  ['Manhattan Midtown', 40.7549, -73.9840],
];
for (const [name, lat, lon] of places) {
  try {
    const z = await resolveZone(db, lat, lon);
    console.log(`${name.padEnd(20)} -> id=${z.id}\n    name="${z.name}"  label="${z.label}"  kind=${z.kind}`);
  } catch (e) {
    console.log(`${name} -> ERROR ${e.message}`);
  }
}
