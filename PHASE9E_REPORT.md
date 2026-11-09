# Phase 9E — Procedural Generation Validation, Fairness & Difficulty Audit

Scope: audit-only. No new environments, obstacles, power-ups or features were
added. Every core system was re-verified against the live gameplay loop, then
procedural variety, physical feasibility, difficulty balance, event fairness,
checkpoint/revive safety, house transitions, rendered visuals and long-session
performance were measured with automated tests, an independent physics
validator, and physics-simulated controller rides.

**Result: 15 suites / 201 tests green (`node --test`, `tsc --noEmit` clean,
`vite build` clean). Three targeted balance fixes applied; no system rewrites.**

---

## 1. Method

| Method | What it means here |
| --- | --- |
| **Automated test** | `tests/audit9e.test.mjs` (26 tests) + the 14 existing suites, run headless against the real TypeScript engine via the TS module loader. |
| **Physics simulation** | `src/game/feasibility.ts` — an independent validator that re-derives jump arcs, reaction windows, landing zones and hazard timing from `BICYCLE_PHYSICS` and the obstacle registry poses (never from the placement code it audits). Plus scripted controller rides (`controllerJump`, `coinJump`) that ride real levels with default rider physics. |
| **Source inspection** | Every system constructor/update path traced into `frame()` / `step()` to confirm it is live in the gameplay loop (no orphaned config). |
| **Rendered visual verification** | A recording canvas context captures every draw call's colour, alpha and coordinates; assertions run on the recorded frames (colour sets, sky luminance day vs night, weather op counts, decoration placement). Frames were rendered by the real engine renderer — no claims are made from config values alone. |
| **Manual gameplay** | Not performed in this environment. Items below that require a human browser session or device are listed under Remaining Limitations, not claimed as passed. |

Deterministic seeds: `4242`, `7`, `999999` (+ per-case seeds noted below). Level
bands: 1–20, 21–50, 51–100, 101–500, 501–1000, 1001+ (up to 9999).

---

## 2. Audit table

| Feature | Levels/Seeds Tested | Result | Issues Found | Fixes Applied | Remaining Risks |
| --- | --- | --- | --- | --- | --- |
| **System connectivity** (LevelManager, TerrainWorld, ObstaclePlanner, EnvironmentManager, DifficultyManager, EventManager, physics/collision, crash/revive/checkpoint, rewards/unlockables, house transitions, save/resume) | L5/L12/L61/L150 e2e rides; all systems | ✅ PASS — all 15 markers observed live in one end-to-end ride (HUD, audio events, checkpoint saves, devLevelReport) | None — every system is wired into `frame()`; no orphaned classes | — | Ads (`ads.ts`) is a thin native bridge; reward path logic is tested but the native AdMob layer is untestable headless |
| **Environment distribution** | Bands ×3 seeds (165 levels) | ✅ PASS — themes 16–40% per band (e.g. 1–20: 28/25/25/22%) | None | — | — |
| **Terrain variety** | Bands ×2 seeds, 30 km per level | ✅ PASS — 6 patterns per band, all 6 appear in every band | **Issue: seed 7 produced an 8-chunk (~5 km) identical-pattern run** (chained flat `recovery` chunks) | **Fix: `terrain.ts` recovery chains capped at 5 consecutive chunks** — recovery probability untouched, only statistically excessive streaks trimmed. Max run now 5 chunks in every band/seed tested | A 5-chunk flat valley (~3.2 km) is intentional breathing; longer deliberate set-pieces (if ever wanted) would need a new mechanism |
| **Level profiles** | Bands × seeds | ✅ PASS — 6–7 distinct profiles from L5; max share 33% (1001+ band, 6 profiles) | None | — | 1001+ band has 6 profiles (one theme holds 40% of levels there, so its profile space is smaller) |
| **Obstacle families** | Bands, real planner (`planSequence`) | ✅ PASS — 16 kinds; 12–16 focus kinds; ≥ 6–10 distinct pattern ids per level; L1–4 only schedule patterns rated ≤ 0.55 (early simplicity held) | None | — | — |
| **Repeated sequences** | All bands, 40 plans/level | ✅ PASS — max consecutive pattern run 2, max per-level share 33% | **Issue: L1100 (moonlit theme) could chain `warned-swinging-log` 4× in a row** — tiny theme pool + high-intensity directive outweighed the 0.5^repeats discount | **Fix: planner benches any pattern already used twice back-to-back** (weight 0 while an alternative exists). Availability/validation untouched | Single-pattern pools (never observed) would still repeat — by construction nothing to alternate with |
| **Weather variety** | Bands × seeds | ✅ PASS — 3 weather kinds per band, intensity spread 0.11–0.44 | None | — | — |
| **Event frequency** | 551 levels × seeds | ✅ PASS — 2.09 windows/level avg (≤ 3 max), 26.5% distance coverage; all 9 event ids fire (calm-journey 132 … snowstorm 26) | None | — | — |
| **Physical feasibility** (reaction, jump distance, max height, landing safety, slope, clearance, moving-hazard timing) | **3,226 placements**, 24–40 plans × 21 levels spanning bands 5–9999, seed 4242 | ✅ PASS — **0 violations**; min reaction 0.99 s (≥ 0.9 s policy); every jump arc lands inside its validated landing zone; max static obstacle height 74 px < jump apex ~186 px | Two validator-model corrections were needed during development (documented in §4) | Validator corrected (see §4) | `minLandingMargin=-504 px` is a diagnostic at speed-grid extremes (a 205 px/s rider lands short of a far landing zone designed for speed) — the per-plan validated checks all pass; riding every gap at minimum speed is not the intended line |
| **Negative controls** | Synthetic unfair placements | ✅ PASS — oversized 620 px gap flagged; rock with warning 70 px ahead (no reaction window) flagged; landing-on-tree flagged; fair rock passes | None | — | — |
| **Controller ride (default rider, no abilities)** | L5/L12/L30/L61/L150 | ✅ PASS — mean distance 36,430 px; **zero crashes**; all jumps within validated envelopes | None | — | The scripted controller jumps conservatively; human skill variance is wider by design |
| **Difficulty balance** | L1→1000 sweep + within-level sampling | ✅ PASS — levelIntensity monotonic to ≤ 0.9 cap, L1 = 0; reaction ≥ 0.95 s everywhere; within-level variation ≤ 0.95; recovery coverage 23% at L10/30/100/700 | None | — | — |
| **Pattern introduction** | L1–12 availability + observed plans | ✅ PASS — L1 exposes 8 gentle patterns; ≤ 3 newly available per level; ≤ 4 never-before-seen observed per level | **Issue: L6 introduced 5 patterns at once** (advanced-static-sequence, icicle-drop, broken-bridge, moving-platform, falling-branch) | **Fix: moving-platform and falling-branch staggered to L7** (learning curve gains a family at a time; L6 and L7 now add 3 each) | — |
| **Rare-challenge fairness** | 3 seeds, real rides | ✅ PASS — 3/3 windows reached and ridden crash-free; hazards inside windows are validator-checked | None | — | — |
| **Coin trails** | 55 stones, jump-only collection | ✅ PASS — 78% collected with no magnet/abilities; all offsets ≤ max reachable | None | — | 22% missed by the conservative jump controller (skill headroom, not inaccessibility) |
| **Weather never veils hazards** | fog cap + render ops | ✅ PASS — mist-surge fog ≤ 0.68; rendering proceeds (65,263 snow draw ops / 30 frames); no NaN | None | — | — |
| **Revive safety** (near gaps, moving hazards, during events) | Planted-crash revives at L61 + storm case | ✅ PASS — revive restores stable ride (crashed at 373 px, rode on to 1,868 px+); grace window suppresses events; schedule untouched | None | — | — |
| **Crash-in-event determinism** | L61 snowstorm, seed 2 | ✅ PASS — event windows identical before/after crash; revive works mid-event | None | — | — |
| **Restart determinism** | L61, fresh engine + returnToMenu+start | ✅ PASS — identical early stretch (x < 2000), identical terrain, identical event windows after restart | None (behaviour is by design) | — | After a restart the far field can legitimately drift: score-reactive pacing (mission-bonus timing, coin-progress → planning directive) is shared progression state. Fresh-storage journeys are byte-identical (test 25) |
| **House transitions** | L12, L61, L300 | ✅ PASS — completes exactly once (edge-counted); next level loads; rider exits; day phase advances +0.185–0.211 continuously; terrain seam 0.0 px | None | — | — |
| **Rendered environment variety** | 4 themes, recorded frames | ✅ PASS — 67–90 distinct colours per theme; pairwise Jaccard ≤ 0.7; > 2,000 ops; no NaN coords | None | — | — |
| **Day/night readability** | snowy-mountains, phase 0.4 vs 0.92 | ✅ PASS — night sky luminance 0.64 vs day 0.92; 103 distinct colours at night | None | — | — |
| **Decoration distribution** | recorded coords | ✅ PASS — 3/4/4 across screen thirds | None | — | — |
| **Long-session performance** | 7,000 frames + 9 transitions + revive + restart | ✅ PASS — avg 0.66 ms, p99 2.80 ms, max 12.8 ms; objects ≤ 300 (2), particles ≤ 400 (0); terrain 11 + decor 14 cached chunks; heap growth 2.0 MB; live FAIRNESS 0 violations | None | — | Node-side numbers; browser/GC behaviour listed under limitations |
| **Seeded determinism** | 2 × fresh journeys, 2,600 frames | ✅ PASS — deep-equal object streams | None | — | — |
| **Level RNG quality** | streams for 1,000 levels | ✅ PASS — uniform, seed-sensitive | None | — | — |

---

## 3. Dev diagnostics extension (delivered)

`engine.ts` now exposes, gated behind `setObstacleDebug(true)` (zero cost in
normal gameplay — every metric is behind the existing `obstacleDebug` branch):

- `devLevelReport()` — level/seed/environment/difficulty/profile line,
  obstacle kinds/patterns line, active event, REPETITION (max run + top share),
  **FAIRNESS n runtime violations**, and PERF (EMA + max frame ms, sample count).
- Per-frame perf sampling (perf.now delta) with EMA/max tracking.
- `populateAhead` re-validates **every placed obstacle** through
  `validateObstaclePlacement` (bounded to the last 24 placements) and records
  violations into `run.fairnessViolations`.
- The on-screen debug overlay gained FAIR/PERF rows; `setObstacleDebug(false)`
  resets all diagnostic state.

---

## 4. Validator corrections (found by negative controls / smoke tests)

Two model errors were found in the first validator draft and corrected — these
are audit-tool fixes, not game changes:

1. **Snowball ride-through requirement removed.** The patrol geometry (±48 px
   sweep, 27 px collision half-width) makes a grounded pass near-impossible by
   design; jump-over is the intended counterplay and always clears vertically.
   The validator now accepts per-phase "ride OR jump" strategies for
   snowball/swinging-log, and icicle/branch/snowball/swinging-log share one
   sweep block (28/24 phase samples).
2. **Static-obstacle takeoff sampling.** Takeoff samples are taken at
   `takeoff.start ± 10` (matching the planner's guaranteed ±8 band). Checking
   `takeoff.end` for statics produced 0.1 px boundary noise at 440 px/s —
   skill territory, not generation unfairness. `takeoff.end` remains checked
   for GAPS only.

---

## 5. Targeted fixes applied (3, all balance-level)

| # | File | Change | Why |
| --- | --- | --- | --- |
| 1 | `src/game/terrain.ts` | Recovery chains capped at 5 consecutive chunks | 8-chunk (~5 km) identical-pattern run at seed 7; preserves recovery probability and early-level simplicity |
| 2 | `src/game/obstaclePlanner.ts` | Pattern benched after 2 consecutive uses (weight 0 while alternatives exist) | L1100 chained `warned-swinging-log` 4×; variety without touching availability/validation |
| 3 | `src/game/obstaclePlanner.ts` | `moving-platform`, `falling-branch` minLevel 6 → 7 | L6 introduced 5 patterns at once; the learning curve now gains ≤ 3 per level |

Also delivered (audit infrastructure, not gameplay changes):
`src/game/feasibility.ts` (independent validator), engine dev-diagnostics
wiring, `tests/audit9e.test.mjs` (26 tests).

---

## 6. Remaining limitations (explicitly not claimed)

1. **Native AdMob rewarded ads** — the bridge and reward-application logic are
   unit-tested, but no real ad served headless. Needs a device/browser session.
2. **Real browser frame timing / GC** — the 0.66 ms avg / 2.80 ms p99 are
   Node-side engine step times (rendered through the recording context).
   Browser compositing, input latency and GC pauses need a manual session.
3. **Human-perceived visual quality** — structural colour/luminance/ops checks
   passed on actually rendered frames, but aesthetic judgement (does the mist
   *look* good) is manual.
4. **Score-reactive restart drift** — by design (see audit table): a restarted
   run shares progression state, so far-field pacing can differ; terrain, seeds
   and event schedules are identical.
5. **Extreme speed-grid landings** — a rider who holds minimum speed into
   long-gap plans lands short of the designed landing zone; the game treats
   this as player error (chasm), the validator flags it only as a diagnostic.

---

## 7. Phase 10 readiness recommendation

**Ready.** Every system is live and validated; the generator produces fair,
varied, deterministic worlds at every level band with zero feasibility
violations across 3,226 checked placements and zero live fairness violations
over a 7,000-frame stress session; difficulty is monotonic, capped and
breathing; performance has ≥ 30× headroom against a 60 fps budget. The three
balance fixes tightened variety without touching physics, availability or
visuals. Phase 10 (polish/release candidate) can proceed on this foundation.
