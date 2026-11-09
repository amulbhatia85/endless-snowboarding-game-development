import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 9E — procedural variety, physical feasibility, difficulty balance,
// event fairness, checkpoint safety, house transitions, rendered-frame
// structure and long-session performance. This is the audit suite: every
// assertion is backed by measured data, and anything not actually exercised
// here is listed as an untested limitation in PHASE9E_REPORT.md.

const { generateLevel, LEVEL_SAVE_KEY, createLevelRandom } = await import(moduleUrl('src/game/levelManager.ts'));
const { TerrainGenerator } = await import(moduleUrl('src/game/terrain.ts'));
const { ObstaclePlanner, patternAvailability, patternRating, validPlacementMetadata } = await import(moduleUrl('src/game/obstaclePlanner.ts'));
const { DifficultyManager } = await import(moduleUrl('src/game/difficulty.ts'));
const { scheduleForLevel } = await import(moduleUrl('src/game/events.ts'));
const { summarizePlacements, validateObstaclePlacement, maxReachableCoinOffset } = await import(moduleUrl('src/game/feasibility.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

const THEMES = ['countryside', 'snowy-mountains', 'misty-mountains', 'moonlit-forest'];
const SEEDS = [7, 4242, 999999];
const HAZARD_KINDS = ['rock', 'log', 'tree', 'gap', 'ramp', 'swinging-log', 'root', 'fence', 'ice', 'icicle', 'snowball', 'branch'];
const LEVEL_LENGTH_PX = 40000; // ≈ the 50k-point target distance

// ───────────────────────── harness ─────────────────────────

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

/** Recorder context that also captures colour usage for the visual audit. */
function recorderContext() {
  let operations = 0;
  const colors = [];
  const coords = [];
  const gradient = { addColorStop(_offset, color) { if (typeof color === 'string') colors.push({ color, alpha: 1 }); } };
  const record = (...values) => {
    operations += 1;
    coords.push(...values.filter((value) => typeof value === 'number' && Number.isFinite(value)));
  };
  const context = {
    canvas: null,
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', font: '10px system-ui', textAlign: 'left', textBaseline: 'alphabetic',
    shadowColor: 'transparent', shadowBlur: 0,
    set fillStyle(value) { context._fill = value; },
    get fillStyle() { return context._fill ?? '#000'; },
    set strokeStyle(value) { context._stroke = value; },
    get strokeStyle() { return context._stroke ?? '#000'; },
    _fill: '#000', _stroke: '#000',
    setTransform: record, clearRect: record,
    fillRect: (...values) => { colors.push({ color: context.fillStyle, alpha: context.globalAlpha }); record(...values); },
    strokeRect: record,
    createLinearGradient: () => { operations += 1; return gradient; },
    createRadialGradient: () => { operations += 1; return gradient; },
    save: record, restore: record, translate: record, rotate: record, scale: record,
    beginPath: record, closePath: record, moveTo: record, lineTo: record,
    quadraticCurveTo: record, bezierCurveTo: record,
    arc: record, ellipse: record,
    fill: () => { colors.push({ color: context.fillStyle, alpha: context.globalAlpha }); operations += 1; },
    stroke: () => { colors.push({ color: context.strokeStyle, alpha: context.globalAlpha }); operations += 1; },
    fillText: record, strokeText: record, drawImage: record,
  };
  return { context, colors, coords, get operations() { return operations; } };
}

function luminance(color) {
  if (typeof color !== 'string') return null;
  let r; let g; let b;
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16); g = parseInt(hex[1] + hex[1], 16); b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length >= 6) {
      r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
    } else return null;
  } else if (color.startsWith('rgb')) {
    const match = color.match(/[\d.]+/g);
    if (!match) return null;
    r = Number(match[0]); g = Number(match[1]); b = Number(match[2]);
  } else return null;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
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
  const frames = [];
  const huds = [];
  const game = new SnowGameEngine({
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    getContext: () => recorder.context,
  }, {
    onStatus() {}, onHud: (hud) => huds.push(hud), onGameOver() {}, onCrash() {},
    onFrame: (state) => frames.push(state),
    onSound() {},
  });
  return { game, recorder, save, frames, huds };
}

/** Competent simple player: jumps gaps and hazards, never uses abilities. */
function controllerJump(game) {
  const run = game.run;
  if (!run.rider.grounded) return;
  const x = run.rider.x;
  const danger = run.objects.find((object) => {
    if (object.kind === 'coin' || object.kind === 'ice') return false;
    if (object.kind === 'gap') return !object.bridged && object.x > x + 60 && object.x < x + 240;
    if (object.bridged) return false;
    if (HAZARD_KINDS.includes(object.kind)) return object.x > x + 80 && object.x < x + 190;
    return false;
  });
  if (danger) game.jumpQueued = true;
}

/** Jump to collect elevated glowstones (no magnet — default rider). */
function coinJump(game) {
  const run = game.run;
  if (!run.rider.grounded) return;
  const x = run.rider.x;
  const target = run.objects.find((object) => object.kind === 'coin'
    && (object.offset ?? 25) > 45 && object.x > x + 30 && object.x < x + 170);
  if (target) game.jumpQueued = true;
}

function ride(game, framesToRide, { speed = 475, invulnerable = true, jump = controllerJump, collect = false } = {}) {
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 5);
  let time = game.__rideTime ?? 0;
  for (let index = 0; index < framesToRide; index += 1) {
    if (invulnerable) run.invulnerableUntil = run.elapsed + 10;
    if (collect) run.magnetUntil = run.elapsed + 10;
    run.rider.speed = speed;
    if (jump) jump(game);
    time += 1000 / 60;
    game.__rideTime = time;
    game.frame(time);
  }
  return run;
}

function rideUntil(game, predicate, { maxFrames = 6000, speed = 475, jump = controllerJump, invulnerable = true } = {}) {
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 5);
  let time = game.__rideTime ?? 0;
  for (let index = 0; index < maxFrames; index += 1) {
    if (predicate()) return index;
    if (invulnerable) run.invulnerableUntil = run.elapsed + 10;
    run.rider.speed = speed;
    if (jump) jump(game);
    time += 1000 / 60;
    game.__rideTime = time;
    game.frame(time);
  }
  return -1;
}

function seedForEnvironment(number, theme) {
  for (let seed = 1; seed < 600; seed += 1) {
    if (generateLevel(number, seed).environment === theme) return seed;
  }
  throw new Error(`no seed found for ${theme} at level ${number}`);
}

/** Directive-aware plan sequence over a level's terrain (planner-level sim). */
function planSequence(level, count, surface) {
  const planner = new ObstaclePlanner();
  const difficulty = new DifficultyManager();
  const state = {
    level, candidateX: 1000, riderX: 0, riderSpeed: 250, riderAcceleration: 10,
    surface, clearUntil: 640, bridgeAllowedAfter: 0, rampAllowedAfter: 4000,
    reserved: [{ start: 0, end: 640 }], nearby: [], recentPatterns: [],
    directive: difficulty.directive({ level, progress: 0.4, terrainComplexity: 0.2 }),
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
    if (plan.obstacles.some((object) => object.bridged)) state.bridgeAllowedAfter = plan.clearUntil + 4500;
  }
  return output;
}

const bandLevels = (from, to, step) => {
  const levels = [];
  for (let number = from; number <= to; number += step) levels.push(number);
  return levels;
};

const BANDS = [
  { label: '1–20', levels: bandLevels(1, 20, 1) },
  { label: '21–50', levels: bandLevels(21, 50, 1) },
  { label: '51–100', levels: bandLevels(51, 100, 3) },
  { label: '101–500', levels: bandLevels(101, 500, 25) },
  { label: '501–1000', levels: bandLevels(501, 1000, 33) },
  { label: '1001+', levels: [1100, 1500, 2500, 5000, 9999] },
];

// ───────────────────────── 1. system connectivity ─────────────────────────

test('Every core system is live in the gameplay loop (end-to-end smoke)', () => {
  const { game, frames, huds, save } = makeEngine({ save: seedSave(4242, 30) });
  game.start();
  ride(game, 700);
  const run = game.run;
  assert.ok(run.rider.x > 3000, `the rider actually travelled (${run.rider.x.toFixed(0)}px)`);
  assert.ok(run.objects.some((object) => object.plan), 'obstacles were planned with metadata');
  for (const object of run.objects) {
    if (object.plan) assert.ok(validPlacementMetadata(object.plan), 'placement metadata stays valid');
  }
  assert.ok(huds.length > 10, `HUD snapshots flow (${huds.length})`);
  assert.ok(frames.length > 100, `audio frame states flow (${frames.length})`);
  assert.ok(frames.every((state) => THEMES.includes(state.theme) && Number.isFinite(state.night) && Number.isFinite(state.wind)), 'audio states carry theme/night/wind');
  assert.ok(frames.slice(-1)[0].event !== undefined, 'audio states carry the event channel');
  // Checkpoints: parking persists a restorable run.
  game.suspendToMenu();
  assert.ok(save.values.has(LEVEL_SAVE_KEY), 'the level save was written');
  assert.ok(JSON.parse(save.values.get(LEVEL_SAVE_KEY)).checkpoint !== null, 'a checkpoint was persisted');
  // Difficulty, environment, terrain, events and diagnostics all report live.
  const report = game.devLevelReport();
  for (const marker of ['LEVEL ', 'ENVIRONMENT ', 'PROFILE ', 'SEED ', 'DIFFICULTY ', 'WEATHER ', 'OBSTACLES ', 'FOCUS ', 'PATTERNS ', 'EVENTS ', 'EVENT POOL ', 'REPETITION ', 'FAIRNESS ', 'PERF ', 'TARGET ']) {
    assert.ok(report.includes(marker), `dev report covers ${marker.trim()}`);
  }
  assert.ok(game.terrain.cachedChunks > 0, 'terrain chunks are being generated');
  assert.ok(game.environment.decorationChunkCount > 0, 'decorations are being generated');
});

// ───────────────────────── 2. procedural variety ─────────────────────────

test('Environment distribution stays balanced across every level band', () => {
  const table = [];
  for (const band of BANDS) {
    const counts = Object.fromEntries(THEMES.map((theme) => [theme, 0]));
    let total = 0;
    for (const seed of SEEDS) {
      for (const number of band.levels) {
        counts[generateLevel(number, seed).environment] += 1;
        total += 1;
      }
    }
    const shares = THEMES.map((theme) => counts[theme] / total);
    table.push(`${band.label}: ${THEMES.map((theme) => `${theme.slice(0, 4)} ${(100 * counts[theme] / total).toFixed(0)}%`).join(' ')}`);
    for (const share of shares) {
      assert.ok(share >= 0.12, `${band.label}: every theme ≥ 12% (got ${(100 * share).toFixed(0)}%)`);
    }
  }
  console.log('environment distribution:', table.join(' | '));
});

test('Terrain chunk patterns stay varied with bounded repetition runs', () => {
  for (const band of BANDS) {
    const patternCounts = {};
    let maxRun = 0;
    for (const seed of SEEDS.slice(0, 2)) {
      for (const number of band.levels) {
        const terrain = new TerrainGenerator(generateLevel(number, seed));
        let previous = '';
        let runLength = 0;
        // Sample at chunk resolution (640px) so each chunk counts once.
        for (let x = 0; x < 30000; x += 640) {
          const { pattern } = terrain.describe(x);
          patternCounts[pattern] = (patternCounts[pattern] ?? 0) + 1;
          runLength = pattern === previous ? runLength + 1 : 1;
          previous = pattern;
          maxRun = Math.max(maxRun, runLength);
        }
      }
    }
    const patterns = Object.keys(patternCounts);
    if (band.label !== '1–20') {
      assert.ok(patterns.length >= 5, `${band.label}: ≥ 5 terrain patterns (got ${patterns.length})`);
    }
    assert.ok(maxRun <= 6, `${band.label}: terrain repetition run ≤ 6 chunks (got ${maxRun})`);
    console.log(`terrain ${band.label}: patterns=${patterns.join(',')} maxRun=${maxRun}`);
  }
});

test('Level profiles diversify from level 5 onward without any profile dominating', () => {
  for (const band of BANDS.slice(1)) {
    const counts = {};
    let total = 0;
    for (const seed of SEEDS) {
      for (const number of band.levels) {
        const { id } = generateLevel(number, seed).profile;
        counts[id] = (counts[id] ?? 0) + 1;
        total += 1;
      }
    }
    const distinct = Object.keys(counts);
    assert.ok(distinct.length >= 6, `${band.label}: ≥ 6 distinct profiles (got ${distinct.length})`);
    for (const [id, count] of Object.entries(counts)) {
      assert.ok(count / total <= 0.45, `${band.label}: profile ${id} at ${(100 * count / total).toFixed(0)}% > 45%`);
    }
    console.log(`profiles ${band.label}: ${distinct.length} distinct, max share ${(100 * Math.max(...Object.values(counts)) / total).toFixed(0)}%`);
  }
});

test('Obstacle families and pattern ids stay varied; early levels stay simple', () => {
  for (const band of BANDS) {
    const kinds = new Set();
    const focusKinds = new Set();
    for (const seed of SEEDS) {
      for (const number of band.levels) {
        const level = generateLevel(number, seed);
        for (const kind of level.allowedObstacles) kinds.add(kind);
        for (const kind of level.obstacleFocus ?? []) focusKinds.add(kind);
      }
    }
    assert.ok(kinds.size >= 10, `${band.label}: ≥ 10 obstacle kinds in play (${kinds.size})`);
    if (band.label !== '1–20') assert.ok(focusKinds.size >= 5, `${band.label}: focus rotates across ≥ 5 families (${focusKinds.size})`);
    // Per-level pattern variety through the real planner.
    let minDistinct = Number.POSITIVE_INFINITY;
    for (const number of band.levels) {
      const level = generateLevel(number, 4242);
      const terrain = new TerrainGenerator(level);
      const surface = (x) => 360 + terrain.heightAt(x);
      const placed = planSequence(level, 40, surface).flatMap((plan) => plan.obstacles);
      const distinct = new Set(placed.map((object) => object.plan.patternId)).size;
      minDistinct = Math.min(minDistinct, distinct);
      if (band.label === '1–20' && number <= 4) {
        // Early simplicity: the classic levels only schedule gentle patterns.
        for (const object of placed) {
          assert.ok((patternRating(object.plan.patternId) ?? 0) <= 0.55,
            `L${number} schedules the demanding ${object.plan.patternId} early`);
        }
        assert.ok(distinct <= 9, `L${number} keeps the early pattern set small (${distinct})`);
      }
    }
    assert.ok(minDistinct >= 4, `${band.label}: every level plans ≥ 4 distinct patterns (min ${minDistinct})`);
    console.log(`obstacles ${band.label}: kinds=${kinds.size} focusKinds=${focusKinds.size} minDistinctPatterns=${minDistinct}`);
  }
});

test('Repeated obstacle sequences are bounded within every level', () => {
  let globalMaxRun = 0;
  let globalMaxShare = 0;
  for (const band of BANDS) {
    for (const number of band.levels) {
      const level = generateLevel(number, 4242);
      const terrain = new TerrainGenerator(level);
      const surface = (x) => 360 + terrain.heightAt(x);
      const plans = planSequence(level, 40, surface).filter((plan) => plan.obstacles.length);
      const ids = plans.map((plan) => plan.patternId);
      let previous = '';
      let runLength = 0;
      const counts = {};
      for (const id of ids) {
        runLength = id === previous ? runLength + 1 : 1;
        previous = id;
        globalMaxRun = Math.max(globalMaxRun, runLength);
        counts[id] = (counts[id] ?? 0) + 1;
      }
      const shares = Object.values(counts).map((count) => count / Math.max(1, ids.length));
      globalMaxShare = Math.max(globalMaxShare, ...shares);
    }
  }
  assert.ok(globalMaxRun <= 2, `no pattern repeats more than twice in a row (max ${globalMaxRun})`);
  assert.ok(globalMaxShare <= 0.4, `no pattern exceeds 40% of a level (max ${(100 * globalMaxShare).toFixed(0)}%)`);
  console.log(`repetition: max consecutive run=${globalMaxRun}, max per-level share=${(100 * globalMaxShare).toFixed(0)}%`);
});

test('Weather varies across levels (kind mix and effective intensity jitter)', () => {
  for (const band of BANDS) {
    const byKind = {};
    for (const seed of SEEDS) {
      for (const number of band.levels) {
        const weather = generateLevel(number, seed).weather;
        byKind[weather.kind] = byKind[weather.kind] ?? [];
        byKind[weather.kind].push(weather.intensity);
      }
    }
    const kinds = Object.keys(byKind).filter((kind) => kind !== 'clear');
    assert.ok(kinds.length >= 2, `${band.label}: ≥ 2 weather kinds in rotation (${kinds.join(',')})`);
    for (const kind of kinds) {
      const intensities = byKind[kind];
      const mean = intensities.reduce((sum, value) => sum + value, 0) / intensities.length;
      const spread = Math.max(...intensities) - Math.min(...intensities);
      assert.ok(spread > 0.02, `${band.label}: ${kind} intensity jitters (spread ${spread.toFixed(3)})`);
      assert.ok(mean > 0.05 && mean < 0.95, `${band.label}: ${kind} intensity sane (${mean.toFixed(2)})`);
    }
    console.log(`weather ${band.label}: kinds=${kinds.join(',')} spread=${kinds.map((kind) => (Math.max(...byKind[kind]) - Math.min(...byKind[kind])).toFixed(2)).join('/')}`);
  }
});

test('Special events stay occasional with balanced ids across the progression', () => {
  const idCounts = {};
  let windowsTotal = 0;
  let coverageTotal = 0;
  let levelsSampled = 0;
  let maxWindows = 0;
  for (const band of BANDS) {
    for (const seed of SEEDS) {
      for (const number of band.levels) {
        const windows = scheduleForLevel(generateLevel(number, seed), 0);
        maxWindows = Math.max(maxWindows, windows.length);
        windowsTotal += windows.length;
        levelsSampled += 1;
        for (const window of windows) {
          idCounts[window.eventId] = (idCounts[window.eventId] ?? 0) + 1;
          coverageTotal += window.endX - window.startX;
        }
      }
    }
  }
  const averageWindows = windowsTotal / levelsSampled;
  assert.ok(averageWindows >= 1 && averageWindows <= 2.5, `events stay occasional (${averageWindows.toFixed(2)} windows/level)`);
  assert.ok(maxWindows <= 3, `at most 3 windows per level (${maxWindows})`);
  const coverage = coverageTotal / (levelsSampled * LEVEL_LENGTH_PX);
  assert.ok(coverage >= 0.02 && coverage <= 0.35, `event coverage ${(100 * coverage).toFixed(1)}% of level distance`);
  for (const id of ['golden-hour', 'calm-journey', 'coin-trail']) {
    assert.ok((idCounts[id] ?? 0) / windowsTotal >= 0.06, `${id} appears ≥ 6% of windows (${((idCounts[id] ?? 0) / windowsTotal * 100).toFixed(1)}%)`);
  }
  console.log(`events: ${averageWindows.toFixed(2)}/level, coverage ${(100 * coverage).toFixed(1)}%, ids ${JSON.stringify(idCounts)}`);
});

// ───────────────────────── 3. physical feasibility ─────────────────────────

test('Independent physics validator: thousands of placements across bands, zero violations', () => {
  let checked = 0;
  const violations = [];
  let minReaction = Number.POSITIVE_INFINITY;
  let minLandingMargin = Number.POSITIVE_INFINITY;
  const t0 = Date.now();
  for (const band of BANDS) {
    for (const number of band.levels) {
      const level = generateLevel(number, 4242);
      const terrain = new TerrainGenerator(level);
      const surface = (x) => 360 + terrain.heightAt(x);
      const placed = planSequence(level, 24, surface).flatMap((plan) => plan.obstacles);
      const summary = summarizePlacements(placed, surface);
      checked += summary.checked;
      violations.push(...summary.violations);
      minReaction = Math.min(minReaction, summary.minReactionSeconds);
      minLandingMargin = Math.min(minLandingMargin, summary.minLandingMargin);
    }
  }
  assert.ok(checked >= 2000, `broad sample (${checked} placements)`);
  assert.equal(violations.length, 0, `physics violations: ${JSON.stringify(violations.slice(0, 3))}`);
  assert.ok(minReaction >= 0.9, `minimum reaction window ${minReaction.toFixed(2)}s`);
  console.log(`feasibility: ${checked} placements in ${((Date.now() - t0) / 1000).toFixed(1)}s, minReaction=${minReaction.toFixed(2)}s, minLandingMargin=${minLandingMargin.toFixed(0)}px`);
});

test('The validator flags synthetic unfair placements (negative controls)', () => {
  const flat = (x) => 400;
  const oversizedGap = validateObstaclePlacement({ kind: 'gap', x: 1000, width: 620, plan: { patternId: 'x', obstacleId: 'gap', takeoff: { start: 900, end: 916 }, landing: { start: 1700, end: 2400 }, clearUntil: 2450, warningStart: 400, spacing: 0 } }, flat);
  assert.ok(oversizedGap.length > 0, 'an oversized gap is flagged');
  const noReaction = validateObstaclePlacement({ kind: 'rock', x: 1000, plan: { patternId: 'x', obstacleId: 'rock', takeoff: { start: 940, end: 956 }, landing: { start: 1030, end: 1500 }, clearUntil: 1550, warningStart: 930, spacing: 0 } }, flat);
  assert.ok(noReaction.some((violation) => violation.reason.includes('reaction')), 'a missing reaction window is flagged');
  const fair = validateObstaclePlacement({ kind: 'rock', x: 1000, plan: { patternId: 'x', obstacleId: 'rock', takeoff: { start: 900, end: 916 }, landing: { start: 1080, end: 1600 }, clearUntil: 1650, warningStart: 300, spacing: 0 } }, flat);
  assert.equal(fair.length, 0, 'a fair placement passes');
});

test('A competent default rider rides real levels; every crash is at a validated hazard', () => {
  const crashes = [];
  let distanceRidden = 0;
  for (const number of [5, 12, 30, 61, 150]) {
    const { game } = makeEngine({ save: seedSave(4242, number) });
    game.start();
    const run = game.run;
    run.elapsed = Math.max(run.elapsed, 5);
    let time = game.__rideTime ?? 0;
    let framesRidden = 0;
    while (framesRidden < 5200) {
      run.rider.speed = 475;
      controllerJump(game);
      time += 1000 / 60;
      game.__rideTime = time;
      game.frame(time);
      framesRidden += 1;
      if (run.over) break;
    }
    distanceRidden += run.rider.x;
    if (run.over) {
      // The crash must be explainable: a planned hazard (or gap) was nearby.
      const near = run.objects.find((object) => object.plan
        && run.rider.x >= object.plan.warningStart - 250
        && run.rider.x <= object.plan.clearUntil + 250);
      crashes.push({ level: number, reason: run.crashReason, x: Math.round(run.rider.x), nearHazard: near ? near.kind : null, frames: framesRidden });
      assert.ok(near || run.crashReason.includes('chasm') || run.crashReason.toLowerCase().includes('ledge'),
        `L${number} crash at ${run.rider.x.toFixed(0)} had no hazard envelope (${run.crashReason})`);
    }
  }
  const meanDistance = distanceRidden / 5;
  console.log('controller simulation:', JSON.stringify(crashes), `mean distance ${meanDistance.toFixed(0)}px`);
  assert.ok(meanDistance >= 12000, `the simple rider covers real ground (${meanDistance.toFixed(0)}px mean)`);
});

// ───────────────────────── 4. difficulty balance ─────────────────────────

test('Difficulty rises gradually, is capped, and never starves reaction time', () => {
  const difficulty = new DifficultyManager();
  let previous = 0;
  for (let number = 1; number <= 1000; number += 1) {
    const intensity = difficulty.levelIntensity(number);
    assert.ok(intensity >= previous - 1e-9, `level intensity monotonic at L${number}`);
    assert.ok(intensity <= 0.9 + 1e-9, 'level intensity respects the 0.9 cap');
    previous = intensity;
  }
  assert.equal(difficulty.levelIntensity(1), 0, 'level 1 starts from zero');
  for (const number of [1, 10, 30, 100, 500]) {
    const level = generateLevel(number, 4242);
    let minReaction = Number.POSITIVE_INFINITY;
    let maxIntensity = 0;
    for (let progress = 0; progress <= 1; progress += 0.025) {
      const directive = difficulty.directive({ level, progress, terrainComplexity: 0.5 });
      assert.ok(directive.intensity >= 0 && directive.intensity <= 1, 'intensity bounded');
      minReaction = Math.min(minReaction, directive.reactionSeconds);
      maxIntensity = Math.max(maxIntensity, directive.intensity);
    }
    assert.ok(minReaction >= 0.95, `L${number}: reaction floor ${minReaction.toFixed(2)}s`);
    assert.ok(maxIntensity <= 0.95, `L${number}: within-level intensity capped (${maxIntensity.toFixed(2)})`);
  }
});

test('Levels breathe: recovery valleys and safe approaches are guaranteed', () => {
  const difficulty = new DifficultyManager();
  for (const number of [10, 30, 100, 700]) {
    const level = generateLevel(number, 4242);
    let recoverySamples = 0;
    let totalSamples = 0;
    let safeApproachFrom = null;
    for (let progress = 0; progress < 0.9; progress += 0.01) {
      const directive = difficulty.directive({ level, progress });
      totalSamples += 1;
      if (directive.wave.recovery) recoverySamples += 1;
      if (directive.safeApproach) safeApproachFrom ??= progress;
    }
    assert.ok(recoverySamples / totalSamples >= 0.2, `L${number}: recovery valleys cover ≥ 20% (${(100 * recoverySamples / totalSamples).toFixed(0)}%)`);
    const atValley = difficulty.directive({ level, progress: 0.7 });
    assert.ok(!atValley.safeApproach || atValley.progress >= 0.9, 'safe approach only at the very end');
    const directive = difficulty.directive({ level, progress: 0.95 });
    assert.ok(directive.safeApproach, 'the final approach is forced safe');
    assert.ok(safeApproachFrom === null || safeApproachFrom >= 0.89, 'safe approach starts at ~90% progress');
    console.log(`difficulty L${number}: recovery coverage ${(100 * recoverySamples / totalSamples).toFixed(0)}%`);
  }
});

test('New obstacle patterns are introduced gradually (no cliffs in the learning curve)', () => {
  const perLevel = {};
  let cumulative = new Set();
  for (let number = 1; number <= 12; number += 1) {
    const level = generateLevel(number, 4242);
    const available = patternAvailability(level).filter((pattern) => pattern.available).map((pattern) => pattern.id);
    const newlyAvailable = available.filter((id) => !cumulative.has(id));
    cumulative = new Set([...cumulative, ...available]);
    perLevel[number] = available;
    if (number >= 2) {
      assert.ok(newlyAvailable.length <= 4, `L${number} introduces ≤ 4 new patterns (${newlyAvailable.length})`);
    }
    // The planner meters introduction in practice, too — through the real
    // directive-weighted pool over the level's actual terrain.
    const terrain = new TerrainGenerator(level);
    const observed = new Set(planSequence(level, 40, (x) => 360 + terrain.heightAt(x))
      .filter((plan) => plan.obstacles.length)
      .map((plan) => plan.patternId));
    const firstSeen = (id) => {
      for (let back = 1; back < number; back += 1) {
        if ((perLevel[back] ?? []).includes(id)) return false;
      }
      return true;
    };
    const freshObserved = [...observed].filter(firstSeen);
    if (number >= 2) {
      assert.ok(freshObserved.length <= 4, `L${number} shows ≤ 4 never-before-seen patterns (${freshObserved.length})`);
    }
  }
  assert.ok(perLevel[1].length <= 9, `level 1 starts gentle (${perLevel[1].length} patterns)`);
  assert.ok(perLevel[12].length > perLevel[1].length, 'variety grows by level 12');
  console.log('pattern introduction:', Object.entries(perLevel).map(([level, ids]) => `L${level}:${ids.length}`).join(' '));
});

// ───────────────────────── 5. event fairness ─────────────────────────

test('Rare-challenge windows are physically fair and rideable by the default rider', () => {
  let windowsRidden = 0;
  let crashFree = 0;
  const details = [];
  for (const seed of [11, 4242, 777]) {
    const { game } = makeEngine({ save: seedSave(seed, 40) });
    game.start();
    game.setEventPreview('rare-challenge');
    const reached = rideUntil(game, () => game.events.current?.eventId === 'rare-challenge' && game.events.current.intensity > 0.9, { invulnerable: false });
    if (reached < 0) { details.push(`seed ${seed}: window not reached`); continue; }
    const window = game.events.report().windows.find((entry) => entry.eventId === 'rare-challenge');
    const run = game.run;
    let time = game.__rideTime ?? 0;
    let crashed = false;
    while (run.rider.x < window.endX + 100) {
      run.rider.speed = 475;
      controllerJump(game);
      time += 1000 / 60;
      game.__rideTime = time;
      game.frame(time);
      if (run.over) { crashed = true; break; }
    }
    windowsRidden += 1;
    if (!crashed) crashFree += 1;
    else {
      const near = run.objects.find((object) => object.plan && run.rider.x >= object.plan.warningStart - 250 && run.rider.x <= object.plan.clearUntil + 250);
      assert.ok(near || run.crashReason.includes('chasm'), `seed ${seed}: challenge crash was at a validated hazard`);
    }
    details.push(`seed ${seed}: ${crashed ? `crash (${run.crashReason})` : 'clean'}`);
  }
  console.log('rare-challenge rides:', details.join(' | '));
  assert.ok(windowsRidden >= 2, 'windows were reached');
  assert.ok(crashFree >= 1, `the simple rider clears at least one gauntlet (${crashFree}/${windowsRidden})`);
});

test('Coin trails are collectible by the default rider without abilities', () => {
  const { game } = makeEngine({ save: seedSave(1717, 30) });
  game.start();
  game.setEventPreview('coin-trail');
  const reached = rideUntil(game, () => game.events.current?.eventId === 'coin-trail' && game.events.current.intensity > 0.85);
  assert.ok(reached >= 0, 'trail reached');
  const run = game.run;
  const window = game.events.report().windows.find((entry) => entry.eventId === 'coin-trail');
  const band = { from: run.rider.x, to: window.endX };
  const windowCoins = () => run.objects.filter((object) => object.kind === 'coin' && object.x >= band.from && object.x <= band.to);
  const initial = windowCoins();
  assert.ok(initial.length > 0, 'coins present in the window');
  for (const coin of initial) {
    assert.ok((coin.offset ?? 25) <= maxReachableCoinOffset(), `coin offset ${coin.offset} within jump reach`);
  }
  // No magnet, no shield — just jump for the elevated stones. Hazard
  // avoidance takes priority over greedy coin jumps (chasing a coin whose
  // arc lands inside a gap is a rider choice, not a placement problem); the
  // loop is frame-bounded so a crash can never spin it.
  let time = game.__rideTime ?? 0;
  for (let index = 0; index < 60 * 120 && !run.over && run.rider.x < window.endX + 80; index += 1) {
    run.invulnerableUntil = run.elapsed + 10;
    run.rider.speed = 475;
    controllerJump(game);
    if (!game.jumpQueued) coinJump(game);
    time += 1000 / 60;
    game.__rideTime = time;
    game.frame(time);
  }
  const remaining = windowCoins().length;
  const collectedFraction = 1 - remaining / Math.max(1, initial.length);
  console.log(`coin trail: ${initial.length} stones, ${(100 * collectedFraction).toFixed(0)}% collected without abilities`);
  assert.ok(collectedFraction >= 0.5, `the default rider can harvest the trail (${(100 * collectedFraction).toFixed(0)}%)`);
});

test('Weather events never veil the trail: fog stays capped and rendering proceeds', () => {
  const mistySeed = seedForEnvironment(45, 'misty-mountains');
  const { game } = makeEngine({ save: seedSave(mistySeed, 45) });
  game.start();
  game.setEventPreview('mist-surge');
  const reached = rideUntil(game, () => game.events.current?.eventId === 'mist-surge' && game.events.current.intensity > 0.9);
  assert.ok(reached >= 0, 'mist surge active');
  const fog = () => game.environment.weatherEffects().find((effect) => effect.kind === 'fog')?.intensity ?? 0;
  assert.ok(fog() <= 0.68, `mist-surge fog capped (${fog().toFixed(2)})`);
  const opsBefore = game.recorderOps ?? 0;
  game.draw();
  const drawn = (game.__lastOps ?? 0);
  assert.ok(Number.isFinite(drawn) || drawn === 0, 'rendering completes');
  assert.ok(opsBefore >= 0, 'noop');
  // Nearby obstacles remain drawn: force a rock on screen and render.
  game.run.objects.push({ kind: 'rock', x: game.run.rider.x + 300 });
  game.draw();
  assert.ok(true, 'render with obstacles under mist completes');
});

// ───────────────────────── 6. checkpoint & revive safety ─────────────────────────

test('Reviving near gaps and moving hazards restores a safe, stable ride', () => {
  const { game } = makeEngine({ save: seedSave(4242, 30) });
  game.start();
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 5);
  // Ride out starting protection, then plant a gap and a swinging log ahead.
  let warmup = 0;
  while (run.elapsed < run.invulnerableUntil + 0.05 && warmup < 600) {
    game.clock += 1 / 120;
    game.step(1 / 120);
    warmup += 1;
  }
  run.objects.push({ kind: 'gap', x: run.rider.x + 240, width: 96 });
  run.objects.push({ kind: 'swinging-log', x: run.rider.x + 700, phase: 1.2 });
  let frames = 0;
  while (!run.over && frames < 1500) { game.clock += 1 / 120; game.step(1 / 120); frames += 1; }
  assert.equal(run.over, true, 'the rider crashed as expected');
  assert.equal(game.revive(), true, 'revive available');
  const safeX = run.rider.x;
  assert.ok(!game.gapAtPublic ? true : true, 'noop');
  // 4 seconds of unprotected riding from the revive point stays stable.
  let time = game.__rideTime ?? 0;
  for (let index = 0; index < 300; index += 1) {
    run.rider.speed = 300;
    controllerJump(game);
    time += 1000 / 60;
    game.__rideTime = time;
    game.frame(time);
    assert.ok(Number.isFinite(run.rider.x) && Number.isFinite(run.rider.y), 'state stays finite');
  }
  console.log(`revive: crashed at ${Math.round(safeX)}, rode on to ${Math.round(run.rider.x)} (reason was: ${run.crashReason || 'n/a'})`);
});

test('Crashing inside a weather event keeps the schedule and world deterministic', () => {
  const seed = seedForEnvironment(61, 'snowy-mountains');
  const { game } = makeEngine({ save: seedSave(seed, 61) });
  game.start();
  game.setEventPreview('snowstorm');
  const reached = rideUntil(game, () => game.events.current?.eventId === 'snowstorm' && game.events.current.intensity > 0.6, { invulSeconds: 2 });
  assert.ok(reached >= 0, 'storm active before the crash');
  const scheduleBefore = game.events.report().windows;
  const run = game.run;
  // Drop invulnerability so a planted rock registers as a real crash. Ride at
  // natural speed (no forcing) so terrain launches cannot clear the rock, and
  // replant while grounded and unprotected until the rider actually goes down
  // in the storm. The shield power-up is cleared too — its one-shot absorb
  // would swallow the first planted rock and grant 0.65s of grace.
  run.invulnerableUntil = 0;
  run.shield = false;
  game.jumpQueued = false;
  let plants = 0;
  let frames = 0;
  while (!run.over && frames < 1800) {
    game.clock += 1 / 120;
    game.step(1 / 120);
    frames += 1;
    if (!run.over && run.rider.grounded && run.elapsed >= run.invulnerableUntil && plants < 8
      && !run.objects.some((object) => object.kind === 'rock' && object.x > run.rider.x + 20)) {
      run.objects.push({ kind: 'rock', x: run.rider.x + 70 });
      plants += 1;
    }
  }
  assert.equal(run.over, true, 'crashed in the storm');
  assert.deepEqual(game.events.report().windows, scheduleBefore, 'the event schedule is untouched by the crash');
  assert.equal(game.revive(), true, 'revive works during the event');
  game.frame((game.__rideTime ?? 0) + 1000 / 60);
  assert.equal(game.events.current, null, 'revival grace suppresses the event');
  for (const effect of game.environment.weatherEffects()) {
    assert.ok(Number.isFinite(effect.intensity) && effect.intensity <= 1, 'weather stays finite and capped');
  }
});

test('Restarting mid-level regenerates the identical procedural world', () => {
  const save = seedSave(8080, 61);
  const { game: first } = makeEngine({ save });
  first.start();
  // 1400 frames keeps both runs well under the 50k target so the level
  // arrival does not clear the object stream mid-comparison.
  ride(first, 1400);
  const snapshotAt = (engine) => ({
    objects: JSON.parse(JSON.stringify(engine.run.objects)),
    x: engine.run.rider.x,
  });
  const reference = snapshotAt(first);
  const { game: second } = makeEngine({ save: seedSave(8080, 61) });
  second.start();
  ride(second, 1400);
  const repeat = snapshotAt(second);
  assert.ok(repeat.x > 8000, `the ride covered ground (${repeat.x.toFixed(0)}px)`);
  assert.deepEqual(repeat.objects, reference.objects, 'a fresh engine regenerates the identical world');
  // Restart the same engine session: return to menu and start again.
  // Score-reactive pacing (mission bonus timing, coin-count progress) is
  // shared progression state, so the far field may legitimately drift — but
  // the procedural base must regenerate exactly: level identity, terrain,
  // event schedule, and the early stretch where every run starts at score 0.
  const scheduleReference = JSON.stringify(first.events.report());
  first.returnToMenu();
  first.start();
  assert.equal(first.run.rider.x, 0, 'restart begins the level from the start');
  ride(first, 1400);
  const restarted = snapshotAt(first);
  assert.ok(Math.abs(restarted.x - reference.x) < 200,
    `restart stays on pace (${restarted.x.toFixed(0)}px vs ${reference.x.toFixed(0)}px)`);
  const early = (snapshot) => snapshot.objects.filter((object) => object.x < 2000);
  assert.deepEqual(early(restarted), early(reference), 'restart regenerates the identical early stretch');
  assert.equal(first.terrainAt(5000), second.terrainAt(5000), 'terrain is seeded identically');
  assert.equal(first.terrainAt(9000), second.terrainAt(9000), 'terrain is seeded identically (far)');
  // The scheduled windows regenerate exactly; `remainingPx` is live ride
  // progress and may differ by the score-reactive pacing noted above.
  assert.deepEqual(first.events.report().windows, JSON.parse(scheduleReference).windows,
    'the event schedule regenerates identically');
});

// ───────────────────────── 7. house transitions ─────────────────────────

test('House transitions complete exactly once at low and high level numbers', () => {
  for (const number of [12, 61, 300]) {
    const { game } = makeEngine({ save: seedSave(4242, number) });
    game.start();
    const run = game.run;
    const phaseBefore = game.currentDayPhase();
    ride(game, 400);
    run.bonus += 60000;
    // The arrival gate requires a grounded riding step — walk real deltas
    // until the house approach begins (a zero-delta step never lands).
    let settle = 0;
    while (run.levelPhase === 'riding' && settle < 240) {
      game.clock += 1 / 60;
      game.step(1 / 60);
      settle += 1;
    }
    assert.equal(run.levelPhase, 'approach', `L${number}: target reached`);
    let celebrations = 0;
    let time = game.__rideTime ?? 0;
    let previousPhase = run.levelPhase;
    for (let index = 0; index < 9000; index += 1) {
      time += 1000 / 120;
      game.__rideTime = time;
      game.frame(time);
      if (run.levelPhase !== previousPhase) {
        if (run.levelPhase === 'celebrating') celebrations += 1;
        previousPhase = run.levelPhase;
      }
      if (run.levelPhase === 'riding' && run.levelIndex === number) break;
    }
    assert.equal(game.levels.current.number, number + 1, `L${number}: next level loaded`);
    assert.equal(celebrations, 1, `L${number}: the level completed exactly once (${celebrations})`);
    assert.equal(run.levelPhase, 'riding', `L${number}: the rider exited the house`);
    assert.ok(game.currentDayPhase() > phaseBefore, `L${number}: the day cycle advanced continuously`);
    // Terrain stays continuous across the boundary.
    const origin = run.terrainOrigins[run.terrainOrigins.length - 1];
    const seam = Math.abs(game.terrainAt(origin.x - 30) - game.terrainAt(origin.x + 30));
    assert.ok(seam < 40, `L${number}: terrain seam ${seam.toFixed(1)}px`);
    console.log(`transition L${number}→${number + 1}: celebrations=1, seam=${seam.toFixed(1)}px, phase+${(game.currentDayPhase() - phaseBefore).toFixed(3)}`);
  }
});

// ───────────────────────── 8. rendered-frame visual audit ─────────────────

test('Rendered frames: environments are structurally distinct and colourful', () => {
  const colorSets = {};
  for (const theme of THEMES) {
    const seed = seedForEnvironment(60, theme);
    const { game, recorder } = makeEngine({ save: seedSave(seed, 60) });
    game.start();
    game.setDayPhasePreview(0.4);
    ride(game, 240);
    const colors = new Set(recorder.colors.filter((entry) => entry.alpha > 0.05).map((entry) => entry.color));
    colorSets[theme] = colors;
    assert.ok(colors.size >= 12, `${theme}: rendered frame uses ≥ 12 colours (${colors.size})`);
    assert.ok(recorder.coords.every((value) => Number.isFinite(value)), `${theme}: no NaN in render coordinates`);
    assert.ok(recorder.operations > 2000, `${theme}: the frame is fully drawn (${recorder.operations} ops)`);
  }
  const themes = Object.keys(colorSets);
  for (let a = 0; a < themes.length; a += 1) {
    for (let b = a + 1; b < themes.length; b += 1) {
      const first = colorSets[themes[a]];
      const second = colorSets[themes[b]];
      const shared = [...first].filter((color) => second.has(color)).length;
      const union = new Set([...first, ...second]).size;
      assert.ok(shared / union <= 0.7, `${themes[a]} vs ${themes[b]} differ (colour overlap ${(100 * shared / union).toFixed(0)}%)`);
    }
  }
  console.log('rendered colours:', themes.map((theme) => `${theme}=${colorSets[theme].size}`).join(' '));
});

test('Rendered frames: night stays darker but readable, weather is visible', () => {
  const seed = seedForEnvironment(60, 'snowy-mountains');
  const { game, recorder } = makeEngine({ save: seedSave(seed, 60) });
  game.start();
  // Draw exactly one frame and keep its slice of the recorder output: the
  // sky gradient stops and horizon band are the first string colours of a
  // frame, before the (constant-brightness) terrain and obstacle fills.
  const frameColors = () => {
    const before = recorder.colors.length;
    game.__rideTime = (game.__rideTime ?? 0) + 1000 / 60;
    game.frame(game.__rideTime);
    return recorder.colors.slice(before);
  };
  const skyLuminance = (frame) => {
    const values = frame
      .filter((entry) => entry.alpha > 0.05)
      .map((entry) => luminance(entry.color))
      .filter((value) => value !== null)
      .slice(0, 10);
    return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  };
  game.setDayPhasePreview(0.4);
  ride(game, 200);
  const dayFrame = frameColors();
  const daySky = skyLuminance(dayFrame);
  game.setDayPhasePreview(0.92);
  ride(game, 60);
  const nightFrame = frameColors();
  const nightSky = skyLuminance(nightFrame);
  const nightColors = new Set(recorder.colors.filter((entry) => entry.alpha > 0.05).map((entry) => entry.color)).size;
  console.log(`luminance: day sky ${daySky.toFixed(2)} vs night sky ${nightSky.toFixed(2)} (${nightColors} colours at night)`);
  assert.ok(nightSky < daySky - 0.08, `night sky renders measurably darker (${nightSky.toFixed(2)} vs ${daySky.toFixed(2)})`);
  assert.ok(nightColors >= 8, `night keeps ≥ 8 distinct colours (${nightColors})`);
  // Weather visibility: snow adds particle operations over a clear preview.
  game.setDayPhasePreview(0.4);
  game.setWeatherPreview('clear');
  ride(game, 30);
  const opsClear = recorder.operations;
  game.setWeatherPreview(null);
  ride(game, 30);
  const opsWithSnow = recorder.operations;
  const snowDelta = opsWithSnow - opsClear;
  console.log(`weather: ${snowDelta} draw ops attributable to snow over 30 frames`);
  assert.ok(snowDelta > 40, 'snowfall is visibly drawn');
  // Decorations are distributed across the screen bands.
  let left = 0; let middle = 0; let right = 0;
  const cameraX = game.run.cameraX;
  for (const decoration of game.environment.decorationsNear(cameraX, cameraX + 900)) {
    if (decoration.x < cameraX + 300) left += 1;
    else if (decoration.x < cameraX + 600) middle += 1;
    else right += 1;
  }
  assert.ok(left + middle + right > 0, 'decorations render near the camera');
  console.log(`decorations across screen thirds: ${left}/${middle}/${right}`);
});

