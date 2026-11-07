// Phase 10D browser QA #2 — audio warning timing + dev-param exposure.
import { chromium } from 'playwright-core';

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // --- Part A: audio warning timing relative to first gesture ---
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const events = [];
    const t0 = Date.now();
    page.on('console', (m) => {
      if (m.text().includes('AudioContext')) events.push({ at: Date.now() - t0, type: m.type() });
    });
    await page.goto('http://127.0.0.1:8931/', { waitUntil: 'load' });
    await page.waitForTimeout(5000); // no gesture yet
    const beforeGesture = events.length;
    await page.keyboard.press('Space'); // first gesture
    await page.waitForTimeout(5000); // play with more taps
    for (let i = 0; i < 3; i += 1) { await page.keyboard.down('Space'); await page.waitForTimeout(150); await page.keyboard.up('Space'); await page.waitForTimeout(500); }
    const afterGesture = events.length;
    // Autoplay policy probe: a fresh context after gesture should run.
    const freshState = await page.evaluate(() => { const c = new AudioContext(); const s = c.state; void c.close(); return s; });
    console.log(JSON.stringify({ beforeGesture, afterGesture, freshStateAfterGesture: freshState }));
    await page.close();
  }

  // --- Part B: dev params on the production build ---
  for (const query of ['?dev=1', '?level=5', '?debugObstacles=1']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await page.goto(`http://127.0.0.1:8931/${query}`, { waitUntil: 'load' });
    await page.waitForTimeout(4000);
    const text = await page.locator('body').innerText();
    const hasLevelSelector = /Level\s*(select|chooser|5)/i.test(text) || /DEV/i.test(text);
    // ?level=5 would jump straight into level 5 (HUD shows LEVEL n)
    await page.keyboard.press('Space');
    await page.waitForTimeout(1500);
    const afterStart = await page.locator('body').innerText();
    const hudLevel = /LEVEL\s+(\d+)/.exec(afterStart)?.[1] ?? null;
    console.log(JSON.stringify({ query, hasLevelSelector, hudLevel, pageErrors: errors.length }));
    await page.close();
  }

  await browser.close();
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });
