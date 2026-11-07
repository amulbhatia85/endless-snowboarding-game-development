# Browser QA harness (Phase 10D)

These scripts drove the release QA in a **real Chromium** (153.0.8010.0,
headless, software rendering) against the production single-file build. They
are evidence artifacts, **not** part of `node --test` — they need a local
Chromium binary and `playwright-core` and are run manually.

## Setup

```bash
npm run build                                   # produce dist/
node tests/browser/serve.mjs "$(pwd)/dist" 8931 # serve the build
npm install playwright-core                     # in any folder
CHROME_BIN=/path/to/chromium node tests/browser/qa1-smoke.mjs
```

If Chromium needs shared libraries (as with the `@sparticuz/chromium` build
used during QA), export `LD_LIBRARY_PATH` accordingly first.

## What each script verifies

| Script | Verifies |
| --- | --- |
| `qa1-smoke.mjs` | Page load, menu, Space-start, riding, console errors/page errors/unhandled rejections |
| `qa2-audio-dev.mjs` | Audio autoplay-warning timing vs. first gesture; dev URL parameters (`?dev`, `?level`, `?debugObstacles`) are inert in the production build |
| `qa3-audiotrace.mjs` / `qa3b-correlate.mjs` | Which code path creates/resumes the AudioContext and when |
| `qa4-journey.mjs` / `qa4b-journey.mjs` | Crash choice screen, web rewarded-ad fallback, End Run → results/leaderboard, restart, pause/resume, visibilitychange, save persistence across reload |
| `qa5-alive.mjs` | 2-minute bot-driven run: rAF frame pacing percentiles, JS heap, canvas liveness, viewport responsiveness (375×667, 812×375, 1920×1080) |
| `qa6-visibility-audio.mjs` | App AudioContext state/advancement after gesture; visibility retries |
| `qa7-visibility-tight.mjs` | visibilitychange pause overlay, frozen ride, resume — timed inside the safe post-restart window |
| `qa8-touch-throttle.mjs` | Emulated touch (tap-to-start, tap-to-jump, long-press hold) and 20× CPU-throttled stability |

## Results from the Phase 10D run (2026-11-07)

Zero page errors and zero unhandled rejections in every scenario. Frame
pacing over 7,412 rAF samples during a 2-minute live run: avg 17.18 ms,
p50 16.7 ms, p95 16.8 ms, p99 33.4 ms, max 50.1 ms; JS heap ≈ 10 MB; all
viewports fill correctly; touch input and visibility handling work; the
production build ignores developer URL parameters.
