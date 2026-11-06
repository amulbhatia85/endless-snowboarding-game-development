# OBSTACLES.md — Phase 9A: Expanded Obstacle Library

## Overview

Phase 9A activates the full obstacle registry. All 16 ids are `ready` with
rendering, collision, rules and planner integration; nothing generates that is
not implemented, and nothing implemented is unreachable. Generation still flows
through the single `ObstaclePlanner` → `validateLanding` pipeline with the
`DifficultyManager` pacing directive — no duplicate systems were added.

## The library

| Id | Group | Collision (r × h) | Behaviour |
| --- | --- | --- | --- |
| rock | static | 19 × 23 | jump-over boulder (unchanged) |
| log | static | 29 × 26 | fallen log hop; snow-capped in cold palettes (unchanged visual, theme-driven) |
| tree | static | 17 × 74 | weave/jump tree (unchanged) |
| root | static | 22 × 11 | low ground protrusion; controlled small hop, close takeoff (58 px) |
| fence | static | 13 × 44 | tall wooden section (2- or 3-rail seeded variant); needs real jump clearance |
| gap | terrain | — | validated chasm 50–170 px (unchanged) |
| bridge | terrain | — | rope bridge over a gap (unchanged) |
| cliff | terrain | — | gap variant 106–150 px with sheer strata dressing |
| broken-bridge | terrain | — | gap variant 88–122 px with frayed plank stubs on both lips |
| ramp | terrain | — | launch ramp (unchanged) |
| ice | environmental | — | ground patch 150–260 px; reduced traction (below), never crashes |
| icicle | environmental | 13 × 26 | 4.2 s cycle: hang → shake warning (0.6 s) → fall (0.35 s) → shatter |
| snowball | environmental | 17 × 30 | patrols ±48 px (+16 px downhill bias), rolls along the terrain |
| swinging-log | moving | 34 × 38 | pendulum log (unchanged) |
| moving-platform | moving | — | bridged gap 128–162 px, deck bobs ±5 px (~3.3 s), always supports |
| branch | moving | 26 × 16 | 5 s cycle: hang → shake + drifting-leaf warning (0.7 s) → fall (0.4 s) → land/fade |

## Physical behaviours (nothing is decorative)

- **Roots/fences** are ordinary static colliders: same `checkCollision` path as
  rocks/logs, kind-specific takeoff distances, seeded `variant` drives the
  visual (1–2 humps; 2–3 rails) within the fixed collision box.
- **Ice** hooks the grounded physics only: slope input on speed is amplified
  ×1.35 and the lean follows the terrain through a lagged exponential instead
  of snapping. Deterministic and controllable — patches are only validated onto
  gentle (≤0.16 slope), step-free terrain.
- **Icicles/branches** collide only during the falling phase, and only when the
  leading edge reaches the rider's body envelope. Hanging, warning and
  landed/shattered states are safe to pass. The shake (with drips / drifting
  leaves) is the visible pre-release cue.
- **Snowballs** are pose-driven colliders resting on the terrain wherever the
  patrol carries them; the sweep is a pure `(elapsed, phase)` function with a
  slope-sampled downhill bias.
- **Moving platforms** are `kind: 'gap', bridged: true` with
  `plan.obstacleId: 'moving-platform'`: the deck is the proven bridge lerp plus
  a ±5 px `platformBob` in `rideHeight`, so the platform always supports the
  rider — a gap that cannot eat you.

## Pose functions (pure, deterministic)

`swingingLogPose`, `iciclePose`, `branchPose`, `snowballPose`, `platformBob`
all live in `obstacleRegistry.ts` as functions of `(x,) elapsed, phase` — the
swinging-log precedent. Collision, drawing and the debug overlay all consume
the same poses, so what you see is what hits you.

## Validation

New validators in `terrain.ts` (all feed the existing `LandingValidation`):

