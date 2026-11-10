import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 9D — deterministic special events: definitions, scheduling,
// envelopes, gates, engine integration (weather bias, gameplay folding,
// coin trails, crossings, dev tools, revival, transitions, determinism).

const { generateLevel, LEVEL_SAVE_KEY, LEVEL_TARGET_SCORE } = await import(moduleUrl('src/game/levelManager.ts'));
const { OBSTACLE_PATTERNS, patternRating, validPlacementMetadata } = await import(moduleUrl('src/game/obstaclePlanner.ts'));
const {
  EVENT_DEFINITIONS, EventManager, scheduleForLevel, eventDefinition, EVENT_IDS,
} = await import(moduleUrl('src/game/events.ts'));
const { EnvironmentManager } = await import(moduleUrl('src/game/environment.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

const THEMES = ['countryside', 'snowy-mountains', 'misty-mountains', 'moonlit-forest'];
const HAZARD_KINDS = ['rock', 'log', 'tree', 'gap', 'ramp', 'swinging-log', 'root', 'fence', 'ice', 'icicle', 'snowball', 'branch', 'cliff', 'broken-bridge', 'moving-platform', 'bridge'];
const SUNSET_GATE = { riding: true, safeApproach: false, reviveGraceX: -1e9, phase: 0.66, night: 0.15 };

// ───────────────────────── harness ─────────────────────────

function storage(values = new Map()) {
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, values };
}

function seedSave(journeySeed, currentLevel) {
  const save = storage();
  save.setItem(LEVEL_SAVE_KEY, JSON.stringify({
    version: 1, journeySeed, currentLevel, unlockedThrough: currentLevel,
    completedThrough: currentLevel - 1, levelScore: 0, runScore: 0, lifetimeScore: 0, checkpoint: null,
  }));
  return save;
}

function recorderContext() {
  let operations = 0;
  const gradient = { addColorStop() {} };
  const record = () => { operations += 1; };
  const context = {
    canvas: null,
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', font: '10px system-ui', textAlign: 'left', textBaseline: 'alphabetic',
    shadowColor: 'transparent', shadowBlur: 0,
    setTransform: record, clearRect: record, fillRect: record, strokeRect: record,
    createLinearGradient: () => { operations += 1; return gradient; },
    createRadialGradient: () => { operations += 1; return gradient; },
    save: record, restore: record, translate: record, rotate: record, scale: record,
    beginPath: record, closePath: record, moveTo: record, lineTo: record,
    quadraticCurveTo: record, bezierCurveTo: record,
    arc: record, ellipse: record, fill: record, stroke: record,
    fillText: record, strokeText: record, drawImage: record,
  };
  return { context, get operations() { return operations; } };
}

function makeEngine({ save = storage() } = {}) {
  globalThis.localStorage = save;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    location: { search: '' },
  };
  globalThis.document = {
    createElement: () => {
      const inner = recorderContext();
      return { width: 192, height: 192, getContext: () => inner.context };
    },
  };
  const recorder = recorderContext();
  const sounds = [];
  const game = new SnowGameEngine({
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    getContext: () => recorder.context,
  }, {
    onStatus() {}, onHud() {}, onGameOver() {}, onCrash() {},
    onSound: (event) => { sounds.push(event.type); },
  });
  return { game, recorder, save, sounds };
}

/** Queues a jump when an unbridged chasm is coming up (keeps test riders alive). */
function autoJump(game) {
  const run = game.run;
  if (!run.rider.grounded) return;
  const danger = run.objects.find((object) => object.kind === 'gap' && !object.bridged
    && object.x > run.rider.x + 60 && object.x < run.rider.x + 260);
  if (danger) game.jumpQueued = true;
}

/** Drives the real frame loop (physics + events + environment + draw). */
function ride(game, frames, { speed = 475, invulnerable = true, invulSeconds = 10, collect = null, neutralizeDouble = false } = {}) {
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 5);
  let time = game.__rideTime ?? 0;
  for (let index = 0; index < frames; index += 1) {
    if (invulnerable) run.invulnerableUntil = run.elapsed + invulSeconds;
    if (collect) run.magnetUntil = run.elapsed + 10;
    if (neutralizeDouble) run.doubleUntil = 0; // keep the 1:1 coin/reward audit exact
    run.rider.speed = speed;
    autoJump(game);
    time += 1000 / 60;
    game.__rideTime = time;
    game.frame(time);
  }
  return run;
}

/** Rides until `predicate` holds (returns frames used, or -1). */
function rideUntil(game, predicate, { maxFrames = 5000, speed = 475, invulSeconds = 10 } = {}) {
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 5);
  let time = game.__rideTime ?? 0;
  for (let index = 0; index < maxFrames; index += 1) {
    if (predicate()) return index;
    run.invulnerableUntil = run.elapsed + invulSeconds;
    run.rider.speed = speed;
    autoJump(game);
    time += 1000 / 60;
    game.__rideTime = time;
    game.frame(time);
  }
  return -1;
}

/** Phase 11 — rides like ride() but records the planned pattern sequence
 * from lastPlanInfo (which updates on every successful plan). The repetition
 * memory's cap makes recentPatterns slices roll over mid-ride, so this is the
 * faithful record of what the planner actually scheduled. */
function rideCollecting(game, frames, { speed = 475, invulSeconds = 10 } = {}) {
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 5);
  let time = game.__rideTime ?? 0;
  const planned = [];
  let lastStamp = null;
  for (let index = 0; index < frames; index += 1) {
    run.invulnerableUntil = run.elapsed + invulSeconds;
    run.rider.speed = speed;
    autoJump(game);
    time += 1000 / 60;
    game.__rideTime = time;
    game.frame(time);
    const info = game.lastPlanInfo;
    const stamp = info ? `${info.patternId}@${Math.round(info.spacing)}` : null;
    if (stamp && stamp !== lastStamp) {
      planned.push(info.patternId);
      lastStamp = stamp;
    }
  }
  return planned;
}

function seedForEnvironment(number, theme) {
  for (let seed = 1; seed < 500; seed += 1) {
    if (generateLevel(number, seed).environment === theme) return seed;
  }
  throw new Error(`no seed found for ${theme} at level ${number}`);
}

const activeWindow = (game) => {
  const report = game.events.report();
  const x = game.run.rider.x;
  return report.windows.find((window) => x >= window.startX - 60 && x <= window.endX + 60) ?? null;
};

// ───────────────────────── definitions ─────────────────────────

test('Event definitions are well formed with unique ids and valid references', () => {
  assert.equal(new Set(EVENT_DEFINITIONS.map((definition) => definition.id)).size, EVENT_DEFINITIONS.length);
  assert.equal(EVENT_IDS.length, 9, 'nine Phase 9D events');
  const patternIds = new Set(OBSTACLE_PATTERNS.map((pattern) => pattern.id));
  for (const definition of EVENT_DEFINITIONS) {
    assert.ok(definition.label && definition.description, `${definition.id} has copy`);
    assert.ok(definition.duration >= 3000, `${definition.id} window length sane`);
    assert.ok(definition.rarity > 0 && definition.cooldown >= 15000, `${definition.id} rarity/cooldown configured`);
    if (definition.environments !== '*') {
      for (const theme of definition.environments) assert.ok(THEMES.includes(theme), `${definition.id} theme ${theme}`);
    }
    for (const id of definition.effects.prefer) assert.ok(patternIds.has(id), `${definition.id} prefers unknown pattern ${id}`);
    for (const value of [definition.effects.calm, definition.effects.coinTrail, definition.effects.dangerBias, definition.effects.hazardFocus, definition.effects.recoveryBoost]) {
      assert.ok(value >= 0 && value <= 1, `${definition.id} gameplay envelopes within 0..1`);
    }
  }
});

test('Every theme has several eligible events; themed events stay in their themes', () => {
  for (const theme of THEMES) {
    const seed = seedForEnvironment(400, theme);
    const themed = generateLevel(400, seed);
    assert.equal(themed.environment, theme);
    const eligible = EVENT_DEFINITIONS.filter((definition) =>
      definition.environments === '*' || definition.environments.includes(theme));
    assert.ok(eligible.length >= 5, `${theme} has at least 5 eligible events (${eligible.length})`);
    assert.ok(eligible.some((definition) => definition.id === 'golden-hour'), 'golden hour is universal');
    assert.ok(eligible.some((definition) => definition.id === 'calm-journey'), 'calm journey is universal');
    assert.ok(eligible.some((definition) => definition.id === 'coin-trail'), 'coin trail is universal');
  }
  const forestWind = eventDefinition('forest-wind');
  assert.deepEqual([...forestWind.environments].sort(), ['countryside', 'moonlit-forest'],
    'forest wind belongs to the wooded themes only');
  const exclusives = [
    ['snowstorm', 'snowy-mountains'],
    ['mist-surge', 'misty-mountains'],
  ];
  for (const [id, theme] of exclusives) {
    const definition = eventDefinition(id);
    assert.deepEqual(definition.environments, [theme], `${id} is exclusive to ${theme}`);
  }
  const snowstorm = eventDefinition('snowstorm');
  for (const other of THEMES.filter((t) => t !== 'snowy-mountains')) {
    assert.ok(!snowstorm.environments.includes(other), `snowstorm must not appear in ${other}`);
  }
});

// ───────────────────────── scheduling ─────────────────────────

test('Schedules are deterministic per (level seed, start x) and vary across them', () => {
  const level = generateLevel(61, 4242);
  const first = scheduleForLevel(level, 0);
  const second = scheduleForLevel(level, 0);
  assert.deepEqual(first, second, 'same inputs → identical schedule');
  assert.ok(first.length >= 1 && first.length <= 3, '1–3 windows per level');
  const otherSeed = scheduleForLevel(generateLevel(61, 4243), 0);
  assert.ok(JSON.stringify(first) !== JSON.stringify(otherSeed) || first.length === 0, 'seeds diverge');
  const otherStart = scheduleForLevel(level, 100000);
  assert.ok(JSON.stringify(first) !== JSON.stringify(otherStart), 'start x shifts windows');
});

test('Every scheduled window is eligible for its level (theme, level, progression)', () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    for (const number of [1, 2, 3, 4, 5, 8, 12, 16, 22, 30, 61, 150, 400]) {
      const level = generateLevel(number, seed);
      for (const window of scheduleForLevel(level, 0)) {
        const definition = eventDefinition(window.eventId);
        assert.ok(number >= definition.minLevel, `${definition.id} below min level at L${number}`);
        assert.ok(level.difficulty.progression >= definition.minProgression,
          `${definition.id} progression ${definition.minProgression} > ${level.difficulty.progression} at L${number}`);
        assert.ok(definition.environments === '*' || definition.environments.includes(level.environment),
          `${definition.id} scheduled outside its themes (${level.environment})`);
      }
    }
  }
});

test('Windows never overlap and respect per-event cooldowns', () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const level = generateLevel(80, seed);
    const windows = scheduleForLevel(level, 0);
    for (let index = 1; index < windows.length; index += 1) {
      assert.ok(windows[index].startX > windows[index - 1].endX, 'windows are ordered and disjoint');
      const previous = eventDefinition(windows[index - 1].eventId);
      assert.ok(windows[index].startX - windows[index - 1].endX >= previous.cooldown * 0.7 - 1,
        `gap after ${previous.id} respects its cooldown`);
    }
    // Same event twice needs the full cooldown distance between the windows.
    for (let first = 0; first < windows.length; first += 1) {
      for (let second = first + 1; second < windows.length; second += 1) {
        if (windows[first].eventId !== windows[second].eventId) continue;
        const definition = eventDefinition(windows[first].eventId);
        assert.ok(windows[second].startX - windows[first].endX >= definition.cooldown * 0.7 - 1,
          `${definition.id} repeats only after its cooldown`);
      }
    }
  }
});

// ───────────────────────── envelope & gates ─────────────────────────

test('The event envelope ramps smoothly in, plateaus, and ramps out', () => {
  const level = generateLevel(61, 4242);
  const manager = new EventManager();
  manager.bind(level, 0);
  manager.forceNext('calm-journey', 0);
  const window = manager.report().windows[0];
  assert.equal(window.eventId, 'calm-journey');
  const gate = SUNSET_GATE;
  assert.equal(manager.intensityAt(window.startX, gate), 0, 'silent at the window edge');
  assert.equal(manager.intensityAt(window.startX + 450, gate), 1, 'full intensity after the ramp');
  assert.equal(manager.intensityAt((window.startX + window.endX) / 2, gate), 1, 'plateau mid-window');
  assert.equal(manager.intensityAt(window.endX - 450, gate), 1, 'still full before the exit ramp');
  assert.equal(manager.intensityAt(window.endX, gate), 0, 'silent at the far edge');
  let previous = 0;
  let rising = true;
  for (let x = window.startX; x <= window.startX + 450; x += 15) {
    const intensity = manager.intensityAt(x, gate);
    if (rising) {
      assert.ok(intensity >= previous - 1e-9, 'ramp is monotonic');
      if (intensity >= 1) rising = false;
    }
    previous = intensity;
  }
});

