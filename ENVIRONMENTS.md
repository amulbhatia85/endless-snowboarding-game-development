# Environments & Weather (Phase 4)

Phase 4 introduced a data-driven environment system. Everything a level *looks* like —
sky palettes, parallax mountain ridges, clouds, weather, ground decorations, ambient
particles — lives in `src/game/environment.ts` and `src/game/weather.ts`, and the game
engine simply delegates drawing to it. Gameplay code (terrain shape, obstacle planning,
collisions, rider physics, scoring) never reads from the environment system, so an
environment can only change how the game looks, never how it plays.

## Architecture

```
LevelManager ──LevelConfiguration──▶ EnvironmentManager ──▶ WeatherSystem
                                     │        │
                                     │        └── DecorationField (per level, seeded)
                                     └── ENVIRONMENTS (data definitions)
SnowGameEngine.frame()  ── env.update(delta, info)   simulation + culling
SnowGameEngine.draw()   ── env.drawSky / drawBackground / drawDecorations / drawAmbient / drawWeather
```

* **`EnvironmentManager`** (`src/game/environment.ts`) owns the active level's look.
  `setLevel(level)` binds it (called on start, restart, menu return and level restore),
  `transitionTo(level, seconds)` starts a timed cross-fade used while the rider glides
  into the next level's safe house.
* **`WeatherSystem`** (`src/game/weather.ts`) is a standalone, reusable particle system
  for snow, rain, fog and wind. It is pooled: particles are recycled, never allocated
  per frame, and active counts are capped.
* **`DecorationField`** generates ground decorations deterministically from the level
  seed in fixed 260 px chunks that are cached and culled.
* **`LevelManager`** maps each level number to a theme (`levelManager.ts`, `THEMES`)
  and exposes it as `LevelConfiguration.environment`. No engine code knows which theme
  a level uses.

### Engine integration (the only touch points)

| Engine call | Purpose |
| --- | --- |
| `env.update(delta, { cameraX, cameraDx, width, height, storm, lighter, groundAt })` | once per frame after terrain maintenance |
| `env.palette(cycle)` / `env.drawSky / drawBackground / drawDecorations / drawAmbient / drawWeather` | once per draw, in that order |
| `env.snowIntensity`, `env.groundSpray`, `env.burstColors` | wheel spray, landing bursts, HUD tint |

The `storm` input only *boosts* weather density during crash combos; `lighter` (the
low-power performance mode) scales particle caps down. Neither touches physics.

## The four environments

| Level | Theme | Look | Weather | Ambient |
| --- | --- | --- | --- | --- |
| 1 | `countryside` (Peaceful Valley) | Green rolling hills, warm sun, soft clouds, morning flock | light wind | floating pollen (9, subtle) |
| 2 | `snowy-mountains` (Snowy Mountains) | Steel-blue ridges with snowcaps, bright snow ground | snow 0.55 + wind 0.3 | — |
| 3 | `misty-mountains` (Misty Mountains) | Layered ridges under heavy fog veils, soft morning light | fog 0.55 + light wind | — |
| 4 | `moonlit-forest` (Moonlight Forest) | Deep blue/purple night, full moon, 84 stars, shooting stars, silhouette treelines | wind + faint fog | glowing fireflies (15, green) |

Each definition (`ENVIRONMENTS` record) contains:

* `stops` — cyclic day-phase palette stops (first == last for a seamless wrap); the
  engine advances the phase with distance so the sky slowly shifts hue during a run.
* `layers` — exactly four parallax ridge styles (`parallax` fraction, `baseY`,
  `amplitude`, `roughness`, `snowcap`, `treeline` density, `color`).
* `fogColor` + `fogVeil[4]` — per-layer fog veils (far → near). Misty Mountains uses
  strong veils to reduce *distant* visibility only; the gameplay strip stays clear.
* `weather` — an ordered list of `{ kind, intensity }` effects (see below).
* `clouds`, `sun`, `moon`, `stars`, `shootingStars`, `flock` — celestial set pieces.
* `decorations` + `decorationColors` — weighted decoration mix and spacing.
* `ambient` — pollen/fireflies (`null` when unused), capped at 24 particles.
* `spray` / `burst` — wheel-snow and landing-burst **colours and rates only**.

### Adding a new environment

1. Add the theme id to `EnvironmentTheme` in `levelManager.ts` and register it in
   `THEMES` (name, obstacle whitelist, weather profile).
2. Write an `EnvironmentDefinition` and register it in the `ENVIRONMENTS` record.
3. Levels 1–4 bind to `THEMES` in order inside `generateLevel()` (`levelManager.ts`);
   deeper levels cycle themes by seed, so a new theme is picked up automatically.

