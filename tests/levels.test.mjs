import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

const { LevelManager, generateLevel, LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}
const callbacks = { onStatus() {}, onHud() {}, onGameOver() {} };
function engine(save = storage(), width = 900) {
  globalThis.localStorage = save;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {} };
  return new SnowGameEngine({
    getBoundingClientRect: () => ({ width, height: 600 }),
    getContext: () => ({ setTransform() {} }),
  }, callbacks);
}
function completeLevel(game) {
  const run = game.run;
  run.elapsed = Math.max(5, run.elapsed);
  run.objects = [];
  run.nextCoinX = run.nextHazardX = 1e12;
  run.bonus += 50000;
  game.step(0);
  assert.equal(run.levelPhase, 'approach');
  assert.equal(game.levels.safeHouseReached, false);
  assert.equal(game.levels.completedThrough, run.levelIndex);
  const initialLevel = run.levelIndex;
  let entered = false;
  for (let i = 0; i < 2400; i++) {
    game.press();
    assert.equal(game.held, false);
    game.step(1 / 60);
    if (run.levelPhase === 'celebrating') {
      entered = true;
      assert.equal(run.riderOpacity, 0);
      assert.equal(game.levels.safeHouseReached, true);
    }
    if (run.levelPhase === 'riding' && run.levelIndex > initialLevel) {
      assert.ok(entered);
      return;
    }
  }
  assert.fail('Level transition failed to finish.');
}

test('Level 1 and dynamic future configurations have stable seeds and independent targets', () => {
  assert.equal(generateLevel(1, 42).environment, 'countryside');
  assert.equal(generateLevel(2, 42).environment, 'snowy-mountains');
  assert.equal(generateLevel(3, 42).environment, 'misty-mountains');
  assert.equal(generateLevel(4, 42).environment, 'moonlit-forest');
  for (const number of [1, 2, 3, 4, 5, 100, 1000000]) {
    const level = generateLevel(number, 42);
    assert.equal(level.number, number);
    assert.equal(level.targetScore, 50000);
    assert.deepEqual(level, generateLevel(number, 42));
    assert.notEqual(level.seed, generateLevel(number, 43).seed);
    assert.ok(level.allowedObstacles.length > 0);
  }
  assert.throws(() => generateLevel(0, 42), RangeError);
  assert.throws(() => generateLevel(1.2, 42), RangeError);
});

test('A target alone cannot advance; safe house and transition reset only the level score', () => {
  const manager = new LevelManager({ storage: storage(), seed: 42 });
  manager.updateScore(49999, 49999);
  assert.equal(manager.targetReached, false);
  assert.equal(manager.markSafeHouseReached(), false);
  assert.throws(() => manager.advanceAfterTransition());
  manager.updateScore(50000, 50000);
  assert.throws(() => manager.advanceAfterTransition());
  assert.equal(manager.markSafeHouseReached(), true);
  assert.equal(manager.advanceAfterTransition().number, 2);
  assert.equal(manager.levelScore, 0);
  assert.equal(manager.lifetimeScore, 50000);
  manager.updateScore(100, 50100);
  assert.equal(manager.levelScore, 100);
  assert.equal(manager.lifetimeScore, 50100);
  assert.throws(() => manager.updateScore(0, 0));
});

test('Progress is atomic, versioned, and ignores invalid checkpoints and corrupt storage', () => {
  const save = storage();
  const valid = value => typeof value === 'number' && value >= 0;
  const manager = new LevelManager({ storage: save, seed: 42, validateCheckpoint: valid });
  manager.updateScore(120, 120);
  manager.saveCheckpoint(12);
  const restored = new LevelManager({ storage: save, validateCheckpoint: valid });
  assert.equal(restored.checkpoint, 12);
  assert.equal(restored.levelScore, 120);
  assert.equal(restored.lifetimeScore, 120);
  manager.updateScore(50000, 50000);
  manager.markSafeHouseReached();
  assert.equal(manager.saveCheckpoint(99), false);
  const duringTransition = new LevelManager({ storage: save, validateCheckpoint: valid });
  assert.equal(duringTransition.current.number, 1);
  assert.equal(duringTransition.levelScore, 120);
  manager.advanceAfterTransition();
  const next = new LevelManager({ storage: save, validateCheckpoint: valid });
  assert.equal(next.current.number, 2);
  assert.equal(next.completedThrough, 1);
  assert.equal(next.unlockedThrough, 2);
  assert.equal(next.levelScore, 0);
  assert.equal(next.checkpoint, null);
  save.setItem(LEVEL_SAVE_KEY, '{invalid');
  assert.equal(new LevelManager({ storage: save }).current.number, 1);
  save.setItem(LEVEL_SAVE_KEY, JSON.stringify({ version: 99, currentLevel: -4 }));
  assert.equal(new LevelManager({ storage: save }).current.number, 1);
  const unavailable = new LevelManager({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } } });
  assert.doesNotThrow(() => unavailable.restartAttempt());
});

test('Engine progresses beyond level 2, restores Continue, and restarts the current unlocked level', () => {
  const save = storage();
  const game = engine(save);
  game.start();
  assert.equal(game.makeHud(game.run).level.number, 1);
  assert.equal(game.makeHud(game.run).level.score, 0);
  assert.equal(game.levels.current.targetScore, 50000);
  completeLevel(game);
  assert.equal(game.levels.current.number, 2);
  assert.equal(game.levels.levelScore, 0);
  completeLevel(game);
  assert.equal(game.levels.current.number, 3);
  assert.equal(game.levels.levelScore, 0);
  completeLevel(game);
  assert.equal(game.levels.current.number, 4);
  const restored = engine(save, 700);
  assert.equal(restored.hasParkedRun, true);
  restored.resumeParkedRun();
  assert.equal(restored.status, 'playing');
  assert.equal(restored.levels.current.number, 4);
  assert.equal(restored.run.levelIndex, 3);
  const total = restored.levels.lifetimeScore;
  restored.step(0);
  assert.equal(restored.levels.lifetimeScore, total);
  restored.start();
  assert.equal(restored.levels.current.number, 4);
  assert.equal(restored.levels.completedThrough, 3);
  assert.equal(restored.levels.levelScore, 0);
});

test('A reload during entry replays the last stable level rather than an incomplete transition', () => {
  const save = storage();
  const game = engine(save);
  game.start();
  game.run.elapsed = 5;
  game.run.bonus = 50000;
  game.step(0);
  for (let i = 0; i < 1800 && game.run.levelPhase !== 'entering'; i++) game.step(1 / 60);
  assert.equal(game.run.levelPhase, 'entering');
  game.destroy();
  const restored = engine(save);
  assert.equal(restored.levels.current.number, 1);
  assert.equal(restored.run.levelPhase, 'riding');
  assert.equal(restored.run.riderOpacity, 1);
});

test('Physics still support a tap jump, one held backflip and repeated rewarded revives', () => {
  for (const held of [false, true]) {
    const game = engine();
    game.terrainAt = () => 360;
    game.start();
    game.run.elapsed = 5;
    game.run.rider.speed = 250;
    game.run.objects = [];
    game.run.nextCoinX = game.run.nextHazardX = 1e9;
    game.press();
    if (!held) game.release();
    for (let i = 0; i < 120; i++) {
      game.clock += 1 / 60;
      game.step(1 / 60);
    }
    assert.equal(game.run.over, false);
    assert.equal(game.run.rider.grounded, true);
    assert.equal(game.run.tricks, held ? 1 : 0);
    for (let i = 0; i < 2; i++) {
      game.finishRun(game.run, 'test crash');
      assert.equal(game.revive(), true);
    }
  }
});

test('Obstacle generation is seeded independently of cosmetics and viewport lookahead', () => {
  const save = storage();
  const first = engine(save, 900);
  first.start();
  first.run.objects = [];
  first.run.nextCoinX = 330;
  first.run.nextHazardX = 760;
  first.run.nextPowerX = 760;
  first.run.nextBridgeX = 760;
  first.run.powerIndex = 0;
  // The spawn corridor must be reset too: start()'s lookahead leaves a
  // width-dependent clear-until behind, which would otherwise shift the
  // first power-up between viewports and make this test seed-flaky.
  first.run.hazardClearUntil = 640;
  // The pacing repetition memory is scheduling state as well — the wider
  // viewport's initial lookahead may have recorded one pattern more.
  first.run.recentPatterns = [];
  first.run.rider.x = 0;
  first.populateAhead(first.run);
  const second = engine(save, 500);
  second.start();
  second.run.objects = [];
  second.run.nextCoinX = 330;
  second.run.nextHazardX = 760;
  second.run.nextPowerX = 760;
  second.run.nextBridgeX = 760;
  second.run.powerIndex = 0;
  second.run.hazardClearUntil = 640;
  second.run.recentPatterns = [];
  second.run.rider.x = 0;
  second.burst(second.run, 0, 0, 30, '#ffffff', 10, 10);
  second.populateAhead(second.run);
  const limit = Math.min(
    first.run.nextHazardX,
    second.run.nextHazardX,
    first.width * 1.7 + 520, // populateAhead's lookahead per viewport
    second.width * 1.7 + 520,
  ) - 245;
  const objects = game => game.run.objects.filter(object => object.x < limit).sort((a, b) => a.x - b.x);
  assert.deepEqual(objects(first), objects(second));
});

test('Finalized and deliberately abandoned attempts cannot reappear as Continue', () => {
  for (const finalize of [false, true]) {
    const save = storage();
    const game = engine(save);
    game.start();
    game.run.coins = 2;
    game.run.bonus = 250;
    game.saveStableCheckpoint();
    const lifetime = game.levels.lifetimeScore;
    if (finalize) {
      game.finishRun(game.run, 'test');
      game.finalizeRun();
    } else {
      game.returnToMenu();
    }
    const restored = engine(save);
    assert.equal(restored.hasParkedRun, false);
    assert.equal(restored.levels.lifetimeScore, lifetime);
    assert.equal(restored.levels.current.number, 1);
  }
});

test('Malformed engine checkpoints are rejected while completed-level progress is retained', () => {
  const save = storage();
  const game = engine(save);
  game.start();
  completeLevel(game);
  const raw = JSON.parse(save.getItem(LEVEL_SAVE_KEY));
  raw.checkpoint.rider.speed = 'invalid';
  save.setItem(LEVEL_SAVE_KEY, JSON.stringify(raw));
  const restored = engine(save);
  assert.equal(restored.hasParkedRun, false);
  assert.equal(restored.levels.current.number, 2);
  assert.equal(restored.levels.completedThrough, 1);
  restored.start();
  assert.equal(restored.makeHud(restored.run).level.score, 0);
});

test('Pausing preserves the cinematic phase until the existing game loop resumes', () => {
  const game = engine();
  game.start();
  game.run.elapsed = 5;
  game.run.bonus = 50000;
  game.step(0);
  game.draw = () => {};
  const time = game.run.sceneTime;
  game.togglePause();
  game.frame(1000);
  game.frame(1100);
  assert.equal(game.run.sceneTime, time);
  assert.equal(game.levels.completedThrough, 0);
  game.resume();
  game.frame(1200);
  assert.ok(game.run.sceneTime > time);
});
