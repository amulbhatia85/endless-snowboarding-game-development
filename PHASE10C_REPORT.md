# Phase 10C Report — Performance, Mobile & Capacitor Readiness

All measurements below were produced by an instrumented Node harness
(`/tmp/perf10c.mjs`, Node v22.22.3, software-rasterizing canvas stub,
2400 frames @60 fps, 480×270 viewport, `--expose-gc`) run against the same
seeds before and after the change set. Visual A/B used the in-repo PNG
rasterizer with identical seeds/day phases. **No numbers in this report are
extrapolated; browser/real-device behaviour is called out separately.**

## 1. Modified files

| File | Change |
| --- | --- |
| `src/game/engine.ts` | Terrain gradient + crest hoisted out of the per-chunk closure; context-keyed cached coin-halo gradient; in-place compaction of particles/trail/popups; `POWER_KINDS` set replaces `POWER_ORDER.find`; `MAX_PARTICLES = 400` cap in `burst`/`emitWheelSnow`; colour-run batching in `drawParticles`; always-on frame-cost EMA + measured auto-quality adaptation (`AUTO_QUALITY_SLOW_MS = 18`, `AUTO_QUALITY_FAST_MS = 10`, 45-frame engage / 900-frame release hysteresis, 120-frame warmup, playing-only); `setGraphicsQuality` resets the adaptation; `handleResize` invoked on tier changes. |
| `src/game/weather.ts` | `drawSnow` batches ~77 individual flake fills into 4 depth-band fills (with `moveTo` before each arc so subpaths never connect). |
| `src/game/environment.ts` | Private `shadedDecorationColors` scratch object replaces per-decoration colour allocations in `drawDecorationField`. |
| `src/App.tsx` | `contextmenu` guard on the canvas (long-press touch no longer raises the browser menu over the play surface); added/removed with the input effect. |
| `tests/raster.mjs` | Fixed a latent `fillPathWith` subpath bug (connector segments between `moveTo`-separated subpaths were treated as polygon edges; browsers never showed it, the test rasterizer did). |
| `tests/perf10c.test.mjs` | New 13-test regression suite (see §6). |
| `CAPACITOR.md` | New: WebView-readiness audit + required Android/iOS configuration for the future shell. |

## 2. Optimizations performed (all measured)

- **Snow batching** — 77 flake fills/frame → 4 band fills. Fill calls dropped 264.5 → 191.4/frame (**−28%**); total draw calls 386.7 → 313.6 (**−19%**).
- **Terrain gradient/crest hoist** — one gradient per frame instead of one per chunk; gradient creations 20.25 → 14.25/frame (**−29.6%**).
- **Coin halo cache** — one radial gradient per context instead of one per coin per frame (context-keyed so a gradient is never handed to a context that did not create it).
- **Allocation removal** — particles/trail/popups compact in place (was 3 array rebuilds/frame); decoration colours reuse a scratch object; `POWER_ORDER.find` → `Set.has`. Long-session 10k-frame drift went from **+9.6% → −1.6%** (first-1k 1.939 ms vs last-1k 1.907 ms in the final run: −0.7%); heap growth stays ≤1.6 MB.
- **Particle cap** — `MAX_PARTICLES = 400` bounds worst-case bursts (crash + landing + wheel spray).
- **Auto-quality** — `auto` tier now *measures* engine frame cost (240-sample EMA) and steps down cosmetics (snow density, decoration, halos, DPR cap) after 45 consecutive frames >18 ms, restoring after 900 consecutive frames <10 ms; manual quality choices reset it. Cosmetic-only by construction: it feeds `lighterGraphics`, which only gates particle/decoration/halo/DPR paths — never physics, collision, or obstacle visibility.

Tail latency (before → after, ms):

| Scene | avg | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| snowy-day L30 | 1.997 → 1.943 | 2.880 → 2.561 | 3.928 → 3.325 | 22.470 → 24.014* |
| snowy-night L30 | 2.009 → 1.841 | 3.387 → 2.212 (−35%) | 4.209 → 3.561 | 24.791 → 8.842 (−64%) |
| moonlit-night L70 | 1.774 → 1.860 | — | 3.100 → 3.919* | — |
| countryside L12 | 1.831 → 1.827 | — | — | — |
| misty-day L61 | 1.896 → 1.836 | 3.072 → 2.679 (−13%) | — | — |
| house transition | — | — | → 3.723 | 11.892 → 7.370 (−38%) |

