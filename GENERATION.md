# Infinite Procedural Level Generation (Phase 9C)

Phase 9C makes the journey genuinely unlimited: **any positive level number** produces a
valid, deterministic, physically achievable level by composing the existing systems —
`LevelManager`, `TerrainGenerator`/`TerrainWorld`, `ObstaclePlanner`, `EnvironmentManager`,
`DifficultyManager` — without duplicating or replacing any of them.

## The recipe

Every level is a pure function of **(level number, journey seed)**:

```
generateLevel(number, journeySeed)
  ├─ identityAt(seed, number)      → environment + terrain profile (identity chain)
  ├─ mixSeed(seed, number)         → level seed (obstacle planning RNG)
  ├─ focusFor(seed, number, theme) → dominant obstacle families (2–4 of the theme list)
  ├─ weather jitter                → theme kind, per-level intensity/speed
  └─ profile label + flavour       → identity name ("Whispering Peaks", …)
```

The journey seed is part of the v1 progress save, so a reload, checkpoint or preview
regenerates the exact same world at any level (asserted in `tests/infinite.test.mjs`).
Levels 1–4 keep their tuned identity byte-for-byte: fixed theme, classic name, **neutral
terrain bias, no focus, legacy weather** — identical terrain to Phase 8.

## The identity chain (variety without randomness at runtime)

Levels ≥ 5 draw their environment and terrain profile from a **seeded chain** that
consults the two previous levels:

- **Environment**: a seeded pick that differs from *both* previous levels — immediate
  repeats and two-level ping-pong are impossible by construction, and there is no fixed
  predictable rotation. Every 12-level window still contains all four themes, and the
  mix stays balanced (each theme ≥ 15 % of any 100-level stretch, asserted).
- **Terrain profile**: a theme-weighted pick (zero-weight combinations never generate —
  e.g. no `technical-slopes` in the countryside, no `mountain-descent` in the forest)
  that never equals the previous level's profile.
- The chain is pure (order-independent, cache-invariant), computed iteratively — no
  recursion at any level number — with a contiguous 512-entry sliding tail per seed, so
  advancing a journey is O(1) and cold-jumping to level 999 999 costs ~0.6 s once.

## Terrain profiles (level identity, spec-faithful)

| Profile | Bias (range / bump / recovery / valley) | Feel |
| --- | --- | --- |
| `flowing-hills` | 0.90 / 0.85 / 1.25 / +0.04 | long flowing hills, generous rest |
| `mountain-descent` | 1.25 / 0.70 / 0.80 / −0.06 | technical mountain descents |
| `gradual-climb` | 0.95 / 0.60 / 1.30 / +0.06 | gradual climbs with recovery |
| `rolling-valleys` | 1.05 / 1.10 / 0.95 / +0.12 | rolling valleys |
| `technical-slopes` | 1.10 / 1.30 / 0.60 / −0.10 | technical, tight, busy |
| `controlled-flats` | 0.55 / 0.35 / 1.45 / +0.02 | controlled flat sections |
| `mixed-terrain` | 1 / 1 / 1 / 0 | balanced mix |

The bias is **statistical** — it scales the anchor range, bump amplitude, recovery
probability and the valley/rolling/ramp split inside `TerrainGenerator`. The hard
guarantees are untouched: the quintic slope cap (`TERRAIN_MAX_SLOPE`), the recovery
anchor resets, chunk continuity and determinism all still hold for every profile
(re-asserted for sampled levels up to 1000).

## Obstacle focus (dominant families)

Each generated level picks **2–4 obstacle families** from its theme (seeded, nudged away
from the previous level's draw). The planner multiplies pattern weights by **1.9** when a
pattern requires a focused family and **0.72** otherwise. Nothing is removed:
availability, min-level gating, physics validation and the safe-approach rules are
unchanged — focus only tilts the dice, so a level *feels* like "the ice-and-snowball
level" while every placement is still individually validated against terrain geometry,
rider speed, jump reach and reaction time. The causal effect is tested (stripping the
focus measurably reduces the hit rate).

## Difficulty

Unchanged in mechanics and still capped: `levelIntensity` saturates at 0.9
(≈ 0.74 by L20, ≈ 0.86 by L61, → 0.9 asymptotically), reaction time never drops below
the 0.95 s planner floor, the terrain scaling (`heightScale`, `progression`) saturates
at 1 (level 256+), and the final 10 % of every level is a forced safe approach. Higher
levels vary *more* (different identities, focuses, weather) rather than *harder without
limit*.

## Weather

The kind stays theme-bound (clear/snow/mist/night — the fold into environment effects is
unchanged); generated levels jitter intensity (×0.55–1.45 of the theme base, capped 0.95)
and speed (×0.8–1.25), so two snowy levels need not feel identical.

## House transitions, checkpoints, saves

Nothing structural changed: every level targets 50 000 points, forces a safe final
approach, ends in the safe house, cross-fades the environment while the rider is inside
(only ever at the house boundary), and the continuous global day/night cycle is
preserved across the switch (asserted for a generated level pair). The save format is
still v1 — the journey seed already in it is the only state needed to regenerate any
level. Previews (`?level=N`, `enterPreview`, the dev bar) write to a throwaway store.

## Developer diagnostics (`?dev=1`)

- **Level # input + Go** — deterministic preview of any level number.
- **ℹ Level** — the full recipe of the current level via `engine.devLevelReport()`:
  number, name, environment, profile + terrain bias, seeds, difficulty
  (tier/progression/levelIntensity), weather, allowed obstacles, focus, available and
  rejected patterns (with reasons), recent patterns and the terrain chunk under the
  rider. `devLevelReport(n)` inspects any level number without leaving the run.

## Testing (`npm run test:infinite`, 17 tests)

- Levels 1–20: validity, determinism, seed dependence, classic prefix byte-integrity.
- Levels 5–104 (three journey seeds): rotation rules, window coverage, balance,
  profile rules/theme weights/anti-repeat, focus rules/variety, weather variation.
- Terrain: determinism, continuity, slope cap and cross-level variety for sampled
  levels 5–1000; measurable profile statistics (flats rest more, technical is rougher).
- Levels 101–1000 (17 samples) and 1001–999 999: validity, determinism, rotation-clean
  triples, cold/warm generation timing, chain order-independence.
- Difficulty: monotonic, capped at 0.9, reaction floor, safe approach at any level.
- Planner: focus dominance (causal, against a focus-stripped control), theme
  containment, no unsupported types at any level.
- Engine: level 61 rides end-to-end inside its theme (2400 frames, ≥ 2 hazard kinds,
  finite rider state, bounded terrain/decoration caches).
- Transition: level 12 → 13 house flow with day-cycle continuity and seamless terrain
  across the origin.
- Persistence: save/reload regenerates identical configs and terrain; preview at level
  500 never touches permanent progress; `devLevelReport` content and determinism.

## Limitations

- The identity chain is O(gap) on a cold jump to a very high level (~0.6 s at 999 999,
  once); sequential advancement and repeats are O(1).
- Focus and profile variety is statistical — a given level can still, by seed, place a
  familiar pattern; the anti-repeat rules guarantee diversity across *levels*, not
  within one.
- Weather jitter affects visuals only (as ever, weather never touches physics).
- The 12-theme-window guarantee holds for the shipped four themes; adding a fifth theme
  would need the window assertion revisited.
