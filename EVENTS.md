# Phase 9D — Special Events & Cinematic Moments

Phase 9D adds a scalable, deterministic special-event system on top of the
existing generation pipeline. Events are **bounded windows of world distance**
in which the world leans into a moment — a golden sunset, a snowstorm rolling
over the ridge, a calm scenic stretch, a dense glowstone trail, a chain of
bridges across the pass. No new mechanics, no new weather engine: every event
reweights the existing weather, ambience, coin and obstacle pipelines inside a
smooth envelope that fades in and out over ~450 px.

## Design invariants

- **Deterministic scheduling.** Every window is derived from
  `level.seed ⊕ constant` plus the level's start x. No event state is
  persisted in the run — save/reload and checkpoint revival rebuild the exact
  same schedule from restored run fields (`levelStartX`). Reproduce any
  schedule from the seed shown in `devLevelReport()`.
- **Positional lifecycle.** Entering and leaving the window *is* the whole
  lifecycle. Cleanup is automatic on crash, revival, level transition or game
  over — an event can never survive a level change.
- **Occasional, never overlapping.** 1–3 windows per level, never the same
  event twice in a row, always separated by the event's cooldown (× 0.7–1.3
  jitter) plus a 3.6 kpx floor. Only one window can cover any position.
- **Safe entry and exit.** The envelope ramps smoothly; no event interrupts
  player control; the day/night clock is never touched.

## The nine events

| id | theme | min | rarity | flavour |
|---|---|---|---|---|
| `golden-hour` | any | 3 | 1.1 | warm horizon light + shafts; only near sunrise/sunset, never at night |
| `snowstorm` | snowy-mountains | 5 | 0.9 | heavier snow + wind; fog capped at 0.68 so the trail stays readable |
| `forest-wind` | moonlit-forest, countryside | 4 | 1.0 | gusty wind, ambient leaves recolour toward drifting autumn tones |
| `mist-surge` | misty-mountains | 4 | 1.0 | thicker fog + ground mist (path and nearby obstacles stay visible) |
| `calm-journey` | any | 2 | 1.2 | scenic stretch: hazard planning collapses to recovery, coins keep flowing |
| `coin-trail` | any | 2 | 1.15 | dense terrain-hugging glowstone arcs riding the existing coin cursor |
| `mountain-crossing` | snowy/misty/countryside | 6 (prog ≥ 0.45) | 0.8 | bridge/broken-bridge/moving-platform patterns; 1800 px bridge spacing inside the window |
| `rare-challenge` | any | 8 (prog ≥ 0.55) | 0.55 | dangerous patterns, intensity +0.22, extra recovery padding |
| `falling-hazards` | snowy-mountains, moonlit-forest | 7 (prog ≥ 0.5) | 0.7 | timed icicle drops / falling branches (existing moving hazards only) |

Falling rocks were **deferred** per the phase spec: no falling-rock mechanic
exists, so the event reuses the existing validated falling hazards instead of
introducing untested collision behaviour.

## Integration surfaces

- `src/game/events.ts` (new) — definitions, `EventManager` (bind / update /
  gates / envelope / dev forcing), `scheduleForLevel`.
- `environment.ts` — `EnvironmentUpdateInfo.event` bias: weather targets
  (snow/fog/wind), wind strength, ambient density (same reused pool), ground
  mist, light shafts, warm horizon wash, leaf tint. All numeric — changes fade
  with the envelope and relax automatically when the window ends.
- `obstaclePlanner.ts` — `PlanningContext.hint.prefer`: the first attempt of
  a hinted plan draws from the preferred patterns (weighted); hinted patterns
  get positional retries (200/420/700/1000 px) so hostile terrain does not
  starve the theme; non-preferred plans inside a hinted window schedule their
  successor sooner (still ≥ clearUntil + reaction distance). Validation,
  conflicts and spacing are never relaxed.
- `engine.ts` — binds the manager per level in `frame()`, folds gameplay into
  the pacing directive (calm → recovery 1; crossings/challenges → focus and
  heat; challenges → +320 px danger recovery), coin-trail mode in the coin
  pipeline (longer arcs, offsets ≤ 106 px — well inside jump reach), a soft
  top-centre banner, an `EVENT` debug row, an `EVENTS` section in
  `devLevelReport`, revival grace (no activation for 1500 px after a revive),
  and no events outside `levelPhase === 'riding'` or during the final safe
  approach.
- `audio.ts` — `AudioFrameState.event`: storms and forest gusts push the wind
  loop up, calm journeys and mist pull it back, golden hour warms the ambient
  tone. All gradual (`setTargetAtTime`).
- `App.tsx` — dev bar Event selector (auto / none / each event) beside the
  weather and time previews. In-memory only; saved progress is untouched.

## Dev tools (`?dev=1`)

- **Event selector** — `auto` (deterministic schedule), `none` (suspend all
  events), or an event id to force the next upcoming window to it (appending a
  window at `rider.x + 700` if the schedule is exhausted). Forcing bypasses
  eligibility for preview purposes; `auto` rebuilds the seed-faithful schedule.
- **Debug overlay** — `EVENT <id> <intensity%> · <remaining>px left` plus the
  next upcoming window.
- **`devLevelReport()`** — full window list (position, state, length), the
  active event, and the eligible event pool with rarity weights.

## Tests — `npm run test:events` (23 tests)

Definitions integrity · determinism per (seed, start x) · eligibility across
156 (level, seed) combinations · no-overlap + cooldown invariants · envelope
shape · riding/safe-approach/revival gates · golden-hour celestial gate · dev
control semantics · environment bias with the fog cap · forced snowstorm
activation and positional fade-out (weather relaxes to the level config) ·
golden hour never moving the day clock · calm-journey hazard suppression with
a control run · coin-trail density/reachability/exactly-once rewards ·
mountain-crossing validated bridges · rare-challenge heat + recovery boost ·
per-theme falling hazards · no events during house transitions (fresh schedule
for the next level) · crash → revival grace → same window resumes ·
park/reload reproducing the schedule mid-event · lockstep determinism of two
forced engines (identical objects) · dev forcing/report/stability · bounded
frame overhead with an event running.
