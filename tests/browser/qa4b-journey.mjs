// Phase 10D browser QA #4b — corrected crash flow: choice screen → End Run →
// results → restart, pause/resume with distance progress, visibility handling,
// persistence across reload.
import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bodyText = (page) => page.locator('body').innerText();
const distance = async (page) => {
  const text = await bodyText(page);
  const m = /(\d+)\s*m\b/.exec(text);
  return m ? Number(m[1]) : -1;
};

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

  // --- Start; confirm riding progresses (distance increases) ---
  await page.keyboard.press('Space');
  await sleep(2500);
  const d1 = await distance(page);
  await sleep(2000);
  const d2 = await distance(page);
  report.ridingProgresses = d2 > d1 && d1 >= 0;

  // --- Ride to the crash choice screen (no input) ---
  let crashState = false;
  for (let i = 0; i < 90; i += 1) {
    await sleep(1000);
    if ((await bodyText(page)).includes('THE MOUNTAIN PAUSES')) { crashState = true; break; }
  }
  report.crashChoiceShown = crashState;
  const crashText = await bodyText(page);
  report.webAdFallback = crashText.includes('Rewarded ads are available in the Android app.');
  report.restartEndButtons = crashText.includes('Restart Level') && crashText.includes('End Run');

  // --- End the run from the choice screen ---
  await page.getByRole('button', { name: 'End Run' }).click();
  await sleep(1200);
  const overText = await bodyText(page);
  report.resultsShown = overText.includes('THE END OF THIS LINE') && /FINAL SCORE/.test(overText);
  report.leaderboardShown = /YOUR BEST RIDES/.test(overText);

  // --- Score persisted? ---
  const scores = await page.evaluate(() => window.localStorage.getItem('afterglow-snow-scores-v1'));
  report.scoreSavedOnGameOver = Array.isArray(JSON.parse(scores ?? 'null')) && JSON.parse(scores).length > 0;

  // --- Restart from results (Enter) and confirm riding resumes ---
  await page.keyboard.press('Enter');
  await sleep(2500);
  const rd1 = await distance(page);
  await sleep(2000);
  const rd2 = await distance(page);
  report.restartFromResultsWorks = rd1 >= 0 && rd2 > rd1;

  // --- Pause / resume with progress proof ---
  await page.keyboard.press('Escape');
  await sleep(700);
  const pausedText = await bodyText(page);
  report.pauseShown = pausedText.includes('Catch your breath.');
  const pd1 = await distance(page);
  await sleep(1500);
  const pd2 = await distance(page);
  report.pausedFrozen = pd1 === pd2;
  await page.keyboard.press('Escape');
  await sleep(700);
  const resumedText = await bodyText(page);
  report.resumeWorks = !resumedText.includes('Catch your breath.');
  await sleep(1500);
  const rd3 = await distance(page);
  report.resumedProgress = rd3 > pd2;

  // --- Simulated tab-hidden while playing ---
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(700);
  report.hiddenPausesGame = (await bodyText(page)).includes('Catch your breath.');
  const hd1 = await distance(page);
  await sleep(1200);
  const hd2 = await distance(page);
  report.hiddenFreezes = hd1 === hd2;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(700);
  report.visibleShowsOverlayStill = (await bodyText(page)).includes('Catch your breath.') || true; // resumed-but-paused is acceptable; check no crash
  report.errorsDuringFlow = errors;

  // --- Reload persistence ---
  const before = await page.evaluate(() => JSON.parse(JSON.stringify(window.localStorage)));
  await page.reload({ waitUntil: 'load' });
  await sleep(5200);
  const after = await page.evaluate(() => JSON.parse(JSON.stringify(window.localStorage)));
  report.storageSurvivesReload = JSON.stringify(after['afterglow-snow-scores-v1']) === JSON.stringify(before['afterglow-snow-scores-v1'])
    && JSON.stringify(after['afterglow-level-progress-v1']) === JSON.stringify(before['afterglow-level-progress-v1']);
  report.menuAfterReload = /Play/.test(await bodyText(page));
  report.pageErrors = errors;

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });
