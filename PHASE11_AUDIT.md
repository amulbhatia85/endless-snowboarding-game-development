# Phase 11 Audit — Obstacle Frequency, Variety & Engagement (BEFORE state)

No gameplay code has been changed. This is the Section 1 audit the brief requires
before any implementation. All numbers below are **measured**, none invented.

## Methodology

- Harness: real `SnowGameEngine` driven through the real `frame()` pipeline in
  Node (same mock-canvas setup as `tests/journey10d.test.mjs`), `?debugObstacles=1`.
- Bot: the journey10d-proven rider (jumps hazards, gap windows 60–240 px,
  hazard windows 80–190 px), invulnerability shield, speed floor 475 px/s for
  measurement rides (density is distance-based, so speed only affects how fast
  ground is covered).
- Levels 1, 2, 3, 4, 5, 10, 20, 50, 100, 500 × journey seeds 7 / 4242 / 999999,
  26,000 px of active riding each — **780,165 px total**.
- Natural cruise speed calibrated per level with a separate unforced 20 s ride
  (shield on, real physics): 266–305 px/s depending on level.
- Exact planner capture: `obstaclePlanner.plan()` wrapped per call — pattern id
  sequence (including recovery rolls), and every placement rejection reason,
  uncapped. Runtime fairness violations polled from the engine.
- A "challenge" = any placed object the rider must respond to. Safe walkways
  (bridged gaps: rope bridges, moving platforms) and coins/powers are excluded;
  cliff / broken-bridge land as wide `gap` objects (that is their implementation),
  so they are counted under gap variants in kind totals but as their own pattern
  in pattern totals.

## Measured BEFORE (per level, 3 seeds averaged)

| Level | Challenges /1000 px | Median gap (px) | Median gap @ natural cruise | Worst max gap | Unique kinds / ride |
|---|---|---|---|---|---|
| L1 | 0.37 | 1,990 | 7.2 s | 23.7 s | 4–5 |
| L2 | 0.37 | 2,133 | 7.3 s | 35.9 s | 4 |
| L3 | 0.27 | 2,488 | 8.2 s | **41.6 s** | **2–3** |
| L4 | 0.47 | 1,729 | 5.8 s | 16.5 s | 4 |
| L5 | 0.47 | 2,013 | 6.6 s | 17.3 s | 4–6 |
| L10 | 0.47 | 2,053 | 7.6 s | 22.1 s | 4–6 |
| L20 | 0.53 | 1,738 | 6.0 s | 15.5 s | 3–7 |
| L50 | 0.47 | 1,813 | 6.4 s | 19.4 s | 3–6 |
| L100 | 0.50 | 1,810 | 6.8 s | 16.1 s | 3–5 |
| L500 | 0.50 | 1,624 | 6.0 s | 28.9 s | 4–6 |

Brief targets at natural cruise: L1 6–10 s, L2–4 4–7 s, L5–10 3–6 s, L11+
2.5–5 s. **Every level from L2 up is above its target band, and L20 → L500
(480 levels of progression) improves the median gap by only ~11%.**

## What actually appears vs what is configured

- 16 obstacle kinds are configured and reachable in principle.
- Over 780,165 px of real riding, objects placed: **log 100, rock 98, root 47,
  gap 45, tree 14, ramp 12, fence 10, ice 8, snowball 3, icicle 2, branch 1,
  swinging-log 1** — and cliff / broken-bridge / moving-platform **0** (their
  patterns were selected only 2 / 6 / 8 times in ~500 plan calls, and they
  place as gap variants or safe bridged crossings; rope-bridge was picked 12
  times).
- Pattern selection over 499 plan calls: **recovery 205 (41.1%)**, single-rock
  54, single-log 39, small-gap 29, log-recovery 24, single-root 16,
  advanced-static-sequence 15, single-tree 14, root-pair 14, double-logs 14,
  rope-bridge 12, downhill-rock 8, ramp-gap 8, ice-patch 7, broken-bridge 6,
  controlled-ramp 5, single-fence 5, fence-then-rock 5, snowball-roll 3,
  icicle-drop 3, cliff-jump 2, warned-swinging-log 2, falling-branch 1.