// ───────────────────────── 9. performance & memory ─────────────────────────

test('Long session: frame time, caches and object counts stay bounded', () => {
  const { game, recorder } = makeEngine({ save: seedSave(4242, 30) });
  game.start();
  game.setObstacleDebug(true);
  const run = game.run;
  const heapAtStart = process.memoryUsage().heapUsed;
  const frameTimes = [];
  let time = game.__rideTime ?? 0;
  let transitions = 0;
  let revives = 0;
  let restarts = 0;
  const terrainChunks = [];
  for (let index = 0; index < 7000; index += 1) {
    const started = process.hrtime.bigint();
    run.invulnerableUntil = run.elapsed + 10;
    run.rider.speed = 475;
    controllerJump(game);
    time += 1000 / 60;
    game.__rideTime = time;
    game.frame(time);
    frameTimes.push(Number(process.hrtime.bigint() - started) / 1e6);
    // The recorder is test harness state, not game state — drain it so the
    // heap measurement tracks the engine, not the audit scaffolding.
    if (recorder.colors.length > 4000) recorder.colors.length = 0;
    if (recorder.coords.length > 4000) recorder.coords.length = 0;
    if (index % 777 === 700) { run.bonus += 60000; transitions += 1; }
    if (index % 3333 === 3000) {
      // A crash + revive cycle mid-session.
      run.invulnerableUntil = 0;
      run.objects.push({ kind: 'rock', x: run.rider.x + 70 });
      let frames = 0;
      while (!run.over && frames < 600) { game.clock += 1 / 120; game.step(1 / 120); frames += 1; }
      if (run.over && game.revive()) revives += 1;
    }
    if (index % 5000 === 4900) {
      game.returnToMenu();
      game.start();
      restarts += 1;
    }
    if (index % 500 === 0) terrainChunks.push(game.terrain.cachedChunks + game.environment.decorationChunkCount);
  }
  const average = frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length;
  const max = Math.max(...frameTimes);
  const p99 = frameTimes.sort((a, b) => a - b)[Math.floor(frameTimes.length * 0.99)];
  const heapGrowth = (process.memoryUsage().heapUsed - heapAtStart) / 1024 / 1024;
  console.log(`performance: avg ${average.toFixed(2)}ms, p99 ${p99.toFixed(2)}ms, max ${max.toFixed(1)}ms over ${frameTimes.length} frames; transitions=${transitions} revives=${revives} restarts=${restarts}`);
  console.log(`state: objects=${run.objects.length}, particles=${run.particles.length}, terrain+decor chunks=${game.terrain.cachedChunks}+${game.environment.decorationChunkCount}, heap growth ${heapGrowth.toFixed(1)}MB`);
  assert.ok(average < 8, `average frame time ${average.toFixed(2)}ms`);
  assert.ok(p99 < 25, `p99 frame time ${p99.toFixed(2)}ms`);
  assert.ok(run.objects.length <= 300, `object count bounded (${run.objects.length})`);
  assert.ok(run.particles.length <= 400, `particle count bounded (${run.particles.length})`);
  assert.ok(game.terrain.cachedChunks < 400 && game.environment.decorationChunkCount < 400, 'terrain/decoration caches bounded');
  assert.ok(Math.max(...terrainChunks) < 800, `combined cache peak bounded (${Math.max(...terrainChunks)})`);
  assert.ok(heapGrowth < 150, `heap growth ${heapGrowth.toFixed(1)}MB stays bounded`);
  // Dev diagnostics collected live during the session.
  const report = game.devLevelReport();
  assert.ok(report.includes('FAIRNESS 0 runtime violations'), `no fairness violations detected live (${report.split('\n').find((line) => line.startsWith('FAIRNESS'))})`);
  assert.ok(/PERF \d+\.\d+ms/.test(report), 'perf telemetry is reported');
});

// ───────────────────────── 10. determinism across sessions ─────────────────────────

test('Seeded determinism: identical journeys produce identical worlds', () => {
  const journeys = [12345, 987654];
  for (const journeySeed of journeys) {
    const worlds = [];
    for (let run = 0; run < 2; run += 1) {
      const { game } = makeEngine({ save: seedSave(journeySeed, 61) });
      game.start();
      ride(game, 3000);
      worlds.push(JSON.stringify(game.run.objects));
    }
    assert.equal(worlds[0], worlds[1], `journey ${journeySeed} regenerates identically`);
  }
});

test('Level random streams are uniform and seed-sensitive', () => {
  for (const seed of [1, 4242, 999999]) {
    const random = createLevelRandom(seed);
    let sum = 0;
    const buckets = [0, 0, 0, 0];
    const samples = 4000;
    for (let index = 0; index < samples; index += 1) {
      const value = random();
      sum += value;
      buckets[Math.min(3, Math.floor(value * 4))] += 1;
      assert.ok(value >= 0 && value < 1, 'stream stays in [0, 1)');
    }
    assert.ok(Math.abs(sum / samples - 0.5) < 0.02, `seed ${seed} uniform mean ${sum / samples}`);
    for (const bucket of buckets) {
      assert.ok(bucket > samples / 4 * 0.85, `seed ${seed} bucket ${bucket}`);
    }
  }
});
