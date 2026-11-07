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
