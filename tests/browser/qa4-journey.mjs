// Phase 10D browser QA #4 — crash flow (web ad fallback), restart, pause,
// visibility-change handling, save persistence across reload.
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

  // --- Start and ride without jumping until the crash overlay appears ---
  await page.keyboard.press('Space');
  report.startedAt = Date.now();
  let crashed = false;
  for (let i = 0; i < 90; i += 1) {
    await sleep(1000);
    const text = await bodyText(page);
    if (text.includes('THE MOUNTAIN PAUSES')) { crashed = true; report.crashSeconds = Math.round((Date.now() - report.startedAt) / 100) / 10; break; }
    if (text.includes('THE END OF THIS LINE')) { crashed = true; report.crashSeconds = Math.round((Date.now() - report.startedAt) / 100) / 10; report.skippedCrashOverlay = true; break; }
  }
  report.crashed = crashed;

  const crashText = await bodyText(page);
  report.webAdFallbackShown = crashText.includes('Rewarded ads are available in the Android app.');
  report.crashStatsShown = crashText.includes('SCORE') && crashText.includes('METERS');

  // --- Wait for the game-over results screen ---
  let gameOver = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    const text = await bodyText(page);
    if (text.includes('THE END OF THIS LINE')) { gameOver = true; break; }
  }
  report.gameOverShown = gameOver;
  const overText = await bodyText(page);
  report.finalScoreShown = /FINAL SCORE/.test(overText);
  report.leaderboardShown = /YOUR BEST RIDES/.test(overText);

  // --- Restart via Enter ---
  await page.keyboard.press('Enter');
  await sleep(2000);
  const afterRestart = await bodyText(page);
  report.restartWorks = /LEVEL 1/.test(afterRestart) && !overText.includes('THE END OF THIS LINE');

  // --- Pause / resume ---
  await page.keyboard.press('Escape');
  await sleep(600);
  report.pauseShown = (await bodyText(page)).includes('Catch your breath.');
  await page.keyboard.press('Escape');
  await sleep(600);
  report.resumeWorks = !(await bodyText(page)).includes('Catch your breath.');

  // --- Simulated tab hidden (visibilitychange handler) ---
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(600);
  report.hiddenPauses = (await bodyText(page)).includes('Catch your breath.');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(600);
  const afterVisible = await bodyText(page);
  report.visibleResumes = !afterVisible.includes('Catch your breath.') && /LEVEL 1|DISTANCE/.test(afterVisible);

  // --- Save persistence across reload ---
  const storageBefore = await page.evaluate(() => JSON.parse(JSON.stringify(window.localStorage)));
  report.storageKeysAfterPlay = Object.keys(storageBefore);
  report.scoreEntrySaved = Array.isArray(JSON.parse(storageBefore['afterglow-snow-scores-v1'] ?? 'null'))
    && JSON.parse(storageBefore['afterglow-snow-scores-v1']).length > 0;
  await page.reload({ waitUntil: 'load' });
  await sleep(5200);
  const storageAfter = await page.evaluate(() => JSON.parse(JSON.stringify(window.localStorage)));
  report.storageSurvivesReload = JSON.stringify(storageAfter['afterglow-snow-scores-v1']) === JSON.stringify(storageBefore['afterglow-snow-scores-v1']);
  const menuAfter = await bodyText(page);
  report.menuAfterReload = /Play/.test(menuAfter);

  report.pageErrors = errors;
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });
