import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { moduleUrl } from './loadTypeScript.mjs';

const { generateLevel, LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { TerrainGenerator, TerrainWorld, TERRAIN_CHUNK_WIDTH: WIDTH, TERRAIN_MAX_SLOPE, validateGap, validateRamp, validateObstacle , validateIcePatch, validateSnowball, validateFallingHazard } = await import(moduleUrl('src/game/terrain.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
// The default engine storage is pre-seeded with a fixed journey seed so the
// generation-driven tests are deterministic run-to-run (an unseeded engine
// draws a random level seed, which made the hazard-corridor test flaky).
function seededStorage(seed = 20260101, level = 1) {
  const storage = memoryStorage();
  storage.setItem(LEVEL_SAVE_KEY, JSON.stringify({
    version: 1, journeySeed: seed, currentLevel: level, unlockedThrough: level,
    completedThrough: level - 1, levelScore: 0, runScore: 0, lifetimeScore: 0, checkpoint: null,
  }));
  return storage;
}
function engine(storage = seededStorage()) {
  globalThis.localStorage = storage;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {} };
  return new SnowGameEngine({ getBoundingClientRect: () => ({ width: 900, height: 600 }), getContext: () => ({ setTransform() {} }) },
    { onStatus() {}, onHud() {}, onGameOver() {} });
}

test('Every theme has continuous chunk heights, tangents and curvature with bounded slopes', () => {
  const epsilon = 0.01;
  for (const level of [1, 2, 3, 4, 30, 1000]) {
    const terrain = new TerrainGenerator(generateLevel(level, 771));
    for (let index = 1; index < 250; index++) {
      const x = index * WIDTH;
      const left = terrain.heightAt(x - epsilon);
      const middle = terrain.heightAt(x);
      const right = terrain.heightAt(x + epsilon);
      assert.ok(Math.abs(left - right) < 0.00001);
      assert.ok(Math.abs((middle - left) / epsilon - (right - middle) / epsilon) < 0.00001);
      const leftCurvature = (middle - 2 * left + terrain.heightAt(x - 2 * epsilon)) / epsilon ** 2;
      const rightCurvature = (terrain.heightAt(x + 2 * epsilon) - 2 * right + middle) / epsilon ** 2;
      assert.ok(Math.abs(leftCurvature - rightCurvature) < 0.00001);
      for (let sample = x; sample < x + WIDTH; sample += 8) {
        const slope = (terrain.heightAt(sample + 0.1) - terrain.heightAt(sample - 0.1)) / 0.2;
        assert.ok(Math.abs(slope) <= TERRAIN_MAX_SLOPE + 0.00001, `unsafe slope ${slope}`);
      }
    }
    for (let x = -300; x <= WIDTH; x += 10) assert.equal(terrain.heightAt(x), 0);
  }
});

test('Patterns are reusable and deterministic across query order, seeds and eviction', () => {
  const level = generateLevel(2, 99);
  const first = new TerrainGenerator(level);
  const second = new TerrainGenerator(level);
  const points = [0, 55, 700, 1912, 4000, 8500, 200000];
  const heights = points.map(x => first.heightAt(x));
  for (const x of [...points].reverse()) second.heightAt(x);
  assert.deepEqual(points.map(x => second.heightAt(x)), heights);
  first.maintain(300000, 304000);
  assert.deepEqual(points.map(x => first.heightAt(x)), heights);
  const other = new TerrainGenerator(generateLevel(2, 100));
  assert.notDeepEqual(points.map(x => other.heightAt(x)), heights);
  const types = new Set();
  for (let index = 0; index < 1000; index++) types.add(first.chunk(index).pattern);
  assert.deepEqual([...types].sort(), ['downhill', 'recovery', 'rolling-hill', 'ramp', 'uphill', 'valley'].sort());
});

test('Camera streaming keeps a small cache through a long ride', t => {
  const world = new TerrainWorld([{ level: 1, x: 0, offset: 0 }], level => generateLevel(level, 10));
  const start = performance.now();
  for (let camera = 0; camera < 500000; camera += 400) {
    world.maintain(camera, 1280);
    for (let x = camera; x <= camera + 1280; x += 12) world.heightAt(x);
    assert.ok(world.cachedChunks <= 15);
  }
  t.diagnostic(`135,000 terrain samples and chunk streaming: ${Math.round(performance.now() - start)} ms`);
  assert.ok(world.cachedChunks > 0);
});

test('Physics validation accepts a clear jump and rejects oversized gaps and sheer faces', () => {
  assert.equal(validateGap(() => 360, 1000, 110).safe, true);
  assert.equal(validateGap(() => 360, 1000, 800).safe, false);
  assert.equal(validateGap(x => x > 1090 ? 100 : 360, 1000, 110).safe, false);
  assert.equal(validateRamp(() => 360, 1000).safe, true);
  assert.equal(validateRamp(x => x > 1050 ? 200 : 360, 1000).safe, false);
});

test('The existing bicycle follows streamed terrain and can perform ordinary jumps', () => {
  const game = engine();
  game.start();
  const run = game.run;
  run.elapsed = 5;
  run.rider.speed = 250;
  run.objects = [];
  run.nextCoinX = run.nextHazardX = 1e12;
  for (let i = 0; i < 9000; i++) {
    if (i % 240 === 0 && run.rider.grounded) { game.press(); game.release(); }
    game.clock += 1 / 60;
    game.step(1 / 60);
    game.terrain.maintain(run.cameraX, 900);
    assert.equal(run.over, false);
    if (run.rider.grounded) assert.ok(Math.abs(run.rider.y - game.terrainAt(run.rider.x) + 5) < 0.001);
  }
  assert.ok(run.distance > 30000);
});

test('Validated gaps are traversable by actual engine jumps at low and high speeds', () => {
  let tested = 0;
  for (const level of [1, 2, 3, 4]) {
    const game = engine();
    game.levels.progress.currentLevel = level;
    game.levels.configuration = generateLevel(level, 1234);
    game.start();
    const surface = x => game.terrainAt(x);
    for (let x = 900; x < 15000 && tested < level * 8; x += 450) {
      if (!validateGap(surface, x, 110).safe) continue;
      for (const speed of [205, 475]) {
        const run = game.run;
        Object.assign(run.rider, { x: x - 55, y: surface(x - 55) - 5, speed, grounded: true, vy: 0, fallingInto: undefined });
        run.rider.rotation = game.terrainAngle(run.rider.x);
        run.distance = run.rider.x;
        run.elapsed = Math.max(5, run.elapsed);
        run.objects = [{ kind: 'gap', x, width: 110 }];
        run.nextHazardX = run.nextCoinX = 1e12;
        // This fixture changes world position between jumps, so reset attempt accounting.
        game.levels.progress.runScore = Math.floor(run.distance / 10) + run.coins * 125 + run.bonus;
        game.press();
        game.release();
        for (let frame = 0; frame < 180; frame++) {
          game.clock += 1 / 60;
          game.step(1 / 60);
          if (run.over || (frame > 1 && run.rider.grounded)) break;
        }
        assert.equal(run.over, false);
        assert.equal(run.rider.grounded, true);
        assert.ok(run.rider.x > x + 110);
      }
      tested++;
    }
  }
  assert.ok(tested >= 24);
});

test('Saved terrain origins reproduce the same world, and legacy saves keep player progress', () => {
  const save = memoryStorage();
  const game = engine(save);
  game.start();
  game.run.rider.x = 1800;
  game.run.rider.y = game.terrainAt(1800) - 5;
  game.run.distance = 1800;
  game.run.elapsed = 5;
  game.run.objects = [];
  game.saveStableCheckpoint();
  const heights = [1400, 1800, 2200].map(x => game.terrainAt(x));
  const restored = engine(save);
  assert.deepEqual([1400, 1800, 2200].map(x => restored.terrainAt(x)), heights);
  const saved = JSON.parse(save.getItem(LEVEL_SAVE_KEY));
  delete saved.checkpoint.terrainOrigins;
  save.setItem(LEVEL_SAVE_KEY, JSON.stringify(saved));
  const legacy = engine(save);
  assert.equal(legacy.hasParkedRun, true);
  assert.equal(legacy.run.distance, 1800);
  assert.equal(legacy.levels.levelScore, 180);
  assert.equal(legacy.run.objects.length, 0);
  assert.ok(legacy.run.nextHazardX >= 1800 + 640);
});

test('Final-house reservation joins the terrain continuously', () => {
  const game = engine();
  game.start();
  for (const x of [1500, 2500, 4000, 5500, 8000]) {
    const run = game.run;
    run.houses = [{ x, groundY: game.baseTerrainAt(x) }];
    for (const edge of [x - 300, x - 95, x + 95, x + 300]) {
      const epsilon = 0.001;
      assert.ok(Math.abs(game.terrainAt(edge - epsilon) - game.terrainAt(edge + epsilon)) < 0.001);
    }
    for (let sample = x - 300; sample < x + 300; sample += 2) {
      const slope = (game.terrainAt(sample + 0.1) - game.terrainAt(sample - 0.1)) / 0.2;
      assert.ok(Math.abs(slope) <= 0.4);
    }
  }
});

test('Generated hazards reserve their validated landing corridors', () => {
  // Phase 11 — early levels pace hazards gently by design (~6–10 s apart at
  // cruise), so the corridor sample rides a later level where the pacing
  // bands are dense. Corridor integrity itself is level-independent.
  const game = engine(seededStorage(20260101, 21));
  game.start();
  const run = game.run;
  run.nextCoinX = 1e12;
  const hazards = [];
  for (let x = 0; x < 60000; x += 1000) {
    run.rider.x = x;
    run.cameraX = x - 250;
    game.populateAhead(run);
    game.terrain.maintain(run.cameraX, 900);
    for (const obstacle of run.objects) {
      if (['rock', 'tree', 'log', 'gap', 'ramp', 'root', 'fence', 'ice', 'icicle', 'snowball', 'branch'].includes(obstacle.kind)
        && !hazards.some(item => item.x === obstacle.x)) hazards.push({ ...obstacle });
    }
  }
  hazards.sort((a, b) => a.x - b.x);
  assert.ok(hazards.length > 25);
  let gaps = 0;
  for (let index = 0; index < hazards.length; index++) {
    const obstacle = hazards[index];
    const surface = x => game.terrainAt(x);
    const validation = obstacle.kind === 'gap' && !obstacle.bridged
      ? validateGap(surface, obstacle.x, obstacle.width)
      : obstacle.kind === 'ramp' ? validateRamp(surface, obstacle.x)
      : ['rock', 'tree', 'log', 'root', 'fence'].includes(obstacle.kind) ? validateObstacle(surface, obstacle.x, obstacle.kind)
      : obstacle.kind === 'ice' ? validateIcePatch(surface, obstacle.x, obstacle.width)
      : obstacle.kind === 'snowball' ? validateSnowball(surface, obstacle.x)
      : (obstacle.kind === 'icicle' || obstacle.kind === 'branch') ? validateFallingHazard(surface, obstacle.x) : null;
    if (!validation) continue;
    if (obstacle.kind === 'gap') gaps++;
    assert.equal(validation.safe, true);
    // A ramp-gap pattern intentionally places its gap inside the ramp's
    // flight corridor — the ramp launches the rider over it — so the
    // "next hazard clears my corridor" rule only applies across patterns.
    const next = hazards[index + 1];
    const pairedGap = obstacle.kind === 'ramp' && next?.kind === 'gap' && next.x - obstacle.x < 400;
    if (next && !pairedGap) assert.ok(next.x >= validation.clearUntil - 0.001);
  }
  assert.ok(gaps > 0);
});

test('Validated tree jumps agree with the existing collision system', () => {
  const game = engine();
  game.start();
  const run = game.run;
  const surface = x => game.terrainAt(x);
  let tested = 0;
  for (let x = 900; x < 15000 && tested < 8; x += 450) {
    if (!validateObstacle(surface, x, 'tree').safe) continue;
    for (const speed of [205, 475]) {
      Object.assign(run.rider, { x: x - 100, y: surface(x - 100) - 5, speed, grounded: true, vy: 0, fallingInto: undefined });
      run.rider.rotation = game.terrainAngle(run.rider.x);
      run.distance = run.rider.x;
      run.elapsed = Math.max(5, run.elapsed);
      run.objects = [{ kind: 'tree', x }];
      run.nextCoinX = run.nextHazardX = 1e12;
      game.levels.progress.runScore = Math.floor(run.distance / 10) + run.coins * 125 + run.bonus;
      game.press();
      game.release();
      for (let frame = 0; frame < 180; frame++) {
        game.clock += 1 / 60;
        game.step(1 / 60);
        if (run.over || (frame > 1 && run.rider.grounded)) break;
      }
      assert.equal(run.over, false);
      assert.equal(run.rider.grounded, true);
    }
    tested++;
  }
  assert.ok(tested > 4);
});
