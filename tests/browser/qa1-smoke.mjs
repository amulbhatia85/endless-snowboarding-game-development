// Phase 10D browser QA #1 — smoke: load the production build, capture console
// errors/warnings, page errors and unhandled rejections through menu → play.
import { chromium } from 'playwright-core';

const results = { console: [], pageErrors: [], unhandled: [] };

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      results.console.push({ type: message.type(), text: message.text().slice(0, 300) });
    }
  });
  page.on('pageerror', (error) => results.pageErrors.push(String(error).slice(0, 300)));
  page.on('unhandledrejection', (reason) => results.unhandled.push(String(reason).slice(0, 300)));

  await page.goto('http://127.0.0.1:8931/', { waitUntil: 'load' });
  await page.waitForTimeout(6000); // splash + menu settle

  const title = await page.title();
  const canvasCount = await page.locator('canvas').count();
  const bodyText = (await page.locator('body').innerText()).slice(0, 400);
  console.log(JSON.stringify({ title, canvasCount, bodyText }, null, 2));

  // Start a run with the keyboard.
  await page.keyboard.press('Space');
  await page.waitForTimeout(2500);
  const afterStart = (await page.locator('body').innerText()).slice(0, 400);
  console.log('--- after Space ---');
  console.log(afterStart);

  // Let it ride for 8 seconds, tapping jump occasionally.
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.down('Space');
    await page.waitForTimeout(140);
    await page.keyboard.up('Space');
    await page.waitForTimeout(860);
  }
  const duringPlay = (await page.locator('body').innerText()).slice(0, 400);
  console.log('--- during play ---');
  console.log(duringPlay);

  console.log(JSON.stringify(results, null, 2));
  await browser.close();
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });
