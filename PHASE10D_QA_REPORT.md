# Phase 10D — Final QA, Stability & Release Readiness Report

**Date:** 2026-11-07 · **Commit:** `03a4660` · **Suite:** 242/242 automated tests,
`tsc` clean, `vite build` green (489 kB single file).

Test-method legend used throughout: **[A]** automated test (Node),
**[BR]** browser test (real Chromium 153, headless, production build — harness
in `tests/browser/`), **[S]** source inspection, **[SIM]** simulation inside a
browser (synthetic events), **[M]** manual gameplay test, **[D]** real-device
test. No test below is claimed beyond its method.

---

## 1. Full project audit

| Area | Method | Result | Issues found | Fixes applied |
| --- | --- | --- | --- | --- |
| LevelManager / TerrainWorld / ObstaclePlanner / EnvironmentManager / DifficultyManager / EventManager integration | [A] audit9e (26 tests), generation10d (new) | All systems live in the gameplay loop; zero feasibility violations across thousands of placements | None new | — |
| Bicycle physics, crash/revive, checkpoints | [A] recovery, transition, levels, journey10d | Consistent state machines; checkpoints atomic and versioned | None | — |
| Rewards/unlockables | [A] rewards, library | Idempotent banking (watermark), no double-credit paths | None | — |
| House transitions | [A] transition | Door cinematic phases valid across levels/seeds | None | — |
| Audio manager | [A] audio10b + [BR] context-state probes | Unlock/resume lifecycle correct | Pre-gesture autoplay console **warnings** (best-effort studio sting at 420 ms — intended; falls back to first-gesture sting; verified warnings stop after gesture) | None needed (cosmetic, by-design; documented) |
| Rendering/performance | [A] visual10a 11/11, perf10c 17/17 + [BR] frame pacing | Visual parity and budgets hold | Auto-quality EMA was **blind to GPU/compositing pressure** (engine work ~2 ms vs. real p99 33 ms) | **Fixed:** adaptation now also tracks end-to-end rAF gaps (25 ms missed-frame budget; release requires healthy work *and* pacing) + 4 regression tests |
| Save/persistence | [A] levels + [BR] reload | Atomic, versioned, survives reload | None | — |
| Advertising | [S] + [A] recovery + [BR] | Test IDs active, production placeholders inert, interstitials only after finalized runs (never mid-cinematic), revive strictly reward-callback-gated | None | — |
| Dead code / unused config | [S] export scan (158 symbols) | `src/utils/cn.ts` + `clsx` + `tailwind-merge` never used (starter leftovers) | **Removed** (with deps) |
| Inconsistent state management | [S] | None found beyond the above | — | — |

## 2. Complete gameplay journey

New **[A] `tests/journey10d.test.mjs`** runs the canonical journey in one
continuous run — launch → Level 1 → ride with hazard-jumping/coins/flips
(coin sounds, tricks, score growth all asserted) → unprotected crash
(`onCrash` exactly once) → rewarded-ad revive (`game.revive()`) → protection
window verified then expiry verified → 50 000-point target topped up through
the real bonus scoring path → natural house approach → entry → celebration
(fires once) → glowstones banked → press continues to Level 2 → house exit →
new environment → save/reload resumes at Level 2 with wallet intact.
The full L1→L2 journey is also exercised across levels/seeds by
transition/infinite tests. Score-to-target is accelerated via the real bonus
path (labelled honestly); everything after the target is the genuine pipeline.

## 3. Physics and controls

Verified by existing automated suites (levels: tap jump, held backflip,
repeated revives; audit9e: default-rider rides every crash at a validated
hazard) plus **[BR/SIM]**: Space starts/jumps; short taps hop; 700 ms
synthetic touch holds complete without errors; keyboard repeat filtered;
pause clears held state. **[BR]** frame pacing under 20× CPU throttle: no
errors, heap stable. Physics is delta-driven (clamped ≤100 ms, ≤25 ms
sub-steps) so frame-rate variation cannot jump physics.
**Real touch-hardware latency/feel: NOT tested (no device) — remains open.**

## 4. Procedural generation

