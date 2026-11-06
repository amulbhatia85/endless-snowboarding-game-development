import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { moduleUrl } from './loadTypeScript.mjs';

const { generateLevel } = await import(moduleUrl('src/game/levelManager.ts'));
const { OBSTACLE_REGISTRY, obstacleReady, swingingLogPose } = await import(moduleUrl('src/game/obstacleRegistry.ts'));
const { ObstaclePlanner, patternAvailability, validPlacementMetadata } = await import(moduleUrl('src/game/obstaclePlanner.ts'));
const { TerrainGenerator, validateRampGap, validateGap, validateRamp, validateObstacle, validateSwingingLog, validateIcePatch, validateSnowball, validateFallingHazard } = await import(moduleUrl('src/game/terrain.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

function context(level = 1, seed = 42, surface = () => 360) {
  return {
    level: generateLevel(level, seed), candidateX: 1000, riderX: 0, riderSpeed: 250, riderAcceleration: 10,
    surface, clearUntil: 640, bridgeAllowedAfter: 0, rampAllowedAfter: 0,
    reserved: [{ start: 0, end: 640 }], nearby: [],
  };
}
function engine() {
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {} };
  return new SnowGameEngine({ getBoundingClientRect: () => ({ width: 900, height: 600 }), getContext: () => ({ setTransform() {} }) },
    { onStatus() {}, onHud() {}, onGameOver() {} });
}
function plans(level, count = 55, seed = 42, surface = () => 360) {
  const planner = new ObstaclePlanner();
  const state = context(level, seed, surface);
  const output = [];
  for (let index = 0; index < count; index++) {
    state.riderX = Math.max(0, state.candidateX - 1100);
    state.nearby = output.flatMap(plan => plan.obstacles).slice(-8);
    const plan = planner.plan(state);
    output.push(plan);
    assert.ok(plan.nextX > state.candidateX);
    state.candidateX = plan.nextX;
    state.clearUntil = Math.max(state.clearUntil, plan.clearUntil);
    if (plan.obstacles.some(object => object.bridged)) state.bridgeAllowedAfter = plan.clearUntil + 4500;
  }
  return output;
}

test('Registry activates only complete implementations and filters unavailable theme assets', () => {
  // Phase 9A: the full expanded library is implemented and active.
  for (const id of ['rock', 'log', 'tree', 'root', 'fence', 'cliff', 'broken-bridge', 'ice', 'icicle', 'snowball', 'swinging-log', 'moving-platform', 'branch']) {
    assert.equal(obstacleReady(id), true);
  }
  assert.equal(obstacleReady('root'), true);
  assert.ok(!patternAvailability(generateLevel(1, 42)).find(pattern => pattern.id === 'double-logs').available);
  for (const level of [1, 2, 3, 4, 8, 30]) {
    const allowed = generateLevel(level, 42).allowedObstacles;
    for (const plan of plans(level, 25)) for (const obstacle of plan.obstacles) {
      assert.ok(obstacleReady(obstacle.plan.obstacleId));
      assert.ok(allowed.includes(obstacle.plan.obstacleId));
      assert.equal(validPlacementMetadata(obstacle.plan), true);
    }
  }
});

test('Early levels stay simple; later levels get spaced combinations and recovery sections', () => {
  const early = plans(1, 80);
  assert.ok(early.every(plan => plan.obstacles.length <= 1));
  assert.ok(early.some(plan => plan.patternId === 'recovery'));
  const intermediate = plans(3, 100);
  assert.ok(intermediate.some(plan => plan.patternId === 'double-logs'));
  const advanced = plans(12, 120);
  assert.ok(advanced.some(plan => plan.obstacles.length >= 2));
  for (const plan of [...early, ...intermediate, ...advanced]) {
    for (let index = 1; index < plan.obstacles.length; index++) {
      if (plan.patternId === 'ramp-gap') continue;
      assert.ok(plan.obstacles[index].plan.takeoff.start >= plan.obstacles[index - 1].plan.clearUntil);
    }
  }
});

test('The same seed and planning inputs reproduce patterns independently of cosmetic randomness', () => {
  assert.deepEqual(plans(4, 40, 123), plans(4, 40, 123));
  assert.notDeepEqual(plans(4, 40, 123), plans(4, 40, 124));
});

test('Reaction space, nearby landing corridors and house reservations reject unsafe placements', () => {
  const planner = new ObstaclePlanner();
  for (let seed = 1; seed < 25; seed++) {
    const state = context(8, seed);
    state.candidateX = 210;
    state.riderX = 0;
    assert.equal(planner.plan(state).obstacles.length, 0);
    state.candidateX = 1000;
    state.reserved = [{ start: 800, end: 10000 }];
    assert.equal(planner.plan(state).obstacles.length, 0);
    state.reserved = [];
    state.nearby = [{ kind: 'tree', x: 1050 }];
    assert.equal(planner.plan(state).obstacles.length, 0);
  }
});

test('Steep and unreachable configurations are rejected with bounded, inspectable reasons', () => {
  const planner = new ObstaclePlanner();
  const state = context(3, 29, x => 360 - x * 0.8);
  const plan = planner.plan(state);
  assert.equal(plan.obstacles.length, 0);
  assert.ok(plan.rejected.length > 0);
  assert.ok(plan.rejected.every(item => item.reason && item.patternId && Number.isFinite(item.x)));
  assert.ok(plan.rejected.length <= 4);
});

test('Generated sequences retain feasible tap and held-flip traversal across themes and terrain', t => {
  let validated = 0;
  const start = performance.now();
  for (const level of [1, 2, 3, 4, 8, 20]) {
    const terrain = new TerrainGenerator(generateLevel(level, 981));
    const surface = x => 360 + terrain.heightAt(x);
    const output = plans(level, 35, 981, surface);
    for (const plan of output) {
      const options = { speeds: [205, 300, 475], modes: ['tap', 'hold'], timingMargin: 8 };
      if (plan.patternId === 'ramp-gap') {
        const [ramp, gap] = plan.obstacles;
        assert.equal(validateRampGap(surface, ramp.x, gap.x, gap.width, options).safe, true);
      } else for (const obstacle of plan.obstacles) {
        if (obstacle.bridged) continue;
        const validation = obstacle.kind === 'gap' ? validateGap(surface, obstacle.x, obstacle.width, options)
          : obstacle.kind === 'ramp' ? validateRamp(surface, obstacle.x, options)
          : obstacle.kind === 'swinging-log' ? validateSwingingLog(surface, obstacle.x, options)
          : obstacle.kind === 'ice' ? validateIcePatch(surface, obstacle.x, obstacle.width)
          : obstacle.kind === 'snowball' ? validateSnowball(surface, obstacle.x, options)
          : (obstacle.kind === 'icicle' || obstacle.kind === 'branch') ? validateFallingHazard(surface, obstacle.x)
          : validateObstacle(surface, obstacle.x, obstacle.kind, options);
        assert.equal(validation.safe, true, plan.patternId);
        validated++;
      }
      for (let index = 0; index < plan.obstacles.length; index++) {
        const metadata = plan.obstacles[index].plan;
        assert.ok(metadata.warningStart <= metadata.takeoff.start - 450);
      }
    }
  }
  assert.ok(validated > 50);
  t.diagnostic(`210 bounded planning requests and traversal revalidation: ${Math.round(performance.now() - start)} ms`);
});

test('Real rider controls can traverse generated combinations with tap and held jumps', () => {
  const combinations = plans(12, 200).filter(plan => plan.obstacles.length > 1);
  assert.ok(combinations.length > 5);
  const selected = new Map(combinations.map(plan => [plan.patternId, plan]));
  for (const plan of selected.values()) for (const held of [false, true]) for (const speed of [205, 475]) {
    const game = engine();
    game.terrainAt = () => 360;
    game.start();
    const run = game.run;
    run.elapsed = 5;
    run.objects = plan.obstacles;
    run.nextCoinX = run.nextHazardX = 1e12;
    const first = plan.obstacles[0];
    const start = first.kind === 'ramp' ? first.x - 30 : (first.plan.takeoff.start + first.plan.takeoff.end) / 2 - 2;
    Object.assign(run.rider, { x: start, y: 355, speed, grounded: true, rotation: 0 });
    run.distance = start;
    game.levels.progress.runScore = Math.floor(start / 10);
    const jumped = new Set();
    const end = plan.clearUntil + 30;
    for (let frame = 0; frame < 6000 && run.rider.x < end && !run.over; frame++) {
      if (run.rider.grounded) {
        const obstacle = plan.obstacles.find(object => !jumped.has(object) && object.kind !== 'ramp'
          && plan.patternId !== 'ramp-gap' && run.rider.x >= object.plan.takeoff.start
          && run.rider.x <= object.plan.takeoff.end);
        if (obstacle) {
          game.release();
          game.press();
          if (!held) game.release();
          jumped.add(obstacle);
        }
      }
      if (held && plan.patternId === 'ramp-gap' && !run.rider.grounded && !game.held) game.press();
      game.clock += 1 / 120;
      game.step(1 / 120);
    }
    assert.equal(run.over, false, `${plan.patternId} speed=${speed} held=${held}`);
    assert.ok(run.rider.x >= end);
  }
});

test('Swinging logs warn and remain clearable at different swing phases', () => {
  const source = generateLevel(8, 14);
  const forest = { ...source, environment: 'moonlit-forest', allowedObstacles: ['swinging-log'] };
  const state = { ...context(8, 14), level: forest };
  const planner = new ObstaclePlanner();
  let plan;
  for (let index = 0; index < 15; index++) {
    const candidate = planner.plan({ ...state, candidateX: 1500 + index * 50 });
    if (candidate.obstacles.length) { plan = candidate; break; }
  }
  assert.equal(plan.obstacles[0].kind, 'swinging-log');
  assert.equal(OBSTACLE_REGISTRY['swinging-log'].requiresWarning, true);
  for (const phase of [0, 1, 2, 3, 4, 5]) for (const speed of [205, 475]) for (const held of [false, true]) {
    const game = engine();
    game.terrainAt = () => 360;
    game.start();
    const run = game.run;
    run.elapsed = 5;
    const x = 1500;
    run.objects = [{ kind: 'swinging-log', x, phase }];
    run.nextCoinX = run.nextHazardX = 1e12;
    Object.assign(run.rider, { x: x - 160, y: 355, grounded: true, rotation: 0, speed });
    run.distance = x - 160;
    game.levels.progress.runScore = Math.floor(run.distance / 10);
    game.press();
    if (!held) game.release();
    for (let frame = 0; frame < 240; frame++) {
      game.clock += 1 / 120;
      game.step(1 / 120);
      if (run.over || (frame > 1 && run.rider.grounded)) break;
    }
    assert.equal(run.over, false);
    assert.ok(run.rider.x > x + 58);
    assert.equal(run.rider.grounded, true);
  }
  const pose = swingingLogPose(100, 360, 5, 2);
  const game = engine();
  game.terrainAt = () => 360;
  game.start();
  game.run.elapsed = 5;
  game.run.objects = [{ kind: 'swinging-log', x: 100, phase: 2 }];
  Object.assign(game.run.rider, { x: pose.x, y: pose.y + 8 });
  assert.equal(game.checkCollision(game.run), true);
});

test('Optional debug rendering exposes diagnostics without changing placement or physics', () => {
  const game = engine();
  game.setObstacleDebug(true);
  game.start();
  assert.equal(game.obstacleDebug, true);
  game.obstacleRejections = [{ x: 1000, patternId: 'test', reason: 'test rejection' }];
  const lines = [];
  const context = new Proxy({}, { get: (_target, name) => name === 'fillText'
    ? text => lines.push(text) : () => {} });
  game.drawObstacleDebug(context, game.run, 0);
  assert.ok(lines.some(text => text.includes('REJECT')));
  game.setObstacleDebug(false);
  assert.equal(game.obstacleRejections.length, 0);
});

test('Moving-hazard warnings render and planning metadata survives a saved checkpoint', () => {
  const game = engine();
  game.terrainAt = () => 360;
  game.start();
  const state = { ...context(8, 14), level: { ...generateLevel(8, 14), environment: 'moonlit-forest', allowedObstacles: ['swinging-log'] } };
  let plan;
  for (let index = 0; index < 20; index++) {
    const result = new ObstaclePlanner().plan({ ...state, candidateX: 1500 + index * 50 });
    if (result.obstacles.length) { plan = result; break; }
  }
  game.run.objects = plan.obstacles;
  game.saveStableCheckpoint();
  assert.equal(game.levels.checkpoint.objects[0].plan.patternId, 'warned-swinging-log');
  game.run.rider.x = plan.obstacles[0].plan.warningStart + 1;
  game.run.cameraX = plan.obstacles[0].x - 300;
  const lines = [];
  const ctx = new Proxy({}, { get: (_target, name) => name === 'fillText' ? text => lines.push(text) : () => {} });
  game.drawObstacleWarning(ctx, game.run);
  assert.ok(lines.some(text => text.includes('SWINGING LOG AHEAD')));
  assert.equal(validPlacementMetadata({ ...plan.obstacles[0].plan, obstacleId: 'toString' }), false);
});
