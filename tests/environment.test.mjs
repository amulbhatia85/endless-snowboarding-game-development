import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

const { generateLevel, LevelManager, LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const {
  EnvironmentManager,
  DecorationField,
  ENVIRONMENTS,
  PARALLAX_LAYER_COUNT,
  decorationOverlapsGameplay,
} = await import(moduleUrl('src/game/environment.ts'));
const { WeatherSystem } = await import(moduleUrl('src/game/weather.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));
const { BICYCLE_PHYSICS } = await import(moduleUrl('src/game/riderPhysics.ts'));

const COLOR_KEYS = ['top', 'horizon', 'far', 'middle', 'near', 'snow', 'snowShade', 'glow', 'moon'];

function storage(values = new Map()) {
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, values };
}

function channels(color) {
  const match = color.match(/\d+/g);
  assert.ok(match, `expected a css colour string, received ${color}`);
  return match.slice(0, 3).map(Number);
}

/** Parses both `rgb()` strings and `#rrggbb` stop values. */
function channelsAny(color) {
  if (color.startsWith('#')) {
    return [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));
  }
  return channels(color);
}

function channelDistanceAny(a, b) {
  const first = channelsAny(a);
  const second = channelsAny(b);
  return Math.max(...first.map((value, index) => Math.abs(value - second[index])));
}

function channelDistance(a, b) {
  const first = channels(a);
  const second = channels(b);
  return Math.max(...first.map((value, index) => Math.abs(value - second[index])));
}

/** Records every numeric coordinate drawn so tests can assert finiteness. */
function mockContext() {
  const coords = [];
  let operations = 0;
  const gradient = { addColorStop() {} };
  const record = (...values) => { operations += 1; coords.push(...values.filter((value) => typeof value === 'number')); };
  const context = {
    canvas: null,
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', font: '10px system-ui', textAlign: 'left', textBaseline: 'alphabetic',
    shadowColor: 'transparent', shadowBlur: 0,
    setTransform: (...values) => record(...values),
    clearRect: (...values) => record(...values),
    fillRect: (...values) => record(...values),
    strokeRect: (...values) => record(...values),
    createLinearGradient: (...values) => { record(...values); return gradient; },
    createRadialGradient: (...values) => { record(...values); return gradient; },
    save() { operations += 1; }, restore() { operations += 1; },
    translate: (...values) => record(...values),
    rotate: (...values) => record(...values),
    scale: (...values) => record(...values),
    beginPath() { operations += 1; }, closePath() { operations += 1; },
    moveTo: (...values) => record(...values),
    lineTo: (...values) => record(...values),
    quadraticCurveTo: (...values) => record(...values),
    bezierCurveTo: (...values) => record(...values),
    arc: (...values) => record(values[0], values[1], values[2]),
    ellipse: (...values) => record(...values.slice(0, 4)),
    fill() { operations += 1; }, stroke() { operations += 1; },
    fillText: (...values) => record(values[1], values[2]),
    strokeText: (...values) => record(values[1], values[2]),
    drawImage() { operations += 1; },
  };
  return { context, coords, get operations() { return operations; } };
}

function makeEngine({ search = '', save = storage() } = {}) {
  globalThis.localStorage = save;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    location: { search },
  };
  // The rider's power-up glow composites through offscreen canvases.
  globalThis.document = {
    createElement: () => {
      const inner = mockContext();
      return { width: 192, height: 192, getContext: () => inner.context };
    },
  };
  const recorder = mockContext();
  const game = new SnowGameEngine({
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    getContext: () => recorder.context,
  }, { onStatus() {}, onHud() {}, onGameOver() {} });
  return { game, recorder, save };
}

function environmentUpdate(game, overrides = {}) {
  game.environment.update(1 / 60, {
    width: 900, height: 600,
    cameraX: game.run ? game.run.cameraX : 0,
    cameraDx: 4, storm: 0, lighter: false,
    groundAt: (x) => 360,
    ...overrides,
  });
}

/** Mirrors the frame loop while a level completes, so blends can advance. */
function completeLevel(game) {
  const run = game.run;
  run.elapsed = Math.max(5, run.elapsed);
  run.objects = [];
  run.nextCoinX = run.nextHazardX = 1e12;
  run.bonus += 50000;
  game.step(0);
  assert.equal(run.levelPhase, 'approach');
  const initialLevel = run.levelIndex;
  let entered = false;
  for (let index = 0; index < 2400; index += 1) {
    game.press();
    game.step(1 / 60);
    environmentUpdate(game);
    if (run.levelPhase === 'celebrating') entered = true;
    if (run.levelPhase === 'riding' && run.levelIndex > initialLevel) {
      assert.ok(entered);
      return;
    }
  }
  assert.fail('Level transition failed to finish.');
}

// ───────────────────────── environment loading ─────────────────────────

test('Every level loads its configured environment with valid palettes, layers and weather', () => {
  const expectedThemes = { 1: 'countryside', 2: 'snowy-mountains', 3: 'misty-mountains', 4: 'moonlit-forest' };
  for (const number of [1, 2, 3, 4, 9, 30]) {
    const level = generateLevel(number, 771);
    const environment = new EnvironmentManager();
    environment.setLevel(level);

    assert.equal(environment.theme, level.environment);
    assert.deepEqual(environment.allowedObstacles, level.allowedObstacles);
    assert.ok(Object.prototype.hasOwnProperty.call(ENVIRONMENTS, level.environment));

    const layers = environment.parallaxLayers();
    assert.equal(layers.length, PARALLAX_LAYER_COUNT);
    for (let index = 1; index < layers.length; index += 1) {
      assert.ok(layers[index].parallax > layers[index - 1].parallax, 'parallax must increase with depth');
    }
    for (const layer of layers) {
      for (const value of [layer.parallax, layer.baseY, layer.amplitude, layer.roughness, layer.snowcap, layer.treeline]) {
        assert.ok(Number.isFinite(value));
      }
      assert.ok(layer.parallax > 0 && layer.parallax < 1);
      assert.ok(layer.baseY > 0 && layer.baseY + layer.amplitude < 1.05);
    }

    const effects = environment.weatherEffects();
    assert.ok(effects.length > 0);
    for (const effect of effects) {
      assert.ok(['clear', 'snow', 'rain', 'fog', 'wind'].includes(effect.kind));
      assert.ok(effect.intensity >= 0 && effect.intensity <= 1);
    }

    for (const phase of [0, 0.25, 0.5, 0.75, 0.999]) {
      const palette = environment.palette(phase);
      for (const key of COLOR_KEYS) assert.match(palette[key], /^rgb\(/);
      assert.ok(palette.night >= 0 && palette.night <= 1);
    }
    if (expectedThemes[number]) assert.equal(environment.theme, expectedThemes[number]);
  }
});

test('Environment palettes carry each theme identity and wrap continuously at the seam', () => {
  const environment = new EnvironmentManager();

  environment.setLevel(generateLevel(1, 42));
  const country = environment.palette(0.4);
  const [countryR, countryG, countryB] = channels(country.snow);
  assert.ok(countryG > countryR && countryG > countryB, 'countryside ground must be green');
  assert.ok(country.night <= 0.1, 'countryside is a warm day scene');

  environment.setLevel(generateLevel(2, 42));
  const snowy = environment.palette(0.4);
  assert.ok(channels(snowy.snow).every((value) => value > 225), 'snowy mountains ground must be near-white');
  assert.ok(environment.weatherEffects().some((effect) => effect.kind === 'snow' && effect.intensity > 0.3));

  environment.setLevel(generateLevel(3, 42));
  const misty = environment.palette(0.4);
  assert.ok(environment.weatherEffects().some((effect) => effect.kind === 'fog' && effect.intensity > 0.3));
  assert.ok(misty.night < 0.3, 'misty mountains stay a soft morning scene');

  environment.setLevel(generateLevel(4, 42));
  const moonlitDay = environment.palette(0.4);
  assert.ok(moonlitDay.night <= 0.45, 'moonlit forest now rides the day cycle instead of frozen night');
  assert.ok(channels(moonlitDay.snow)[2] > channels(moonlitDay.snow)[0], 'moonlit ground leans blue');
  const moonlitNight = environment.palette(0.9);
  assert.ok(moonlitNight.night > 0.8, 'moonlit forest keeps its signature deep night');

  // Phase wraps must not jump: stops at 0 and 1 carry identical values, and no
  // stop-to-stop segment is steep enough to read as a flash transition.
  for (const number of [1, 2, 3, 4]) {
    environment.setLevel(generateLevel(number, 42));
    const stops = ENVIRONMENTS[environment.theme].stops;
    assert.equal(stops[stops.length - 1].at, 1, 'the cycle closes at phase 1');
    for (const key of COLOR_KEYS) {
      assert.equal(channelDistanceAny(stops[0].palette[key], stops[stops.length - 1].palette[key]), 0, `${key} wraps at the seam`);
    }
    assert.equal(stops[0].palette.night, stops[stops.length - 1].palette.night, 'night wraps at the seam');
    for (let index = 0; index < stops.length - 1; index += 1) {
      const span = stops[index + 1].at - stops[index].at;
      assert.ok(span >= 0.03, 'stops are spaced far enough apart to animate');
      for (const key of COLOR_KEYS) {
        assert.ok(channelDistanceAny(stops[index].palette[key], stops[index + 1].palette[key]) / span <= 2600, `${key} segment is not a flash`);
      }
      assert.ok(Math.abs(stops[index + 1].palette.night - stops[index].palette.night) / span <= 8, 'night segment is not a flash');
    }
    const opening = environment.palette(0.002);
    const closing = environment.palette(0.998);
    for (const key of COLOR_KEYS) assert.ok(channelDistance(opening[key], closing[key]) <= 8, `${key} jumps at the phase seam`);
    assert.ok(Math.abs(opening.night - closing.night) <= 0.12);
  }
});

// ───────────────────────── transitions ─────────────────────────

test('Level transitions cross-fade smoothly from one environment to the next', () => {
  const environment = new EnvironmentManager();
  environment.setLevel(generateLevel(1, 42));
  const before = environment.palette(0.4);
  const layersBefore = environment.parallaxLayers().map((layer) => ({ ...layer }));

  environment.transitionTo(generateLevel(2, 42), 2, 5000);
  environment.update(0, { width: 900, height: 600, cameraX: 0, cameraDx: 0, storm: 0, lighter: false });
  const start = environment.palette(0.4);
  for (const key of COLOR_KEYS) assert.ok(channelDistance(start[key], before[key]) === 0, 'blend starts exactly at the source palette');

  environment.update(1, { width: 900, height: 600, cameraX: 0, cameraDx: 0, storm: 0, lighter: false });
  const mid = environment.palette(0.4);
  for (const key of COLOR_KEYS) assert.match(mid[key], /^rgb\(/);
  for (const layer of environment.parallaxLayers()) {
    for (const value of [layer.parallax, layer.baseY, layer.amplitude, layer.roughness, layer.snowcap, layer.treeline]) {
      assert.ok(Number.isFinite(value), 'layer parameters stay finite mid-blend');
    }
  }
  const layersAfter = new EnvironmentManager();
  layersAfter.setLevel(generateLevel(2, 42));
  const targetParallax = layersAfter.parallaxLayers().map((layer) => layer.parallax);
  for (let index = 0; index < PARALLAX_LAYER_COUNT; index += 1) {
    const current = environment.parallaxLayers()[index].parallax;
    const low = Math.min(layersBefore[index].parallax, targetParallax[index]);
    const high = Math.max(layersBefore[index].parallax, targetParallax[index]);
    assert.ok(current >= low - 1e-9 && current <= high + 1e-9, 'blended parallax stays between endpoints');
  }

  environment.update(1, { width: 900, height: 600, cameraX: 0, cameraDx: 0, storm: 0, lighter: false });
  assert.equal(environment.theme, 'snowy-mountains');
  const reference = new EnvironmentManager();
  reference.setLevel(generateLevel(2, 42));
  const end = environment.palette(0.4);
  const target = reference.palette(0.4);
  for (const key of COLOR_KEYS) assert.ok(channelDistance(end[key], target[key]) <= 2, 'blend ends at the target palette');
  assert.ok(Math.abs(end.night - target.night) <= 0.01);

  // Re-targeting the same level mid-blend is a no-op; snapping back is supported.
  environment.transitionTo(generateLevel(2, 42), 1, 0);
  assert.equal(environment.theme, 'snowy-mountains');
  environment.setLevel(generateLevel(3, 42));
  assert.equal(environment.theme, 'misty-mountains');
});

// ───────────────────────── weather system ─────────────────────────

test('Weather pools are capped, reused, intensity-driven and stay finite', () => {
  const system = new WeatherSystem({ particleCap: 100 });
  const info = { delta: 1 / 60, width: 800, height: 600, cameraDx: 6, wind: 0.4, lighter: false };

  system.configure([{ kind: 'snow', intensity: 1 }]);
  for (let index = 0; index < 600; index += 1) system.update(info);
  assert.ok(system.activeParticles('snow') > 50, 'full intensity fills the pool');
  assert.ok(system.activeParticles('snow') <= 100, 'active count respects the cap');
  const allocated = system.poolSize('snow');
  assert.ok(allocated <= 100);

  for (let index = 0; index < 5000; index += 1) system.update(info);
  assert.equal(system.poolSize('snow'), allocated, 'long runs never allocate new particles');

  system.configure([{ kind: 'snow', intensity: 0 }]);
  for (let index = 0; index < 60; index += 1) system.update(info);
  assert.equal(system.activeParticles('snow'), 0, 'zero intensity retires all snow');

  system.configure([{ kind: 'rain', intensity: 1 }, { kind: 'fog', intensity: 0.5 }]);
  system.update({ ...info, delta: 5, cameraDx: 1e6, wind: 1 });
  const recorder = mockContext();
  system.drawSnow(recorder.context, 0.5);
  system.drawRain(recorder.context, 0.8);
  assert.ok(recorder.coords.length > 0);
  assert.ok(recorder.coords.every((value) => Number.isFinite(value)), 'extreme frames never produce NaN coordinates');
  assert.ok(system.intensity('fog') > 0.4);

  system.configure([{ kind: 'clear', intensity: 1 }]);
  system.update(info);
  assert.equal(system.activeParticles('rain'), 0);
});

// ───────────────────────── decorations ─────────────────────────

test('Decorations are deterministic per level seed, respect their origin and are culled', () => {
  const entries = [{ kind: 'grass', weight: 3 }, { kind: 'flower', weight: 1 }];
  const field = new DecorationField(123, entries, 60, 5000);
  const mirror = new DecorationField(123, entries, 60, 5000);
  const sample = field.sample(0, 9000);
  assert.ok(sample.length > 0);
  assert.ok(sample.every((decoration) => decoration.x >= 5000), 'decorations never appear before their origin');
  assert.deepEqual(sample, mirror.sample(0, 9000), 'same seed generates identical decorations');
  assert.notDeepEqual(sample, new DecorationField(124, entries, 60, 5000).sample(0, 9000));

  const environment = new EnvironmentManager();
  environment.setLevel(generateLevel(2, 771));
  environment.update(1 / 60, { width: 900, height: 600, cameraX: 0, cameraDx: 0, storm: 0, lighter: false });
  const twin = new EnvironmentManager();
  twin.setLevel(generateLevel(2, 771));
  assert.deepEqual(environment.decorationsNear(2000, 4200), twin.decorationsNear(2000, 4200));

  environment.update(1 / 60, { width: 900, height: 600, cameraX: 80000, cameraDx: 80000, storm: 0, lighter: false });
  assert.ok(environment.decorationChunkCount < 45, 'far behind the camera, chunk caches are pruned');
  assert.ok(environment.decorationsNear(80000, 82600).length > 0, 'new ground still receives decorations');
});

test('Decorations avoid gameplay objects and never participate in collisions', () => {
  assert.equal(decorationOverlapsGameplay(1000, 14, [{ kind: 'rock', x: 1000 }]), true);
  assert.equal(decorationOverlapsGameplay(1200, 14, [{ kind: 'rock', x: 1000 }]), false);
  assert.equal(decorationOverlapsGameplay(1000, 14, [{ kind: 'coin', x: 1000 }]), true);
  assert.equal(decorationOverlapsGameplay(1045, 14, [{ kind: 'coin', x: 1000 }]), false);
  assert.equal(decorationOverlapsGameplay(1160, 14, [{ kind: 'gap', x: 1000, width: 100 }]), true);
  assert.equal(decorationOverlapsGameplay(1200, 14, [{ kind: 'gap', x: 1000, width: 100 }]), false);
  assert.equal(decorationOverlapsGameplay(1000, 14, [{ kind: 'ramp', x: 1000 }]), true);
  assert.equal(decorationOverlapsGameplay(1000, 10, [], [{ x: 1000 }]), true);
  assert.equal(decorationOverlapsGameplay(300, 14, []), true, 'the spawn corridor stays clear');

  const { game } = makeEngine();
  game.start();
  for (let index = 0; index < 600; index += 1) game.step(1 / 60);
  const decorationKinds = new Set(['grass', 'flower', 'bush', 'snowy-bush', 'pine', 'snowy-pine', 'silhouette-pine', 'drift', 'stone', 'mossy-rock', 'fern', 'reed', 'glow-shroom']);
  assert.ok(game.run.objects.length > 0);
  assert.ok(game.run.objects.every((object) => !decorationKinds.has(object.kind)), 'decorations never enter the collision world');
});

// ───────────────────────── physics isolation ─────────────────────────

test('Weather and environment updates never change rider physics', () => {
  assert.deepEqual(BICYCLE_PHYSICS, {
    minSpeed: 205, maxSpeed: 475, gravity: 920, jumpVelocity: 585, jumpSpeedFactor: 0.18,
    maxJumpBoost: 85, airborneAcceleration: 2.5, collisionPadding: 10, collisionBottom: 7,
    groundOffset: 5, collisionInset: 3, landingAngleLimit: 1.22, landingSpinLimit: 4.2,
    flipHoldSeconds: 0.14, flipSeconds: 1.1, flipEaseFraction: 0.12,
  });

  const seedSave = () => {
    const save = storage();
    save.setItem(LEVEL_SAVE_KEY, JSON.stringify({
      version: 1, journeySeed: 4242, currentLevel: 2, unlockedThrough: 2,
      completedThrough: 1, levelScore: 0, runScore: 0, lifetimeScore: 0, checkpoint: null,
    }));
    return save;
  };

  const quiet = makeEngine({ save: seedSave() });
  const stormy = makeEngine({ save: seedSave() });
  quiet.game.start();
  stormy.game.start();

  for (let index = 0; index < 900; index += 1) {
    const holding = index % 90 < 18;
    if (holding) { quiet.game.press(); stormy.game.press(); }
    else { quiet.game.release(); stormy.game.release(); }
    quiet.game.step(1 / 60);
    stormy.game.step(1 / 60);
    // Storm-level weather + aggressive camera movement between every step.
    stormy.game.environment.update(1 / 60, {
      width: 900, height: 600, cameraX: stormy.game.run.cameraX, cameraDx: 260,
      storm: 1, lighter: index % 2 === 0, groundAt: () => 9999,
    });
    if (index % 90 === 89) {
      const a = quiet.game.run.rider;
      const b = stormy.game.run.rider;
      assert.equal(b.x, a.x, 'rider position must be identical with weather active');
      assert.equal(b.speed, a.speed);
      assert.equal(b.y, a.y);
      assert.equal(quiet.game.run.coins, stormy.game.run.coins);
      assert.equal(quiet.game.run.objects.length, stormy.game.run.objects.length);
    }
  }
  assert.equal(quiet.game.status, stormy.game.status);
});

// ───────────────────────── engine integration ─────────────────────────

test('The engine renders every environment without errors and with finite coordinates', () => {
  const themes = { 1: 'countryside', 2: 'snowy-mountains', 3: 'misty-mountains', 4: 'moonlit-forest' };
  for (const number of [1, 2, 3, 4]) {
    const { game, recorder } = makeEngine({ search: `?level=${number}` });
    assert.equal(game.levels.current.number, number);
    assert.equal(game.environment.theme, themes[number]);
    game.start();
    for (let index = 0; index < 150; index += 1) {
      game.step(1 / 60);
      game.environment.update(1 / 60, {
        width: 900, height: 600, cameraX: game.run.cameraX, cameraDx: 5,
        storm: 0.5, lighter: false, groundAt: (x) => game.terrainAt(x),
      });
      if (index % 37 === 0) game.draw();
    }
    game.draw();
    assert.ok(recorder.operations > 500, `level ${number} produced render output`);
    assert.ok(recorder.coords.length > 100);
    assert.ok(recorder.coords.every((value) => Number.isFinite(value)), `level ${number} drew a NaN coordinate`);
  }
});

test('Levels advance the environment, restarts stay consistent and preview levels are isolated', () => {
  const { game } = makeEngine();
  game.start();
  assert.equal(game.environment.theme, 'countryside');
  completeLevel(game);
  assert.equal(game.levels.current.number, 2);
  assert.equal(game.environment.theme, 'snowy-mountains');
  for (let index = 0; index < 200; index += 1) {
    game.step(1 / 60);
    environmentUpdate(game);
  }
  // Progress persists: restarting continues in the new environment.
  game.start();
  assert.equal(game.levels.current.number, 2);
  assert.equal(game.environment.theme, 'snowy-mountains');

  const fresh = makeEngine();
  fresh.game.start();
  assert.equal(fresh.game.environment.theme, 'countryside');

  // ?level=N preview starts at level N without touching real saves.
  const realSave = storage();
  realSave.setItem(LEVEL_SAVE_KEY, JSON.stringify({
    version: 1, journeySeed: 7, currentLevel: 1, unlockedThrough: 1,
    completedThrough: 0, levelScore: 0, runScore: 0, lifetimeScore: 0, checkpoint: null,
  }));
  const preview = makeEngine({ search: '?level=4', save: realSave });
  assert.equal(preview.game.levels.current.number, 4);
  assert.equal(preview.game.environment.theme, 'moonlit-forest');
  preview.game.start();
  for (let index = 0; index < 120; index += 1) preview.game.step(1 / 60);
  const stored = JSON.parse(realSave.values.get(LEVEL_SAVE_KEY));
  assert.equal(stored.currentLevel, 1, 'preview play never rewrites the real save');

  assert.throws(() => new LevelManager({ storage: storage(), initialLevel: 0 }), RangeError);
  assert.throws(() => new LevelManager({ storage: storage(), initialLevel: 1.5 }), RangeError);
  assert.equal(new LevelManager({ storage: storage(), initialLevel: 3 }).current.number, 3);
});

test('Returning to the menu restores the current level environment and terrain stays intact', () => {
  const { game } = makeEngine();
  game.start();
  for (let index = 0; index < 300; index += 1) game.step(1 / 60);
  const heightBefore = game.terrainAt(1500);
  game.togglePause();
  game.returnToMenu();
  assert.equal(game.status, 'menu');
  assert.equal(game.environment.theme, 'countryside');
  assert.ok(Number.isFinite(game.terrainAt(1500)));
  assert.equal(Math.abs(game.terrainAt(1500) - heightBefore) < 1e-6, true, 'terrain shape is untouched by the environment layer');
  game.start();
  assert.equal(game.status, 'playing');
});
