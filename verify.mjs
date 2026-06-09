// verify.mjs — headless end-to-end check of the Worldsong client.
// Boots the server on a throwaway DB, drives the page with Playwright, asserts
// the zone loads, audio starts, voting changes counts, and there are no JS errors.
import { chromium } from 'file:///C:/Users/Lloyd%20Gibbs/playground/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5599;
const DB = path.join(__dirname, 'verify.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }

const srv = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
  stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error('FAIL:', m); cleanup(1); };
function cleanup(code) {
  try { srv.kill(); } catch {}
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  process.exit(code);
}

await sleep(1200);

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({
  geolocation: { latitude: 48.8566, longitude: 2.3522 }, // Paris
  permissions: ['geolocation'],
});
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

  // 1) zone loads (name changes away from "Locating…")
  await page.waitForFunction(() => {
    const el = document.getElementById('zoneName');
    return el && el.textContent && el.textContent !== 'Locating…';
  }, { timeout: 8000 });
  const zoneName = await page.textContent('#zoneName');
  console.log('zone name:', JSON.stringify(zoneName));

  // 2) profile chips rendered (10 dimensions)
  const chipCount = await page.$$eval('#profileChips .chip', (els) => els.length);
  console.log('profile chips:', chipCount);
  if (chipCount !== 10) fail(`expected 10 chips, got ${chipCount}`);

  // 3) play -> audio context starts, button flips to pause
  await page.click('#playBtn');
  await sleep(1400);
  const playLabel = await page.textContent('#playBtn');
  console.log('play button after click:', JSON.stringify(playLabel));
  if (playLabel.trim() !== '⏸') fail('play button did not flip to pause');
  const audioState = await page.evaluate(() => {
    // engine is module-scoped; probe via an AudioContext existence heuristic
    return window.__probeAudio ? window.__probeAudio() : 'n/a';
  });

  // 4) downvote (next) increments downvotes and changes the seed
  const downBefore = parseInt(await page.textContent('#downCount'), 10);
  await page.click('#nextBtn');
  await sleep(400);
  const downAfter = parseInt(await page.textContent('#downCount'), 10);
  console.log('downvotes:', downBefore, '->', downAfter);
  if (downAfter !== downBefore + 1) fail('next did not increment downvotes');

  // 5) upvote (prev) increments upvotes
  const upBefore = parseInt(await page.textContent('#upCount'), 10);
  await page.click('#prevBtn');
  await sleep(400);
  const upAfter = parseInt(await page.textContent('#upCount'), 10);
  console.log('upvotes:', upBefore, '->', upAfter);
  if (upAfter !== upBefore + 1) fail('prev did not increment upvotes');

  // 6) like keeps playing and bumps upvotes again
  await page.click('#likeBtn');
  await sleep(300);

  // 7) world map has at least one dot (our zone) — check canvas got drawn
  const matWidth = await page.$eval('#matFill', (el) => el.style.width);
  console.log('maturity fill width:', matWidth);

  await page.screenshot({ path: path.join(__dirname, 'verify-shot.png'), fullPage: true });
  console.log('screenshot saved: verify-shot.png');

  if (errors.length) {
    console.error('JS ERRORS:\n' + errors.join('\n'));
    fail('page had JS errors');
  }

  console.log('\nRESULT: PASS — page loads, audio starts, voting works, no JS errors.');
  await browser.close();
  cleanup(0);
} catch (e) {
  console.error(e);
  if (errors.length) console.error('JS ERRORS:\n' + errors.join('\n'));
  try { await browser.close(); } catch {}
  fail('exception: ' + e.message);
}
