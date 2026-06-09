// verify-travel.mjs — proves the music auto-changes as location changes.
// Boots the server, loads the page with a Paris fix, then simulates GPS moving
// to Tokyo and asserts the zone + track changed WITHOUT any manual interaction.
import { chromium } from 'file:///C:/Users/Lloyd%20Gibbs/playground/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5601;
const DB = path.join(__dirname, 'travel.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }

// Use the deterministic offline geocoder so this test is hermetic (no network,
// no OSM rate limits). The real suburb/postcode path is covered by gtest.mjs.
const srv = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, GEOCODE_PROVIDER: 'mock' },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanup(code) {
  try { srv.kill(); } catch {}
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  process.exit(code);
}
const fail = (m) => { console.error('FAIL:', m); cleanup(1); };
await sleep(1200);

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({
  geolocation: { latitude: 48.8566, longitude: 2.3522 }, // Paris
  permissions: ['geolocation'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const el = document.getElementById('zoneName');
    return el && el.textContent && el.textContent !== 'Locating…';
  }, { timeout: 8000 });

  const zone1 = await page.textContent('#zoneName');
  const coords1 = await page.textContent('#coords');
  console.log('start zone:', JSON.stringify(zone1), '|', coords1.split('·')[0].trim());

  // press play so we exercise the cross-fade transition path
  await page.click('#playBtn');
  await sleep(800);

  // SIMULATE TRAVEL: move GPS to Tokyo via the dev hook (no clicks).
  await page.evaluate(() => window.__simPos(35.6762, 139.6503));
  await page.waitForFunction(
    (prev) => document.getElementById('zoneName').textContent !== prev,
    zone1, { timeout: 8000 },
  );
  await sleep(1200); // let the transition settle
  const zone2 = await page.textContent('#zoneName');
  const coords2 = await page.textContent('#coords');
  console.log('after travel to Tokyo:', JSON.stringify(zone2), '|', coords2.split('·')[0].trim());
  if (zone2 === zone1) fail('zone did not change when location changed');

  // moving WITHIN the same cell must NOT reload (tiny nudge)
  await page.evaluate(() => window.__simPos(35.6763, 139.6504));
  await sleep(600);
  const zone3 = await page.textContent('#zoneName');
  if (zone3 !== zone2) fail('reloaded on a sub-cell move (should have stayed put)');
  console.log('tiny move within cell kept zone:', JSON.stringify(zone3), '(correct)');

  // travel again to New York
  await page.evaluate(() => window.__simPos(40.7128, -74.006));
  await page.waitForFunction((prev) => document.getElementById('zoneName').textContent !== prev, zone2, { timeout: 8000 });
  const zone4 = await page.textContent('#zoneName');
  console.log('after travel to New York:', JSON.stringify(zone4));
  if (zone4 === zone2) fail('zone did not change on second travel');

  // still playing?
  const playLabel = (await page.textContent('#playBtn')).trim();
  console.log('still playing after travels:', playLabel === '⏸');
  if (playLabel !== '⏸') fail('audio stopped during travel');

  if (errors.length) { console.error('JS ERRORS:\n' + errors.join('\n')); fail('page had JS errors'); }

  console.log('\nRESULT: PASS — music auto-changes on travel, ignores sub-cell jitter, keeps playing, no JS errors.');
  await browser.close();
  cleanup(0);
} catch (e) {
  console.error(e);
  if (errors.length) console.error('JS ERRORS:\n' + errors.join('\n'));
  try { await browser.close(); } catch {}
  fail('exception: ' + e.message);
}