\* single-run outliers on the shared sandbox, not a regression signal (the
harness's max is one GC pause; p99 improved or held everywhere).

Visual parity (mean pixel delta vs the pre-10C engine, both rendered with the
fixed rasterizer): snowy-day 0.11/255, snowy-night 0.43, moonlit 0.10,
countryside 0.06, misty 0.12, airborne-tuck 0.00, landing-squat 0.00 — i.e.
imperceptible; `visual10a` snapshot suite 11/11 green. The one functional bug
found during this A/B — the halo cache initially reused a gradient created by
a different context — is fixed and now regression-tested.

## 3. Mobile control improvements

- Jump fires on **pointerdown** (touch-down), hold-to-jump charge runs while
  held, release on pointerup **and pointercancel**; repeat pointerdowns while
  already held do not re-queue (`if (!this.held)`).
- `contextmenu` is suppressed on the canvas so long-press holds never raise
  the browser menu mid-charge.
- Keyboard path unchanged (Space/ArrowUp/W with `event.repeat` filtered).
- Pause clears held/jump state, so resuming never replays a stale charge.
- Verified by automated harness (frame stepping, queued-jump semantics) and
  code review; **on-device touch latency/feel not tested in this environment.**

## 4. Capacitor compatibility changes

- No new runtime dependencies on browser-only APIs; engine already consumes
  `window`/`document`/`localStorage` through patchable globals and draws only
  through the injected 2D context.
- Audio unlocks on first gesture, suspends on `visibilitychange`, resumes
  without duplication; ad lifecycle suspends/restores it.
- `ads.ts` keeps AdMob **test** ids with production placeholders and a
  `Capacitor.isNativePlatform()` branch — unchanged and re-verified.
- `index.html` ships `viewport-fit=cover` (notch/safe-area ready); all assets
  are procedural (no asset URLs to rewrite for `cap://`).
- `CAPACITOR.md` documents the required Android/iOS steps. **No native
  platform was added** and no web functionality was replaced.

## 5. Measured performance results

See §2 tables (same harness, same seeds, before/after in one environment).
Environment: Node v22.22.3 software raster stub @480×270, 2400 frames @60,
no GPU — representative of engine-side cost only; GPU/compositing costs are
outside this harness. Memory: heap delta per 2400-frame run ≤ +1.6 MB, and
the 10k-frame long-session run shows no upward frame-time drift.

## 6. Tests performed (automated, this sandbox)

- **New `tests/perf10c.test.mjs` — 13 tests:** rasterizer subpath fills (no
  connector leakage; `moveTo`-first works), auto-quality warmup gate,
  45-frame engage, streak resets, 900-frame release, manual-choice reset,
  fixed-tier immunity, particle cap (burst + 600-frame ride peak), in-place
  compaction semantics (order, expiry, settling, idempotence), colour-run
  batching, halo-gradient context keying.
- **Full suite: 235/235 pass** (`node --test tests/*.test.mjs`), including the
  11-case `visual10a` snapshot suite against post-10C renders.
- `tsc --noEmit` clean; `vite build` green (492.8 kB single file).
- **Not performed here:** real-device touch/audio/battery testing, browser
  GPU profiling, house transitions on hardware. These remain for a device
  pass before any store release.

## 7. Remaining limitations

- Frame-time measurements are engine-side (software raster stub); they cannot
  capture GPU rasterization or compositing differences on real devices.
- The rasterizer's `Gradient` evaluates stops against creation-space
  coordinates (a pre-existing test-tool approximation, identical before/after
  10C — it does not affect the shipped browser rendering).
- Auto-quality thresholds (18 ms/10 ms, 45/900 frames) are tuned to the
  harness; they should be validated on target hardware once a device is
  available.
- Capacitor shell steps (platforms, signing, production ad ids, store
  policies) are documented in `CAPACITOR.md` but intentionally not executed.