test('Gates: events need riding, avoid safe approaches and revival grace', () => {
  const level = generateLevel(61, 4242);
  const manager = new EventManager();
  manager.bind(level, 0);
  manager.forceNext('calm-journey', 0);
  const window = manager.report().windows[0];
  const mid = (window.startX + window.endX) / 2;
  assert.equal(manager.update(mid, { ...SUNSET_GATE, riding: false })?.eventId ?? null, null, 'no events outside riding');
  assert.equal(manager.update(mid, { ...SUNSET_GATE, safeApproach: true })?.eventId ?? null, null, 'no events during the safe approach');
  manager.reviveFrom(mid);
  assert.equal(manager.update(mid + 100, SUNSET_GATE), null, 'revival grace blocks activation');
  assert.equal(manager.update(mid + 1600, SUNSET_GATE)?.eventId, 'calm-journey', 'activation resumes after the grace distance');
});

test('Golden hour only ignites near sunrise or sunset and never at night', () => {
  const level = generateLevel(61, 4242);
  const manager = new EventManager();
  manager.bind(level, 0);
  manager.forceNext('golden-hour', 0);
  const window = manager.report().windows[0];
  const mid = (window.startX + window.endX) / 2;
  assert.equal(manager.update(mid, { ...SUNSET_GATE, phase: 0.4, night: 0 }), null, 'midday is not golden hour');
  assert.equal(manager.update(mid, { ...SUNSET_GATE, phase: 0.9, night: 0.85 }), null, 'never at night');
  const dawn = manager.update(mid, { ...SUNSET_GATE, phase: 0.06, night: 0.1 });
  assert.equal(dawn?.eventId, 'golden-hour', 'dawn band activates');
  const sunset = manager.update(mid, { ...SUNSET_GATE, phase: 0.66, night: 0.2 });
  assert.equal(sunset?.eventId, 'golden-hour', 'sunset band activates');
  assert.ok(manager.bias().warmLight > 0.3, 'warm light bias while active');
});

test('Dev controls: none suppresses, auto restores determinism, forcing overrides', () => {
  const level = generateLevel(61, 4242);
  const manager = new EventManager();
  manager.bind(level, 0);
  const original = manager.report().windows;
  manager.forceNext('snowstorm', 0);
  assert.equal(manager.report().forced, 'snowstorm');
  assert.equal(manager.report().windows[0].eventId, 'snowstorm', 'first upcoming window overridden');
  manager.setPreview('auto');
  assert.deepEqual(manager.report().windows, original, 'auto restores the deterministic schedule');
  assert.equal(manager.report().forced, null);
  manager.setPreview('none');
  assert.equal(manager.report().suppressed, true);
  assert.equal(manager.update(original[0].startX + 500, SUNSET_GATE), null, 'suppressed events never activate');
  manager.setPreview('auto');
  assert.equal(manager.update(original[0].startX + 500, SUNSET_GATE)?.eventId, original[0].eventId, 'restored schedule activates');
});

// ───────────────────────── environment bias ─────────────────────────

test('Event bias raises snow and wind without hiding the trail (fog capped)', () => {
  const seed = seedForEnvironment(80, 'snowy-mountains');
  const environment = new EnvironmentManager();
  environment.setLevel(generateLevel(80, seed));
  const info = { width: 900, height: 600, cameraX: 0, cameraDx: 3, storm: 0, lighter: false, groundAt: () => 300 };
  environment.update(0.1, { ...info, event: null });
  const snowBefore = environment.weatherEffects().find((effect) => effect.kind === 'snow')?.intensity ?? 0;
  const windBefore = environment.windStrength;
  environment.update(0.1, {
    ...info,
    event: { snow: 0.38, fog: 0.14, wind: 0.32, warmLight: 0, shafts: 0, groundMist: 0.15, ambient: 0, leafTint: 0 },
  });
  const snowAfter = environment.weatherEffects().find((effect) => effect.kind === 'snow')?.intensity ?? 0;
  const fogAfter = environment.weatherEffects().find((effect) => effect.kind === 'fog')?.intensity ?? 0;
  assert.ok(snowAfter > snowBefore + 0.3, `snowstorm thickens the snow (${snowBefore} → ${snowAfter})`);
  assert.ok(environment.windStrength > windBefore, `snowstorm raises the wind (${windBefore} → ${environment.windStrength})`);
  assert.ok(fogAfter <= 0.68, `fog stays readable (${fogAfter})`);
});

// ───────────────────────── engine end-to-end ─────────────────────────

test('A forced snowstorm activates with live weather bias and fades out positionally', () => {
  const seed = seedForEnvironment(61, 'snowy-mountains');
  const { game } = makeEngine({ save: seedSave(seed, 61) });
  game.start();
  assert.equal(game.levels.current.environment, 'snowy-mountains');
  game.setEventPreview('snowstorm');
  const snow = () => game.environment.weatherEffects().find((effect) => effect.kind === 'snow')?.intensity ?? 0;
  const wind = () => game.environment.windStrength;
  ride(game, 60); // settle the weather before measuring the baseline
  const baseSnow = snow();
  const baseWind = wind();
  const reached = rideUntil(game, () => game.events.current?.eventId === 'snowstorm' && game.events.current.intensity > 0.9);
  assert.ok(reached >= 0, 'the snowstorm window was reached');
  assert.ok(snow() > baseSnow + 0.25, `snow biased while active (${baseSnow} → ${snow()})`);
  assert.ok(wind() > baseWind + 0.1, `wind biased while active (${baseWind} → ${wind()})`);
  const fog = game.environment.weatherEffects().find((effect) => effect.kind === 'fog')?.intensity ?? 0;
  assert.ok(fog <= 0.68, `the trail stays visible (${fog})`);
  const window = activeWindow(game);
  assert.ok(window, 'an active window is reported');
  rideUntil(game, () => game.run.rider.x > window.endX + 600);
  assert.equal(game.events.current, null, 'the event ends positionally');
  assert.ok(Math.abs(snow() - baseSnow) < 0.03, `weather relaxes to the level config (${snow()} vs ${baseSnow})`);
  // Bounded caches with the event running.
  assert.ok(game.terrain.cachedChunks < 400, 'terrain cache bounded');
  assert.ok(game.environment.decorationChunkCount < 400, 'decoration cache bounded');
});

test('Golden hour activates only when the sky allows it and never moves the clock', () => {
  const { game: gameA, save } = makeEngine({ save: seedSave(909, 30) });
  gameA.start();
  gameA.setDayPhasePreview(0.66);
  gameA.setEventPreview('golden-hour');
  const reached = rideUntil(gameA, () => gameA.events.current?.eventId === 'golden-hour' && gameA.events.current.intensity > 0.8);
  assert.ok(reached >= 0, 'golden hour at sunset');
  assert.ok(gameA.events.bias().warmLight > 0.25, 'warm light bias live');
  const { game: gameB } = makeEngine({ save: seedSave(909, 30) });
  gameB.start();
  gameB.setDayPhasePreview(0.66);
  ride(gameB, reached + 120);
  assert.equal(gameA.currentDayPhase(), gameB.currentDayPhase(), 'the day/night clock is untouched by events');
  gameA.setDayPhasePreview(0.9);
  gameA.frame((gameA.__rideTime ?? 0) + 1000 / 60);
  assert.equal(gameA.events.current, null, 'golden hour goes quiet at night');
});

test('Calm journeys suppress new hazards while coins keep flowing', () => {
  const { game } = makeEngine({ save: seedSave(3131, 30) });
  game.start();
  game.setEventPreview('calm-journey');
  const reached = rideUntil(game, () => game.events.current?.eventId === 'calm-journey' && game.events.current.intensity > 0.9);
  assert.ok(reached >= 0, 'calm journey reached');
  const run = game.run;
  let newHazards = 0;
  for (let index = 0; index < 240; index += 1) {
    const before = run.objects.filter((object) => HAZARD_KINDS.includes(object.kind)).length;
    ride(game, 1, { speed: 300 });
    const after = run.objects.filter((object) => HAZARD_KINDS.includes(object.kind)).length;
    if (after > before) newHazards += after - before;
    assert.ok(game.events.current?.intensity > 0.85, 'still inside the window');
  }
  assert.equal(newHazards, 0, 'no new hazards spawn during the calm journey');
  const coinsNearby = run.objects.filter((object) => object.kind === 'coin' && object.x > run.rider.x && object.x < run.rider.x + 2000).length;
  assert.ok(coinsNearby > 0, 'coins still spawn during the calm journey');
  // Control: the same stretch without the event does schedule hazards.
  const { game: control } = makeEngine({ save: seedSave(3131, 30) });
  control.start();
  ride(control, reached + 240, { speed: 300 });
  const controlHazards = control.run.objects.filter((object) => HAZARD_KINDS.includes(object.kind)).length;
  assert.ok(controlHazards > 0, 'control run has hazards');
});

test('Glowstone trails densify coins, stay reachable and reward exactly once', () => {
  const save = seedSave(1717, 30);
  const { game, sounds } = makeEngine({ save });
  game.start();
  game.setEventPreview('coin-trail');
  const reached = rideUntil(game, () => game.events.current?.eventId === 'coin-trail' && game.events.current.intensity > 0.9);
  assert.ok(reached >= 0, 'trail window reached');
  const run = game.run;
  const window = activeWindow(game);
  const band = { from: run.rider.x, to: window.endX };
  const trailCoins = () => run.objects.filter((object) => object.kind === 'coin' && object.x >= band.from && object.x <= band.to);
  const coins = trailCoins();
  assert.ok(coins.length >= 18, `dense trail (${coins.length} coins in the window)`);
  for (const coin of coins) {
    assert.ok(coin.offset <= 110, `coin offset reachable (${coin.offset})`);
    for (const hazard of run.objects) {
      if (!HAZARD_KINDS.includes(hazard.kind)) continue;
      const width = hazard.width ?? 35;
      assert.ok(coin.x < hazard.x - 10 || coin.x > hazard.x + width + 10,
        `coin at ${coin.x} overlaps ${hazard.kind} at ${hazard.x}`);
    }
  }
  const startCoins = run.coins;
  const windowCoinCount = coins.length;
  const soundsBefore = sounds.filter((type) => type === 'coin').length;
  ride(game, 900, { collect: true, neutralizeDouble: true });
  assert.equal(trailCoins().length, 0, 'every window coin was collected exactly once');
  const collected = run.coins - startCoins;
  const coinSounds = sounds.filter((type) => type === 'coin').length - soundsBefore;
  assert.ok(collected >= windowCoinCount, `window coins credited (${collected} of ${windowCoinCount})`);
  // Every glowstone credit emits exactly one collection sound, so credits can
  // never exceed sounds; the sound counter also ticks for power pickups.
  assert.ok(collected <= coinSounds && coinSounds - collected <= 10,
    `no phantom or double credits (${collected} credits vs ${coinSounds} sounds)`);
});

test('Mountain crossings schedule validated bridges across the gaps', () => {
  const seed = seedForEnvironment(30, 'snowy-mountains');
  const { game } = makeEngine({ save: seedSave(seed, 30) });
  game.start();
  game.setEventPreview('mountain-crossing');
  const reached = rideUntil(game, () => game.events.current?.eventId === 'mountain-crossing' && game.events.current.intensity > 0.9);
  assert.ok(reached >= 0, 'crossing window reached');
  const run = game.run;
  const window = activeWindow(game);
  // Phase 11 — the repetition memory is capped and rolls over mid-ride, so
  // the planned sequence is tracked from lastPlanInfo (updated on every
  // successful plan) instead of diffing recentPatterns slices.
  const slice = rideCollecting(game, 700);
  const bridges = slice.filter((id) => ['rope-bridge', 'broken-bridge', 'moving-platform'].includes(id));
  assert.ok(bridges.length >= 1, `bridge patterns scheduled (${slice.join(',')})`);
  for (const object of run.objects) {
    if (object.x < window.startX || object.x > window.endX || !object.plan) continue;
    assert.ok(validPlacementMetadata(object.plan), `${object.kind} carries validated takeoff/landing metadata`);
  }
});

test('Rare challenges run hot with recovery room', () => {
  const { game } = makeEngine({ save: seedSave(2727, 40) });
  game.start();
  game.setEventPreview('rare-challenge');
  const reached = rideUntil(game, () => game.events.current?.eventId === 'rare-challenge' && game.events.current.intensity > 0.9);
  assert.ok(reached >= 0, 'challenge window reached');
  const run = game.run;
  // Phase 11 — planned sequence from lastPlanInfo (see rideCollecting).
  const slice = rideCollecting(game, 800);
  const hot = slice.filter((id) => (patternRating(id) ?? 0) >= 0.6);
  assert.ok(hot.length >= 2, `dangerous patterns scheduled (${slice.join(',')})`);
  const manager = new EventManager();
  manager.bind(game.levels.current, run.levelStartX);
  manager.forceNext('rare-challenge', 0);
  const forcedWindow = manager.report().windows[0];
  assert.ok(manager.gameplayAt((forcedWindow.startX + forcedWindow.endX) / 2).recoveryBoost > 0.9, 'recovery boost is part of the event');
});

test('Falling hazards reuse the existing timed drops per theme', () => {
  const snowySeed = seedForEnvironment(25, 'snowy-mountains');
  const { game } = makeEngine({ save: seedSave(snowySeed, 25) });
  game.start();
  game.setEventPreview('falling-hazards');
  let reached = rideUntil(game, () => game.events.current?.eventId === 'falling-hazards' && game.events.current.intensity > 0.9);
  assert.ok(reached >= 0, 'falling hazards window reached (snowy)');
  // Phase 11 — planned sequence from lastPlanInfo (see rideCollecting).
  let planned = rideCollecting(game, 600);
  assert.ok(planned.includes('icicle-drop'),
    `icicle drops scheduled (${planned.join(',')})`);

  const moonlitSeed = seedForEnvironment(25, 'moonlit-forest');
  const { game: moonlit } = makeEngine({ save: seedSave(moonlitSeed, 25) });
  moonlit.start();
  moonlit.setEventPreview('falling-hazards');
  reached = rideUntil(moonlit, () => moonlit.events.current?.eventId === 'falling-hazards' && moonlit.events.current.intensity > 0.9);
  assert.ok(reached >= 0, 'falling hazards window reached (moonlit)');
  planned = rideCollecting(moonlit, 600);
  assert.ok(planned.includes('falling-branch'),
    `falling branches scheduled (${planned.join(',')})`);
});

