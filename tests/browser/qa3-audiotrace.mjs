// Phase 10D browser QA #3 — trace who creates/resumes AudioContext pre-gesture.
import { chromium } from 'playwright-core';

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    window.__audioCalls = [];
    const NativeCtor = window.AudioContext;
    const nativeResume = NativeCtor.prototype.resume;
    NativeCtor.prototype.resume = function () {
      window.__audioCalls.push({ op: 'resume', state: this.state, stack: new Error().stack.split('\n').slice(1, 6).join(' | ') });
      return nativeResume.apply(this, arguments);
    };
    window.AudioContext = function (...args) {
      window.__audioCalls.push({ op: 'construct', stack: new Error().stack.split('\n').slice(1, 6).join(' | ') });
      return new NativeCtor(...args);
    };
  });
  await page.goto('http://127.0.0.1:8931/', { waitUntil: 'load' });
  await page.waitForTimeout(6000);
  const calls = await page.evaluate(() => window.__audioCalls);
  console.log('pre-gesture audio calls:', calls.length);
  const ops = {};
  for (const c of calls) ops[c.op] = (ops[c.op] ?? 0) + 1;
  console.log('ops:', JSON.stringify(ops));
  for (const c of calls.slice(0, 4)) console.log(JSON.stringify(c, null, 1));
  await browser.close();
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });
