import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { moduleUrl } from './loadTypeScript.mjs';

const { generateLevel, LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { OBSTACLE_PATTERNS, ObstaclePlanner, patternIsDangerous, patternRating, validPlacementMetadata } = await import(moduleUrl('src/game/obstaclePlanner.ts'));
const { TerrainGenerator, validateGap, validateRamp, validateObstacle, validateSwingingLog, validateRampGap, validateIcePatch, validateSnowball, validateFallingHazard, BICYCLE_PHYSICS } = await import(moduleUrl('src/game/terrain.ts'));
const { DifficultyManager, DEFAULT_DIFFICULTY_CONFIG } = await import(moduleUrl('src/game/difficulty.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

const TARGET = 50_000;

function storage() {
  const values = new Map();
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

function makeEngine(save = storage()) {
  globalThis.localStorage = save;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    location: { search: '' },
  };
  return new SnowGameEngine(
    { getBoundingClientRect: () => ({ width: 900, height: 600 }), getContext: () => ({ setTransform() {} }) },
    { onStatus() {}, onHud() {}, onGameOver() {} },
  );
}

function context(level, seed, surface = () => 360, overrides = {}) {
  return {
    level: generateLevel(level, seed), candidateX: 1000, riderX: 0, riderSpeed: 250, riderAcceleration: 10,
    surface, clearUntil: 640, bridgeAllowedAfter: 0, rampAllowedAfter: 0,
    reserved: [{ start: 0, end: 640 }], nearby: [], ...overrides,
  };
}

function directive(overrides = {}) {
  return {
    reactionSeconds: 1.2, recoveryChance: 0.05, patternIntensity: 0.4, minSpacing: 150,
    dangerRecovery: 240, safeApproach: false, ...overrides,
  };
}

function pacedPlans({ level, seed = 42, count = 30, progress = 0.5, surface = () => 360, contextOverrides = {} }) {
  const planner = new ObstaclePlanner();
  const state = context(level, seed, surface, contextOverrides);
  state.directive = directive();
  state.directive.patternIntensity = new DifficultyManager()
    .directive({ level: state.level, progress, terrainComplexity: 0 }).patternIntensity;
  state.recentPatterns = [];
  const output = [];
  for (let index = 0; index < count; index += 1) {
    state.riderX = Math.max(0, state.candidateX - 1100);
    state.nearby = output.flatMap((plan) => plan.obstacles).slice(-8);
    const plan = planner.plan(state);
    output.push(plan);
    state.candidateX = plan.nextX;
    state.clearUntil = Math.max(state.clearUntil, plan.clearUntil);
    if (plan.obstacles.length) state.recentPatterns = [...state.recentPatterns, plan.patternId].slice(-8);
    if (plan.obstacles.some((object) => object.bridged)) state.bridgeAllowedAfter = plan.clearUntil + 4500;
  }
  return output;
}

const dangerousKinds = (object) => (object.kind === 'gap' && !object.bridged) || object.kind === 'ramp' || object.kind === 'swinging-log';

// ───────────────────────── between-level progression ─────────────────────────

test('Between-level intensity is monotonic, saturating and configurable', () => {
  const manager = new DifficultyManager();
  const levels = Array.from({ length: 60 }, (_, index) => index + 1);
  const curve = levels.map((number) => manager.levelIntensity(number));
  for (let index = 1; index < curve.length; index += 1) {
    assert.ok(curve[index] >= curve[index - 1], `intensity must not decrease at level ${levels[index]}`);
  }
  assert.equal(curve[0], 0, 'level 1 is the zero-difficulty baseline');
  assert.ok(curve.every((value) => value <= DEFAULT_DIFFICULTY_CONFIG.levelCap + 1e-9), 'curve respects the cap');
  // The suggested tier bands stay ordered: 1–2 beginner, 3–5 moderate, 6–10 advanced,
  // 11–20 varied combinations, 21+ controlled expert territory.
  assert.ok(curve[1] < curve[2] && curve[4] < curve[5] && curve[9] < curve[10] && curve[19] < curve[20]);
  assert.ok(manager.levelIntensity(400) - manager.levelIntensity(200) < 0.02, 'curve saturates');
  const custom = new DifficultyManager({ levelCap: 0.5, levelTau: 3 });
  assert.ok(custom.levelIntensity(1) === 0 && custom.levelIntensity(500) <= 0.5);
  for (const bad of [{ levelCap: 0 }, { levelTau: -1 }, { waves: 0 }, { safeApproachFrom: 0 },
    { zones: [{ upTo: 0.5, multiplier: 1, label: 'a' }, { upTo: 0.4, multiplier: 1, label: 'b' }] },
    { zones: [{ upTo: 0.5, multiplier: 1, label: 'a' }] }]) {
    assert.throws(() => new DifficultyManager(bad), RangeError);
  }
  assert.throws(() => manager.levelIntensity(0), RangeError);
});

test('Pacing zones map the 50k journey and taper into a safe approach', () => {
  const manager = new DifficultyManager();
  const level = generateLevel(12, 42);
  assert.equal(manager.zoneAt(0.05, TARGET).label, 'WARM-UP');
  assert.equal(manager.zoneAt(0.25, TARGET).label, 'BUILD-UP');
  assert.equal(manager.zoneAt(0.5, TARGET).label, 'MODERATE');
  assert.equal(manager.zoneAt(0.7, TARGET).label, 'MAIN CHALLENGE');
  assert.equal(manager.zoneAt(0.85, TARGET).label, 'FINAL SEQUENCES');
  assert.equal(manager.zoneAt(0.95, TARGET).label, 'SAFE APPROACH');
  const zone = manager.zoneAt(0.25, TARGET);
  assert.deepEqual([zone.fromPoints, zone.toPoints], [10_000, 20_000]);
  const multipliers = [0.05, 0.25, 0.5, 0.7, 0.85, 0.95].map((p) => manager.zoneAt(p, TARGET).multiplier);
  for (let index = 1; index < 4; index += 1) assert.ok(multipliers[index] >= multipliers[index - 1]);
  assert.ok(multipliers[5] < multipliers[4], 'the final zone backs off');
  const challenge = manager.directive({ level, progress: 0.7 });
  const approach = manager.directive({ level, progress: 0.95 });
  assert.equal(approach.safeApproach, true);
  assert.equal(challenge.safeApproach, false);
  assert.ok(approach.intensity < challenge.intensity, '45k–50k tapers below the main challenge');
});

test('Difficulty waves breathe instead of climbing monotonically', () => {
  const manager = new DifficultyManager();
  const level = generateLevel(12, 42);
  const samples = [];
  for (let progress = 0; progress < 0.9; progress += 0.005) {
    samples.push({ progress, wave: manager.waveAt(progress), d: manager.directive({ level, progress }) });
  }
  assert.ok(samples.every((sample) => sample.d.intensity <= 1 && sample.d.intensity >= 0));
  // A genuine peak: strictly higher than some earlier AND some later sample.
  const peaked = samples.some((mid, index) => samples.some((before, beforeIndex) => beforeIndex < index
    && mid.d.intensity > before.d.intensity + 0.02)
    && samples.some((after, afterIndex) => afterIndex > index && mid.d.intensity > after.d.intensity + 0.02));
  assert.ok(peaked, 'waves must produce local maxima (difficulty is not monotonic)');
  const valleys = samples.filter((sample) => sample.wave.recovery);
  assert.ok(valleys.length > 20, `recovery valleys exist and hold (got ${valleys.length} samples)`);
  const distinct = new Set(samples.map((sample) => sample.wave.index));
  assert.deepEqual([...distinct].sort(), [0, 1, 2], 'three wave cycles across the level');
  const tensions = samples.map((sample) => sample.wave.tension);
  assert.ok(Math.max(...tensions) >= 0.95 && Math.min(...tensions) <= DEFAULT_DIFFICULTY_CONFIG.waveRecoveryTension + 1e-9,
    'each wave swings between a challenge crest and a recovery floor');
  // Upcoming-recovery bookkeeping is self-consistent.
  const before = manager.directive({ level, progress: 0.35 });
  assert.ok(before.nextRecoveryPoints > 0 && before.nextRecoveryPoints <= 15_000);
  assert.equal(manager.directive({ level, progress: 0.35 + before.nextRecoveryPoints / TARGET + 0.001 }).wave.recovery, true);
  assert.equal(manager.directive({ level, progress: 0.57 }).nextRecoveryPoints, 0, 'inside a valley reports 0');
  assert.equal(manager.directive({ level, progress: 0.95 }).nextRecoveryPoints, null, 'safe approach needs no waves');
});

test('Directives are deterministic, pure and damped by terrain complexity', () => {
  const manager = new DifficultyManager();
  const level = generateLevel(9, 4242);
  const a = manager.directive({ level, progress: 0.55, terrainComplexity: 0.4 });
  const b = manager.directive({ level, progress: 0.55, terrainComplexity: 0.4 });
  assert.deepEqual(a, b);
  const flat = manager.directive({ level, progress: 0.55, terrainComplexity: 0 });
  const rough = manager.directive({ level, progress: 0.55, terrainComplexity: 0.9 });
  assert.ok(rough.intensity <= flat.intensity, 'rough terrain never sharpens obstacles');
  assert.ok(rough.reactionSeconds >= flat.reactionSeconds, 'rough terrain buys reaction time');
  assert.ok(rough.minSpacing >= flat.minSpacing, 'rough terrain widens spacing');
  assert.ok(a.riderEnvelope.maxSpeed === BICYCLE_PHYSICS.maxSpeed);
  assert.ok(a.riderEnvelope.minJumpDistance > 200 && a.riderEnvelope.maxJumpDistance > a.riderEnvelope.minJumpDistance);
  assert.throws(() => manager.directive({ level, progress: Number.NaN }), RangeError);
});

// ───────────────────────── planner pacing integration ─────────────────────────

test('The safe final approach refuses dangerous patterns across levels and seeds', () => {
  const planner = new ObstaclePlanner();
  const safe = directive({ safeApproach: true, recoveryChance: 0, patternIntensity: 0.85 });
  let accepted = 0;
  for (const level of [1, 6, 12, 21, 40]) {
    for (const seed of [3, 77, 911]) {
      const state = context(level, seed);
      state.directive = safe;
      state.recentPatterns = [];
      for (let candidate = 800; candidate < 9000; candidate += 379) {
        state.candidateX = candidate;
        state.riderX = Math.max(0, candidate - 1100);
        const plan = planner.plan(state);
        if (!plan.obstacles.length) continue;
        accepted += 1;
        assert.equal(patternIsDangerous(plan.patternId), false, `${plan.patternId} at L${level} seed ${seed} x${candidate}`);
        assert.ok(plan.obstacles.length <= 1, 'safe approach keeps single, mild obstacles');
      }
    }
  }
  assert.ok(accepted > 60, `expected a meaningful sample, got ${accepted}`);
  // Control: without the safe flag the same space does schedule dangerous patterns.
  let dangerousSeen = 0;
  for (const seed of [3, 77, 911]) {
    const state = context(21, seed);
    state.directive = directive({ recoveryChance: 0, patternIntensity: 0.85 });
    state.recentPatterns = [];
    for (let candidate = 800; candidate < 9000; candidate += 379) {
      state.candidateX = candidate;
      state.riderX = Math.max(0, candidate - 1100);
      const plan = planner.plan(state);
      if (plan.obstacles.length && patternIsDangerous(plan.patternId)) dangerousSeen += 1;
    }
  }
  assert.ok(dangerousSeen > 5, 'high intensity outside the approach must still schedule dangerous patterns');
});

test('Pattern selection targets the pacing rating and suppresses repetition', () => {
  const manager = new DifficultyManager();
  const high = manager.directive({ level: generateLevel(20, 15), progress: 0.7 });
  const low = manager.directive({ level: generateLevel(1, 15), progress: 0.05 });
  assert.ok(high.patternIntensity - low.patternIntensity > 0.4);

  const ratings = (config) => {
    const planner = new ObstaclePlanner();
    const state = context(config.level, config.seed);
    state.directive = { ...directive({ recoveryChance: 0 }), patternIntensity: config.patternIntensity };
    state.recentPatterns = [];
    const seen = [];
    for (let candidate = 800; candidate < 12_000; candidate += 331) {
      state.candidateX = candidate;
      state.riderX = Math.max(0, candidate - 1100);
      const plan = planner.plan(state);
      if (!plan.obstacles.length) continue;
      seen.push(patternRating(plan.patternId));
      state.recentPatterns = [...state.recentPatterns, plan.patternId].slice(-8);
    }
    return seen;
  };
  const highRatings = ratings({ level: 20, seed: 15, patternIntensity: high.patternIntensity });
  const lowRatings = ratings({ level: 1, seed: 15, patternIntensity: low.patternIntensity });
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(mean(highRatings) - mean(lowRatings) > 0.25, `high ${mean(highRatings).toFixed(2)} vs low ${mean(lowRatings).toFixed(2)}`);
  assert.ok(highRatings.filter((value) => value >= 0.5).length > lowRatings.filter((value) => value >= 0.5).length);

  // Repetition: a pattern recent three times is heavily discounted.
  const countPattern = (recent) => {
    const planner = new ObstaclePlanner();
    const state = context(1, 8);
    state.directive = directive({ recoveryChance: 0, patternIntensity: 0.05 });
    let count = 0;
    for (let candidate = 800; candidate < 20_000; candidate += 307) {
      state.candidateX = candidate;
      state.riderX = Math.max(0, candidate - 1100);
      state.recentPatterns = recent;
      const plan = planner.plan(state);
      if (plan.patternId === 'single-rock') count += 1;
    }
    return count;
  };
  const clean = countPattern([]);
  const suppressed = countPattern(['single-rock', 'single-rock', 'single-rock']);
  assert.ok(clean > 10, `control must choose single-rock often, got ${clean}`);
  assert.ok(suppressed < clean * 0.5, `penalised run chose it ${suppressed}/${clean} times`);
});

test('Pacing enforces spacing, reaction and danger recovery budgets', () => {
  const manager = new DifficultyManager();
  const level = generateLevel(12, 42);
  const planner = new ObstaclePlanner();
  const state = context(12, 42);
  const pacing = manager.directive({ level, progress: 0.85, terrainComplexity: 0 });
  state.directive = { ...directive({ recoveryChance: 0 }), ...pacing };
  state.recentPatterns = [];
  // Phase 11 — the corridor is speed-projected off the rider's approach
  // (floor 300) instead of always assuming sprint speed.
  const reactionDistance = Math.max(300, 250 + 10 * (1000 / 250)) * pacing.reactionSeconds;
  let dangerous = null;
  let mild = null;
  for (let candidate = 800; candidate < 15_000; candidate += 307) {
    state.candidateX = candidate;
    state.riderX = Math.max(0, candidate - 1100);
    const plan = planner.plan(state);
    if (!plan.obstacles.length) continue;
    const gap = plan.nextX - plan.clearUntil;
    assert.ok(gap >= reactionDistance + pacing.minSpacing - 1e-6, `spacing ${Math.round(gap)} at ${candidate}`);
    if (patternIsDangerous(plan.patternId)) {
      assert.ok(gap >= reactionDistance + pacing.minSpacing + pacing.dangerRecovery - 1e-6, 'dangerous patterns earn recovery room');
      dangerous ??= plan;
    } else mild ??= plan;
  }
  assert.ok(dangerous, 'high intensity schedules at least one dangerous pattern');
  assert.ok(mild, 'and still interleaves mild ones');
  // Spacing tightens with intensity but never below the configured floor.
  const easy = manager.directive({ level, progress: 0.05 });
  const hard = manager.directive({ level, progress: 0.85 });
  assert.ok(easy.minSpacing > hard.minSpacing);
  assert.ok(hard.minSpacing >= DEFAULT_DIFFICULTY_CONFIG.spacingHard);
  assert.equal(easy.reactionSeconds, hard.reactionSeconds, 'reaction time is level-scaled, not zone-scaled');
});

test('Paced sequences stay physically achievable across levels, seeds and zones', () => {
  const validated = { count: 0 };
  const start = performance.now();
  for (const level of [2, 8, 21, 40]) {
    for (const progress of [0.25, 0.85]) {
      const terrain = new TerrainGenerator(generateLevel(level, 981));
      const surface = (x) => 360 + terrain.heightAt(x);
      const plans = pacedPlans({ level, seed: 981, count: 26, progress, surface });
      const options = { speeds: [205, 300, 475], modes: ['tap', 'hold'], timingMargin: 8 };
      for (const plan of plans) {
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
          assert.equal(validation.safe, true, `${plan.patternId} L${level} p${progress}`);
          validated.count += 1;
        }
        for (const obstacle of plan.obstacles) {
          assert.equal(validPlacementMetadata(obstacle.plan), true);
          // Phase 11 — the corridor buys a constant reaction time at any
          // approach speed (max(300, projected) × reactionSeconds).
          assert.ok(obstacle.plan.warningStart <= obstacle.plan.takeoff.start - 300, 'reaction floor holds');
        }
      }
    }
  }
  assert.ok(validated.count > 60);
  console.log(`paced revalidation of ${validated.count} obstacles: ${Math.round(performance.now() - start)} ms`);
});

// ───────────────────────── engine integration ─────────────────────────

test('The engine paces real runs and keeps the final approach safe', () => {
  const game = makeEngine(seedSave(4242, 12));
  game.start();
  const run = game.run;
  // Phase 11 — recovery slots join the repetition memory (bounded by the
  // directive's recentPatternMemory, default 10) so empty stretches count.
  assert.ok(Array.isArray(run.recentPatterns) && run.recentPatterns.length <= 10
    && run.recentPatterns.every((id) => id === 'recovery'
      || OBSTACLE_PATTERNS.some((pattern) => pattern.id === id)),
    'the pacing memory starts as a bounded list of valid pattern ids');

  // 45k+ → safe approach: injected dangerous hazards beyond the visible edge
  // are retired, visible/mild ones stay, and nothing dangerous regenerates.
  run.rider.x = 460_000;
  run.rider.y = game.terrainAt(run.rider.x) - 5;
  run.distance = run.rider.x;
  run.elapsed = 5;
  run.objects = [
    { kind: 'gap', x: run.rider.x + 2000, width: 90 },
    { kind: 'swinging-log', x: run.rider.x + 3000 },
    { kind: 'rock', x: run.rider.x + 1500 },
  ];
  run.hazardClearUntil = run.rider.x + 640;
  run.nextHazardX = run.rider.x + 650;
  run.nextCoinX = run.rider.x + 180;
  run.nextPowerX = run.rider.x + 1100;
  run.recentPatterns = [];
  game.populateAhead(run);
  assert.ok(run.objects.some((object) => object.kind === 'rock'), 'mild obstacles survive');
  assert.ok(!run.objects.some(dangerousKinds), 'dangerous obstacles are retired ahead of the approach');
  for (let pass = 0; pass < 12; pass += 1) {
    run.rider.x += 1500;
    run.distance = run.rider.x;
    game.populateAhead(run);
    assert.ok(!run.objects.some((object) => dangerousKinds(object) && object.x > run.rider.x + 900),
      'the approach never regenerates dangerous hazards');
  }
  assert.ok(run.recentPatterns.length <= 10);
  assert.ok(run.recentPatterns.every((id) => id === 'recovery'
    || OBSTACLE_PATTERNS.some((pattern) => pattern.id === id)));

  // Control: at ~38k (main-challenge crest, pre-approach) dangerous patterns flow.
  const control = makeEngine(seedSave(4242, 12));
  control.start();
  const controlRun = control.run;
  controlRun.rider.x = 375_000;
  controlRun.rider.y = control.terrainAt(controlRun.rider.x) - 5;
  controlRun.distance = controlRun.rider.x;
  controlRun.elapsed = 5;
  controlRun.objects = [];
  controlRun.hazardClearUntil = controlRun.rider.x + 640;
  controlRun.nextHazardX = controlRun.rider.x + 650;
  controlRun.nextCoinX = controlRun.rider.x + 180;
  controlRun.nextPowerX = controlRun.rider.x + 1100;
  controlRun.recentPatterns = [];
  let dangerousSeen = 0;
  for (let pass = 0; pass < 15; pass += 1) {
    controlRun.rider.x += 1500;
    controlRun.distance = controlRun.rider.x;
    control.populateAhead(controlRun);
    dangerousSeen += controlRun.objects.filter((object) => dangerousKinds(object) && object.x > controlRun.rider.x).length;
  }
  assert.ok(dangerousSeen > 0, 'challenge zones still schedule dangerous patterns before 45k');
  assert.equal(control.lastDirective.safeApproach, false);
  assert.ok(game.lastDirective.safeApproach === true);
  assert.ok(game.lastDirective.intensity < control.lastDirective.intensity, 'the approach eases off');

  // Debug overlay exposes the pacing state.
  game.setObstacleDebug(true);
  const lines = [];
  const debugContext = new Proxy({}, { get: (_target, name) => (name === 'fillText' ? (text) => lines.push(text) : () => {}) });
  game.drawObstacleDebug(debugContext, game.run, 0);
  const joined = lines.join('\n');
  for (const fragment of ['LVL 12', 'DIFF', 'ZONE SAFE APPROACH', 'WAVE', 'PATTERN', 'TERRAIN']) {
    assert.ok(joined.includes(fragment), `debug panel shows ${fragment}`);
  }
  game.setObstacleDebug(false);
});

test('Physics, speed limits and checkpoints stay intact under pacing', () => {
  assert.deepEqual(BICYCLE_PHYSICS, {
    minSpeed: 205, maxSpeed: 475, gravity: 920, jumpVelocity: 585, jumpSpeedFactor: 0.18,
    maxJumpBoost: 85, airborneAcceleration: 2.5, collisionPadding: 10, collisionBottom: 7,
    groundOffset: 5, collisionInset: 3, landingAngleLimit: 1.22, landingSpinLimit: 4.2,
    flipHoldSeconds: 0.14, flipSeconds: 1.1, flipEaseFraction: 0.12,
  });

  const game = makeEngine(seedSave(4242, 21));
  game.start();
  const run = game.run;
  run.nextCoinX = run.nextHazardX = 1e12;
  run.objects = [];
  for (let frame = 0; frame < 900; frame += 1) {
    if (frame % 120 === 0 && run.rider.grounded) { game.press(); game.release(); }
    game.clock += 1 / 60;
    game.step(1 / 60);
    if (frame % 60 === 0) {
      const { x, y, vy, speed } = run.rider;
      assert.ok([x, y, vy, speed].every(Number.isFinite), `rider state finite at frame ${frame}`);
      if (frame > 250) assert.ok(speed >= BICYCLE_PHYSICS.minSpeed && speed <= BICYCLE_PHYSICS.maxSpeed,
        `speed ${speed} within physics bounds at frame ${frame}`);
    }
  }

  // Pacing memory rides along checkpoints and rejects corruption.
  const save = storage();
  const saved = makeEngine(save);
  saved.start();
  saved.run.recentPatterns = ['single-rock', 'small-gap'];
  saved.saveStableCheckpoint();
  assert.deepEqual(saved.levels.checkpoint.recentPatterns, ['single-rock', 'small-gap']);
  const restored = makeEngine(save);
  assert.equal(restored.hasParkedRun, true);
  assert.deepEqual(restored.run.recentPatterns, ['single-rock', 'small-gap']);
  const raw = JSON.parse(save.getItem(LEVEL_SAVE_KEY));
  raw.checkpoint.recentPatterns = ['bogus-pattern'];
  save.setItem(LEVEL_SAVE_KEY, JSON.stringify(raw));
  const rejected = makeEngine(save);
  assert.equal(rejected.hasParkedRun, false, 'invalid pacing memory invalidates the checkpoint');
});
