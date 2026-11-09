// Phase 10D browser QA #5 — sustained live run with a hopping bot:
// visibility handling, frame pacing (real rAF), viewports, canvas evidence.
import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bodyText = (page) => page.locator('body').innerText();

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  const report = {};

  await page.goto('http://127.0.0.1:8931/', { waitUntil: 'load' });
  await sleep(5200);

  // --- In-page hopping bot + rAF sampler (kept alive across the session) ---
  await page.evaluate(() => {
    window.__frames = [];
    window.__samples = 0;
    const sampler = (t) => { window.__frames.push(t); window.__samples += 1; requestAnimationFrame(sampler); };
    requestAnimationFrame(sampler);
    window.__bot = setInterval(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' })), 110 + Math.floor(Math.random() * 220));
    }, 780);
  });
  await page.keyboard.press('Space'); // start the run
  await sleep(3000);

  // Confirm alive before visibility test.
  const alive = (await bodyText(page)).includes('DISTANCE');
  report.botRunAlive = alive;

  // --- Simulated tab hidden while definitely playing ---
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(800);
  report.hiddenShowsPause = (await bodyText(page)).includes('Catch your breath.');
  const pausedDist = await page.evaluate(() => {
    const m = /(\d+)\s*m\b/.exec(document.body.innerText);
    return m ? Number(m[1]) : -1;
  });
  await sleep(1500);
  const stillPausedDist = await page.evaluate(() => {
    const m = /(\d+)\s*m\b/.exec(document.body.innerText);
    return m ? Number(m[1]) : -1;
  });
  report.hiddenFreezesRide = pausedDist === stillPausedDist && pausedDist >= 0;

  // --- Tab visible again: audio resume path, still paused (user resumes) ---
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(800);
  report.afterVisibleNoCrash = (await bodyText(page)).includes('Catch your breath.');
  await page.keyboard.press('Escape'); // resume
  await sleep(800);
  const resumedAlive = (await bodyText(page)).includes('DISTANCE');
  report.resumeAfterHidden = resumedAlive;

  // --- Sustained play: 120s with the bot, frame pacing recorded ---
  await sleep(120000);
  const aliveAfter2min = (await bodyText(page)).includes('DISTANCE') || (await bodyText(page)).includes('THE MOUNTAIN PAUSES');
  report.aliveAfter2Min = aliveAfter2min;

  const pacing = await page.evaluate(() => {
    const f = window.__frames;
    const gaps = [];
    for (let i = 1; i < f.length; i += 1) gaps.push(f[i] - f[i - 1]);
    gaps.sort((a, b) => a - b);
    const pick = (q) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))];
    return { samples: gaps.length, avg: gaps.reduce((a, b) => a + b, 0) / gaps.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: gaps[gaps.length - 1] };
  });
  report.framePacingMs = pacing;

  // JS heap if available.
  report.jsHeapMB = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));

  // Canvas liveness: sample twice 1s apart, expect different pixels.
  const sig = async () => page.evaluate(() => {
    const c = document.querySelector('canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, Math.min(40, c.height)).data;
    let acc = 0;
    for (let i = 0; i < d.length; i += 997) acc = (acc + d[i]) % 1000003;
    return acc;
  });
  const s1 = await sig();
  await sleep(1000);
  const s2 = await sig();
  report.canvasAnimating = s1 !== s2;

  await page.evaluate(() => clearInterval(window.__bot));

  // --- Viewport responsiveness (fresh page per size) ---
  report.viewports = [];
  for (const vp of [{ width: 375, height: 667 }, { width: 812, height: 375 }, { width: 1920, height: 1080 }]) {
    const p = await browser.newPage({ viewport: vp });
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
    await p.goto('http://127.0.0.1:8931/', { waitUntil: 'load' });
    await sleep(3500);
    const info = await p.evaluate(() => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return {
        canvasCss: [Math.round(r.width), Math.round(r.height)],
        backing: [c.width, c.height],
        viewport: [window.innerWidth, window.innerHeight],
        fillsViewport: r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2,
      };
    });
    report.viewports.push({ vp, ...info, errors: errs.length });
    await p.close();
  }

  report.pageErrors = errors;
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });
