// Phase 10D browser QA #8 — emulated touch input (tap-to-start, tap-to-jump,
// long-press hold) and CPU-throttled stability.
import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bodyText = (page) => page.locator('body').innerText();

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // ── Emulated touch (Playwright touchscreen, mobile viewport) ──────────────
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  const report = { touch: {}, throttle: {} };

  await page.goto('http://127.0.0.1:8931/', { waitUntil: 'load' });
  await sleep(5200);

  // Tap the Play button.
  const play = page.getByRole('button', { name: /Play/i }).first();
  await play.tap();
  await sleep(2000);
  report.touch.startedByTap = (await bodyText(page)).includes('DISTANCE');

  // Tap the canvas to jump (pointerdown → press immediately).
  const before = await page.evaluate(() => {
    const m = /(\d+)\s*m\b/.exec(document.body.innerText);
    return m ? Number(m[1]) : -1;
  });
  await page.touchscreen.tap(195, 500);
  await sleep(400);
  await page.touchscreen.tap(195, 500);
  await sleep(1600);
  const after = await page.evaluate(() => {
    const m = /(\d+)\s*m\b/.exec(document.body.innerText);
    return m ? Number(m[1]) : -1;
  });
  report.touch.tapJumpsKeepRunAlive = after > before && before >= 0;

  // Long-press hold on the canvas (synthetic pointer events, touch type).
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const down = new PointerEvent('pointerdown', { pointerType: 'touch', button: 0, bubbles: true });
    canvas.dispatchEvent(down);
    setTimeout(() => canvas.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true })), 700);
  });
  await sleep(1500);
  report.touch.longPressNoErrors = errors.length === 0;
  report.touch.stillRunningAfterHold = /DISTANCE|THE MOUNTAIN PAUSES/.test(await bodyText(page));
  report.touch.errors = errors;
  await context.close();

  // ── CPU-throttled stability (20× — frames miss vsync badly) ──────────────
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors2 = [];
  page2.on('pageerror', (e) => errors2.push(String(e).slice(0, 200)));
  await page2.goto('http://127.0.0.1:8931/', { waitUntil: 'load' });
  await sleep(5200);
  const cdp = await page2.context().newCDPSession(page2);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  await page2.keyboard.press('Space');
  await sleep(10000); // ~10 s of heavily throttled riding
  const text = await bodyText(page2);
  report.throttle.survivesThrottle = /DISTANCE|THE MOUNTAIN PAUSES|THE END OF THIS LINE/.test(text);
  report.throttle.errors = errors2;
  const heap = await page2.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
  report.throttle.jsHeapMB = heap;
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page2.close();

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });
