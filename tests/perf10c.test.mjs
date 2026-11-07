import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';
import { rasterCanvas } from './raster.mjs';

// Phase 10C — rendering/performance regressions: rasterizer subpath fills,
// the measured auto-quality adaptation (hysteresis), the particle cap,
// in-place effect compaction, particle colour-run batching and the
// context-keyed coin halo gradient cache.

const { LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

const MAX_PARTICLES = 400;
const AUTO_QUALITY_SLOW_MS = 18;
const AUTO_QUALITY_FAST_MS = 10;

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

/** No-op 2D context used for logic-only frames. */
function mockContext() {
  const gradient = { addColorStop() {} };
  return {
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    font: '10px system-ui', textAlign: 'left', textBaseline: 'alphabetic',
    setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    createLinearGradient: () => gradient, createRadialGradient: () => gradient,
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, ellipse() {},
    fill() {}, stroke() {}, fillText() {}, strokeText() {}, drawImage() {},
  };
}

/** Recording context: every fillStyle assignment and gradient is captured. */
function recordingContext(tag) {
  const gradients = [];
  const fillStyles = [];
  const gradient = { addColorStop() {} };
  const context = {
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    font: '10px system-ui', textAlign: 'left', textBaseline: 'alphabetic',
    setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    createLinearGradient: () => gradient,
    createRadialGradient: () => { const g = { tag, addColorStop() {} }; gradients.push(g); return g; },
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, ellipse() {},
    fill() {}, stroke() {}, fillText() {}, strokeText() {}, drawImage() {},
  };
  Object.defineProperty(context, 'fillStyle', {
    get() { return fillStyles.length ? fillStyles[fillStyles.length - 1] : '#000'; },
    set(value) { fillStyles.push(value); },
  });
  return { context, gradients, fillStyles };
}

function makeEngine({ search = '', save = storage(), android = false } = {}) {
  globalThis.localStorage = save;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    location: { search },
  };
  globalThis.document = {
    createElement: () => {
      const inner = mockContext();
      return { width: 192, height: 192, getContext: () => inner };
    },
  };
  const game = new SnowGameEngine({
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    getContext: () => mockContext(),
  }, {
    onStatus() {}, onHud() {}, onGameOver() {}, onCrash() {}, onSound() {},
  }, android);
  game.start();
  return game;
}

/** Drive frames with explicit rAF-style timestamps. */
function ride(game, frames, startTs = 5000) {
  for (let index = 0; index < frames; index += 1) {
    game.frame(startTs + index * 16.7);
  }
}

test('rasterizer: separate subpaths in one path do not leak connector fills', () => {
  const canvas = rasterCanvas(240, 120);
  const ctx = canvas.getContext();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 240, 120);
  ctx.beginPath();
  // Two isolated circles inside a single path, each opened with moveTo.
  ctx.moveTo(80, 60);
  ctx.arc(60, 60, 20, 0, Math.PI * 2);
  ctx.moveTo(200, 60);
  ctx.arc(180, 60, 20, 0, Math.PI * 2);
  ctx.fillStyle = '#ff0000';
  ctx.fill();
  const at = (x, y) => Array.from(ctx.data.subarray((y * 240 + x) * 4, (y * 240 + x) * 4 + 4));
  assert.deepEqual(at(60, 60), [255, 0, 0, 255], 'first circle centre painted');
  assert.deepEqual(at(180, 60), [255, 0, 0, 255], 'second circle centre painted');
  assert.deepEqual(at(120, 60), [0, 0, 0, 255], 'midpoint between circles stays background');
  assert.deepEqual(at(93, 60), [0, 0, 0, 255], 'just outside first circle stays background');
});

test('rasterizer: moveTo before the first arc does not break single-subpath fills', () => {
  const canvas = rasterCanvas(120, 120);
  const ctx = canvas.getContext();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 120, 120);
  ctx.beginPath();
  ctx.moveTo(70, 60);
  ctx.arc(60, 60, 20, 0, Math.PI * 2);
  ctx.fillStyle = '#00ff00';
  ctx.fill();
  const at = (x, y) => Array.from(ctx.data.subarray((y * 120 + x) * 4, (y * 120 + x) * 4 + 4));
  assert.deepEqual(at(60, 60), [0, 255, 0, 255], 'circle painted');
  assert.deepEqual(at(30, 60), [0, 0, 0, 255], 'outside stays background');
});

test('auto-quality: warmup ignores slow frames for the first 120 samples', () => {
  const game = makeEngine();
  game.setGraphicsQuality('auto');
  game.frameCostSamples = 0;
  for (let index = 0; index < 200; index += 1) game.trackAutoQuality(AUTO_QUALITY_SLOW_MS + 5);
  assert.equal(game.autoQualityDegraded, false, 'no degradation during warmup');
});

test('auto-quality: engages after 45 consecutive slow frames, not before', () => {
  const game = makeEngine();
  game.setGraphicsQuality('auto');
  game.frameCostSamples = 200;
  for (let index = 0; index < 44; index += 1) game.trackAutoQuality(AUTO_QUALITY_SLOW_MS + 5);
  assert.equal(game.autoQualityDegraded, false, '44 slow frames are not enough');
  game.trackAutoQuality(AUTO_QUALITY_SLOW_MS + 5);
  assert.equal(game.autoQualityDegraded, true, '45th slow frame engages the lighter tier');
});

test('auto-quality: a single fast frame resets the slow streak', () => {
  const game = makeEngine();
  game.setGraphicsQuality('auto');
  game.frameCostSamples = 200;
  for (let index = 0; index < 44; index += 1) game.trackAutoQuality(AUTO_QUALITY_SLOW_MS + 5);
  game.trackAutoQuality(AUTO_QUALITY_FAST_MS - 1);
  game.trackAutoQuality(AUTO_QUALITY_SLOW_MS + 5);
  assert.equal(game.autoQualityDegraded, false, 'streak restarted, so one more slow frame does not engage');
});

test('auto-quality: releases after 900 consecutive fast frames only', () => {
  const game = makeEngine();
  game.setGraphicsQuality('auto');
  game.frameCostSamples = 200;
  for (let index = 0; index < 45; index += 1) game.trackAutoQuality(AUTO_QUALITY_SLOW_MS + 5);
  assert.equal(game.autoQualityDegraded, true);
  for (let index = 0; index < 899; index += 1) game.trackAutoQuality(AUTO_QUALITY_FAST_MS - 1);
  assert.equal(game.autoQualityDegraded, true, '899 fast frames are not enough to release');
  // An intermediate frame (between FAST_MS and SLOW_MS) resets the fast streak.
  game.trackAutoQuality(13);
  for (let index = 0; index < 899; index += 1) game.trackAutoQuality(AUTO_QUALITY_FAST_MS - 1);
  assert.equal(game.autoQualityDegraded, true, 'streak was reset by the intermediate frame');
  game.trackAutoQuality(AUTO_QUALITY_FAST_MS - 1);
  assert.equal(game.autoQualityDegraded, false, '900 consecutive fast frames release the lighter tier');
});

test('auto-quality: manual quality choice resets the adaptation', () => {
  const game = makeEngine();
  game.setGraphicsQuality('auto');
  game.frameCostSamples = 200;
  for (let index = 0; index < 45; index += 1) game.trackAutoQuality(AUTO_QUALITY_SLOW_MS + 5);
  assert.equal(game.autoQualityDegraded, true);
  game.setGraphicsQuality('auto');
  assert.equal(game.autoQualityDegraded, false, 're-choosing auto resets the degradation');
});

test('auto-quality: never engages for a fixed quality tier', () => {
  const game = makeEngine();
  game.setGraphicsQuality('high');
  game.frameCostSamples = 200;
  for (let index = 0; index < 100; index += 1) game.trackAutoQuality(AUTO_QUALITY_SLOW_MS + 20);
  assert.equal(game.autoQualityDegraded, false, 'high tier ignores slow frames');
});

test('particles: bursts respect the hard cap', () => {
  const game = makeEngine({ save: seedSave(4242, 30) });
  const run = game.run;
  assert.ok(run, 'run exists');
  game.burst(run, run.rider.x, run.rider.y, 500, '#ffffff', 120, -40);
  assert.ok(run.particles.length <= MAX_PARTICLES, `first burst capped (got ${run.particles.length})`);
  game.burst(run, run.rider.x, run.rider.y, 500, '#ffffff', 120, -40);
  assert.ok(run.particles.length <= MAX_PARTICLES, `second burst capped (got ${run.particles.length})`);
});

test('particles: riding never exceeds the hard cap', () => {
  const game = makeEngine({ save: seedSave(999999, 30) });
  const run = game.run;
  run.invulnerableUntil = run.elapsed + 999;
  run.rider.speed = 475;
  let peak = 0;
  for (let index = 0; index < 600; index += 1) {
    game.frame(5000 + index * 16.7);
    if (run.particles.length > peak) peak = run.particles.length;
  }
  assert.ok(peak <= MAX_PARTICLES, `particle peak ${peak} stays under the cap`);
});

test('updateEffects: in-place compaction preserves order and drops expired effects', () => {
  const game = makeEngine({ save: seedSave(7, 12) });
  const run = game.run;
  const groundY = game.terrainAt(run.rider.x + 100);
  run.particles = [
    { x: run.rider.x + 10, y: groundY - 50, vx: 0, vy: 0, size: 2, life: 0.9, maxLife: 1, color: '#a' },
    { x: run.rider.x + 20, y: groundY - 50, vx: 0, vy: 0, size: 2, life: 0.15, maxLife: 1, color: '#b' },
    { x: run.rider.x + 30, y: groundY - 50, vx: 0, vy: 0, size: 2, life: 0.9, maxLife: 1, color: '#c' },
    { x: run.rider.x + 40, y: groundY - 50, vx: 0, vy: 0, size: 2, life: 0.9, maxLife: 1, color: '#d' },
    // wheelSnow below the ground with downward velocity settles and is removed.
    { x: run.rider.x + 50, y: groundY + 4, vx: 0, vy: 30, size: 2, life: 0.9, maxLife: 1, color: '#e', wheelSnow: true },
  ];
  run.trail = [
    { x: run.rider.x, y: groundY, age: 0.1 },
    { x: run.rider.x + 5, y: groundY, age: 0.35 },
    { x: run.rider.x + 10, y: groundY, age: 0.9 },
  ];
  run.popups = [
    { x: run.rider.x, y: groundY - 30, text: '1', color: '#fff', life: 1.35, maxLife: 1.35 },
    { x: run.rider.x + 5, y: groundY - 30, text: '2', color: '#fff', life: 0.05, maxLife: 1.35 },
  ];
  game.updateEffects(run, 0.2);
  assert.deepEqual(run.particles.map((p) => p.color), ['#a', '#c', '#d'], 'expired and settled particles removed, order preserved');
  assert.deepEqual(run.trail.map((t) => Math.round(t.age * 10) / 10), [0.3], 'expired trail points removed, survivor aged');
  assert.deepEqual(run.popups.map((p) => p.text), ['1'], 'expired popups removed');
  // Idempotence: a second identical step keeps compounding correctly.
  game.updateEffects(run, 0.2);
  assert.deepEqual(run.particles.map((p) => p.color), ['#a', '#c', '#d'], 'survivors live out their full life');
  assert.deepEqual(run.trail, [], 'the trail survivor ages out next');
});

test('drawParticles: colour runs assign fillStyle only on change', () => {
  const game = makeEngine({ save: seedSave(7, 12) });
  const run = game.run;
  const groundY = game.terrainAt(run.rider.x);
  run.particles = [
    { x: 10, y: 10, vx: 0, vy: 0, size: 2, life: 1, maxLife: 1, color: '#a' },
    { x: 20, y: 10, vx: 0, vy: 0, size: 2, life: 1, maxLife: 1, color: '#a' },
    { x: 30, y: 10, vx: 0, vy: 0, size: 2, life: 1, maxLife: 1, color: '#b' },
    { x: 40, y: 10, vx: 0, vy: 0, size: 2, life: 1, maxLife: 1, color: '#a' },
  ];
  const { context, fillStyles } = recordingContext('particles');
  game.drawParticles(context, run, 0);
  const colourSets = fillStyles.filter((value) => typeof value === 'string' && /^#[abcd]$/.test(value));
  assert.deepEqual(colourSets, ['#a', '#b', '#a'], 'three assignments for two colour runs');
});

test('coin halo: cached gradient is keyed to the drawing context', () => {
  const game = makeEngine({ save: seedSave(4242, 12) });
  game.setGraphicsQuality('high');
  const run = game.run;
  const groundY = game.terrainAt(run.rider.x + 160);
  run.objects.push({ kind: 'coin', x: run.rider.x + 160, y: groundY - 42, width: 0, phase: 0 });

  const a = recordingContext('A');
  const original = game.context;
  game.context = a.context;
  game.frame(9000);
  const aGradients = a.gradients.filter((g) => g.tag === 'A');
  assert.ok(aGradients.length >= 1, 'context A created the halo gradient');
  assert.ok(a.fillStyles.includes(aGradients[0]), 'context A painted its own gradient');
  const createdOnA = a.gradients.length;

  // Swap to a second context (as the test harness does between fast and
  // raster passes). The cached gradient from A must never leak into B.
  const b = recordingContext('B');
  game.context = b.context;
  game.frame(9016.7);
  game.context = original;
  assert.equal(a.gradients.length, createdOnA, 'context B did not call through A');
  const bGradients = b.gradients.filter((g) => g.tag === 'B');
  assert.ok(bGradients.length >= 1, 'context B created its own halo gradient');
  for (const value of b.fillStyles) {
    if (value && typeof value === 'object' && 'tag' in value) {
      assert.equal(value.tag, 'B', 'no gradient created by context A reaches context B');
    }
  }
  assert.ok(b.fillStyles.includes(bGradients[0]), 'context B painted its own gradient');
});
