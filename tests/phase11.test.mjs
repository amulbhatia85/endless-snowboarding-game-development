import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 11 — regression tests for the score-ledger freeze bug found by the
// density audit. Several engine paths can leave rider.x momentarily behind
// the furthest point reached (the chasm-lip clamp pulls the rider back to
// farEdge - 8, the crash tumble bumps the rider backwards), and the engine
// used to write that smaller x straight into run.distance. The next score
// sync then computed a lower runScore and LevelManager.updateScore threw
// RangeError — which, in the browser, kills the un-caught rAF chain and
// hard-freezes the game mid-run. The fix: run.distance is monotonic
// (Math.max) at every live write inside an attempt; restarts and checkpoint
// restores build a fresh run object, so the monotonic clamp never leaks
// across attempts.

const { LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
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
      return { width: 192, height: 192, getContext: () => inner };
    },
  };
  const game = new SnowGameEngine({
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    getContext: () => mockContext(),
  }, {
    onStatus() {}, onHud() {}, onGameOver() {}, onCrash() {}, onSound() {},
  });
  game.start();
  return game;
}

const HAZARDS = ['rock', 'log', 'tree', 'gap', 'ramp', 'swinging-log', 'root', 'fence', 'ice', 'icicle', 'snowball', 'branch'];

/** Drive the real frame() pipeline; returns per-frame run.distance samples. */
function ride(game, maxFrames, { shield = true, bot = null } = {}) {
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 5);
  run.invulnerableUntil = shield ? run.elapsed + 999 : 0;
  const distances = [run.distance];
  let t = 0;
  for (let frame = 0; frame < maxFrames && !run.over; frame += 1) {
    if (bot) bot(game);
    t += 1000 / 60;
    game.frame(t);
    distances.push(run.distance);
    if (run.levelPhase !== 'riding') break;
  }
  return distances;
}

function assertMonotonic(distances) {
  for (let i = 1; i < distances.length; i += 1) {
    assert.ok(distances[i] >= distances[i - 1] - 1e-9,
      `run.distance regressed at frame ${i}: ${distances[i - 1]} → ${distances[i]}`);
  }
}

test('an unshielded obstacle crash never regresses run.distance or throws', () => {
  // No shield, no input: the rider deterministically crashes into the first
  // hazard, exercising crash(), the cosmetic backward tumble and the score
  // sync that used to throw when the tumble crossed a 10 px score boundary.
  // Phase 11 pacing places the first hazard after the first power-up, so the
  // power pipeline is disabled here — otherwise the passive rider rides
  // through a shield and survives exactly the crash this test needs.
  const game = makeEngine({ save: seedSave(7, 1) });
  game.run.objects = game.run.objects.filter((object) => !['magnet', 'shield', 'double'].includes(object.kind));
  game.run.nextPowerX = 1e12;
  const distances = ride(game, 60 * 30, { shield: false });

  assertMonotonic(distances);
  assert.ok(game.run.over, 'the rider crashes into the first hazard');
  assert.ok(game.levels.progress.runScore >= 0, 'ledger stays valid after the crash');
});

test('the audit repro ride (shielded, queued jumps) completes without freezing', () => {
  // The exact Phase 11 audit scenario: Level 1, seed 7, natural speed, shield
  // on, a bot that queues jumps without holding press(). The original bug
  // threw here within the first seconds; the fixed engine rides the whole
  // level through to the house approach.
  const game = makeEngine({ save: seedSave(7, 1), search: '?debugObstacles=1' });
  const bot = (instance) => {
    const run = instance.run;
    if (!run.rider.grounded) return;
    const x = run.rider.x;
    const danger = run.objects.find((object) => {
      if (object.kind === 'coin' || object.kind === 'ice' || object.bridged) return false;
      if (object.kind === 'gap') return object.x > x + 60 && object.x < x + 240;
      return HAZARDS.includes(object.kind) && object.x > x + 80 && object.x < x + 190;
    });
    if (danger) instance.jumpQueued = true;
  };
  // Phase 12 — the level target rose to 150 000 (from 50 000), so the
  // natural-speed audit ride needs roughly three times the frames to roll
  // a whole level into the house approach.
  const distances = ride(game, 60 * 400, { shield: true, bot });

  assertMonotonic(distances);
  assert.equal(game.run.levelPhase, 'approach', 'the level completes into the house approach');
  assert.ok(game.levels.progress.levelScore > 0, 'score accrued along the way');
});

test('a natural-speed jumping bot can fail gaps across levels without freezing', () => {
  // Level 20, seed 4242: the natural-speed calibration ride crashed here too.
  const game = makeEngine({ save: seedSave(4242, 20), search: '?debugObstacles=1' });
  const bot = (instance) => {
    const run = instance.run;
    if (!run.rider.grounded) return;
    const x = run.rider.x;
    const danger = run.objects.find((object) => {
      if (object.kind === 'coin' || object.kind === 'ice' || object.bridged) return false;
      if (object.kind === 'gap') return object.x > x + 60 && object.x < x + 240;
      return HAZARDS.includes(object.kind) && object.x > x + 80 && object.x < x + 190;
    });
    if (danger) instance.jumpQueued = true;
    if (instance.jumpQueued) instance.press();
    else instance.release();
  };
  const distances = ride(game, 60 * 40, { shield: true, bot });

  assertMonotonic(distances);
});