test('No events run during house transitions; the next level starts clean', () => {
  const { game } = makeEngine({ save: seedSave(4242, 12) });
  game.start();
  game.setEventPreview('coin-trail');
  const reached = rideUntil(game, () => game.events.current?.eventId === 'coin-trail' && game.events.current.intensity > 0.5);
  assert.ok(reached >= 0, 'event active before the house');
  const run = game.run;
  run.bonus += LEVEL_TARGET_SCORE;
  game.step(0);
  assert.equal(run.levelPhase, 'approach');
  game.frame((game.__rideTime ?? 0) + 1000 / 60);
  assert.equal(game.events.current, null, 'no event during the approach');
  const phases = new Set();
  let time = game.__rideTime ?? 0;
  for (let index = 0; index < 6400; index += 1) {
    time += 1000 / 120;
    game.__rideTime = time;
    game.frame(time);
    phases.add(run.levelPhase);
    if (run.levelPhase !== 'riding' && game.events.current) {
      assert.fail(`event leaked into the ${run.levelPhase} phase`);
    }
    if (run.levelPhase === 'riding' && run.levelIndex > 11) break;
  }
  assert.equal(game.levels.current.number, 13, 'level 13 reached');
  assert.ok(phases.has('celebrating') && phases.has('exiting'), `house phases visited (${[...phases]})`);
  assert.equal(game.events.current, null, 'the new level starts without a running event');
  assert.ok(game.events.report().windows.length >= 1, 'a fresh schedule is bound for level 13');
});

test('Crash and revival: grace distance, then the same window resumes', () => {
  const { game } = makeEngine({ save: seedSave(5151, 30) });
  game.start();
  game.setEventPreview('coin-trail');
  const reached = rideUntil(game, () => game.events.current?.eventId === 'coin-trail' && game.events.current.intensity > 0.5,
    { invulSeconds: 2 });
  assert.ok(reached >= 0, 'trail active before the crash');
  const run = game.run;
  // Crash for real (no invulnerability).
  let warmup = 0;
  while (run.elapsed < run.invulnerableUntil + 0.05 && warmup < 600) {
    game.clock += 1 / 120;
    game.step(1 / 120);
    warmup += 1;
  }
  run.objects.push({ kind: 'rock', x: run.rider.x + 70 });
  let frames = 0;
  while (!run.over && frames < 900) { game.clock += 1 / 120; game.step(1 / 120); frames += 1; }
  assert.equal(run.over, true, 'the rider crashed');
  assert.equal(game.revive(), true, 'revival available');
  const revivedAt = run.rider.x;
  game.frame((game.__rideTime ?? 0) + 1000 / 60);
  assert.equal(game.events.current, null, 'no event immediately after revival');
  const resumed = rideUntil(game, () => game.events.current?.eventId === 'coin-trail');
  assert.ok(resumed >= 0, 'the same window resumes after the grace distance');
  assert.ok(game.run.rider.x >= revivedAt + 1400, 'resumption only after the grace stretch');
});

test('Parking and reloading reproduces the same schedule mid-event', () => {
  // Find a journey whose deterministic first window is a glowstone trail so
  // the reload path exercises the real (non-forced) schedule.
  let trailSeed = null;
  for (let seed = 1; seed < 400 && trailSeed === null; seed += 1) {
    if (generateLevel(30, seed).environment === 'countryside'
      && scheduleForLevel(generateLevel(30, seed), 0)[0]?.eventId === 'coin-trail') {
      trailSeed = seed;
    }
  }
  assert.ok(trailSeed, 'a countryside journey with a deterministic coin trail exists');
  const save = seedSave(trailSeed, 30);
  const { game } = makeEngine({ save });
  game.start();
  const reached = rideUntil(game, () => game.events.current?.eventId === 'coin-trail' && game.events.current.intensity > 0.8);
  assert.ok(reached >= 0, 'the deterministic trail is active at park time');
  const run = game.run;
  const scheduleAtPark = game.events.report().windows;
  const nextCoinXAtPark = run.nextCoinX;
  game.suspendToMenu();
  const { game: reloaded } = makeEngine({ save });
  assert.ok(reloaded.hasParkedRun, 'the checkpoint restored a parked run');
  reloaded.resumeParkedRun();
  reloaded.frame(1000 / 60);
  assert.deepEqual(reloaded.events.report().windows, scheduleAtPark, 'identical schedule after reload');
  assert.deepEqual(reloaded.events.report().windows, scheduleForLevel(reloaded.levels.current, reloaded.run.levelStartX),
    'the reloaded schedule is the deterministic one for the restored level');
  assert.ok(reloaded.events.report().windows.some((window) => window.eventId === 'coin-trail'), 'the trail window survived the reload');
  assert.ok(reloaded.run.coins <= run.coins, 'a rollback never grants extra glowstones');
  assert.ok(reloaded.run.nextCoinX >= reloaded.run.rider.x, 'the coin cursor stays ahead of the restored rider');
  assert.ok(nextCoinXAtPark >= 0);
  const resumed = rideUntil(reloaded, () => reloaded.events.current?.eventId === 'coin-trail');
  assert.ok(resumed >= 0, 'the event is live again after resuming');
});

test('Two identically forced engines stay in lockstep (determinism)', () => {
  const saveA = seedSave(8888, 61);
  const saveB = seedSave(8888, 61);
  const { game: a } = makeEngine({ save: saveA });
  const { game: b } = makeEngine({ save: saveB });
  a.start();
  b.start();
  a.setEventPreview('coin-trail');
  b.setEventPreview('coin-trail');
  for (let index = 0; index < 900; index += 1) {
    ride(a, 1);
    ride(b, 1);
    if (index % 150 === 149) {
      assert.equal(a.run.rider.x, b.run.rider.x, 'riders in lockstep');
      assert.deepEqual(a.events.report().windows, b.events.report().windows, 'schedules in lockstep');
      assert.equal(a.events.current?.eventId ?? null, b.events.current?.eventId ?? null, 'active events in lockstep');
      assert.deepEqual(a.run.objects, b.run.objects, 'identical world state (coins included)');
    }
  }
});

test('Dev tools: forcing bypasses eligibility, none silences, report inspects', () => {
  const seed = seedForEnvironment(30, 'countryside');
  const { game } = makeEngine({ save: seedSave(seed, 30) });
  game.start();
  assert.equal(game.levels.current.environment, 'countryside');
  // Snowstorm is not eligible in the countryside — forcing must still work.
  game.setEventPreview('snowstorm');
  const reached = rideUntil(game, () => game.events.current?.eventId === 'snowstorm' && game.events.current.intensity > 0.9);
  assert.ok(reached >= 0, 'forced event ignores theme eligibility');
  game.setEventPreview('none');
  const silenced = ride(game, 900);
  assert.equal(game.events.current, null, 'suppressed engines never run events');
  game.setEventPreview('auto');
  assert.deepEqual(game.events.report().windows, scheduleForLevel(game.levels.current, game.run.levelStartX),
    'auto restores the deterministic schedule');
  const report = game.devLevelReport();
  assert.ok(report.includes('EVENTS'), 'report lists the schedule');
  assert.ok(report.includes('EVENT POOL'), 'report lists the eligible pool');
  assert.equal(report, game.devLevelReport(), 'report is stable');
  const preview = game.devLevelReport(427);
  assert.ok(preview.includes('EVENTS'), 'arbitrary level reports include events');
  assert.ok(silenced, 'ride completed');
});

test('Event overhead stays bounded while running', () => {
  const seed = seedForEnvironment(61, 'snowy-mountains');
  const { game: withEvent, recorder: recorderA } = makeEngine({ save: seedSave(seed, 61) });
  withEvent.start();
  withEvent.setEventPreview('snowstorm');
  const reached = rideUntil(withEvent, () => withEvent.events.current?.eventId === 'snowstorm' && withEvent.events.current.intensity > 0.9);
  assert.ok(reached >= 0);
  const { game: control, recorder: recorderB } = makeEngine({ save: seedSave(seed, 61) });
  control.start();
  ride(control, reached);
  const opsA = recorderA.operations;
  const opsB = recorderB.operations;
  ride(withEvent, 240);
  ride(control, 240);
  const deltaA = recorderA.operations - opsA;
  const deltaB = recorderB.operations - opsB;
  assert.ok(deltaA <= deltaB * 2.5 + 200, `event frames stay affordable (${deltaA} vs ${deltaB})`);
  assert.ok(Number.isFinite(withEvent.run.rider.x), 'state stays finite with events running');
});
