import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { moduleUrl } from './loadTypeScript.mjs';

const { generateLevel, LEVEL_SAVE_KEY, previewLevelForObstacle } = await import(moduleUrl('src/game/levelManager.ts'));
const { OBSTACLE_REGISTRY, obstacleReady, iciclePose, branchPose, snowballPose, platformBob } = await import(moduleUrl('src/game/obstacleRegistry.ts'));
const { ObstaclePlanner, patternAvailability, validPlacementMetadata, patternIsDangerous } = await import(moduleUrl('src/game/obstaclePlanner.ts'));
const { TerrainGenerator, validateObstacle, validateIcePatch, validateFallingHazard, validateSnowball } = await import(moduleUrl('src/game/terrain.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

// ───────────────────────── harness (mirrors audit.test.mjs) ─────────────────────────

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
  let operations = 0;
  const record = (...values) => { operations += 1; void values; };
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
    arc: (...v) => record(...v), ellipse: (...v) => record(...v),
    fill() { operations += 1; }, stroke() { operations += 1; },
    fillText: (...v) => record(...v), strokeText: (...v) => record(...v),
    drawImage() { operations += 1; },
  };
  return { context, get operations() { return operations; } };
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

function drive(game, frames, delta = 1 / 60) {
  const run = game.run;
  for (let frame = 0; frame < frames; frame += 1) {
    game.clock += delta;
    game.step(delta);
    if (!game.run || game.run.over) break;
  }
  return game.run ?? run;
}

const NEW_IDS = ['root', 'fence', 'cliff', 'broken-bridge', 'ice', 'icicle', 'snowball', 'moving-platform', 'branch'];

function driveUntil(game, predicate, maxFrames = 3600, delta = 1 / 60) {
  const run = game.run;
  for (let frame = 0; frame < maxFrames; frame += 1) {
    if (predicate(run)) return true;
    game.clock += delta;
    game.step(delta);
    if (!game.run || game.run.over) break;
  }
  return predicate(game.run ?? run);
}

const aheadOf = (run, kind, id) => run.objects.find((object) =>
  (kind ? object.kind === kind : true) && (!id || object.plan?.obstacleId === id)
  && object.x > run.rider.x + 400 && object.x < run.rider.x + 2400);
const PHYSICAL_IDS = ['rock', 'log', 'tree', 'root', 'fence', 'swinging-log', 'icicle', 'snowball', 'branch'];

// ───────────────────────── pose functions & registry ─────────────────────────

test('Every expanded-library obstacle is implemented, physical ones carry collision data', () => {
  for (const id of [...PHYSICAL_IDS, 'gap', 'bridge', 'ramp', 'cliff', 'broken-bridge', 'ice', 'moving-platform']) {
    assert.equal(obstacleReady(id), true, `${id} must be ready`);
  }
  for (const id of PHYSICAL_IDS) {
    const collision = OBSTACLE_REGISTRY[id].collision;
    assert.ok(collision && collision.radius > 0 && collision.height > 0, `${id} has positive collision geometry`);
  }
  for (const id of NEW_IDS) {
    assert.ok(Number.isInteger(previewLevelForObstacle(id)) && previewLevelForObstacle(id) >= 1, `${id} has a preview level`);
  }
});

test('Moving-hazard pose functions are deterministic, cyclic and bounded', () => {
  // Icicle: full state machine over one 4.2s cycle, monotone fall.
  const ground = 400;
  assert.equal(iciclePose(ground, 1.0).state, 'hanging');
  assert.equal(iciclePose(ground, 2.3).state, 'shaking');
  const falling = iciclePose(ground, 2.75);
  assert.equal(falling.state, 'falling');
  assert.ok(falling.y > iciclePose(ground, 2.65).y && falling.y < iciclePose(ground, 2.9).y, 'fall accelerates');
  assert.equal(iciclePose(ground, 3.5).state, 'shattered');
  assert.deepEqual(iciclePose(ground, 2.3), iciclePose(ground, 2.3), 'deterministic');
  // Phase offsets shift the cycle but keep the same states.
  assert.equal(iciclePose(ground, 1.0, 1.3).state, iciclePose(ground, 2.3).state);
  // Branch: 5s cycle with the same contract.
  assert.equal(branchPose(ground, 1.0).state, 'hanging');
  assert.equal(branchPose(ground, 3.2).state, 'shaking');
  assert.equal(branchPose(ground, 3.7).state, 'falling');
  assert.equal(branchPose(ground, 4.4).state, 'landed');
  // Snowball: patrol stays inside amplitude+bias, direction flips, deterministic.
  let minX = Infinity;
  let maxX = -Infinity;
  for (let t = 0; t < 12; t += 0.05) {
    const pose = snowballPose(500, 0, t);
    minX = Math.min(minX, pose.x);
    maxX = Math.max(maxX, pose.x);
    assert.deepEqual(pose, snowballPose(500, 0, t), 'deterministic');
  }
  assert.ok(minX >= 500 - 48 && maxX <= 500 + 48, `flat-ground patrol bounded to ±48 (${minX - 500}..${maxX - 500})`);
  const downhill = snowballPose(500, 1.2, 3);
  assert.ok(downhill.x > 500 + 16, 'downhill bias shifts the patrol basin');
  // Platform bob: ±5px, smooth, deterministic.
  for (let t = 0; t < 8; t += 0.1) {
    const bob = platformBob(t);
    assert.ok(bob >= -5 && bob <= 5, 'bob bounded to ±5px');
    assert.equal(bob, platformBob(t), 'deterministic');
  }
});

// ───────────────────────── validators ─────────────────────────

test('Roots and fences validate as jumpable static obstacles with kind-specific takeoffs', () => {
  const flat = (x) => 360;
  const root = validateObstacle(flat, 1000, 'root');
  const fence = validateObstacle(flat, 2000, 'fence');
  assert.equal(root.safe, true);
  assert.equal(fence.safe, true);
  assert.ok(root.takeoff.start > 1000 - 60, 'root takeoff sits close to the hop');
  assert.ok(fence.takeoff.start <= 2000 - 85 + 1, 'fence takeoff is set further back for the bigger jump');
  assert.ok(OBSTACLE_REGISTRY.fence.collision.height > OBSTACLE_REGISTRY.root.collision.height * 2,
    'fence is the taller clearance');
  // An unclimbable cliff right at the obstacle must not validate.
  const cliff = (x) => (x >= 2000 ? -40 : 360);
  assert.equal(validateObstacle(cliff, 2000, 'fence').safe, false);
});

test('Ice patches validate only on gentle, step-free terrain within width limits', () => {
  const flat = () => 360;
  assert.equal(validateIcePatch(flat, 1000, 180).safe, true);
  assert.equal(validateIcePatch(flat, 1000, 80).safe, false, 'too short');
  assert.equal(validateIcePatch(flat, 1000, 300).safe, false, 'too long');
  const steep = (x) => 360 + Math.max(0, x - 1000) * 0.3;
  assert.equal(validateIcePatch(steep, 1000, 180).safe, false, 'steep terrain rejected');
  const drifting = (x) => 360 - (x - 1000) * 0.14;
  assert.equal(validateIcePatch(drifting, 1000, 200).safe, false, 'elevation drift rejected');
});

test('Falling-hazard corridors and snowball patrols validate their full envelopes', () => {
  const flat = () => 360;
  assert.equal(validateFallingHazard(flat, 1000).safe, true);
  const bumpy = (x) => 360 + Math.sin((x - 1000) / 22) * 8;
  assert.equal(validateFallingHazard(bumpy, 1000).safe, false, 'unreadable corridor rejected');
  // The snowball must be clearable in one jump wherever it patrols.
  const options = { speeds: [205, 300, 475], modes: ['tap', 'hold'], timingMargin: 8 };
  assert.equal(validateSnowball(flat, 1000, options).safe, true);
});

// ───────────────────────── planner: generation, gating, environments ─────────────────────────

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

test('The planner generates every new obstacle type in its matching environments', () => {
  const expected = {
    countryside: ['root', 'fence'],
    'snowy-mountains': ['ice', 'icicle', 'snowball'],
    'misty-mountains': ['cliff', 'broken-bridge', 'moving-platform'],
    'moonlit-forest': ['root', 'branch'],
    jungle: ['root', 'branch', 'swinging-log'],
  };
  const seen = new Map(Object.keys(expected).map((env) => [env, new Set()]));
  const start = performance.now();
  for (let level = 6; level <= 44; level += 1) {
    for (const seed of [7, 20260101]) {
      const config = generateLevel(level, seed);
      const terrain = new TerrainGenerator(config);
      const surface = (x) => 360 + terrain.heightAt(x);
      for (const plan of planSequence(config, 14, surface)) {
        for (const obstacle of plan.obstacles) {
          assert.ok(seen.has(config.environment), 'known environment');
          seen.get(config.environment).add(obstacle.plan.obstacleId);
          assert.ok(config.allowedObstacles.includes(obstacle.plan.obstacleId),
            `${obstacle.plan.obstacleId} generated inside ${config.environment} which does not allow it`);
          assert.equal(validPlacementMetadata(obstacle.plan), true);
          if (obstacle.variant !== undefined) {
            assert.ok(obstacle.variant >= 0 && obstacle.variant <= 1, 'variant is a seeded 0..1 draw');
          }
        }
      }
    }
  }
  for (const [environment, ids] of Object.entries(expected)) {
    for (const id of ids) {
      assert.ok(seen.get(environment).has(id), `${id} must generate in ${environment}`);
    }
  }
  assert.ok(performance.now() - start < 20000, 'bounded planning budget');
});

test('Difficulty gating: new hazards respect their minimum levels', () => {
  const level1 = patternAvailability(generateLevel(1, 42));
  const unavailable = (id) => level1.find((pattern) => pattern.id === id)?.available !== true;
  assert.equal(unavailable('single-fence'), true, 'fence waits for level 2');
  assert.equal(unavailable('ice-patch'), true, 'ice waits for level 2');
  assert.equal(unavailable('snowball-roll'), true, 'snowball waits for level 5');
  for (const id of ['icicle-drop', 'broken-bridge', 'moving-platform', 'falling-branch']) {
    assert.equal(unavailable(id), true, `${id} waits for level 6`);
  }
  assert.equal(unavailable('cliff-jump'), true, 'cliff waits for level 7');
  // Past the minimum level, unavailability can only ever come from the theme.
  let anyAvailable = 0;
  for (let level = 9; level <= 40; level += 1) {
    const availability = patternAvailability(generateLevel(level, 42));
    for (const id of ['icicle-drop', 'broken-bridge', 'moving-platform', 'falling-branch', 'cliff-jump', 'snowball-roll']) {
      const pattern = availability.find((item) => item.id === id);
      assert.ok(pattern, `${id} exists`);
      assert.ok(!pattern.reason?.includes('Requires level'), `${id} level-gated only up to its minimum`);
      if (pattern.available) anyAvailable += 1;
    }
  }
  assert.ok(anyAvailable >= 6, 'every gated pattern becomes available in some matching theme');
  // Timed and terrain variants count as dangerous: never scheduled on the safe final approach.
  for (const id of ['icicle-drop', 'snowball-roll', 'cliff-jump', 'broken-bridge', 'moving-platform', 'falling-branch']) {
    assert.equal(patternIsDangerous(id), true, `${id} is a dangerous pattern`);
  }
  assert.equal(patternIsDangerous('single-root'), false, 'roots stay as mild as rocks');
  assert.equal(patternIsDangerous('ice-patch'), false, 'ice is a traction patch, not a crash hazard');
});

test('Consecutive hazard corridors never overlap, including the new kinds', () => {
  const config = generateLevel(12, 20260101);
  const terrain = new TerrainGenerator(config);
  const surface = (x) => 360 + terrain.heightAt(x);
  const placed = planSequence(config, 40, surface).flatMap((plan) => plan.obstacles);
  assert.ok(placed.length > 12, 'enough placements to stress spacing');
  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed[index - 1];
    const current = placed[index];
    // A coupled ramp-gap is ONE shared trajectory: the ramp launches the
    // rider over the gap that sits 135 px later, so the pair intentionally
    // shares a single corridor (same validation, same clearUntil). Only
    // independent hazard groups must clear each other's corridors.
    const coupled = previous.plan.patternId === 'ramp-gap'
      && current.plan.patternId === 'ramp-gap'
      && current.x - previous.x < 200;
    if (coupled) continue;
    const footprintStart = Math.min(current.x - 40, current.plan.takeoff.start);
    assert.ok(footprintStart >= previous.plan.clearUntil - 1,
      `${current.plan.obstacleId} at ${Math.round(current.x)} overlaps ${previous.plan.obstacleId} corridor`);
  }
});

// ───────────────────────── engine: preview, physics, collisions, rendering ─────────────────────────

test('Obstacle preview mode collapses generation to one validated type and restores mixes', () => {
  // Phase 11 — the passive rider dies on the first hazard after the reset
  // that ending a preview triggers, which starved the mix sample. The rider
  // stays invulnerable here because this test is about the planner's variety,
  // not survival.
  const collect = (game, frames) => {
    const placed = [];
    const run = game.run;
    for (let frame = 0; frame < frames; frame += 1) {
      for (const object of run.objects) {
        if (object.plan && !placed.includes(object)) placed.push(object);
      }
      run.invulnerableUntil = run.elapsed + 10;
      game.clock += 1 / 60;
      game.step(1 / 60);
      if (run.over) break;
    }
    return placed;
  };
  let engine = null;
  for (const id of NEW_IDS) {
    const made = makeEngine({ save: seedSave(4242, 3) });
    const game = made.game;
    engine = game;
    assert.equal(game.startObstaclePreview(id), true, `${id} preview starts`);
    const hazards = collect(game, 2400);
    assert.ok(hazards.length >= 1, `${id} preview placed hazards`);
    for (const hazard of hazards) {
      assert.equal(hazard.plan.obstacleId, id, `preview only places ${id}`);
      assert.equal(validPlacementMetadata(hazard.plan), true);
    }
    if (id === 'moving-platform') {
      assert.ok(hazards.every((hazard) => hazard.kind === 'gap' && hazard.bridged), 'platform is a bridged gap');
    }
    if (id === 'cliff' || id === 'broken-bridge') {
      assert.ok(hazards.every((hazard) => hazard.kind === 'gap' && !hazard.bridged), `${id} is an open gap variant`);
    }
  }
  assert.equal(engine.startObstaclePreview('nonexistent-id'), false, 'unknown ids are rejected');
  assert.equal(engine.startObstaclePreview(null), true, 'null restores the normal mix');
  const mixed = collect(engine, 2400);
  const ids = new Set(mixed.map((object) => object.plan.obstacleId));
  assert.ok(ids.size >= 2, 'mixed generation is restored');
});

