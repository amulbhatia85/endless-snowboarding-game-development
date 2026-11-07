// Phase 10D browser QA #3b — correlate unlock events, audio calls, warnings.
import { chromium } from 'playwright-core';

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    window.__log = [];
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(type, () => window.__log.push({ t: Math.round(performance.now()), ev: type }), true);
    }
    const NativeCtor = window.AudioContext;
    const nativeResume = NativeCtor.prototype.resume;
    NativeCtor.prototype.resume = function () {
      window.__log.push({ t: Math.round(performance.now()), ev: 'ctx.resume(' + this.state + ')' });
      return nativeResume.apply(this, arguments);
    };
    window.AudioContext = function (...args) {
      window.__log.push({ t: Math.round(performance.now()), ev: 'ctx.construct' });
      return new NativeCtor(...args);
    };
  });
  const warnings = [];
  page.on('console', (m) => { if (m.text().includes('AudioContext')) warnings.push(Math.round(Date.now())); });
  await page.goto('http://127.0.0.1:8931/', { waitUntil: 'load' });
  await page.waitForTimeout(5000);
  await page.keyboard.press('Space');
  await page.waitForTimeout(5000);
  for (let i = 0; i < 3; i += 1) { await page.keyboard.down('Space'); await page.waitForTimeout(150); await page.keyboard.up('Space'); await page.waitForTimeout(500); }
  const log = await page.evaluate(() => window.__log);
  console.log('page log:', JSON.stringify(log, null, 0));
  console.log('warnings:', warnings.length);
  await browser.close();
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });
