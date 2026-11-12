import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 13 — deep valleys, high mountains and giant rolling ice boulders.
// These tests pin the three new systems end to end: the boulder's gravity
// physics, the gorge's valley-neck validation, the planner's new patterns,
// and the engine's rendering / crush / warning / audio wiring.

const { generateLevel, LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const {
  ObstaclePlanner, OBSTACLE_PATTERNS, patternAvailability, patternIsDangerous, validPlacementMetadata,
} = await import(moduleUrl('src/game/obstaclePlanner.ts'));
const {
  OBSTACLE_REGISTRY, obstacleReady, ICE_BOULDER, iceBoulderState, iceBoulderStep, iceBoulderPose,
} = await import(moduleUrl('src/game/obstacleRegistry.ts'));
const {
  TerrainGenerator, validateGorge, validateIceBoulder, BICYCLE_PHYSICS,
} = await import(moduleUrl('src/game/terrain.ts'));
const { validateObstaclePlacement } = await import(moduleUrl('src/game/feasibility.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));
const { EVENT_DEFINITIONS } = await import(moduleUrl('src/game/events.ts'));

const TAU = Math.PI * 2;

function storage(values = new Map()) {
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
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
  const context = {
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    font: '10px system-ui', textAlign: 'left', textBaseline: 'alphabetic',
    setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    createLinearGradient: () => gradient, createRadialGradient: () => gradient,
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, ellipse() {},
    fill() {}, stroke() {}, fillText() {}, strokeText() {}, drawImage() {},
  };
  return context;
}

function makeEngine({ search = '', save = storage() } = {}) {
  const events = [];
  globalThis.localStorage = save;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    location: { search },
  };
  globalThis.document = {
    createElement: () => ({ width: 192, height: 192, getContext: () => mockContext() }),
  };
  const game = new SnowGameEngine({
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    getContext: () => mockContext(),
  }, { onStatus() {}, onHud() {}, onGameOver() {}, onSound: (event) => events.push(event) });
  return { game, events, save };
}

// Deterministic planner driver (mirrors the audit harness).
function planSequence(level, count, surface) {
  const planner = new ObstaclePlanner();
  const state = {
    level, candidateX: 1000, riderX: 0, riderSpeed: 250, riderAcceleration: 10,
    surface, clearUntil: 640, bridgeAllowedAfter: 0, rampAllowedAfter: 4000,
    reserved: [{ start: 0, end: 640 }], nearby: [], recentPatterns: [],
  };
  const output = [];
  for (let index = 0; index < count; index += 1) {
    state.riderX = Math.max(0, state.candidateX - 1100);
    state.nearby = output.flatMap((plan) => plan.obstacles).slice(-8);
    state.recentPatterns = [...state.recentPatterns, ...output.filter((plan) => plan.patternId !== 'recovery').map((plan) => plan.patternId)].slice(-8);
    const plan = planner.plan(state);
    output.push(plan);
    state.candidateX = plan.nextX;
    state.clearUntil = Math.max(state.clearUntil, plan.clearUntil);
  }
  return output;
}

/** Flat approach with a raised far side — the minimal valley neck. */
function neckSurface(gapX, width, lift = 30) {
  return (x) => {
    if (x < gapX) return 360;
    if (x < gapX + width) return 360;
    // Gentle rise onto the next mountain section (canvas y shrinks = up).
    const t = Math.min(1, (x - (gapX + width)) / 240);
    return 360 - lift * (t * t * (3 - 2 * t));
  };
}

/** Ground rising toward +x (the rider's uphill) — the boulder's downhill. */
function uphillSurface(steepness = 0.12) {
  return (x) => 400 - x * steepness;
}

function snowyLevels(minNumber, limit = 6) {
  const found = [];
  for (let number = minNumber; number < minNumber + 60 && found.length < limit; number += 1) {
    for (const seed of [11, 4242, 981, 77]) {
      const level = generateLevel(number, seed);
      if (level.environment === 'snowy-mountains') { found.push({ level, seed }); break; }
    }
  }
  return found;
}

// ───────────────────────── registry & definitions ─────────────────────────

test('Gorge and ice boulder are fully implemented, warned hazards', () => {
  assert.equal(obstacleReady('gorge'), true, 'gorge is ready');
  assert.equal(obstacleReady('ice-boulder'), true, 'ice boulder is ready');
  assert.equal(OBSTACLE_REGISTRY.gorge.group, 'terrain');
  assert.equal(OBSTACLE_REGISTRY['ice-boulder'].group, 'moving');
  assert.equal(OBSTACLE_REGISTRY.gorge.requiresWarning, true);
  assert.equal(OBSTACLE_REGISTRY['ice-boulder'].requiresWarning, true);
  // Jump-over-able: the boulder's collision height must stay far below the
  // ~120px jump apex at any speed in the envelope.
  const collision = OBSTACLE_REGISTRY['ice-boulder'].collision;
  assert.ok(collision && collision.height >= 44 && collision.height <= 96, 'boulder is massive but jumpable');
  assert.ok(ICE_BOULDER.range >= 1200, 'roll corridor covers the meeting zone');
});

test('Mountain themes allow the new families; others do not', () => {
  for (const { level } of snowyLevels(5, 3)) {
    assert.ok(level.allowedObstacles.includes('gorge'), `${level.environment} L${level.number} allows the gorge`);
    assert.ok(level.allowedObstacles.includes('ice-boulder'), `${level.environment} L${level.number} allows the boulder`);
  }
  const misty = [];
  for (let number = 5; number < 40 && misty.length < 3; number += 1) {
    const level = generateLevel(number, 4242);
    if (level.environment === 'misty-mountains') misty.push(level);
  }
  for (const level of misty) assert.ok(level.allowedObstacles.includes('gorge'), 'misty allows the gorge');
  const level1 = generateLevel(1, 4242);
  assert.ok(!level1.allowedObstacles.includes('gorge') && !level1.allowedObstacles.includes('ice-boulder'), 'countryside stays classic');
});

// ───────────────────────── boulder physics ─────────────────────────

test('Boulder gravity: rolls toward the rider, accelerates downhill, rotates by distance', () => {
  const flat = (x) => 400;
  // Flat ground: constant release-speed roll toward −x.
  const poseFlat = iceBoulderPose(2000, flat, 5, 0);
  assert.ok(poseFlat.released, 'released after warmup');
  assert.ok(poseFlat.x < 2000, 'moves toward the rider');
  assert.ok(poseFlat.speed >= ICE_BOULDER.minSpeed - 1e-6 && poseFlat.speed <= ICE_BOULDER.maxSpeed, 'speed inside the roll band');
  // Rider-uphill ground: gravity accelerates the roll.
  const poseUp = iceBoulderPose(2000, uphillSurface(0.15), 5, 0);
  assert.ok(poseUp.speed > poseFlat.speed + 40, `uphill-for-the-rider terrain accelerates the boulder (${poseUp.speed} vs ${poseFlat.speed})`);
  assert.ok(poseUp.x < poseFlat.x, 'accelerating boulder covers more ground');
  // Rider-downhill ground: the boulder decelerates but never stalls or reverses.
  const downhill = (x) => 400 + x * 0.15;
  const poseDown = iceBoulderPose(2000, downhill, 5, 0);
  assert.ok(poseDown.x < 2000, 'still rolls toward the rider');
  assert.ok(poseDown.speed >= ICE_BOULDER.minSpeed - 1e-6, 'never stalls');
  // Rotation tracks travel: |rotation| = distance / radius.
  assert.ok(Math.abs(Math.abs(poseUp.rotation) - poseUp.distance / ICE_BOULDER.radius) < 1e-6, 'rotation = distance / radius');
  assert.ok(poseUp.rotation < 0, 'rolls counter-clockwise toward −x');
});

test('Boulder pose: warmup hold, determinism, and settle past the corridor', () => {
  const surface = uphillSurface(0.12);
  const held = iceBoulderPose(2000, surface, ICE_BOULDER.warmup - 0.01, 0);
  assert.equal(held.released, false);
  assert.equal(held.x, 2000, 'teeters on the spawn ledge before release');
  const a = iceBoulderPose(2000, surface, 6.25, 0.5);
  const b = iceBoulderPose(2000, surface, 6.25, 0.5);
  assert.deepEqual(a, b, 'pose is deterministic');
  const early = iceBoulderPose(2000, surface, 4, 0.5);
  const late = iceBoulderPose(2000, surface, 9, 0.5);
  assert.ok(late.x < early.x, 'keeps rolling with time');
  // Beyond the corridor range the boulder has left play for good.
  const settled = iceBoulderPose(2000, surface, 30, 0);
  const settledLater = iceBoulderPose(2000, surface, 60, 0);
  assert.equal(settled.x, settledLater.x, 'settles once past the validated range');
  assert.ok(settled.distance <= ICE_BOULDER.range + 1e-6, 'distance is capped by the range');
  // The fixed-step integrator advances monotonically.
  let state = iceBoulderState(1500);
  let monotonic = true;
  for (let index = 0; index < 200; index += 1) {
    const next = iceBoulderStep(state, surface, 1 / 60);
    if (next.x >= state.x || next.distance < state.distance) monotonic = false;
    state = next;
  }
  assert.ok(monotonic, 'step integration is monotonic toward the rider');
});

// ───────────────────────── validators ─────────────────────────

test('validateGorge accepts true valley necks and rejects everything else', () => {
  const options = { speeds: [BICYCLE_PHYSICS.minSpeed, 300, BICYCLE_PHYSICS.maxSpeed], modes: ['tap'] };
  for (const width of [88, 104, 118, 130]) {
    const surface = neckSurface(2000, width);
    const check = validateGorge(surface, 2000, width, options);
    assert.equal(check.safe, true, `width ${width} neck is safe (${check.reason})`);
    assert.ok(check.clearUntil >= 2000 + width, 'clears past the far lip');
    assert.ok(check.landing && check.landing.end > 2000 + width, 'landing band is past the gorge');
  }
  // Far side not raised: not a valley.
  assert.equal(validateGorge((x) => 360, 2000, 120).safe, false, 'flat far side rejected');
  const lowered = (x) => (x < 2120 ? 360 : 380);
  assert.equal(validateGorge(lowered, 2000, 120).safe, false, 'lowered far side rejected');
  // Width outside the validated band.
  assert.equal(validateGorge(neckSurface(2000, 80), 2000, 80).safe, false, 'too narrow');
  assert.equal(validateGorge(neckSurface(2000, 170), 2000, 170).safe, false, 'too wide');
  // Steep takeoff.
  const steepApproach = (x) => (x < 2000 ? 360 - (x - 1900) * 0.3 : 360 - 30 * Math.min(1, (x - 2000) / 240));
  assert.equal(validateGorge(steepApproach, 2000, 120).safe, false, 'steep takeoff rejected');
});

test('validateIceBoulder demands a ledge falling away toward the rider', () => {
  const options = { speeds: [BICYCLE_PHYSICS.minSpeed, 300, BICYCLE_PHYSICS.maxSpeed], modes: ['tap'] };
  const uphill = validateIceBoulder(uphillSurface(0.12), 3000, options);
  assert.equal(uphill.safe, true, `rider-uphill ledge is safe (${uphill.reason})`);
  assert.ok(uphill.takeoff && uphill.takeoff.end <= 3000 - 140, 'takeoff band sits before the spawn ledge');
  assert.equal(validateIceBoulder((x) => 400, 3000).safe, false, 'flat ground rejected');
  const downhill = (x) => 400 + x * 0.12;
  assert.equal(validateIceBoulder(downhill, 3000).safe, false, 'rider-downhill ground rejected');
  const wall = (x) => 400 - x * 0.4;
  assert.equal(validateIceBoulder(wall, 3000).safe, false, 'unreadable wall rejected');
});

// ───────────────────────── planner integration ─────────────────────────

test('Gorge-crossing and boulder-run are dangerous patterns gated by the level ladder', () => {
  const gorge = OBSTACLE_PATTERNS.find((pattern) => pattern.id === 'gorge-crossing');
  const boulder = OBSTACLE_PATTERNS.find((pattern) => pattern.id === 'boulder-run');
  assert.ok(gorge && gorge.requires.includes('gorge'), 'gorge pattern exists');
  assert.ok(boulder && boulder.requires.includes('ice-boulder'), 'boulder pattern exists');
  assert.equal(patternIsDangerous('gorge-crossing'), true);
  assert.equal(patternIsDangerous('boulder-run'), true);
  const snowy7 = snowyLevels(7, 1)[0].level;
  assert.ok(snowy7.number >= 7, 'found a snowy level ≥ 7');
  const available = patternAvailability(snowy7);
  assert.ok(available.find((item) => item.id === 'gorge-crossing')?.available, `gorge available in snowy L${snowy7.number}`);
  assert.ok(available.find((item) => item.id === 'boulder-run')?.available, `boulder available in snowy L${snowy7.number}`);
  // The stagger: the first mountain level past 5 carries the boulder but not
  // yet the gorge (no level introduces five families at once).
  const snowy5 = snowyLevels(5, 1)[0].level;
  assert.ok(snowy5.number < snowy7.number, 'an earlier mountain level exists');
  assert.ok(!patternAvailability(snowy5).find((item) => item.id === 'gorge-crossing')?.available, `gorge staggered past snowy L${snowy5.number}`);
  assert.ok(patternAvailability(snowy5).find((item) => item.id === 'boulder-run')?.available, `boulder already live in snowy L${snowy5.number}`);
  // Level 2 is snowy but below the envMinLevel gate; level 1 has no mountain theme.
  const level2 = generateLevel(2, 4242);
  assert.equal(level2.environment, 'snowy-mountains');
  assert.ok(!patternAvailability(level2).find((item) => item.id === 'gorge-crossing')?.available, 'gorge gated before snowy L5');
  assert.ok(!patternAvailability(level2).find((item) => item.id === 'boulder-run')?.available, 'boulder gated before snowy L5');
  assert.ok(!patternAvailability(generateLevel(1, 4242)).find((item) => item.id === 'gorge-crossing')?.available, 'gorge gated outside mountain themes');
});

test('Planner places gorges and boulders on real mountain terrain with valid metadata', () => {
  const options = { speeds: [BICYCLE_PHYSICS.minSpeed, 300, BICYCLE_PHYSICS.maxSpeed], modes: ['tap', 'hold'], timingMargin: 8 };
  let gorges = 0;
  let boulders = 0;
  for (const { level } of snowyLevels(7, 5)) {
    const terrain = new TerrainGenerator(level);
    const surface = (x) => 360 + terrain.heightAt(x);
    for (const plan of planSequence(level, 60, surface)) {
      for (const obstacle of plan.obstacles) {
        assert.equal(validPlacementMetadata(obstacle.plan), true, `${plan.patternId} metadata validates`);
        if (obstacle.kind === 'gap' && obstacle.plan.obstacleId === 'gorge') {
          gorges += 1;
          assert.ok(obstacle.width >= 88 && obstacle.width <= 150, 'gorge width in band');
          assert.equal(validateGorge(surface, obstacle.x, obstacle.width, options).safe, true, `gorge @${Math.round(obstacle.x)} revalidates`);
        }
        if (obstacle.kind === 'ice-boulder') {
          boulders += 1;
          assert.equal(validateIceBoulder(surface, obstacle.x, options).safe, true, `boulder @${Math.round(obstacle.x)} revalidates`);
          assert.equal(validateObstaclePlacement(obstacle, surface).length, 0, `boulder @${Math.round(obstacle.x)} passes the feasibility sweep`);
          // Head-on hazard: the warning leads by the combined closing distance.
          assert.ok(obstacle.plan.warningStart <= obstacle.plan.takeoff.start - 300, 'boulder reaction floor holds');
          assert.ok(obstacle.plan.warningStart <= obstacle.x - 1400, 'boulder warning leads the closing distance');
        }
      }
    }
  }
  assert.ok(gorges >= 1, `gorge crossings appear on mountain terrain (${gorges})`);
  assert.ok(boulders >= 1, `ice boulders appear on mountain terrain (${boulders})`);
});

test('Gorge placements pass the independent feasibility auditor', () => {
  let checked = 0;
  for (const { level } of snowyLevels(7, 4)) {
    const terrain = new TerrainGenerator(level);
    const surface = (x) => 360 + terrain.heightAt(x);
    for (const plan of planSequence(level, 20, surface)) {
      for (const obstacle of plan.obstacles) {
        if (obstacle.kind === 'gap' && obstacle.plan.obstacleId === 'gorge') {
          const violations = validateObstaclePlacement({ ...obstacle, bridged: false }, surface);
          assert.deepEqual(violations, [], `gorge @${Math.round(obstacle.x)} feasible: ${JSON.stringify(violations)}`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked >= 1, `feasibility checked at least one gorge (${checked})`);
});

test('A boulder never rolls its corridor across a chasm', () => {
  const level = { ...snowyLevels(6, 1)[0].level, allowedObstacles: ['ice-boulder'] };
  const terrain = new TerrainGenerator(level);
  const surface = (x) => 360 + terrain.heightAt(x);
  // Find a ledge the validator accepts, then plant an un-bridged gap inside
  // its backward roll corridor and demand the planner refuse.
  let ledge = -1;
  for (let x = 2000; x < 12000 && ledge < 0; x += 40) {
    if (validateIceBoulder(surface, x).safe) ledge = x;
  }
  assert.ok(ledge > 0, 'found a boulder ledge on mountain terrain');
  const planner = new ObstaclePlanner();
  const base = {
    level, candidateX: ledge, riderX: ledge - 1200, riderSpeed: 300, riderAcceleration: 10,
    surface, clearUntil: ledge - 1600, bridgeAllowedAfter: 0, rampAllowedAfter: 0,
    reserved: [], nearby: [], recentPatterns: [],
  };
  // Inside every scan offset's backward corridor ([ledge−600, ledge+60] is
  // the intersection of all the windows the scan tries).
  const gap = { kind: 'gap', x: ledge - 300, width: 100, plan: { obstacleId: 'gap', takeoff: { start: ledge - 460, end: ledge - 400 }, landing: { start: ledge - 180, end: ledge - 120 }, clearUntil: ledge - 100, warningStart: ledge - 900, spacing: 0 } };
  const blocked = planner.plan({ ...base, nearby: [gap] });
  assert.ok(!blocked.obstacles.some((object) => object.kind === 'ice-boulder'), 'boulder refused behind a chasm');
  assert.ok(blocked.rejected.some((entry) => entry.reason.includes('chasm')), `rejection recorded (${blocked.rejected.at(-1)?.reason})`);
});

// ───────────────────────── mountains & terrain ─────────────────────────

test('Mountain-descent terrain: elevated peaks, deep valleys, slope cap intact', () => {
  let descentLevels = 0;
  for (let number = 5; number < 40 && descentLevels < 4; number += 1) {
    const level = generateLevel(number, 4242);
    if (level.environment !== 'snowy-mountains' || level.profile.id !== 'mountain-descent') continue;
    descentLevels += 1;
    const terrain = new TerrainGenerator(level);
    let min = Infinity;
    let max = -Infinity;
    let worstSlope = 0;
    for (let x = 0; x <= 25600; x += 8) {
      const y = terrain.heightAt(x);
      min = Math.min(min, y);
      max = Math.max(max, y);
      if (x >= 8) worstSlope = Math.max(worstSlope, Math.abs((y - terrain.heightAt(x - 8)) / 8));
    }
    assert.ok(max - min >= 100, `L${level.number} peak-to-valley ${Math.round(max - min)}px — mountains read as mountains`);
    assert.ok(worstSlope <= 0.34 + 1e-9, `L${level.number} slope cap holds (${worstSlope.toFixed(3)})`);
  }
  assert.ok(descentLevels >= 1, `found mountain-descent levels (${descentLevels})`);
});

// ───────────────────────── engine integration ─────────────────────────

test('Engine harvest: boulders and gorges stream through the live planner', () => {
  let boulderRuns = 0;
  const harvest = (game, passes) => {
    const run = game.run;
    const objects = [];
    const scheduled = new Set();
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
      run.rider.x += 1500;
      run.distance = run.rider.x;
      game.populateAhead(run);
      // Objects are culled behind the rider and the repetition memory rolls
      // over mid-ride, so each pass snapshots the live stream AND the
      // scheduled-pattern union (the audit harness snapshots objects the
      // same way).
      objects.push(...run.objects);
      for (const id of run.recentPatterns ?? []) scheduled.add(id);
    }
    return { objects, scheduled };
  };
  for (const { level, seed } of snowyLevels(7, 4)) {
    const { game } = makeEngine({ save: seedSave(seed, level.number) });
    game.start();
    const { scheduled } = harvest(game, 26);
    if (scheduled.has('boulder-run')) boulderRuns += 1;
  }
  assert.ok(boulderRuns >= 1, `the natural mix schedules boulder runs (${boulderRuns} of 4 levels)`);

  // The dev preview path collapses the mix to one family while keeping the
  // full validation pipeline — the strongest live-engine stream for both
  // new hazards on real terrain.
  const { level, seed } = snowyLevels(7, 1)[0];
  const options = { speeds: [BICYCLE_PHYSICS.minSpeed, 300, BICYCLE_PHYSICS.maxSpeed], modes: ['tap', 'hold'], timingMargin: 8 };
  {
    const { game } = makeEngine({ save: seedSave(seed, level.number) });
    game.start();
    assert.equal(game.startObstaclePreview('ice-boulder'), true, 'preview accepts the boulder');
    let boulders = 0;
    for (const object of harvest(game, 30).objects) {
      if (object.kind === 'ice-boulder') {
        boulders += 1;
        assert.ok(object.plan, 'boulder carries planner metadata');
        assert.equal(typeof object.phase, 'number', 'boulder clock is stamped');
        assert.ok(object.phase >= 5, 'clock stamped at insertion time');
      }
    }
    assert.ok(boulders >= 1, `live planner streams ice boulders (${boulders})`);
  }
  {
    const { game } = makeEngine({ save: seedSave(seed, level.number) });
    game.start();
    assert.equal(game.startObstaclePreview('gorge'), true, 'preview accepts the gorge');
    let gorges = 0;
    for (const object of harvest(game, 30).objects) {
      if (object.kind === 'gap' && object.plan?.obstacleId === 'gorge') {
        gorges += 1;
        assert.ok(object.width >= 88 && object.width <= 150, 'gorge width in band');
        assert.equal(validateGorge((x) => game.terrainAt(x), object.x, object.width, options).safe, true, `gorge @${Math.round(object.x)} revalidates on the engine terrain`);
      }
    }
    assert.ok(gorges >= 1, `live planner streams gorges (${gorges})`);
  }
});

test('Boulders smash the static obstacles they roll through', () => {
  const { game, events } = makeEngine({ save: seedSave(4242, 9) });
  game.start();
  const run = game.run;
  run.elapsed = 100;
  run.objects = [];
  const spawn = 6000;
  const surface = (x) => game.terrainAt(x);
  // Choose a release time that puts the boulder mid-roll (inside the
  // corridor, still moving) regardless of the terrain it spawned on.
  let phase = run.elapsed - 2;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = iceBoulderPose(spawn, surface, run.elapsed, phase);
    if (probe.released && probe.distance > 300 && probe.distance < 1000) break;
    phase -= 0.5;
  }
  const boulder = { kind: 'ice-boulder', x: spawn, phase };
  run.objects.push(boulder);
  game.updateIceBoulders(run);
  const before = iceBoulderPose(spawn, surface, run.elapsed, phase);
  const after = iceBoulderPose(spawn, surface, run.elapsed + 1 / 60, phase);
  assert.ok(after.x < before.x, 'boulder is advancing toward the rider');
  // A rock and a tree squarely inside the next frame's sweep.
  const rock = { kind: 'rock', x: (before.x + after.x) / 2, plan: undefined };
  const tree = { kind: 'tree', x: after.x - 6, plan: undefined };
  run.objects.push(rock, tree);
  run.elapsed += 1 / 60;
  game.updateIceBoulders(run);
  assert.ok(!run.objects.includes(rock), 'rock smashed by the rolling boulder');
  assert.ok(!run.objects.includes(tree), 'tree smashed too');
  assert.ok(run.particles.length > 0, 'debris particles spawned');
  assert.ok(events.some((event) => event.type === 'iceCrush'), 'ice crush cue emitted');
  // The boulder itself survives its own smash-through.
  assert.ok(run.objects.includes(boulder), 'the boulder keeps rolling');
});

test('Boulder crash: rider impact emits the ice crash and finishes the run', () => {
  const { game, events } = makeEngine({ save: seedSave(4242, 9) });
  game.start();
  const run = game.run;
  run.elapsed = 100;
  const spawn = 6000;
  let phase = run.elapsed - 2;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = iceBoulderPose(spawn, (x) => game.terrainAt(x), run.elapsed, phase);
    if (probe.released && probe.distance > 300 && probe.distance < 1000) break;
    phase -= 0.5;
  }
  const boulder = { kind: 'ice-boulder', x: spawn, phase };
  run.objects.push(boulder);
  const surface = (x) => game.terrainAt(x);
  const pose = iceBoulderPose(spawn, surface, run.elapsed, boulder.phase);
  run.rider.x = pose.x;
  run.rider.y = game.terrainAt(pose.x) - 5;
  run.rider.grounded = true;
  run.rider.speed = 300;
  run.invulnerableUntil = 0;
  const crashed = game.checkCollision(run);
  assert.equal(crashed, true, 'rider collides with the boulder envelope');
  assert.ok(run.over, 'run finished');
  assert.ok(events.some((event) => event.type === 'crash' && event.kind === 'ice'), 'ice crash sound emitted');
});

test('The boulder is survivable: a well-timed jump clears the envelope', () => {
  const { game } = makeEngine({ save: seedSave(4242, 9) });
  game.start();
  const run = game.run;
  run.elapsed = 100;
  const spawn = 6000;
  let phase = run.elapsed - 2;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = iceBoulderPose(spawn, (x) => game.terrainAt(x), run.elapsed, phase);
    if (probe.released && probe.distance > 300 && probe.distance < 1000) break;
    phase -= 0.5;
  }
  const boulder = { kind: 'ice-boulder', x: spawn, phase };
  run.objects.push(boulder);
  const surface = (x) => game.terrainAt(x);
  // Freeze the rider high above the boulder's envelope at the exact meeting
  // x — the jump apex clears the 58px collision box.
  const pose = iceBoulderPose(spawn, surface, run.elapsed, boulder.phase);
  run.rider.x = pose.x;
  run.rider.y = game.terrainAt(pose.x) - 5 - 100;
  run.invulnerableUntil = 0;
  assert.equal(game.checkCollision(run), false, 'airborne rider clears the boulder');
});

test('Audio rumble, warning and visual wiring are connected', () => {
  const engineSource = readFileSync('src/game/engine.ts', 'utf8');
  assert.ok(engineSource.includes('private drawIceBoulder('), 'boulder renderer exists');
  assert.ok(engineSource.includes("object.plan?.obstacleId === 'gorge'"), 'gorge pit variant renders');
  assert.ok(engineSource.includes('rollingIce: this.iceBoulderProximity()'), 'frame state feeds the rumble');
  assert.ok(engineSource.includes("type: 'iceCrush'"), 'crush cue emitted');
  assert.ok(engineSource.includes("'ICE BOULDER AHEAD'") || engineSource.includes('(upcoming.plan?.obstacleId ?? upcoming.kind)'), 'warning label derives from the obstacle id');
  const audioSource = readFileSync('src/game/audio.ts', 'utf8');
  assert.ok(audioSource.includes('private iceShatter('), 'ice shatter sound exists');
  assert.ok(audioSource.includes('this.rumble = this.makeLoop'), 'rumble loop is built');
  const registrySource = readFileSync('src/game/obstacleRegistry.ts', 'utf8');
  assert.ok(registrySource.includes('ICE_BOULDER'), 'boulder physics constants exported');
  // The new families do not disturb the event catalogue.
  assert.ok(EVENT_DEFINITIONS.length >= 1, 'events intact');
});