New **[A] `tests/generation10d.test.mjs`**: milestone levels
1, 2, 3, 4, 10, 25, 50, 100, 500, 1000 × seeds {7, 4242, 999999} — all
generate deterministically (identical regeneration), valid environments
(countryside×11, snowy-mountains×6, misty-mountains×8, moonlit-forest×5),
bounded terrain, zero physics-validator violations, valid checkpoints,
smooth-capped difficulty curve (0 → 0.90, ≤0.128/level, saturating), safe
house approaches. audit9e's broader bands (~105 levels × seeds) cover the
rest of the progression. Claim scope: **validated fair and deterministic at
these samples**, not a proof over all seeds (per the brief).

## 5. Crash, revive, restart

[A] recovery (gating, gap-fatality during protection, revive safety near
gaps/moving hazards, repeated revives, memory) + journey10d (single
`onCrash`, revive → protection → expiry → normal speed) + [BR] qa4b (crash
choice screen → End Run → results → restart; web fallback message when no
rewarded ads). Ad-interruption edge: `finally` blocks restore audio and busy
state; failed ads settle `false` and never grant revival **[S+A]**.

## 6. Rewards and unlockables

[A] rewards/library: coins collected once, balance persists, completion
bonuses, purchase deductions, locked items unequippable, reload cannot
duplicate (watermark). [BR] qa4b: score entry written on game-over,
survives reload. [A] journey10d: wallet survives engine reload.

## 7. Visual and audio QA

Visual: [A] visual10a — 11 scene snapshots structurally validated against the
current renderer; 10C's pixel A/B (≤0.43/255) still stands. [BR] canvas
animates, viewports render correctly. **Human aesthetic judgement: not
claimed.** Audio: [BR] app AudioContext `running` and advancing after
gesture; autoplay warnings cease after gesture; mixing/timing/Music
transitions are structurally covered by audio10b automated tests —
**listened-to-by-a-human: not claimed.** Sun/moon cycle continuity across
levels: [A] atmosphere (phase computed once per frame, shared by
render/audio; continuity asserted).

## 8. Special events

[A] events + audit9e: eligibility, rarity, cooldowns, no overlap, safe
placement, determinism after crash/restart/transition, cleanup.
Visual/audio event effects: structural checks only.

## 9. Performance and memory

**[BR] Real browser (production build, software rendering):** 2-minute live
run — 7,412 rAF samples: **avg 17.18 ms, p50 16.7, p95 16.8, p99 33.4,
max 50.1 ms; JS heap ≈ 10 MB**; canvas liveness confirmed; 20× CPU
throttle survived with zero errors. **[A] Node harness vs. 10C benchmarks**
(same seeds): snowy-day avg 1.94 ms, fills 191.4/frame (−28% vs. pre-10C),
long-session drift eliminated (−1.6%), transition max −38%, heap ≤1.6 MB.
**Moonlit variance investigation (10C follow-up):** 5 identical-code re-runs
gave avg 1.783–1.906 ms (±3.4%) and p99 3.08–3.63 — the 10C "after"
numbers sit inside this band, so the reported moonlit increase was
**measurement variance, not a regression**.

## 10. Mobile and Capacitor readiness

[BR]: viewports 375×667 / 812×375 / 1920×1080 — canvas fills viewport,
backing store correct, zero errors; emulated touch (tap-start, tap-jump,
long-hold) works; simulated visibilitychange pauses and resumes correctly;
localStorage persists across reloads. [S]: safe-area viewport meta, no
browser-only engine assumptions, ad layer split, `CAPACITOR.md` documents
the required native steps. **Android/iOS on real devices: NOT tested —
unverified until actual Capacitor builds exist.**

## 11. Advertisement safety

[S+A+BR]: test IDs active (`testMode: true`, Google sample ids); production
placeholders cannot activate accidentally; interstitials every 3 runs +
90 s minimum, only after `finalizeRun()` (never during cinematics); revive
only after the Rewarded callback; failed ads never freeze gameplay
(settled promises, busy-state guards, audio restored in `finally`);
web build shows a graceful fallback instead of dead buttons.

## 12. Error handling

[A]: corrupt storage/invalid checkpoints ignored with defaults
(levels.test); malformed engine checkpoints rejected while progress is
retained; storage-unavailable fallbacks in App/audio (try/catch, run stays
playable). [BR]: **zero console errors, zero page errors, zero unhandled
rejections across every scenario**, including dev-param pages, throttling,
visibility and touch. Unsupported browsers: engine throws a clear error if
Canvas 2D is unavailable [S].

## 13. Automated regression tests

`node --test tests/*.test.mjs` — **242 pass / 0 fail** (was 235; +1 journey,
+2 generation, +4 auto-quality pacing). New this phase:
`journey10d`, `generation10d`, 4 pacing tests in `perf10c`, plus the
non-suite browser harness under `tests/browser/`.

## 14. Release preparation

- **Dev controls:** `?dev=1`, `?level=N`, `?debugObstacles=1` are now
  honoured only in development builds (engine `devTools` param; App passes
  `import.meta.env.DEV`). **[BR] verified inert in the production bundle.**
  Tools remain in source for development, per the brief.
- **Console errors:** zero in browser QA.
- **Production build:** single-file 489 kB (gzip 150 kB), builds clean.
- **Assets/audio licensing:** no external media at all — everything
  procedural/synthesized (verified: no media files in repo).
- **Save compatibility:** versioned keys with tested backward behaviour.
- **Version info:** `APP_VERSION 1.0.0` now shown in Settings.
- **Error logging:** no telemetry layer (deliberate — no network deps);
  browser console is the channel; verified clean.

---

## 15. Issue classification (all issues found this phase)

| # | Severity | Issue | Status |
| --- | --- | --- | --- |
| 1 | **High** | Developer tools (`?dev`, `?level`, `?debugObstacles`) reachable in the production build | **Fixed + browser-verified** |
| 2 | **Medium** | Auto-quality adaptation measured engine work only — blind to real frame pressure (GPU/compositing) | **Fixed + regression-tested** (rAF-gap signal) |
| 3 | **Low** | Dead starter code (`utils/cn.ts`, `clsx`, `tailwind-merge`) | **Removed** |
| 4 | **Low** | No user-visible version identifier | **Fixed** (Settings footer) |
| 5 | **Low** | Pre-gesture AudioContext autoplay console warnings (intended best-effort sting with graceful fallback) | **Accepted** (cosmetic, browser-emitted) |
| 6 | **Low** | Crash screen has no auto-timeout | **By design** (choice screen; verified) — not a defect |
| 7 | **Info** | Moonlit 10C "regression" | **Resolved: measurement variance** (5-run band) |

## 16. Release decision

### Web browser release: **READY FOR WEB RELEASE**

Evidence: 242/242 automated tests; zero errors across extensive real-Chromium
QA of the production build (load, menu, full run, crash/revive/restart,
pause, visibility, reload persistence, touch emulation, throttling, three
viewports); performance holds 60 fps p50 with 10 MB heap over long sessions;
saves atomic and versioned; ads safe; dev tools gated; single-file offline
build. Remaining web risks are Low (see below) and none block release.

### Android (Capacitor): **NOT READY — UNVERIFIED (by design)**

The code is prepared (lifecycle abstraction, native ad bridge with test
ids, safe-area viewport, `CAPACITOR.md` runbook) but **no Capacitor build
exists and no Android device was tested**. Required before ready: add the
Android platform, build the APK, and run on-device: touch latency,
pause/resume via `appStateChange`, rewarded-ad end-to-end, audio focus,
battery, performance on mid-range hardware (the new frame-pacing
auto-quality signal should then be re-validated on-device).

### iOS (Capacitor): **NOT READY — UNVERIFIED (by design)**

Same as Android plus ATT/consent and signing; explicitly not tested. No
claim of iOS readiness is made from browser testing.

## Remaining risks (all classified)

- **Medium:** auto-quality thresholds (18/10/25 ms, 45/900 frames) are
  harness- and headless-browser-informed; validate on real devices. Real
  touch-hardware input latency untested. Native AdMob flow untested on
  device.
- **Low:** software-rendered headless browser approximates GPU cost
  (real GPUs will differ, usually favourably); aesthetic/audio quality is
  structurally verified only; no crash-report telemetry in production;
  generation fairness is sample-validated, not exhaustively proven.
- **None Critical or High remain open.**

## Recommended next actions

1. Ship the web build (single `dist/index.html`).
2. When native is green-lit: follow `CAPACITOR.md` (platform add, manifest,
   signing), keep test ad ids until explicitly authorized, then run the
   on-device checklist above.
3. Optional polish backlog (non-blocking): quiet the pre-gesture audio
  attempt if console cleanliness matters; add a lightweight opt-in error
  logger; on-device threshold tuning for auto-quality.
