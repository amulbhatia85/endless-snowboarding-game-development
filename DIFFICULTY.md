# Difficulty & Obstacle Pacing (Phase 5)

Phase 5 adds an intelligent difficulty progression and obstacle pacing engine on
top of the existing level, terrain and obstacle systems. It decides **what kind
of challenge belongs at a given moment** — never *where the challenge is
physically legal* (that stays the terrain validators' job) and never *how the
bike handles* (rider physics are untouched).

## Architecture

```
LevelManager ──LevelConfiguration──┐
TerrainWorld.complexity(window) ───┤
run score progress ────────────────┴─▶ DifficultyManager ─▶ DifficultyDirective
                                                                      │
SnowGameEngine.populateAhead ── planner.plan({ directive, recentPatterns })
                                     │
                                     └─▶ ObstaclePlanner: pacing-weighted pattern
                                         selection + physics validation (unchanged)
```

* **`src/game/difficulty.ts`** — `DifficultyManager` and the `DifficultyConfig`.
  A pure, deterministic, viewport-independent function from
  `{level, progress, terrainComplexity}` to a `DifficultyDirective`. No randomness,
  no per-level hardcoding: every number is a named config field.
* **`src/game/obstaclePlanner.ts`** — extended (not duplicated): patterns carry a
  0–1 challenge `rating`; the planner accepts an optional
  `directive` + `recentPatterns` in its `PlanningContext` and uses them for
  selection, spacing and recovery. Without a directive the planner behaves
  exactly as before (legacy callers and tests are unchanged).
* **`src/game/engine.ts`** — `populateAhead` computes one directive per planning
  pass and feeds the planner; tracks the bounded repetition memory on
  `run.recentPatterns` (checkpointed); prunes unseen dangerous hazards during
  the safe final approach; extends the developer debug overlay.

## Between-level progression

`levelIntensity(n) = levelCap · (1 − e^(−(n−1)/levelTau))` — monotonic, 0 at
level 1, saturating at `levelCap = 0.9`:

| Level | 1 | 2 | 3 | 5 | 6 | 10 | 11 | 20 | 21 | 40 | ∞ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Intensity | 0.00 | 0.13 | 0.24 | 0.41 | 0.45 | 0.58 | 0.61 | 0.74 | 0.75 | 0.83 | → 0.90 |

This matches the suggested bands: levels 1–2 beginner, 3–5 moderate, 6–10
advanced with moving hazards (swinging logs unlock at level 8), 11–20 varied
combinations, 21+ controlled expert play. Nothing — speed, density, terrain
amplitude — grows without bound; the legacy terrain `progression` field remains
capped at 1 as before.

## Within-level pacing zones (50 000-point target)

| Progress | Zone | Multiplier |
| --- | --- | --- |
| 0–10k | WARM-UP | 0.50 |
| 10–20k | BUILD-UP | 0.75 |
| 20–30k | MODERATE | 0.90 |
| 30–40k | MAIN CHALLENGE | 1.00 |
| 40–45k | FINAL SEQUENCES | 1.06 |
| 45–50k | SAFE APPROACH | 0.32 |

On top of the zones, **three difficulty waves** run across 0–45k: each ramps
easy → challenging, dips into a recovery valley and holds it, so the journey
reads *easy → moderate → challenging → recovery → …* instead of a monotonic
climb. Wave valleys raise the planner's recovery-chance dramatically, producing
the short recovery sections required throughout the journey.

Terrain complexity (slope + bump amplitude of the next 2 000 px, a fixed window
so generation is viewport-independent) damps obstacle intensity and buys extra
reaction time: rough ground never stacks with dense obstacles.

## The directive

```ts
directive({
  levelIntensity, zone, wave, terrainComplexity,   // inputs & shaping
  intensity,            // final 0..1 obstacle intensity
  patternIntensity,     // target challenge rating for pattern selection
  reactionSeconds,      // ≥ 0.95s, level-scaled (never zone-scaled), terrain-loosened
  recoveryChance,       // chance a planning slot becomes a recovery section
  minSpacing,           // base px between groups, on top of reaction distance
  dangerRecovery,       // extra corridor after dangerous patterns
  safeApproach,         // final approach flag (progress ≥ 0.9)
  nextRecoveryPoints,   // points until the next wave valley (debug overlay)
  riderEnvelope,        // min/max jump reach from BICYCLE_PHYSICS
})
```

## Obstacle scheduling (planner changes)

* **Rating-matched selection**: each pattern has a rating (`single-rock` 0.08 …
  `warned-swinging-log` 0.85). Weight = base weight × Gaussian compatibility
  with `patternIntensity` (σ 0.22, floor 0.12) × `0.5^repeats` repetition
  penalty from the last 8 scheduled patterns. Variety up, repetition down,
  difficulty on target.
* **Spacing**: `nextX = clearUntil + reactionDistance + minSpacing +
  extraRecovery + dangerPad + stackingPad + jitter`, where `reactionDistance =
  max(maxSpeed, projectedSpeed) × reactionSeconds` keeps every gap compatible
  with jump physics; dangerous patterns earn `dangerRecovery` extra room and a
  dangerous pattern following another dangerous landing gets more still.
* **Recovery sections**: `recoveryChance` (legacy flat 17 % when no directive)
  turns a slot into a `recovery` plan — wide open ground.
* **Safe final approach** (`safeApproach`): only single, mild patterns
  (single rock/log/tree, log-recovery, rope bridge, downhill rock) may be
  scheduled; dangerous patterns are filtered out entirely.
* Environment restrictions are untouched: `patternAvailability` still filters
  by the level's `allowedObstacles`, so themes keep their own hazard sets.

## Physics-based validation (unchanged, still mandatory)

Every candidate placement still passes the same `validateGap / validateRamp /
validateBridge / validateObstacle / validateRampGap / validateSwingingLog`
simulations — tap and held-flip modes across the full speed envelope with timing
margins, takeoff/landing corridors, reaction-distance checks and house
reservations. The directive can only choose among *already validated* plans;
infeasible draws are rejected with bounded, inspectable reasons exactly as
before. Moving hazards are validated over their entire swing envelope (every
phase, rotation and ground offset), i.e. over their motion in time, not just
their spawn pose. Rejection and regeneration stay bounded (3 attempts, then a
recovery slot).

## Rider speed management

Bicycle speed limits are untouched: `minSpeed 205 / maxSpeed 475`, the same
rollout, the same slope-driven acceleration. Difficulty comes from pattern
selection, combinations, spacing and reaction budgets — never from speeding the
bike up. The debug overlay shows the jump-reach envelope (≈ 277–691 px) so
spacing stays auditable against physics.

## Safe level completion approach

From 45 k (progress ≥ 0.9):

1. The SAFE APPROACH zone drops intensity to ~0.32 and the planner refuses
   dangerous patterns (no new gaps, ramps, swinging logs or combinations).
2. `populateAhead` retires dangerous hazards that lie **beyond the visible
   screen edge** — obstacles the player has already seen are never yanked away.
3. The existing arrival flow takes over: the safe house gets a reserved,
   obstacle-free corridor, terrain blends flat around it, and all remaining
   objects are cleared at `beginLevelArrival`. The house animation itself is
   Phase 6 — nothing was added there.

## Debug overlay (`?debugObstacles=1`)

The existing developer overlay now leads with the pacing panel:

```
LVL 12 · SNOWY-MOUNTAINS
DIFF 0.55 (lvl 0.86 · zone 0.90 · wave 0.69 · terr 0.94)
ZONE MODERATE (20k–30k pts)
WAVE 2/3 · recovery in ~3.1k pts        (or: RECOVERY ACTIVE / SAFE APPROACH)
PATTERN double-logs · rating 0.55 · spacing 182px
TERRAIN complexity 0.18 · spacing min 143px · jump reach 277–691px
REJECT small-gap @12843: Takeoff slope too steep        (existing, up to 4)
```

Per-obstacle collision boxes, takeoff/landing corridors and pattern/spacing
labels render as before.

## Testing

```bash
npm run test:difficulty    # 10 tests
npm run test:levels && npm run test:terrain && npm run test:obstacles && npm run test:environment
npx tsc --noEmit
```

`tests/difficulty.test.mjs` covers: the saturating level curve (monotonic,
bounded, tier ordering, config validation, custom caps); zone mapping and the
final taper; wave non-monotonicity, held recovery valleys and upcoming-recovery
bookkeeping; directive determinism and terrain damping; safe-approach pattern
refusal across levels/seeds (with a control proving dangerous patterns still
flow pre-45k); rating-targeted selection and repetition suppression
(statistical, seeded); spacing/reaction/danger-budget enforcement; full physics
re-validation of paced sequences across levels 2–40 × seeds × zones; engine
integration (pruning, regeneration, memory bounds, debug panel, control run);
and physics/checkpoint integrity (BICYCLE_PHYSICS deep-equal, 900-frame speed
bounds, checkpoint round-trip of the pacing memory, corruption rejection).

`tests/levels.test.mjs` gained a two-line reset of `run.recentPatterns` in the
viewport-independence test — the pacing memory is scheduling state like
`hazardClearUntil` and must be equalised when comparing generation from a
manually reset state (see the Phase 4 note about `hazardClearUntil`).

## Measured pacing (seed 4242, full 50k journey per level)

| Level | Recovery slots | Dangerous share | Median inter-group gap | Dominant patterns |
| --- | --- | --- | --- | --- |
| 1 | 35 % | 10 % | 1077 px | single-rock, single-log |
| 4 | 36 % | 18 % | 994 px | singles + small-gap |
| 8 | 38 % | 44 % | 975 px | singles, small-gap, double-logs |
| 12 | 36 % | 54 % | 1006 px | mixed + ramp-gap |
| 21 | 34 % | 56 % | 955 px | combinations |
| 40 | 37 % | 63 % | 968 px | combinations (saturating) |

## Limitations

* The legacy `LevelConfiguration.difficulty.progression` (log₂-based) still
  drives terrain bump amplitude as in earlier phases; Phase 5 intensity is the
  DifficultyManager's saturating curve. Both are bounded; they intentionally
  are not merged to avoid regenerating terrain for existing saves.
* `recentPatterns` is capped at 8 entries and checkpointed; old checkpoints
  without the field remain valid (it is optional).
* The debug overlay is canvas-side only (`?debugObstacles=1`); no in-app HUD
  pacing readout was added.