- `validateObstacle` widened to `root`/`fence` (takeoff 58/85 px).
- `validateIcePatch` — width 90–280, gentle slopes, no elevation drift.
- `validateFallingHazard` — readable, rideable ±90 px corridor (no forced jump).
- `validateSnowball` — one jump clears the full patrol corridor
  (48 + 16 + 17 = 81 px box) at every validated speed; same profile as the
  swinging log.
- cliff / broken-bridge / moving-platform reuse `validateGap` /
  `validateBridge` envelopes (widths inside the 50–170 validated band).

## Planning

Eleven new patterns join `OBSTACLE_PATTERNS` with ratings fitted to the pacing
bands: `single-root` (L1), `single-fence`/`ice-patch` (L2), `root-pair` (L3),
`snowball-roll` (L5), `fence-then-rock`, `icicle-drop`, `broken-bridge`,
`moving-platform`, `falling-branch` (L6), `cliff-jump` (L7). Timed hazards,
cliff/bridge variants and the platform count as dangerous patterns: they are
never scheduled on the safe final approach and earn danger-recovery spacing.
`conflict()` and the coin/preview/checkpoint/revive kind lists all include the
new kinds. `variant` (seeded 0–1) rides on every placement for visual
variation; collision always matches the visible shape.

## Environment compatibility

- Green Hills: rocks, logs, trees, roots, fences (+ramp/gap/bridge)
- Snowy Mountains: rocks, logs, ice, icicles, snowballs (+gap/ramp/bridge)
- Misty Mountains: rocks, cliffs, bridges, broken bridges, moving platforms
  (+gap/ramp/log)
- Moonlit Forest: trees, rocks, roots, branches, logs, swinging logs (+gap)

Snow-covered logs are the existing theme-driven log rendering (snow stroke in
cold palettes) — a visual variant, not a separate collision type, per spec.

## Developer preview (`?dev=1`)

The dev bar gains an obstacle selector. `startObstaclePreview(id)` restarts
the run in a level whose theme permits the id, with generation collapsed to
that obstacle — but every placement still runs the full planner validation, so
previews only show fair, real placements. Selecting “Obstacle mix…” restores
normal generation. Unknown ids are rejected.

## Determinism note (pre-existing bug fixed)

`nextMission` was drawn from `Math.random()` at engine construction, so two
identical saves could get different missions → different bonuses → different
difficulty directives → drifted hazard placement. It is now seeded from the
level seed on first use (rotation preserved). Cosmetic randomness (stat popup
timing, particle spray) intentionally remains `Math.random()` — it never feeds
generation. Full-engine lockstep equality is covered by
`tests/library.test.mjs`.

## Tests

`tests/library.test.mjs` (17 tests): registry/collision data, pose determinism
and bounds, validator acceptance/rejection, per-environment generation of every
new type, difficulty gating, corridor non-overlap, preview mode, rendering of
every animation state, ice traction (lean lag + snap + speed amplification),
icicle/branch/snowball collision windows, moving-platform support, fence
crash + revive compatibility, and seeded end-to-end determinism. Existing
suites updated where they enumerate kinds (terrain/obstacles/audit/rewards).
**111/111 across the ten suites.**

## Known limitations

- Icicle/branch fairness is timing-based like the swinging log: the warning is
  fully visible and the falling window is narrow (0.35–0.4 s of a 4.2–5 s
  cycle), but a rider arriving inside the falling window cannot dodge — the
  planner spaces these hazards rarely (L6+, low weight, danger recovery).
- The snowball patrol is bounded (±48 px + bias) so one minimum-speed jump can
  clear the whole corridor; larger patrols would be unvalidatable at 205 px/s.
- The moving platform's bob is vertical only; a horizontally-moving platform
  was rejected as unfair/unvalidatable with the current trajectory model.
- Ice amplification (×1.35) and slip-lag rate (4.5) are tuned constants; no
  difficulty scaling is applied to them (weather never changes physics).