No engine changes are required — that is the point of the system.

## Weather

```ts
const weather = new WeatherSystem();            // default particleCap: 170
weather.configure([{ kind: 'snow', intensity: 0.55 }, { kind: 'wind', intensity: 0.3 }]);
weather.update({ delta, width, height, cameraDx, storm: 0, lighter: false });
weather.drawSnow(context, night);   // night: 0..1 tinting
weather.drawRain(context, wind);    // available, not used by the shipped levels
weather.activeParticles('snow');    // introspection for tests
```

* Kinds: `clear`, `snow`, `rain`, `fog`, `wind`. Intensity is 0..1 per effect.
* Effective particle target = `cap × quality × intensity`, where quality is 0.55 in
  `lighter` mode. Setting intensity to 0 retires existing particles on their next
  update — pools drain to empty instead of drifting forever.
* Fog is rendered as layered veils from the environment definition, not particles.
* Wind gusts modulate snow drift and rain slant; it never modifies rider physics.

**Intensities are configurable per level** through the theme in `levelManager.ts`
(`weather: { kind, intensity, speed }`) and the `weather` list in the environment
definition; the two are merged by the manager.

## Decorations

* **Deterministic**: chunk seed = `level.seed ^ imul(chunkIndex, 0x9e3779b9) ^ 0xdec0a1`.
  The same level seed always produces the same decorations, restart or not.
* **Chunked & culled**: 260 px chunks, generated on demand, cached in a `Map`, and
  only chunks intersecting the camera ± margin are visited. `cachedChunks` is exposed
  for leak checks in tests.
* **Never collide**: decorations are pure visuals. The engine passes a
  `decorationReserved` footprint list (safe houses, ramps, gaps, coins, power-ups) to
  `drawDecorations`; `decorationOverlapsGameplay()` keeps spawns clear of gameplay
  objects. Nothing in the collision path reads decorations.
* **Variety**: each chunk rolls weighted kinds (see `DecorationKind`) with per-item
  scale, flip, sway phase and tint, so scenery repeats without looking stamped.

## Performance

* All particles (weather + ambient + engine bursts) are **pooled and capped**; there
  is no per-frame allocation in the steady state.
* The `lighter` flag (low-power/preferred-performance mode) cuts particle targets to
  ~55 % and simplifies sky gradients.
* Decoration chunks are O(visible) per frame; distant work is skipped entirely.
* Everything renders with plain canvas 2D paths — no images to decode, works on the
  single-file build for web and the Capacitor Android shell alike.

## Testing

```bash
npm run test:environment   # 10 tests — env binding, palettes, blends, weather pools,
                           # decoration determinism/culling/footprints, physics
                           # isolation, level transitions, previews
npm run test:levels        # includes the environment-per-level assertions
npm run test:terrain
npm run test:obstacles
npx tsc --noEmit
```

The environment suite covers: correct theme per level; palette identity at stop times
and seamlessness across the phase wrap; transition blend endpoints/midpoint/retarget;
weather pool retirement at zero intensity and respect for caps; decoration determinism
across restarts, origin/culling behaviour, gameplay-footprint avoidance; the guarantee
that decorations never leak into `run.objects`; physics isolation (two engines, same
seed, one with a full storm — identical rider state after 900 frames); level advance /
restart / preview isolation; and menu return.

> Note: `tests/levels.test.mjs` ("Obstacle generation is seeded independently of
> cosmetics and viewport lookahead") was seed-flaky before Phase 4 — it reset the
> obstacle counters but not `hazardClearUntil`, whose value depends on viewport
> width, and compared beyond the narrower viewport's lookahead. The test now resets
> that field and bounds the comparison by both engines' lookahead; verified stable
> over 30 consecutive runs (previously ~1-in-4 flaky at the base commit).

## Manual preview

The engine accepts `?level=N` (1–4) to jump straight into a level for visual checks:

```
npm run dev -- --host 0.0.0.0     # then open /?level=2, /?level=3, /?level=4
```

## Limitations

* `rain` is implemented in `WeatherSystem` (and unit-tested) but no shipped level
  uses it — it is available for future themes.
* Weather intentionally has **zero** effect on bicycle physics. Any future
  friction/wind/traction gameplay must come from explicit, separately tested
  configuration — not from the weather renderer.
* Reference images for the four themes could not be viewed directly; palettes were
  derived by programmatic colour extraction (dominant/quantised colours) from the
  supplied artwork.
* The Android APK was **not** rebuilt (no Android SDK in this environment); rebuild
  with `npm run build && npx cap sync android` + `gradlew assembleDebug` (see
  `BUILD_APK.md`). The web build in `dist/index.html` is up to date.
