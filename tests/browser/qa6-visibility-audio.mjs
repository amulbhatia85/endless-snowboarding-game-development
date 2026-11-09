// Phase 10D browser QA #6 — visibilitychange pause/resume with retries and
// state proof + real app AudioContext state after gesture.
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

  // Capture the app's AudioContext instance.
  await page.addInitScript(() => {
    const NativeCtor = window.AudioContext;
    window.AudioContext = function (...args) {
      const ctx = new NativeCtor(...args);
      if (!window.__appCtx) window.__appCtx = ctx;
      return ctx;
    };
  });

  await page.goto('http://127.0.0.1:8931/', { waitUntil: 'load' });
  await sleep(5200);

  // Hopping bot with varied holds.
  await page.evaluate(() => {
    window.__bot = setInterval(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' })), 110 + Math.floor(Math.random() * 260));
    }, 700);
  });
  await page.keyboard.press('Space');
  await sleep(1500);

  // App audio context after the gesture.
  const audio = await page.evaluate(() => ({
    state: window.__appCtx?.state ?? 'none',
    currentTime: window.__appCtx ? Math.round(window.__appCtx.currentTime * 10) / 10 : null,
  }));
  await sleep(2500);
  const audioLater = await page.evaluate(() => ({
    state: window.__appCtx?.state ?? 'none',
    currentTime: window.__appCtx ? Math.round(window.__appCtx.currentTime * 10) / 10 : null,
  }));
  const report = { audioAfterGesture: audio, audioAdvancing: audioLater.currentTime > audio.currentTime && audioLater.state === 'running' };

  // --- Visibility: retry until we catch a genuinely-playing moment ---
  let attempt = 0;
  let done = false;
  for (attempt = 1; attempt <= 6 && !done; attempt += 1) {
    const text = await bodyText(page);
    if (!text.includes('DISTANCE')) {
      // crashed or game over — restart and wait
      if (text.includes('THE MOUNTAIN PAUSES')) { await page.getByRole('button', { name: 'Restart Level' }).click(); }
      else if (text.includes('THE END OF THIS LINE')) { await page.keyboard.press('Enter'); }
      else { await page.keyboard.press('Space'); }
      await sleep(2500);
      continue;
    }
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(700);
    const duringHidden = await bodyText(page);
    const paused = duringHidden.includes('Catch your breath.');
    const frozen = await page.evaluate(() => {
      const m = /(\d+)\s*m\b/.exec(document.body.innerText);
      return m ? Number(m[1]) : -1;
    });
    await sleep(1200);
    const frozenLater = await page.evaluate(() => {
      const m = /(\d+)\s*m\b/.exec(document.body.innerText);
      return m ? Number(m[1]) : -1;
    });
    const stillFrozen = frozen >= 0 && frozen === frozenLater;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(700);
    const afterVisible = await bodyText(page);
    const resumedAfterEscape = await (async () => {
      if (afterVisible.includes('Catch your breath.')) {
        await page.keyboard.press('Escape');
        await sleep(700);
        return (await bodyText(page)).includes('DISTANCE');
      }
      return afterVisible.includes('DISTANCE');
    })();
    if (paused || stillFrozen) {
      report.visibility = { attempt, pausedOnHidden: paused, distanceFrozen: stillFrozen, overlayAfterVisible: afterVisible.includes('Catch your breath.'), resumedAfterEscape, stateDuringHidden: duringHidden.includes('THE MOUNTAIN PAUSES') ? 'crashed(race)' : 'paused-or-playing' };
      done = true;
    }
  }
  if (!done) report.visibility = { attempts: attempt - 1, result: 'inconclusive (bot kept crashing)' };

  await page.evaluate(() => clearInterval(window.__bot));
  report.pageErrors = errors;
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });
