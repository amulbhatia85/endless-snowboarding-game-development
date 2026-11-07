// Phase 10D browser QA #7 — visibilitychange with tight post-restart timing.
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
  await page.goto('http://127.0.0.1:8931/', { waitUntil: 'load' });
  await sleep(5200);

  // Start, ride to the first crash (deterministic ~5s, no input).
  await page.keyboard.press('Space');
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    if ((await bodyText(page)).includes('THE MOUNTAIN PAUSES')) break;
  }
  await page.getByRole('button', { name: 'Restart Level' }).click();
  await sleep(1500); // inside the safe pre-hazard window

  const before = await bodyText(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(600);
  const during = await bodyText(page);
  const dist1 = /(\d+)\s*m\b/.exec(during)?.[1] ?? null;
  await sleep(1200);
  const during2 = await bodyText(page);
  const dist2 = /(\d+)\s*m\b/.exec(during2)?.[1] ?? null;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(600);
  const after = await bodyText(page);
  await page.keyboard.press('Escape'); // resume if paused overlay is up
  await sleep(900);
  const resumed = await bodyText(page);

  console.log(JSON.stringify({
    beforePlaying: before.includes('DISTANCE'),
    pausedOnHidden: during.includes('Catch your breath.'),
    distanceFrozenWhileHidden: dist1 !== null && dist1 === dist2,
    stillPausedAfterVisible: after.includes('Catch your breath.'),
    resumedAfterEscape: resumed.includes('DISTANCE'),
    pageErrors: errors,
  }, null, 2));
  await browser.close();
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });
