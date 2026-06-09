import { chromium } from 'file:///C:/Users/Lloyd%20Gibbs/playground/node_modules/playwright/index.mjs';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ geolocation: { latitude: -37.8136, longitude: 144.9631 }, permissions: ['geolocation'], viewport: { width: 1100, height: 950 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
let status = 'n/a';
try {
  const resp = await p.goto('http://localhost:5577/', { waitUntil: 'networkidle', timeout: 15000 });
  status = resp.status();
} catch (e) { console.log('GOTO ERROR:', e.message); }
console.log('HTTP status:', status);
await p.waitForTimeout(1500);
const zn = await p.textContent('#zoneName').catch(() => '(none)');
const chips = await p.$$eval('#profileChips .chip', (e) => e.length).catch(() => -1);
console.log('zoneName:', JSON.stringify(zn), '| chips:', chips);
console.log('errors:', errs.length ? errs.join(' || ') : 'none');
await p.screenshot({ path: 'live-shot.png', fullPage: true });
console.log('saved live-shot.png');
await b.close();
