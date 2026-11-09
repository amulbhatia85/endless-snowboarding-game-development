import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 5A implementation audit: these tests assert that every system is
// actually connected to the running game — through execution paths, not the
// mere existence of classes. They double as permanent regression tripwires.

const { generateLevel, LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { OBSTACLE_PATTERNS, validPlacementMetadata, patternAvailability } = await import(moduleUrl('src/game/obstaclePlanner.ts'));
const { obstacleReady } = await import(moduleUrl('src/game/obstacleRegistry.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

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

function mockContext() {
  const coords = [];
  let operations = 0;
  const gradient = { addColorStop() {} };
  const record = (...values) => { operations += 1; coords.push(...values.filter((value) => typeof value === 'number')); };
  const context = {
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    font: '10px system-ui', textAlign: 'left', textBaseline: 'alphabetic',
    setTransform: (...v) => record(...v), clearRect: (...v) => record(...v), fillRect: (...v) => record(...v),
    strokeRect: (...v) => record(...v),
    createLinearGradient: (...v) => { record(...v); return gradient; },
    createRadialGradient: (...v) => { record(...v); return gradient; },
    save() { operations += 1; }, restore() { operations += 1; },
    translate: (...v) => record(...v), rotate: (...v) => record(...v), scale: (...v) => record(...v),
    beginPath() { operations += 1; }, closePath() { operations += 1; },
    moveTo: (...v) => record(...v), lineTo: (...v) => record(...v),
    quadraticCurveTo: (...v) => record(...v), bezierCurveTo: (...v) => record(...v),
    arc: (...v) => record(v[0], v[1], v[2]), ellipse: (...v) => record(...v.slice(0, 4)),
    fill() { operations += 1; }, stroke() { operations += 1; },
    fillText: (...v) => record(v[1], v[2]), strokeText: (...v) => record(v[1], v[2]),
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

const channelDistance = (a, b) => {
  const parse = (color) => color.match(/\d+/g).slice(0, 3).map(Number);
  const first = parse(a);
  const second = parse(b);
  return Math.max(...first.map((value, index) => Math.abs(value - second[index])));
};

const HAZARD_KINDS = ['rock', 'log', 'tree', 'gap', 'ramp', 'swinging-log', 'root', 'fence', 'ice', 'icicle', 'snowball', 'branch'];
const POWER_KINDS = ['magnet', 'shield', 'double'];

/** Drives populateAhead across the level journey and collects everything
 *  generated, exactly like a long ride would encounter. */
function harvestObstacles(game, { passes = 24, stride = 1500 } = {}) {
  const run = game.run;
  const kinds = {};
  const patterns = {};
  const objects = [];
  run.elapsed = Math.max(5, run.elapsed);
  run.objects = [];
  run.recentPatterns = [];
  run.rider.x = 5000;
  run.rider.y = game.terrainAt(run.rider.x) - 5;
  run.distance = run.rider.x;
  run.hazardClearUntil = run.rider.x + 640;
  run.nextHazardX = run.rider.x + 650;
  run.nextCoinX = 1e12;
  run.nextPowerX = 1e12;
  for (let pass = 0; pass < passes; pass += 1) {
    run.rider.x += stride;
    run.distance = run.rider.x;
    game.populateAhead(run);
    for (const object of run.objects) {
      if (object.kind === 'coin' || POWER_KINDS.includes(object.kind)) continue;
      kinds[object.kind] = (kinds[object.kind] ?? 0) + 1;
      if (object.plan) patterns[object.plan.patternId] = (patterns[object.plan.patternId] ?? 0) + 1;
      objects.push(object);
    }
  }
  return { kinds, patterns, objects };
}

// ───────────────────── level & environment binding ─────────────────────

test('Levels 1–4 bind to their intended environments and themes', () => {
  const expected = [
    [1, 'countryside', 'Green Hills'],
    [2, 'snowy-mountains', 'Snowfall Adventure'],
    [3, 'misty-mountains', 'Misty Mountains'],
    [4, 'moonlit-forest', 'Moonlit Forest'],
  ];
  for (const [number, environment, name] of expected) {
    const level = generateLevel(number, 4242);
    assert.equal(level.environment, environment);
    assert.equal(level.name, name);
  }
  // A fresh save starts at level 1 — the default experience.
  const { game } = makeEngine();
  game.start();
  assert.equal(game.levels.current.number, 1);
  assert.equal(game.levels.current.environment, 'countryside');
  assert.equal(game.run.levelIndex + 1, 1);
});

test('?level=N preview engines run the requested level end to end', () => {
  for (const n of [2, 3, 4]) {
    const { game } = makeEngine({ search: `?level=${n}` });
    game.start();
    assert.equal(game.levels.current.number, n, `level ${n} config`);
    assert.equal(game.run.levelIndex + 1, n, `level ${n} HUD`);
    assert.equal(game.environment.palette(0).snow !== '', true);
  }
});

test('Environments differ per level: palette, weather, decorations, terrain', () => {
  const engines = {};
  const palettes = {};
  const weathers = {};
  const decorationKinds = {};
  const terrainSeries = {};
  for (const n of [1, 2, 3, 4]) {
    const { game } = makeEngine({ save: seedSave(4242, n) });
    game.start();
    engines[n] = game;
    palettes[n] = game.environment.palette(0.3);
    weathers[n] = game.environment.weatherEffects().map((effect) => effect.kind).sort();
    decorationKinds[n] = new Set(game.environment.decorationsNear(0, 4000).map((item) => item.kind));
    const heights = Array.from({ length: 48 }, (_, index) => game.terrainAt(index * 400));
    terrainSeries[n] = heights;
    // Procedural terrain is active: the surface genuinely varies.
    const spread = Math.max(...heights) - Math.min(...heights);
    assert.ok(spread > 10, `L${n} terrain varies (spread ${Math.round(spread)}px)`);
  }
  // Ground palettes are pairwise distinct (green / white / grey / night-blue).
  for (const a of [1, 2, 3, 4]) for (const b of [1, 2, 3, 4]) {
    if (a >= b) continue;
    assert.ok(channelDistance(palettes[a].snow, palettes[b].snow) > 30, `L${a} vs L${b} ground colour`);
  }
  assert.deepEqual(weathers[2], ['snow', 'wind']);
  assert.deepEqual(weathers[3], ['fog', 'wind']);
  assert.ok(weathers[1].includes('wind') && !weathers[1].includes('snow') && !weathers[1].includes('fog'));
  assert.ok(weathers[4].includes('fog') && !weathers[4].includes('snow'));
  assert.ok(decorationKinds[2].has('drift') && decorationKinds[4].has('glow-shroom') && decorationKinds[1].has('grass'));
  for (const a of [1, 2, 3, 4]) for (const b of [1, 2, 3, 4]) {
    if (a >= b) continue;
    const differs = [...decorationKinds[a]].some((kind) => !decorationKinds[b].has(kind));
    assert.ok(differs, `L${a} vs L${b} decoration sets differ`);
    assert.notDeepEqual(terrainSeries[a], terrainSeries[b], `L${a} vs L${b} terrain series`);
  }
});

// ───────────────────── execution-path proof (no legacy bypass) ─────────────────────

test('Every frame of scenery renders through the EnvironmentManager', () => {
  const { game } = makeEngine();
  game.start();
  const env = game.environment;
  const calls = [];
  for (const name of ['drawSky', 'drawBackground', 'drawDecorations', 'drawAmbient', 'drawWeather']) {
    const original = env[name].bind(env);
    env[name] = (...args) => { calls.push(name); return original(...args); };
  }
  game.draw();
  for (const name of ['drawSky', 'drawBackground', 'drawDecorations', 'drawAmbient', 'drawWeather']) {
    assert.ok(calls.includes(name), `draw() must delegate ${name} to the environment`);
  }
});

test('The engine source contains no legacy scenery or obstacle-placement code', () => {
  const source = readFileSync(new URL('../src/game/engine.ts', import.meta.url), 'utf8');
  for (const legacy of ['private drawSky(', 'private drawMountains(', 'private drawClouds(', 'private drawSnow(', 'getPalette(', 'PALETTE_STOPS']) {
    assert.ok(!source.includes(legacy), `legacy code must not return: ${legacy}`);
  }
  assert.ok(source.includes('this.obstaclePlanner.plan('), 'hazard placement must go through the ObstaclePlanner');
  assert.ok(source.includes('this.difficulty.directive('), 'planning must consult the DifficultyManager');
  assert.ok(source.includes('this.environment.setLevel('), 'level changes must rebind the environment');
});

test('Every generated hazard is planner-produced with valid physics metadata', () => {
  for (const n of [1, 2, 3, 4, 8, 21]) {
    const { game } = makeEngine({ save: seedSave(4242, n) });
    game.start();
    const { kinds, patterns, objects } = harvestObstacles(game);
    const level = game.levels.current;
    const activeAllowed = level.allowedObstacles.filter((id) => obstacleReady(id));
    assert.ok(objects.length >= 10, `L${n} generated ${objects.length} hazards`);
    for (const object of objects) {
      assert.ok(HAZARD_KINDS.includes(object.kind), `L${n} kind ${object.kind} is a known hazard`);
      if (object.kind === 'gap' && object.bridged) {
        assert.ok(activeAllowed.includes('bridge'), 'bridges only where the theme allows');
      } else {
        assert.ok(activeAllowed.includes(object.kind), `L${n} ${object.kind} is allowed+implemented in ${level.environment}`);
      }
      assert.ok(object.plan, 'hazard carries planner metadata (not hand-placed)');
      assert.equal(validPlacementMetadata(object.plan), true, 'planner metadata validates');
    }
    // Difficulty pacing is live in the engine's own planning pass.
    assert.ok(game.lastDirective, 'directive computed');
    assert.equal(game.lastDirective.level, n);
    // The pattern mix really differs per level (environment + difficulty).
    if (n === 1) assert.ok(!Object.keys(patterns).includes('ramp-gap'));
    if (n >= 4) assert.ok(Object.keys(patterns).length >= 2, `L${n} mixes patterns`);
  }
  // Global variety: across levels the scheduler uses a broad pattern palette.
  const union = new Set();
  for (const n of [1, 2, 3, 4, 8, 21]) {
    const { game } = makeEngine({ save: seedSave(4242, n) });
    game.start();
    for (const id of Object.keys(harvestObstacles(game).patterns)) union.add(id);
  }
  assert.ok(union.size >= 8, `pattern variety across levels (got ${[...union].join(', ')})`);
});

test('DifficultyManager visibly changes pacing between levels', () => {
  const samples = {};
  for (const n of [1, 21]) {
    const { game } = makeEngine({ save: seedSave(4242, n) });
    game.start();
    const run = game.run;
    run.elapsed = 5;
    run.rider.x = 350_000;
    run.rider.y = game.terrainAt(run.rider.x) - 5;
    run.distance = run.rider.x;
    run.hazardClearUntil = run.rider.x + 640;
    run.nextHazardX = run.rider.x + 650;
    run.nextCoinX = run.nextPowerX = 1e12;
    game.populateAhead(run);
    const directive = game.lastDirective;
    // Chain real plans at this progress and measure obstacle density + gaps.
    const planner = game.obstaclePlanner;
    const spacing = [];
    let hazards = 0;
    const state = { x: run.nextHazardX, clear: run.hazardClearUntil };
    for (let index = 0; index < 16; index += 1) {
      const plan = planner.plan({
        level: game.levels.current, candidateX: state.x, riderX: run.rider.x, riderSpeed: 380, riderAcceleration: 10,
        surface: (x) => game.terrainAt(x), clearUntil: state.clear, bridgeAllowedAfter: 0, rampAllowedAfter: 0,
        reserved: [], nearby: [], directive, recentPatterns: run.recentPatterns ?? [],
      });
      if (plan.obstacles.length) {
        spacing.push(plan.nextX - plan.clearUntil);
        hazards += plan.obstacles.length;
      }
      state.x = plan.nextX;
      state.clear = Math.max(state.clear, plan.clearUntil);
    }
    samples[n] = { directive, spacing, hazards };
  }
  assert.ok(samples[21].directive.intensity > samples[1].directive.intensity + 0.3,
    `intensity L21 ${samples[21].directive.intensity.toFixed(2)} vs L1 ${samples[1].directive.intensity.toFixed(2)}`);
  assert.ok(samples[1].directive.minSpacing > samples[21].directive.minSpacing + 40,
    'L1 grants wider base recovery spacing than L21');
  // Density: harder levels pack more hazards per planning slot through
  // combinations, even though dangerous patterns earn wider corridors.
  // Phase 11 — variety floors spread late-level selections across the rare
  // single-obstacle families too, so the per-slot margin is +3 (measured
  // 20 vs 16, +25%).
  assert.ok(samples[21].hazards > samples[1].hazards + 3,
    `hazard density L21 ${samples[21].hazards} vs L1 ${samples[1].hazards} over the same slots`);
});

// ───────────────────── developer level selector ─────────────────────

test('The developer level selector switches levels without touching saved progress', () => {
  const save = seedSave(4242, 2);
  const { game } = makeEngine({ save });
  game.start();
  assert.equal(game.levels.current.number, 2);
  assert.equal(game.levels.current.environment, 'snowy-mountains');
  const paletteBefore = game.environment.palette(0.3).snow;
  const weatherBefore = game.environment.weatherEffects().map((effect) => effect.kind).sort().join(',');

  // Normal play writes a level-2 checkpoint — that is the legitimate baseline.
  const savedAtSwitch = save.getItem(LEVEL_SAVE_KEY);
  assert.ok(!savedAtSwitch.includes('"currentLevel":4'), 'no preview level recorded yet');

  assert.equal(game.startLevelPreview(0), false);
  assert.equal(game.startLevelPreview(2.5), false);
  assert.equal(game.levels.current.number, 2, 'invalid previews are rejected');

  assert.equal(game.startLevelPreview(4), true);
  assert.equal(game.levels.current.number, 4);
  assert.equal(game.levels.current.environment, 'moonlit-forest');
  assert.equal(game.run.levelIndex + 1, 4);
  assert.equal(game.status, 'playing');
  assert.ok(channelDistance(paletteBefore, game.environment.palette(0.3).snow) > 30
    || weatherBefore !== game.environment.weatherEffects().map((effect) => effect.kind).sort().join(','),
    'visual identity changes with the level');
  // Ride a little: checkpoints must go to the throwaway store, never the real one.
  for (let frame = 0; frame < 300; frame += 1) {
    game.clock += 1 / 60;
    game.step(1 / 60);
  }
  assert.equal(save.getItem(LEVEL_SAVE_KEY), savedAtSwitch, 'saved progression is byte-identical while previewing');

  // Switching back and forth is stable and each level rebinds correctly.
  for (const [n, environment] of [[1, 'countryside'], [3, 'misty-mountains'], [2, 'snowy-mountains']]) {
    assert.equal(game.startLevelPreview(n), true);
    assert.equal(game.levels.current.environment, environment);
    assert.equal(game.levels.current.number, game.run.levelIndex + 1);
  }
  assert.equal(save.getItem(LEVEL_SAVE_KEY), savedAtSwitch, 'saved progression still untouched');
});

test('?dev=1 sandboxes the whole session — even normal play never touches storage', () => {
  const save = seedSave(4242, 3);
  const savedBefore = save.getItem(LEVEL_SAVE_KEY);
  const { game } = makeEngine({ search: '?dev=1', save });
  // The dev session ignores the stored journey: it starts fresh, in memory.
  assert.equal(game.obstacleDebug, true);
  game.start();
  assert.equal(game.levels.current.number, 1);
  game.startLevelPreview(3);
  for (let frame = 0; frame < 200; frame += 1) {
    game.clock += 1 / 60;
    game.step(1 / 60);
  }
  assert.equal(save.getItem(LEVEL_SAVE_KEY), savedBefore, 'a dev session is fully sandboxed');
});

test('The diagnostics overlay reports the live system state', () => {
  const { game } = makeEngine({ search: '?dev=1' });
  assert.equal(game.obstacleDebug, true, '?dev=1 enables the overlay');
  game.start();
  const run = game.run;
  run.elapsed = 5;
  run.rider.x = 20_000;
  run.distance = run.rider.x;
  run.hazardClearUntil = run.rider.x + 640;
  run.nextHazardX = run.rider.x + 650;
  run.nextCoinX = run.nextPowerX = 1e12;
  game.populateAhead(run);
  const lines = [];
  const debugContext = new Proxy({}, { get: (_target, name) => (name === 'fillText' ? (text) => lines.push(text) : () => {}) });
  game.drawObstacleDebug(debugContext, run, 0);
  const joined = lines.join('\n');
  for (const fragment of ['LVL 1 · COUNTRYSIDE', 'DIFF ', 'ZONE ', 'WAVE ', 'PATTERN ', 'WEATHER ', 'TERRAIN ', 'OBSTACLES ']) {
    assert.ok(joined.includes(fragment), `diagnostics show ${fragment}`);
  }
  assert.ok(/WEATHER (wind|snow|fog|clear)/.test(joined));
  assert.ok(/chunk \d+/.test(joined), 'terrain chunk is reported');
  assert.ok(joined.includes('rock'), 'available obstacle types are listed');
  assert.ok(/patterns \d+\/\d+/.test(joined), 'pattern availability is reported');
});
