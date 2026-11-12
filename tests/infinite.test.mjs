import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

const { LevelManager, generateLevel, LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { TerrainGenerator, TerrainWorld, TERRAIN_MAX_SLOPE } = await import(moduleUrl('src/game/terrain.ts'));
const { ObstaclePlanner, patternAvailability } = await import(moduleUrl('src/game/obstaclePlanner.ts'));
const { DifficultyManager } = await import(moduleUrl('src/game/difficulty.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

const THEMES = ['countryside', 'snowy-mountains', 'misty-mountains', 'moonlit-forest', 'jungle'];
const LEGACY_LEVELS = {
  1: { environment: 'countryside', name: 'Green Hills' },
  2: { environment: 'snowy-mountains', name: 'Snowfall Adventure' },
  3: { environment: 'misty-mountains', name: 'Misty Mountains' },
  4: { environment: 'moonlit-forest', name: 'Moonlit Forest' },
};
const PROFILE_IDS = ['classic', 'flowing-hills', 'mountain-descent', 'gradual-climb', 'rolling-valleys', 'technical-slopes', 'controlled-flats', 'mixed-terrain'];
const ZERO_WEIGHT = {
  countryside: ['technical-slopes'],
  'snowy-mountains': ['gradual-climb', 'controlled-flats'],
  'misty-mountains': ['flowing-hills'],
  'moonlit-forest': ['mountain-descent'],
  jungle: ['mountain-descent'],
};

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
    fillText: (...values) => record(...values.slice(1, 3)),
    strokeText: (...values) => record(...values.slice(1, 3)),
    drawImage() { operations += 1; },
  };
  return { context, coords, get operations() { return operations; } };
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
  const game = new SnowGameEngine({
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    getContext: () => recorder.context,
  }, { onStatus() {}, onHud() {}, onGameOver() {} });
  return { game, recorder, save };
}

function validConfiguration(level) {
  assert.ok(Number.isInteger(level.number) && level.number >= 1);
  assert.equal(level.targetScore, 50000);
  assert.ok(THEMES.includes(level.environment));
  assert.ok(PROFILE_IDS.includes(level.profile.id));
  assert.equal(typeof level.profile.label, 'string');
  for (const value of Object.values(level.profile.terrain)) {
    assert.ok(Number.isFinite(value), 'terrain bias values are finite');
  }
  // Phase 13 — mountain-descent deepened to 1.55 (the terrain generator's
  // anchor clamp keeps every chunk inside the 0.34 slope cap at any bias).
  assert.ok(level.profile.terrain.rangeScale >= 0.55 && level.profile.terrain.rangeScale <= 1.6);
  assert.ok(level.profile.terrain.bumpScale >= 0.3 && level.profile.terrain.bumpScale <= 1.3);
  assert.ok(level.profile.terrain.recoveryScale >= 0.55 && level.profile.terrain.recoveryScale <= 1.45);
  assert.ok(Math.abs(level.profile.terrain.valleyBias) <= 0.12);
  // Phase 15 — deep mountain runs: 0 (never) .. 1 (the mountain-descent identity).
  assert.ok(level.profile.terrain.descentScale >= 0 && level.profile.terrain.descentScale <= 1);
  assert.ok(level.allowedObstacles.length >= 3);
  assert.ok(level.weather.intensity >= 0 && level.weather.intensity <= 0.95);
  assert.ok(level.weather.speed >= 0.2 && level.weather.speed <= 1.5);
  assert.ok(['clear', 'snow', 'mist', 'night'].includes(level.weather.kind));
  assert.equal(level.transitions.start.kind, 'house-exit');
  assert.equal(level.transitions.end.kind, 'safe-house');
  assert.ok(Number.isFinite(level.seed));
}

// ───────────────────────── levels 1–20 ─────────────────────────

test('Levels 1–20 produce valid, deterministic configurations with the classic prefix intact', () => {
  for (let number = 1; number <= 20; number += 1) {
    const level = generateLevel(number, 4242);
    validConfiguration(level);
    assert.deepEqual(level, generateLevel(number, 4242), `level ${number} regenerates identically`);
    assert.notEqual(level.seed, generateLevel(number, 4243).seed, `level ${number} depends on the journey seed`);
    assert.ok(level.name.length > 0);
  }
  // The first four levels keep their tuned identity — including neutral
  // terrain (byte-identical to Phase 8), no focus and the legacy weather.
  for (const [number, expected] of Object.entries(LEGACY_LEVELS)) {
    const level = generateLevel(Number(number), 4242);
    assert.equal(level.environment, expected.environment);
    assert.equal(level.name, expected.name);
    assert.equal(level.profile.id, 'classic');
    assert.deepEqual(level.profile.terrain, { rangeScale: 1, bumpScale: 1, recoveryScale: 1, valleyBias: 0, descentScale: 0 });
    assert.deepEqual(level.obstacleFocus, []);
    if (number === '1') assert.deepEqual(level.weather, { kind: 'clear', intensity: 0, speed: 1 });
    if (number === '2') assert.deepEqual(level.weather, { kind: 'snow', intensity: 0.5, speed: 0.38 });
  }
  // Generated levels carry an identity: a real profile and a focus list.
  for (let number = 5; number <= 20; number += 1) {
    const level = generateLevel(number, 4242);
    assert.notEqual(level.profile.id, 'classic');
    assert.ok(level.obstacleFocus.length >= 2 && level.obstacleFocus.length <= 4);
    for (const id of level.obstacleFocus) assert.ok(level.allowedObstacles.includes(id), 'focus ⊆ allowed');
    assert.ok(new Set(level.obstacleFocus).size === level.obstacleFocus.length, 'focus has no duplicates');
  }
});

// ───────────────────────── environment rotation ─────────────────────────

test('Environment rotation beyond level 4 never repeats or ping-pongs and stays balanced', () => {
  for (const journeySeed of [42, 777, 20260101]) {
    const environments = [];
    for (let number = 1; number <= 104; number += 1) environments.push(generateLevel(number, journeySeed).environment);
    for (let number = 5; number <= 104; number += 1) {
      assert.ok(environments[number - 1] !== environments[number - 2], `L${number} repeats the previous environment (seed ${journeySeed})`);
      assert.ok(environments[number - 1] !== environments[number - 3], `L${number} ping-pongs with two levels back (seed ${journeySeed})`);
    }
    // No theme vanishes: with five environments in the mix, every 15-level
    // window still shows at least four of them (verified: no repeats and no
    // ping-pongs make long absences structurally impossible).
    for (let start = 5; start + 14 <= 104; start += 1) {
      const window = new Set(environments.slice(start - 1, start + 14));
      assert.ok(window.size >= 4, `window ${start}..${start + 14} lost two themes`);
    }
    // And the mix stays reasonably balanced over the first hundred levels.
    const counts = {};
    for (let number = 5; number <= 104; number += 1) counts[environments[number - 1]] = (counts[environments[number - 1]] ?? 0) + 1;
    for (const theme of THEMES) assert.ok(counts[theme] >= 15, `${theme} appears ${counts[theme] ?? 0}/100 times (seed ${journeySeed})`);
    // Different journeys diverge (not one shared fixed rotation).
    const other = [];
    for (let number = 5; number <= 40; number += 1) other.push(generateLevel(number, 9090).environment);
    assert.notDeepEqual(environments.slice(4, 40), other, 'seeds produce different sequences');
  }
});

// ───────────────────────── profiles ─────────────────────────

test('Terrain profiles follow theme weights, never repeat back to back and stay varied', () => {
  const seen = new Set();
  for (let number = 5; number <= 104; number += 1) {
    const level = generateLevel(number, 4242);
    const previous = generateLevel(number - 1, 4242);
    seen.add(level.profile.id);
    assert.ok(level.profile.id !== previous.profile.id, `L${number} repeats the previous profile`);
    // Theme-appropriate: zero-weight combinations are never generated.
    assert.ok(!ZERO_WEIGHT[level.environment].includes(level.profile.id),
      `L${number} generated ${level.profile.id} in ${level.environment}`);
  }
  assert.ok(seen.size >= 5, `at least 5 distinct profiles over 100 levels (${seen.size})`);
});

// ───────────────────────── obstacle focus ─────────────────────────

test('Dominant obstacle families vary per level and stay inside the theme', () => {
  const sets = new Set();
  for (let number = 5; number <= 104; number += 1) {
    const level = generateLevel(number, 4242);
    const previous = generateLevel(number - 1, 4242);
    assert.ok(level.obstacleFocus.every((id) => level.allowedObstacles.includes(id)), `L${number} focus within theme`);
    assert.notDeepEqual(level.obstacleFocus, previous.obstacleFocus, `L${number} repeats the previous focus`);
    sets.add([...level.obstacleFocus].sort().join(','));
  }
  assert.ok(sets.size >= 10, `focus variety over 100 levels (${sets.size} distinct sets)`);
});

// ───────────────────────── weather ─────────────────────────

test('Weather stays theme-bound while its intensity varies per generated level', () => {
  const THEME_KIND = { countryside: 'clear', 'snowy-mountains': 'snow', 'misty-mountains': 'mist', 'moonlit-forest': 'night', jungle: 'mist' };
  const intensities = {};
  for (let number = 5; number <= 104; number += 1) {
    const level = generateLevel(number, 4242);
    assert.equal(level.weather.kind, THEME_KIND[level.environment], `L${number} keeps the theme weather kind`);
    (intensities[level.environment] ??= new Set()).add(Math.round(level.weather.intensity * 1000));
  }
  for (const theme of ['snowy-mountains', 'misty-mountains', 'moonlit-forest', 'jungle']) {
    assert.ok(intensities[theme].size >= 3, `${theme} varies its weather intensity (${intensities[theme].size} distinct)`);
  }
});

// ───────────────────────── terrain ─────────────────────────

test('Generated terrain is deterministic, continuous, slope-capped and varied across levels', () => {
  const sampled = [5, 12, 23, 47, 61, 88, 101, 202, 404, 606, 808, 1000];
  const series = {};
  for (const number of sampled) {
    const level = generateLevel(number, 4242);
    const terrain = new TerrainGenerator(level);
    const twin = new TerrainGenerator(generateLevel(number, 4242));
    for (let index = 0; index < 60; index += 1) {
      const x = index * 640 + 137;
      assert.equal(terrain.heightAt(x), twin.heightAt(x), `L${number} terrain is deterministic`);
    }
    // Continuity + the hard slope cap everywhere.
    let previousY = terrain.heightAt(0);
    for (let x = 4; x <= 40000; x += 8) {
      const y = terrain.heightAt(x);
      const slope = (y - previousY) / 8;
      assert.ok(Math.abs(slope) <= TERRAIN_MAX_SLOPE + 0.005, `L${number} slope ${slope.toFixed(3)} at ${x}`);
      assert.ok(Number.isFinite(y));
      previousY = y;
    }
    series[number] = Array.from({ length: 24 }, (_, index) => Math.round(terrain.heightAt(1000 + index * 640)));
  }
  // Levels genuinely differ (not one recycled landscape).
  const keys = Object.keys(series);
  for (let a = 0; a < keys.length; a += 1) {
    for (let b = a + 1; b < keys.length; b += 1) {
      assert.notDeepEqual(series[keys[a]], series[keys[b]], `levels ${keys[a]} and ${keys[b]} differ`);
    }
  }
});

test('Terrain profiles measurably change the landscape statistics', () => {
  // Find a controlled-flats and a technical-slopes level in the same theme.
  let flats;
  let technical;
  for (let number = 5; number <= 400 && !(flats && technical); number += 1) {
    const level = generateLevel(number, 4242);
    if (!flats && level.profile.id === 'controlled-flats') flats = level;
    if (!technical && level.profile.id === 'technical-slopes') technical = level;
  }
  assert.ok(flats, 'a controlled-flats level exists by level 400');
  assert.ok(technical, 'a technical-slopes level exists by level 400');
  const measure = (level) => {
    const terrain = new TerrainGenerator(level);
    let recovery = 0;
    let roughness = 0;
    for (let index = 0; index < 240; index += 1) {
      const chunk = terrain.chunk(index);
      if (chunk.pattern === 'recovery') recovery += 1;
      roughness += Math.abs(chunk.bump);
    }
    return { recovery, roughness };
  };
  const flatStats = measure(flats);
  const techStats = measure(technical);
  assert.ok(flatStats.recovery > techStats.recovery, `flats rest more (${flatStats.recovery} vs ${techStats.recovery} recovery chunks)`);
  assert.ok(flatStats.roughness < techStats.roughness, `technical terrain is rougher (${techStats.roughness} vs ${flatStats.roughness} bump energy)`);
});

// ───────────────────────── levels 101–1000 and beyond ─────────────────────────

test('Levels 101–1000 stay valid, deterministic and rotation-clean', () => {
  for (const number of [101, 133, 155, 178, 202, 247, 303, 361, 404, 468, 505, 577, 606, 707, 808, 909, 1000]) {
    const level = generateLevel(number, 4242);
    validConfiguration(level);
    assert.deepEqual(level, generateLevel(number, 4242));
    const previous = generateLevel(number - 1, 4242);
    const before = generateLevel(number - 2, 4242);
    assert.ok(level.environment !== previous.environment && level.environment !== before.environment, `L${number} rotation clean`);
    assert.ok(level.difficulty.progression <= 1, 'progression is capped');
  }
});

test('Levels beyond 1000 generate deterministically and fast', () => {
  for (const number of [1001, 1234, 2500, 5000, 9999, 12345]) {
    const level = generateLevel(number, 4242);
    validConfiguration(level);
    assert.deepEqual(level, generateLevel(number, 4242));
  }
  const coldStart = Date.now();
  const big = generateLevel(999999, 31337);
  const coldMs = Date.now() - coldStart;
  validConfiguration(big);
  const warmStart = Date.now();
  assert.deepEqual(generateLevel(999999, 31337), big);
  const warmMs = Date.now() - warmStart;
  assert.ok(coldMs < 4000, `cold chain walk to 999999 took ${coldMs}ms`);
  assert.ok(warmMs < 100, `warm regeneration took ${warmMs}ms`);
  // Chain results never depend on the order levels were asked for.
  const ascending = [];
  for (let number = 5; number <= 80; number += 1) ascending.push(generateLevel(number, 5150).environment);
  const descending = [];
  for (let number = 80; number >= 5; number -= 1) descending[number - 5] = generateLevel(number, 5150).environment;
  assert.deepEqual(ascending, descending, 'identity chain is order-independent');
});

// ───────────────────────── difficulty ─────────────────────────

test('Difficulty saturates: monotonic, capped and fair at any level number', () => {
  const manager = new DifficultyManager();
  let previous = 0;
  for (const number of [1, 2, 3, 5, 10, 20, 50, 100, 500, 1000, 5000, 100000, 999999]) {
    const intensity = manager.levelIntensity(number);
    assert.ok(intensity >= previous - 1e-12, 'level intensity is monotonic');
    assert.ok(intensity <= 0.9 + 1e-12, `intensity capped at ${intensity}`);
    previous = intensity;
  }
  const level = generateLevel(5000, 4242);
  const directive = manager.directive({ level, progress: 0.7, terrainComplexity: 0.5 });
  assert.ok(directive.intensity <= 1);
  assert.ok(directive.reactionSeconds >= 0.95, 'reaction time never drops below the planner floor');
  assert.ok(manager.directive({ level, progress: 0.95 }).safeApproach, 'the final approach is always safe');
  assert.ok(level.difficulty.progression === 1, 'terrain scaling saturates');
});

// ───────────────────────── planner ─────────────────────────

function planSequence(level, count, surface) {
  const planner = new ObstaclePlanner();
  const state = {
    level, candidateX: 1000, riderX: 0, riderSpeed: 250, riderAcceleration: 10,
    surface, clearUntil: 640, bridgeAllowedAfter: 0, rampAllowedAfter: 0,
    reserved: [{ start: 0, end: 640 }], nearby: [],
  };
  const output = [];
  for (let index = 0; index < count; index += 1) {
    state.riderX = Math.max(0, state.candidateX - 1100);
    state.nearby = output.flatMap((plan) => plan.obstacles).slice(-8);
    const plan = planner.plan(state);
    output.push(plan);
    state.candidateX = plan.nextX;
    state.clearUntil = Math.max(state.clearUntil, plan.clearUntil);
    if (plan.obstacles.some((object) => object.bridged)) state.bridgeAllowedAfter = plan.clearUntil + 4500;
  }
  return output;
}

test('The planner leans on the level focus and never leaves the theme', () => {
  let focusedHits = 0;
  let strippedHits = 0;
  let total = 0;
  let dominated = 0;
  const checked = [];
  for (const number of [7, 23, 61, 122, 303]) {
    const level = generateLevel(number, 4242);
    const terrain = new TerrainGenerator(level);
    const surface = (x) => 360 + terrain.heightAt(x);
    const placed = planSequence(level, 60, surface).flatMap((plan) => plan.obstacles);
    assert.ok(placed.length > 10);
    for (const obstacle of placed) {
      assert.ok(level.allowedObstacles.includes(obstacle.plan.obstacleId), `L${number} generated ${obstacle.plan.obstacleId} outside the theme`);
      total += 1;
      if (level.obstacleFocus.includes(obstacle.plan.obstacleId)) focusedHits += 1;
    }
    // Causal check: stripping the focus must reduce the emphasis.
    const stripped = { ...level, obstacleFocus: [] };
    const strippedPlaced = planSequence(stripped, 60, surface).flatMap((plan) => plan.obstacles);
    const strippedRate = strippedPlaced.filter((obstacle) => level.obstacleFocus.includes(obstacle.plan.obstacleId)).length / Math.max(1, strippedPlaced.length);
    const focusedRate = placed.filter((obstacle) => level.obstacleFocus.includes(obstacle.plan.obstacleId)).length / Math.max(1, placed.length);
    if (focusedRate > strippedRate) dominated += 1;
    checked.push(`L${number} ${(focusedRate).toFixed(2)} vs ${(strippedRate).toFixed(2)}`);
  }
  assert.ok(dominated >= 3, `focus dominates in most levels (${dominated}/5: ${checked.join('; ')})`);
  assert.ok(focusedHits / total >= 0.3, `focus families dominate overall (${focusedHits}/${total})`);
});

test('No unsupported obstacle type is ever generated at any level', () => {
  for (const number of [5, 9, 20, 64, 129, 500, 2222]) {
    const level = generateLevel(number, 4242);
    for (const availability of patternAvailability(level)) {
      if (!availability.available) continue;
      // Every available pattern's requirements sit inside the allowed list.
      assert.ok(!availability.reason, `L${number}: ${availability.id} unavailable yet marked available`);
    }
    const terrain = new TerrainGenerator(level);
    const surface = (x) => 360 + terrain.heightAt(x);
    const placed = planSequence(level, 30, surface).flatMap((plan) => plan.obstacles);
    for (const obstacle of placed) {
      assert.ok(level.allowedObstacles.includes(obstacle.plan.obstacleId), `L${number} generated ${obstacle.plan.obstacleId}`);
    }
  }
});

// ───────────────────────── engine end-to-end ─────────────────────────

test('A high generated level plays end to end inside its theme with bounded caches', () => {
  const { game } = makeEngine({ save: seedSave(4242, 61) });
  game.start();
  assert.equal(game.levels.current.number, 61);
  const level = game.levels.current;
  const kinds = new Set();
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 3);
  for (let index = 0; index < 2400; index += 1) {
    run.invulnerableUntil = run.elapsed + 10; // keep riding through hazards for generation auditing
    game.step(1 / 60);
    game.environment.update(1 / 60, {
      width: 900, height: 600, cameraX: run.cameraX, cameraDx: 4,
      storm: 0.2, lighter: false, groundAt: (x) => game.terrainAt(x),
    });
    if (index % 45 === 0) game.draw();
    for (const object of run.objects) {
      if (['rock', 'log', 'tree', 'gap', 'ramp', 'swinging-log', 'root', 'fence', 'ice', 'icicle', 'snowball', 'branch'].includes(object.kind)) {
        kinds.add(object.kind);
      }
    }
  }
  assert.ok(Number.isFinite(run.rider.x) && Number.isFinite(run.rider.y), 'rider state stays finite');
  for (const kind of kinds) assert.ok(level.allowedObstacles.includes(kind), `engine generated ${kind} outside L61's theme`);
  assert.ok(kinds.size >= 2, `variety of hazards (${[...kinds].join(',')})`);
  // Bounded caches: generation cost does not grow with distance ridden.
  assert.ok(game.terrain.cachedChunks < 400, `terrain cache bounded (${game.terrain.cachedChunks})`);
  assert.ok(game.environment.decorationChunkCount < 400, `decoration cache bounded (${game.environment.decorationChunkCount})`);
});

test('House transitions work at generated levels and preserve the day cycle', () => {
  const { game } = makeEngine({ save: seedSave(4242, 12) });
  game.start();
  const levelTwelve = game.levels.current;
  assert.notEqual(levelTwelve.profile.id, 'classic', 'level 12 is a generated level');
  const before = {
    phase: game.environmentView.phase,
    environment: levelTwelve.environment,
  };
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 3);
  run.objects = [];
  run.nextCoinX = run.nextHazardX = 1e12;
  run.bonus += 50000;
  game.step(0);
  assert.equal(run.levelPhase, 'approach');
  let entered = false;
  for (let index = 0; index < 2400; index += 1) {
    game.step(1 / 60);
    game.environment.update(1 / 60, {
      width: 900, height: 600, cameraX: run.cameraX, cameraDx: 4,
      storm: 0, lighter: false, groundAt: (x) => game.terrainAt(x),
    });
    if (run.levelPhase === 'celebrating') entered = true;
    if (run.levelPhase === 'riding' && run.levelIndex > 11) break;
  }
  assert.ok(entered, 'the rider entered the safe house');
  assert.equal(game.levels.current.number, 13);
  const levelThirteen = game.levels.current;
  assert.ok(levelThirteen.environment !== before.environment || levelThirteen.profile.id !== levelTwelve.profile.id,
    'the next level has a fresh identity');
  game.draw();
  assert.ok(game.environmentView.phase > before.phase, 'the global day/night cycle kept advancing');
  // Terrain stays continuous across the level boundary.
  const origin = run.terrainOrigins[run.terrainOrigins.length - 1];
  const left = game.terrainAt(origin.x - 2);
  const right = game.terrainAt(origin.x + 2);
  assert.ok(Math.abs(right - left) < 40, `terrain continuous across the origin (${left.toFixed(1)} → ${right.toFixed(1)})`);
  assert.ok(game.terrain.describe(run.rider.x)?.level === 13, 'the generator below the rider is the new level');
});

// ───────────────────────── persistence ─────────────────────────

test('Saving and reloading regenerates the exact same world at any level', () => {
  const save = storage();
  const manager = new LevelManager({ storage: save, seed: 42 });
  // Walk through three levels of real progression.
  for (let step = 0; step < 3; step += 1) {
    manager.updateScore(50000, 50000 + step * 50000);
    assert.equal(manager.markSafeHouseReached(), true);
    manager.advanceAfterTransition();
  }
  assert.equal(manager.current.number, 4);
  manager.updateScore(12000, 162000);
  const persisted = save.values.get(LEVEL_SAVE_KEY);
  assert.ok(persisted, 'progress was persisted');

  const reloaded = new LevelManager({ storage: save });
  assert.equal(reloaded.current.number, 4);
  assert.equal(reloaded.completedThrough, 3);
  assert.equal(reloaded.unlockedThrough, 4);
  assert.deepEqual(reloaded.getLevel(7), manager.getLevel(7), 'future levels regenerate identically');
  const terrainA = new TerrainGenerator(manager.getLevel(9));
  const terrainB = new TerrainGenerator(reloaded.getLevel(9));
  for (let index = 0; index < 40; index += 1) {
    assert.equal(terrainA.heightAt(index * 640 + 99), terrainB.heightAt(index * 640 + 99), 'terrain identical after reload');
  }
});

test('Level previews never touch permanent progress, even at level 500', () => {
  const save = storage();
  const manager = new LevelManager({ storage: save, seed: 4242 });
  manager.updateScore(50000, 50000);
  assert.equal(manager.markSafeHouseReached(), true);
  manager.advanceAfterTransition(); // persists level 2 with a completed level 1
  const before = save.values.get(LEVEL_SAVE_KEY);
  assert.ok(before.includes('"currentLevel":2'), 'progress was persisted');
  const preview = manager.enterPreview(500);
  assert.equal(preview.number, 500);
  assert.notEqual(preview.profile.id, 'classic');
  assert.ok(preview.obstacleFocus.length >= 2);
  assert.equal(manager.current.number, 500);
  // The real save is untouched and a fresh manager sees the true progress.
  assert.equal(save.values.get(LEVEL_SAVE_KEY), before, 'preview wrote nothing permanent');
  const reloaded = new LevelManager({ storage: save });
  assert.equal(reloaded.current.number, 2, 'the preview did not advance the real journey');
  assert.equal(reloaded.completedThrough, 1);
});

test('The developer level report reproduces any level deterministically', () => {
  const { game } = makeEngine({ save: seedSave(4242, 23) });
  game.start();
  const report = game.devLevelReport();
  for (const marker of ['LEVEL 23', 'ENVIRONMENT', 'PROFILE', 'SEED', 'TERRAIN BIAS', 'DIFFICULTY', 'WEATHER', 'OBSTACLES', 'FOCUS', 'PATTERNS', 'TARGET 50000']) {
    assert.ok(report.includes(marker), `report includes ${marker}`);
  }
  assert.equal(report, game.devLevelReport(), 'the report is stable');
  const future = game.devLevelReport(427);
  assert.ok(future.includes('LEVEL 427'), 'any level number can be inspected');
  assert.ok(future.includes(game.levels.getLevel(427).profile.label), 'the inspected profile matches generateLevel');
  assert.notEqual(future, report);
});