test('Rendering draws every new obstacle across its full animation without errors', () => {
  for (const id of NEW_IDS) {
    const { game, recorder } = makeEngine({ save: seedSave(4242, 3) });
    game.startObstaclePreview(id);
    const run = game.run;
    // Ride until a preview hazard is on screen ahead of the rider.
    const found = driveUntil(game, (r) => !!aheadOf(r, null, id), 3600);
    assert.ok(found, `${id} hazard appeared ahead`);
    const hazard = aheadOf(run, null, id);
    // Park the rider just before the hazard so it stays on screen, then sweep
    // run.elapsed across a full cycle while drawing — every pose state
    // (hanging, shaking, falling, shattered/landed, sweeps, bobs) renders.
    run.rider.x = hazard.x - 520;
    run.rider.y = game.terrainAt(run.rider.x) - 5;
    const base = Math.max(run.elapsed, 3);
    for (let step = 0; step <= 16; step += 1) {
      run.elapsed = base + step * 0.36;
      game.draw();
    }
    assert.ok(recorder.operations > 500, `${id} preview rendered substantial canvas output`);
  }
});

test('Ice patches cut traction: lean lags and slope input is amplified', () => {
  const { game } = makeEngine({ save: seedSave(4242, 2) });
  game.startObstaclePreview('ice');
  const run = game.run;
  const slopeAt = (x) => (game.terrainAt(x + 8) - game.terrainAt(x - 8)) / 16;
  const flatPatch = driveUntil(game, (r) => {
    const patch = aheadOf(r, 'ice');
    if (!patch) return false;
    const mid = patch.x + (patch.width ?? 180) / 2;
    return Math.abs(slopeAt(mid)) < 0.06;
  }, 3600);
  assert.ok(flatPatch, 'flat ice patch generated ahead');
  const patch = aheadOf(run, 'ice');
  const x = patch.x + (patch.width ?? 180) / 2;
  run.rider.x = x;
  run.rider.y = game.terrainAt(x) - 5;
  run.rider.grounded = true;
  run.rider.vy = 0;
  run.rider.speed = 300;
  run.rider.rotation = 0.4;
  run.elapsed = Math.max(run.elapsed, 3);
  game.step(1 / 60);
  const onIceRotation = run.rider.rotation;
  assert.ok(onIceRotation > 0.25, `lean lags on ice (${onIceRotation.toFixed(3)})`);
  // Same spot without the patch: the lean snaps to the terrain angle.
  // (Phase 11 note — the patch hunt accepts slopes up to 0.06, so the snap
  // target itself can sit at ~0.057 rad; compare against the real ground
  // angle instead of near-zero.)
  run.objects.splice(run.objects.indexOf(patch), 1);
  run.rider.rotation = 0.4;
  game.step(1 / 60);
  const groundAngle = Math.atan(slopeAt(x));
  assert.ok(Math.abs(run.rider.rotation - groundAngle) < 0.03,
    `lean snaps to the terrain angle without ice (${run.rider.rotation.toFixed(3)} vs ${groundAngle.toFixed(3)})`);

  // Speed amplification: same engine, same descending spot, two passes — one
  // with an ice patch covering it, one without. The backward re-park between
  // passes is compensated in run.bonus so the score stays monotonic.
  const clear = driveUntil(game, (r) => {
    const spot = r.rider.x + 700;
    if (spot > r.rider.x + 2400) return false;
    const slope = slopeAt(spot);
    return slope > 0.005 && slope < 0.15
      && !r.objects.some((object) => object.kind === 'ice' && spot >= object.x - 60 && spot <= object.x + (object.width ?? 0) + 60);
  }, 3600);
  assert.ok(clear, 'found a clear descending spot');
  const spot = run.rider.x + 700;
  const scoreOf = (r) => Math.max(0, Math.floor(r.distance / 10)) + r.coins * 125 + r.bonus;
  const park = (target) => {
    const before = scoreOf(run);
    run.rider.x = target;
    run.rider.y = game.terrainAt(target) - 5;
    run.rider.grounded = true;
    run.rider.vy = 0;
    run.rider.speed = 300;
    run.rider.rotation = 0.3;
    run.distance = run.rider.x;
    run.bonus += Math.max(0, before - scoreOf(run));
    run.elapsed = Math.max(run.elapsed, 3);
  };
  park(spot);
  for (let frame = 0; frame < 30; frame += 1) game.step(1 / 60);
  const normal = run.rider.speed;
  run.objects.push({ kind: 'ice', x: spot - 30, width: 170 });
  park(spot);
  for (let frame = 0; frame < 30; frame += 1) game.step(1 / 60);
  const iced = run.rider.speed;
  assert.ok(iced > normal, `leaning accelerates more on ice (${iced.toFixed(1)} > ${normal.toFixed(1)})`);
  // Source contract: the traction hook is explicit and deterministic.
  const source = readFileSync(new URL('../src/game/engine.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('onIce ? 1.35 : 1'), 'slope amplification factor present');
});

test('Icicles crash only inside the falling window and telegraph a warning first', () => {
  const { game } = makeEngine({ save: seedSave(4242, 2) });
  game.startObstaclePreview('icicle');
  const run = game.run;
  assert.ok(driveUntil(game, (r) => !!aheadOf(r, 'icicle'), 3600), 'icicle generated ahead');
  const icicle = aheadOf(run, 'icicle');
  const ground = game.terrainAt(icicle.x);
  const phase = icicle.phase ?? 0;
  // Hanging: the rider passes underneath safely (cycle position 0).
  run.rider.x = icicle.x;
  run.rider.y = ground - 5;
  run.rider.grounded = true;
  run.rider.speed = 300;
  run.elapsed = 4.2 - phase + 4.2;
  assert.equal(iciclePose(ground, run.elapsed, phase).state, 'hanging');
  game.step(1 / 60);
  assert.equal(run.over, false, 'hanging icicle is passable');
  // Falling with the tip inside the rider envelope: crash. Search in
  // cycle-time, then convert back to an elapsed value that honours the phase.
  run.over = false;
  run.crashReason = '';
  run.rider.x = icicle.x;
  run.rider.y = ground - 5;
  run.rider.grounded = true;
  run.invulnerableUntil = 0;
  let cycleFall = 2.6;
  for (; cycleFall < 2.95; cycleFall += 0.005) {
    const pose = iciclePose(ground, cycleFall - phase, phase);
    if (pose.state === 'falling' && pose.y > run.rider.y - 36 && pose.y < run.rider.y + 8) break;
  }
  run.elapsed = cycleFall - phase + 4.2;
  assert.equal(iciclePose(ground, run.elapsed, phase).state, 'falling');
  game.step(1 / 60);
  assert.equal(run.over, true, 'falling icicle hits the rider');
  assert.ok(run.crashReason.toLowerCase().includes('icicle'), `crash reason names the icicle (${run.crashReason})`);
  // Shattered: harmless.
  run.over = false;
  run.crashReason = '';
  run.invulnerableUntil = 0;
  run.rider.x = icicle.x;
  run.rider.y = ground - 5;
  run.elapsed = 3.4 - phase + 4.2;
  assert.equal(iciclePose(ground, run.elapsed, phase).state, 'shattered');
  game.step(1 / 60);
  assert.equal(run.over, false, 'shattered icicle is harmless');
});

test('Branches follow the same timed-hazard contract', () => {
  const { game } = makeEngine({ save: seedSave(4242, 4) });
  game.startObstaclePreview('branch');
  const run = game.run;
  assert.ok(driveUntil(game, (r) => !!aheadOf(r, 'branch'), 3600), 'branch generated ahead');
  const branch = aheadOf(run, 'branch');
  const ground = game.terrainAt(branch.x);
  const phase = branch.phase ?? 0;
  run.rider.y = ground - 5;
  run.rider.grounded = true;
  run.rider.speed = 300;
  run.invulnerableUntil = 0;
  // Landed branches lie on the ground: safe.
  run.rider.x = branch.x;
  run.elapsed = 4.5 - phase + 5;
  assert.equal(branchPose(ground, run.elapsed, phase).state, 'landed');
  run.elapsed = Math.max(run.elapsed, 3);
  game.step(1 / 60);
  assert.equal(run.over, false, 'landed branch is harmless');
  // Falling with the limb across the rider envelope: crash.
  run.over = false;
  run.crashReason = '';
  run.rider.x = branch.x;
  run.invulnerableUntil = 0;
  let cycleFall = 3.5;
  for (; cycleFall < 3.9; cycleFall += 0.005) {
    const pose = branchPose(ground, cycleFall - phase, phase);
    if (pose.state === 'falling' && pose.y + 12 > run.rider.y - 36 && pose.y + 12 < run.rider.y + 8) break;
  }
  run.elapsed = cycleFall - phase + 5;
  assert.equal(branchPose(ground, run.elapsed, phase).state, 'falling');
  game.step(1 / 60);
  assert.equal(run.over, true, 'falling branch hits the rider');
  assert.ok(run.crashReason.toLowerCase().includes('branch'), `crash reason names the branch (${run.crashReason})`);
});

test('Snowballs collide at the ball, wherever the patrol has carried it', () => {
  const { game } = makeEngine({ save: seedSave(4242, 2) });
  game.startObstaclePreview('snowball');
  const run = game.run;
  assert.ok(driveUntil(game, (r) => !!aheadOf(r, 'snowball'), 3600), 'snowball generated ahead');
  const ball = aheadOf(run, 'snowball');
  const slope = (game.terrainAt(ball.x + 40) - game.terrainAt(ball.x - 40)) / 80;
  const phase = ball.phase ?? 0;
  const ballAt = (t) => snowballPose(ball.x, slope, t, phase).x;
  // Park the ball at its patrol center (sin = 0) and put the rider on it.
  // Search an absolute elapsed value at or after the current clock.
  let t = Math.max(run.elapsed, 3);
  for (; t < Math.max(run.elapsed, 3) + 8; t += 0.005) {
    if (Math.abs(Math.sin(t * 0.85 + phase)) < 0.02) break;
  }
  run.rider.x = ballAt(t);
  run.rider.y = game.terrainAt(run.rider.x) - 5;
  run.rider.grounded = true;
  run.rider.speed = 300;
  run.elapsed = t;
  run.invulnerableUntil = 0;
  run.shield = false;
  game.step(1 / 60);
  assert.equal(run.over, true, 'rider on the snowball crashes');
  assert.ok(run.crashReason.toLowerCase().includes('snowball'), `crash reason names the snowball (${run.crashReason})`);
  // Half a sweep away: safe.
  run.over = false;
  run.crashReason = '';
  run.invulnerableUntil = 0;
  const far = ballAt(t) + 130;
  run.rider.x = far;
  run.rider.y = game.terrainAt(far) - 5;
  game.step(1 / 60);
  assert.equal(run.over, false, 'rider far from the ball is safe');
});

test('Moving platforms fully support the rider across their gap', () => {
  const { game } = makeEngine({ save: seedSave(4242, 3) });
  game.startObstaclePreview('moving-platform');
  const run = game.run;
  assert.ok(driveUntil(game, (r) => !!aheadOf(r, 'gap', 'moving-platform'), 3600), 'moving platform generated ahead');
  const platform = aheadOf(run, 'gap', 'moving-platform');
  assert.ok(platform.width >= 120 && platform.width <= 170, `platform width in validated range (${platform.width})`);
  const end = platform.x + platform.width + 60;
  let frames = 0;
  while (run.rider.x < end && frames < 3600 && !run.over) {
    game.clock += 1 / 60;
    game.step(1 / 60);
    frames += 1;
  }
  assert.equal(run.over, false, 'the rider never crashes on the platform');
  assert.ok(run.rider.x >= end, 'the rider crossed the whole platform');
  assert.ok(!run.rider.fallingInto, 'the platform gap never swallows the rider');
});

test('Crashing into a new hazard and reviving stays safe and playable', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  game.startObstaclePreview('fence');
  const run = game.run;
  assert.ok(driveUntil(game, (r) => !!aheadOf(r, 'fence'), 3600), 'fence generated ahead');
  const fence = aheadOf(run, 'fence');
  const ground = game.terrainAt(fence.x);
  run.rider.x = fence.x;
  run.rider.y = ground - 5;
  run.rider.grounded = true;
  run.rider.speed = 300;
  run.elapsed = Math.max(run.elapsed, 3);
  run.invulnerableUntil = 0;
  run.shield = false;
  game.step(1 / 60);
  assert.equal(run.over, true, 'riding into a fence crashes');
  assert.ok(run.crashReason.toLowerCase().includes('fence'), `crash reason names the fence (${run.crashReason})`);
  assert.equal(game.revive(), true, 'revive is available');
  const revived = game.run;
  assert.ok(revived && !revived.over, 'rider is back on the board');
  const revivedX = revived.rider.x;
  // The revive protection window (3 s, obstacle-only) must carry the rider
  // through nearby fences without an instant re-crash.
  const after = drive(game, 150);
  assert.equal(after.over, false, 'no instant re-crash inside the revive window');
  assert.ok(after.rider.x > revivedX + 300, 'the run keeps moving');
});

test('Generation with the expanded library is deterministic and memory-bounded', () => {
  const runs = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { game } = makeEngine({ save: seedSave(777, 6) });
    game.start();
    const run = game.run;
    const placed = [];
    for (let frame = 0; frame < 2700; frame += 1) {
      for (const object of run.objects) {
        if (object.plan && !placed.includes(object)) placed.push(object);
      }
      if (frame % 46 === 0) game.press();
      if (frame % 46 === 3) game.release();
      game.clock += 1 / 60;
      game.step(1 / 60);
      if (run.over) break;
    }
    runs.push(placed
      .map((object) => [object.plan.obstacleId, Math.round(object.x), object.width ?? 0, object.bridged === true]));
    assert.ok(run.objects.length < 400, 'object count stays bounded');
  }
  assert.deepEqual(runs[0], runs[1], 'identical seeds produce identical hazard sequences');
  assert.ok(runs[0].length >= 2, 'level 6 actually schedules hazards');
  const kinds = new Set(runs[0].map(([id]) => id));
  assert.ok(kinds.size >= 2, 'high levels mix multiple patterns');
});