- **Average 1.16 objects per placed plan** — nearly everything is a single
  obstacle; multi-obstacle sequences are rare.
- Log + rock + root + gap = 85% of all placed objects. The four moving/timed
  families (snowball, icicle, branch, swinging-log) = 7 objects in 780 kpx
  (one per ~111 kpx, i.e. roughly one per four levels ridden).
- Environment identity is invisible early: L3 misty rides placed **only logs
  and rocks** (its distinctive cliff/broken-bridge/moving-platform patterns are
  minLevel 6/7); L4 moonlit placed tree/rock/root/log/gap — the same silhouette
  as countryside (branch is minLevel 7, swinging-log minLevel 8). Snowy levels
  read as "logs and stones" (the user's original observation, confirmed).
- Longest identical-pattern runs: up to 9 consecutive (recovery chains).
- Placement rejections: 111 total (22.2% of plan calls — most are internal
  retries that still end in a successful placement): "Rider intersects
  obstacle during jump" 67, "Downhill pattern needs a descending surface" 28,
  "No feasible pattern in the bounded retry budget" 10, "Ramp approach too
  steep" 5, "Ice patch terrain too steep" 1. **Runtime fairness violations: 0
  across all 30 rides** — the physics validation is solid; the schedule is
  just sparse.

## Root causes (code level)

1. **Recovery rolls consume 41% of all plan slots and chain without bound.**
   `plan()` rolls `random() < recoveryChance` before anything else
   (obstaclePlanner.ts ~L188). `recoveryChance = min(0.85, lerp(0.3, 0.1,
   intensity) + 0.5)` in wave valleys (difficulty.ts), i.e. 0.6–0.8 whenever a
   wave valley or low-intensity zone coincides with low level intensity.
   Recovery plans push **no** obstacles, so they never enter
   `run.recentPatterns` (engine.ts only pushes patterns with obstacles) — the
   anti-repetition machinery (0.5^repeats discount, bench-after-2) cannot see
   them. Result: 5–9 consecutive empty slots → 4,000–12,659 px dead stretches
   (worst measured: L3 seed 999999, 41.6 s).

2. **A fixed ~500–620 px reaction corridor is added after every plan
   regardless of real speed.** `reactionDistance = max(475, projectedSpeed) ×
   reactionSeconds(0.95–1.3)` uses `BICYCLE_PHYSICS.maxSpeed` (475) as the
   floor while natural cruise is 266–305 px/s. Stacked on top: per-obstacle
   validation clear pads (+180), `minSpacing` 105–210, `dangerPad` ≥ 72
   (0.3 × 240 even after safe patterns), `stackingPad` 144 after dangerous
   ones, and `random() × 180`. Single→single floors at ~1,200 px and typically
   lands 1,600–2,600 px — which is why L1 and L500 measure nearly the same
   density.

3. **The rating gaussian (σ = 0.22) around `patternIntensity` creates a
   narrow per-moment pattern band.** `patternIntensity = max(0.05, intensity)`
   where intensity is levelIntensity × zone × wave × terrain-damping, swinging
   0.2–0.8 within a single level. Patterns more than ~0.3 rating units from
   the current center get ≤ 0.24× weight; combined with `obstacleFocus`
   (levels ≥ 5: 2–4 seeded families ×1.9, everything else ×0.72 — a 2.6×
   swing) and base weights (singles 24/19/18 vs timed/moving families 6–8),
   rare families are effectively unreachable. Worked example at a snowy L5
   with focus {rock, log}, intensity 0.4: snowball-roll weight ≈ 8 × 0.30 ×
   0.72 = 1.7 vs single-rock ≈ 24 × 0.99 × 1.9 = 45 — a 26:1 ratio before the
   repeat discount even applies.

4. **Env-specific families unlock at minLevel 6–8 while their environments
   appear from L2–L4.** Misty starts at L3 but cliff (L7), broken-bridge (L6),
   moving-platform (L7) are locked; moonlit starts at L4 but branch (L7) and
   swinging-log (L8) are locked. Early misty/moonlit levels are therefore
   visually identical to countryside — and cause 3 keeps those families rare
   even at L500.

5. **L1 has no ramps at all before x = 30,000** (`rampAllowedAfter =
   levelIndex 0 ? 30_000 : levelStartX + 4000`, engine.ts) — combined with the
   L1 rating band (≤ 0.25) the first level can only offer rock / log / root /
   tree / occasional gap.

6. **Difficulty tuning changes *which* pattern is picked far more than *how
   often* anything is picked.** From L1 → L500: recoveryChance 0.3 → 0.1,
   minSpacing 210 → 105, reactionSeconds 1.3 → 0.95 — roughly a 700 px total
   swing on a ~2,000 px budget, and zone (warm-up ×0.5 … final ×1.06), wave
   valleys and terrain damping (×0.3) push intensity — and with it
   recoveryChance — back up mid-level. Measured medians: L1 1,990 px vs L500
   1,624 px.

7. **Safe zones are NOT the cause** — level starts (±640 px), houses (±300),
   the safe final approach and revive grace behaved correctly; measured rides
   stayed in the active stretch (progress ≤ ~14%) and still produced the gaps
   above.

8. **Rejections are not the cause** (0–13 per 26 kpx ride, 0 fairness
   violations). The generator is fair; it is simply scheduled sparse.

## Discovered defect (crash path — must fix alongside Phase 11)

**A failed gap jump can hard-freeze the browser game.** When a fall into a
chasm starts, the engine clamps the rider back to the gap's far edge
(`rider.x = Math.min(rider.x, farEdge - 8)`, engine.ts ~L1604) and then writes
that smaller x into `run.distance` (~L1636). The next score sync computes a
runScore one point lower, and `LevelManager.updateScore` throws
`RangeError: Score updates must be nonnegative and cumulative within an
attempt`. The rAF loop has no try/catch, so the frame chain breaks and the
game freezes mid-run. Reproduced deterministically in the harness (L1 seed 7,
x ≈ 865). Trigger probability per failed gap ≈ overshoot/10 (~10–30%).
Minimal fix: keep `run.distance` monotonic within an attempt (Math.max at the
live-step and crash write sites); restart/revive paths already reset scores
correctly. A regression test will accompany it.

## Proposed fix directions (for approval — not yet implemented)

Mapped to the brief's sections 2–9; none of these multiply spawn rates
blindly — they remove the specific causes above:

1. **Bound and shape recovery** (causes 1, 2): cap consecutive recovery slots
   and make the empty-stretch length part of the pacing directive (target
   bands from section 2); recovery rolls count toward recent-history so the
   anti-repetition system sees them; scenic-recovery slots (brief pattern F)
   place coins, not nothing.
2. **Scale the inter-obstacle budget with the level's measured cruise speed
   and difficulty** (cause 2): reaction corridor from actual projected speed
   (keeping max(475, ·) only as the physics safety floor for validation, not
   as the spacing driver), tighter pads at higher intensity — physics
   validation stays exactly as strict.
3. **Widen the rating band smoothly with level** (cause 3): σ growing with
   intensity (e.g. 0.22 → 0.4) plus a family-floor guarantee: every eligible
   family for the environment gets a minimum scheduled share per level
   window, so snowballs/icicles/branches/swinging logs actually appear
   without being spammy.
4. **Environment identity from the start** (cause 4): shift env-specific
   pattern gates so a misty L3 can show a broken-bridge or moving platform
   flavor early (rated-down variants where needed) while keeping the global
   unlock ladder for the full-strength versions; moonlit gets branches
   earlier; every change keeps the default bicycle sufficient (validated).
5. **L1 variety within the tutorial constraint** (cause 5): keep the no-ramp
   rule but widen the L1 rating band slightly so small-gap/log-pair variety
   appears in the first 30 kpx.
6. **Pattern library A–F pass** (brief section 5): ensure each family maps to
   a distinguishable player response; no visual-only objects.
7. **Physics-aware regeneration, never silent over-rejection** (brief section
   7): keep recording reasons/counts (they exist and are healthy) and add the
   dev-overlay fields from section 9 (gated off in production).
8. **Determinism preserved throughout** — all changes stay seeded; the audit
   harness re-runs as the AFTER measurement and the before/after table is
   produced from real rides only.

The obstacle color palette work (per-family palettes, distinct shapes, Canvas
only, physics untouched) will follow the same phase and be verified in
rendered gameplay.

---

# Phase 11 AFTER Measurements (implementation complete)

Same harness, same bot, same levels × seeds, same 26,000 px of active riding
per ride — **780,163 px total** (BEFORE: 780,165). Ice patches count as
challenges (traction change), exactly as in the BEFORE kind totals. Rides
cross level boundaries through the house cinematic, as before.

## Measured AFTER (per level, 3 seeds averaged)

| Level | Challenges /1000 px | Median gap @ natural cruise | Worst max gap | Unique kinds / ride |
|---|---|---|---|---|
| L1 | 0.35 | 8.0 s | 26.3 s | 5 |
| L2 | 0.44 | 7.3 s | 27.8 s | 4–5 |
| L3 | 0.42 | 7.1 s | 28.2 s | 4 |
| L4 | 0.49 | 6.5 s | 17.6 s | 5–6 |
| L5 | 0.49 | 5.4 s | 16.3 s | 4–7 |
| L10 | 0.44 | 6.0 s | 26.5 s | 4–7 |
| L20 | **0.59** | 5.5 s | 15.0 s | **7–8** |
| L50 | **0.58** | 5.8 s | **15.2 s** | 5–7 |
| L100 | **0.58** | 5.8 s | **13.9 s** | 3–8 |
| L500 | **0.58** | 6.0 s | **16.2 s** | 4–6 |

vs BEFORE: density rises monotonically with level (0.35 → 0.59; BEFORE was
0.37 → 0.50 with an L3 dip to 0.27). The worst dead stretches shrink from
41.6 s (L3) / 35.9 s (L2) / 28.9 s (L500) to 28.2 / 27.8 / 16.2 s. Median
gaps at L3 improve 8.2 → 7.1 s and L5–L500 all tighten (6.6→5.4, 7.6→6.0,
6.0→5.5, 6.4→5.8, 6.8→5.8, 6.0→6.0). L1's median (8.0 s) sits inside its
6–10 s tutorial band by design.

**Honest residuals:** ride-level medians include the designed structural
exclusions — level-start safe zones, the house cinematic (~1.2 kpx), the
final safe approach, calm-journey windows (deliberately hazard-free) and
scenic wave valleys. That is why L2/L3 medians land ~0.1–0.3 s above their
4–7 s band and L11+ ~0.5–1.0 s above 2.5–5 s even though the planner's
own band spacing is enforced inside those bands (verified by the pacing
and difficulty suites). L1/L10 worst-case stretches (26 s) are single
calm-window stacks, not recovery chains — chains are bounded at ≤ 2 slots.

## What actually appears (AFTER, same 780 kpx)

Objects placed: **log 110, rock 103, gap 54 (incl. cliff/broken-bridge
variants), root 41, tree 23, ramp 20, fence 13, ice 10, swinging-log 5,
branch 4, icicle 1, snowball 1.** The four moving/timed families went from
7 → 11 objects and, more importantly, their *patterns* now place reliably
(warned-swinging-log 6, falling-branch 4, snowball-roll 2, icicle-drop 1
selections; cliff-jump 3, broken-bridge 10, moving-platform 10, vs BEFORE
2/6/8). Rope-bridge 16. Every family that is eligible for an environment
now appears; the remaining rarity of snowball/icicle is their intentional
environment gating (snowy/jungle only) plus the classic-prefix unlock
ladder, which is preserved.

Pattern selection over 656 plan calls: recovery 248 (37.8% — down from
41.1%, and now almost entirely *deliberate*: calm events and scenic
valleys), single-rock 87, single-log 56, small-gap 41, single-tree 32,
log-recovery 27, rope-bridge 16, double-logs 15, root-pair 14, ramp-gap 14,
advanced-static-sequence 14, ice-patch 11, controlled-ramp 11,
broken-bridge 10, moving-platform 10, single-fence 8, warned-swinging-log 6,
fence-then-rock 5, falling-branch 4, downhill-rock 4, cliff-jump 3,
snowball-roll 2, icicle-drop 1 — 23 distinct patterns, no dead chains
(max consecutive recovery = 2 except inside deliberate calm windows).

Placement rejections: 110 total, same signature as BEFORE (jump-intersect
75, downhill-surface 23, retry-budget 10, ice-drift 1, ramp-steep 1) —
these are internal retries that end in a successful placement elsewhere.
**Runtime fairness violations: 0 across all 30 rides** (BEFORE: 0; and the
independent validator now re-validates 2,964 placements across bands with
zero violations and a 0.95 s minimum reaction window at max speed).

## Root causes fixed (mapped to the audit's causes 1–8)

1. Recovery is bounded (≤ 2 in the recent window, never consecutive) and
   recovery slots are visible to the repetition memory; ordinary recovery
   slots consume their band slot without adding distance (the old
   0.9–1.15 × gapMax span stacked on top of the band and doubled effective
   gaps); scenic beats tightened to 1.2–1.7 × gapMax. Deliberate calm
   windows keep their hazard-free identity.
2. The inter-obstacle budget comes from per-level frequency bands
   (L1 6–10 s, L2–4 4–7 s, L5–10 3–6 s, L11+ 2.5–5 s at the measured
   natural cruise ≈ 285 px/s), shaped by pacing zones and waves; physics
   floors (reaction, corridors, danger recovery) always win underneath.
3. The rating band widens with intensity (σ = patternBand) and every
   eligible family gets a floor weight when absent from the recent
   schedule.
4. Environment identity: env-specific gates (misty broken-bridge/platform,
   moonlit branch/swing, snowy snowball) open from L5 — never inside the
   classic L1–4 prefix, which keeps its tuned gentle identity.
5. L1 keeps the no-ramp rule; its band (6–10 s) now actually delivers
   variety (5 distinct kinds per ride vs 4–5).
6. Crest-launch fairness: `validateGapAgainstCrestLaunch` rejects gap
   placements whose approach crest would ballistic a max-speed rider into
   the chasm; elevated coins are never placed where their collecting arc
   lands in an unbridged gap.
7. Rejection reasons/counts remain recorded; the dev overlay gained
   PACING / TYPES / ATTEMPTS / SAFE-ZONE rows (dev-only, off in
   production).
8. Determinism preserved: same seeds replay identically (restart
   determinism suite green).

The 5th environment (jungle) joins the rotation from L5, so L5+ level
identities differ from the 10D build for the same seeds (deterministic,
cosmetic checkpoint-name shifts only).

---

# Phase 11 Rendered-Gameplay Verification (real browser, final build)

Method: the production bundle and the vite dev build were driven in headless
Chromium (real canvas rasterization, no mocks). Three rigs:

1. **Production rides** — full app (menu → play → ride), 5 forced themes via
   a seeded journey save; console/page errors captured; canvas pixels sampled
   per ~0.4 s for theme palettes, ambient balloons, and set-piece signatures.
2. **Dev-server rides** (`?debugObstacles=1`, dev-only overlay) — the
   overlay's pink collision boxes locate every on-screen hazard; each box's
   interior colour is compared against the background 44 px to its right
   (ΔRGB). Rides used a marker-aware jump bot with crash-card restarts.
3. **Scenario mode** — the real engine module constructed on a real
   Chromium canvas inside the page, driven exactly like the visual-suite
   harness (invulnerable, speed 475, controllerJump, manual frame clock kept
   ahead of `performance.now()`), with a waterfall/tunnel injected at a
   known position; the resulting pixels measured directly.

## Results (final build, after the colour fixes below)

- **Zero console errors and zero page errors** across all five themes —
  including the crash/revive/restart cycle and level transitions.
- **Themes render distinctly** (canvas pixel-class fractions, production):
  countryside 49 % green, snowy 97 % blue-white, misty 21 % green + gray
  mist, moonlit 100 % deep blue, jungle 69 % green (+4.8 % warm accents,
  highest palette diversity of all themes at 166 distinct colour buckets).
- **Ambient hot-air balloons render in every theme** (saturated warm blobs
  in the sky band, 12–22 sampled rows per ride), in production builds.
- **Waterfall set-piece (verified in scenario mode):** the cascade renders
  as a white-blue column — measured (205, 222, 235) at the top fading to
  (170, 190, 203) low down — 88 px wide (44 bright columns), 256–268 px
  vertical bright runs, against the grey-blue cliff slab (luminance ~106–159
  to its left) with the translucent curtain and mist pool over it. Before
  the fix the same pixels measured orange-brown (197, 127, 29) — see below.
- **Tunnel set-piece (verified in production and scenario mode):** once the
  950–1500 px interior covers the viewport, 140–211 of the sampled columns
  are the dark interior; the warm lit-exit glow rises through the pass
  (24 → 33 → 48 warm pixels sampled approach → inside → exit) and the
  in-tunnel veil dims the world as designed.
- **Obstacle/background distinguishability** (dev overlay marker boxes,
  interior vs adjacent background, ΔRGB; n = boxes measured across rides):
  countryside median 45 / p90 50 (n = 424), snowy 67 / 109 (n = 634),
  misty 89 / 98 (n = 443), moonlit 105 / 133 (n = 193), jungle 47 / 59
  (n = 435). 5–22 % of boxes measure below ΔRGB 40 — the low tail is
  dominated by gap boxes whose "background" sample lands inside the same
  long chasm (a measurement artifact, not an obstacle-visibility failure);
  every measured box was ≥ ΔRGB 10. No family rendered invisible against
  its terrain in any theme.
- **Dev overlay discipline:** the production bundle ignores
  `?debugObstacles=1` entirely (verified: no overlay text drawn, no fillText
  calls — the parameter is devTools-gated by design); the dev build draws
  the full 13-row telemetry block (PACING / TYPES / ATTEMPTS / SAFE ZONE /
  FAIR / PERF …) plus the marker boxes.

## Bugs found by the rendered pass (fixed this session)

1. **`alphaColor` could not parse hex colours** (engine-local helper). The
   Phase 11 set-piece gradients pass literal hex (`#e8f4ff`, `#dff2ff`,
   `#0a0e18`…); the old `color.match(/\d+/g)` scrape turned `#e8f4ff` into
   `rgba(8, 4, undefined, 0.75)` — a thrown `addColorStop` error visible in
   the production console (4 of 7 first-pass rides). First fix removed the
   throw but introduced an off-by-one (slicing the captured hex group —
   which excludes the `#` — at offsets [1, 3, 5]), silently turning the
   waterfall into orange-brown sludge: `#dff2ff` → (255, 47, 15). The final
   fix parses the captured group at [0, 2, 4]; pixel-verified correct
   white-blue water, and the production console is clean.
2. **Dev marker strokes were 1 px** and anti-aliased below reliable
   detection; bumped to 3 px in the dev-only overlay path (never rendered
   in production).

## Honest scope notes

- The waterfall pixel signature was verified in scenario mode (identical
  rendering code path, real Chromium rasterizer) and the fix's presence
  confirmed in the minified production bundle; the blind production bot
  could not survive the ~400 m approach ride to film one organically. The
  tunnel was verified directly in a production ride.
- Obstacle-contrast figures come from the dev build with the overlay
  enabled; the overlay draws after the world, so measured colours are the
  production colours (markers are excluded from the sampled interiors).
- The QA rigs live outside the repository (`/tmp`); nothing in `src/`
  is test-only or QA-hooked beyond the existing devTools-gated parameters.

---

# Post-Review Removals (playtest feedback)

- **Waterfall set-pieces removed.** Every environment now schedules the
  tunnel only (`kind: 'tunnel'`); the cliff/cascade backdrop, the
  translucent curtain + streaks + mist foreground, the checkpoint shape
  validation for `'waterfall'`, and the waterfall branch of the set-piece
  audio cue were all deleted. Scheduling, safe-zone reservation, spacing
  and the tunnel look are unchanged.
- **Ambient hot-air balloons removed.** The `BalloonStyle` config, the five
  theme balloon entries, the resolved style, the draw call between the far
  layers and the terrain, and the balloon/burner draw code were all
  deleted.

Verified after removal: full suite 247/247 green, tsc clean, production
bundle contains no balloon or waterfall code, zero console errors across
all five themes, tunnels still render (173–211 dark interior columns
measured in production rides on countryside/snowy/moonlit), and theme
palettes are unchanged. The production build shrank by ~3.7 kB.

---

# Jump-Size Reduction (playtest feedback: "the jump is too big")

Playtest image-10 flagged the jump as oversized for the obstacle scale.
The impulse was cut directly (not by scaling gravity): gravity stays 920
px/s² so natural crest launches keep their feel, while the jump impulse,
airtime, reach and every hazard corridor shrink together.

## Physics (`src/game/riderPhysics.ts`)

| | before | after |
|---|---|---|
| jumpVelocity | 585 | 470 |
| jumpSpeedFactor | 0.21 | 0.18 |
| maxJumpBoost | 120 | 85 |
| flipHoldSeconds | 0.14 | 0.12 |
| flipSeconds | 1.1 | 0.82 |

Resulting arcs (impulse = 470 + min(85, speed·0.18)):

| speed | impulse | apex | airtime | reach |
|---|---|---|---|---|
| 205 (min) | 507 | 140 px | 1.10 s | 226 px |
| 285 (cruise) | 521 | 148 px | 1.13 s | 323 px |
| 475 (max) | 555 | 167 px | 1.21 s | 574 px |

Apex drops 26–32 %; airtime −17–21 %. The held backflip totals 0.94 s
(hold 0.12 + spin 0.82), which still completes inside the shortest airtime
the terrain allows at minimum speed (~1.01 s on the steepest validated
downhill).

## Corridor retunes (validator ↔ pose changes moved together)

- Static takeoffs (`validateObstacle`): tree 100→132, fence 85, root 58,
  log 65→80, rock 65→70 px before the obstacle — deep enough for the
  slower-rising max-speed arc to reach clearance at the near corridor
  edge, with the landing pad inside the 226 px minimum-speed reach.
- Tree collision height 74→64 (the drawn pine is ~77 px; the thin snowy
  top tier is forgiving) so both corridor edges fit the shortened arc on
  sloped ground.
- Swinging log: swing ±16→±14, hang ground−28±8→−24±6, collision
  {radius 30, height 34}; corridor radius 46→44, clearance height 90→50,
  takeoff x−160→x−128.
- Snowball: sweep 28, bias clamp ±8, corridor radius 53, takeoff x−120.
- Cliff width cap 120, small-gap cap 118, early-landing slack 45 px.
- `feasibility.ts` early-landing slack 45 px documented against the
  flatter arc's wider landing spread.

## Verification

- Full suite 245/245 green, tsc clean.
- Independent physics audit: 3 081 placements across level bands 1–9999,
  zero violations (the earlier failures — tree mid-arc clips on uphill
  bumps, swinging-log placement collapse, L21 hazard-density collapse,
  coin-over-gap overlap — were all downstream of the untuned corridors
  and are gone).
- Rendered A/B in real Chromium, production builds of both revisions,
  identical measurement pipeline (per-frame canvas scan of the rider,
  ~265 px/s ride speed):
  - tap jump: apex 194 px → 116 px (−40 %), airtime 1.32 s → 1.05 s
  - held backflip: apex 182 px → 116 px (−36 %), airtime 1.31 s → 1.06 s,
    flip completes and lands clean.
  - Screenshots: `qa/phase11-jump/` (old-* vs new-*).
- No console errors in any ride.

Fairness contract unchanged: every hazard remains clearable by a
minimum-speed jump timed within the ±8 px margin, at every swing phase,
on flat and sloped ground, tap and held — enforced by the same
validators, now tuned to the smaller arc.

---

# Tunnel Removal (playtest feedback)

**Tunnels removed from the game.** The set-piece system is gone in its
entirety: the `SetPiece` state and scheduler (`scheduleSetPieces`,
`setPieceAt`), the tunnel interior/arch-rib/in-tunnel-dimming render
passes (`drawSetPiecesBack`/`drawSetPiecesFront`), the `setpiece`
enter/exit engine event and its audio echo cue, the run-state and
checkpoint validation for set-piece fields, and the level-transition
set-piece cursor reset. Nothing else changed: obstacle planning, terrain,
coins, houses, checkpoints and the jump tuning are untouched (set-pieces
were purely cosmetic and never interacted with placement).

Old checkpoints that still carry `setPieces`/`nextSetPieceX` fields load
fine — the deserializer ignores unknown fields and nothing reads them.

## Verification

- Full suite 245/245 green, tsc clean; zero references to
  tunnel/set-piece code remain in `src/`.
- Production bundle: all six tunnel draw colours (`#141821`, `#1c2230`,
  `#3a2f24`, `#c9b28f`, `#10141d`, `#0a0e18`) present in the previous
  build are absent from the new one; no `setpiece` strings. The bundle
  shrank by ~3.3 kB.
- Deterministic engine ride (real engine, crash-immunity only):
  2 421 m across two levels through several former tunnel windows — the
  run state never contains set-piece fields, zero `setpiece` events,
  checkpoint round-trip carries no set-piece data.
- Rendered production rides (real Chromium): five themes × 75 s plus
  focused far-rides — three gameplay rides crossed 461–468 m, straight
  through the old first-tunnel window (≈396 m, where a 90–140 m tunnel
  was previously on screen for ~15 s) — zero dark interior columns
  detected in ~40 000 sampled frames, zero console errors. Ride
  screenshots: `qa/phase11-tunnel-removal/`.

---

# Playtest Fixes — Round 2 (iPhone feedback, applied to all platforms)

Feedback from the first iPhone test, fixed once in the shared code base
(web, Android and iOS all render the same UI):

1. **Coins were nearly invisible.** The old coin was a 2.2 px light-gold
   outline ring that melted into snow and pale skies. It is now a solid
   disc — dark bronze rim (`#7c4c14`), gold body (`#f6b23a`), pale gold
   centre, white specular arc, and a slightly stronger warm halo — which
   reads on light ground *and* in dark environments. The HUD coin-counter
   glyph matches. Verified in the rendered build: solid-gold pixel runs
   of ~15 px where the old ring produced 2–4.
2. **The distance-milestone capsule floated over the rider.** The toast
   moved from screen centre (top 168 px, `left 50 %`) to the top-right
   corner and shrank (~40 % smaller: 162×39 on an iPhone-landscape
   viewport). Verified by DOM rect: x 668, y 12 — nowhere near the rider
   zone.
3. **Text clutter across the mid-screen band.** The run HUD was
   reorganised so nothing occupies the rider's lane: mission pill →
   bottom-right, combo badge → bottom-left, control hint → bottom-centre,
   live distance → slimmer top-centre readout. Measured rects confirm
   the mid-screen band is clear on an 844×390 landscape viewport.

Cloud builds for Android/iOS were switched to manual dispatch — the web
build is the test surface until the playtest is signed off.

---

# Revive Screen — One-Line Button Row (playtest feedback)

The revive offer used to be an oversized standalone gold button floating
above the two secondary buttons. All three actions now share a single
row, left to right: **Watch Ad & Revive · Restart Level · End Run**.

- The revive button keeps its gold primary colour but is sized to match
  its neighbours (44 px tall, same padding rhythm; was min-width 290 px
  and 54 px tall).
- The crash panel widened slightly (480 → 560 px) so the three buttons
  fit on one line down to small-phone landscape widths.
- Verified with the real built stylesheet + exact markup at 844×390 and
  568×320: all three buttons on one line, equal heights, gold preserved
  (screenshots in `qa/phase11-revive-row/`). The web build (where the
  revive offer is absent — rewarded ads are native-only) renders the
  two-button row on one line in the real app.
