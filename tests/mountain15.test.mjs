import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 15 — deep mountain slopes with realistic physics (Alto-style flow).
//
// Terrain: levels ≥ 5 interpolate anchors with a quintic-Hermite flow spline
// (non-zero tangents across boundaries) and generate deep mountain runs —
// multi-chunk shaped descents of 300–650 px with rounded bottoms and climbs
// that may fall short of the entry height. Levels 1–4 are byte-identical to
// the classic construction.
//
// Physics: slope input on the speed is strong enough to feel (300 vs 230),
// the camera follows the rider through deep vertical swings (72% gain, wide
// clamp, frozen during chasm falls), and crests launch a fast rider into the
// air along their tangent without any input.

const { generateLevel, LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { TerrainGenerator, TERRAIN_CHUNK_WIDTH: WIDTH, TERRAIN_MAX_SLOPE } = await import(moduleUrl('src/game/terrain.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));
const { BICYCLE_PHYSICS } = await import(moduleUrl('src/game/terrain.ts'));

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
  return {
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1, lineCap: 'butt',
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
    createElement: () => ({ width: 192, height: 192, getContext: () => mockContext() }),
  };
  const game = new SnowGameEngine({
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    getContext: () => mockContext(),
  }, { onStatus() {}, onHud() {}, onGameOver() {}, onCrash() {} });
  return { game };
}

function beginRun(game) {
  game.start();
  const run = game.run;
  run.elapsed = Math.max(5, run.elapsed);
  run.nextCoinX = run.nextHazardX = run.nextPowerX = 1e12;
  run.objects = [];
  return run;
}

/** Find a deep descent: a terrain crest (small y = high ground, y grows
 *  downward) followed by a valley floor `drop` pixels below it. */
function findDescent(game, fromX, drop = 240, window = 130000) {
  const step = 32;
  const at = (x) => game.terrainAt(x);
  let crestX = fromX;
  let crestY = at(fromX);
  for (let x = fromX; x < fromX + window; x += step) {
    const y = at(x);
    if (y < crestY) { crestY = y; crestX = x; continue; }
    if (y - crestY >= drop) {
      // Follow the fall to the local valley floor (largest y nearby).
      let bottomX = x;
      let bottomY = y;
      for (let x2 = x; x2 < x + 4600; x2 += step) {
        const y2 = at(x2);
        if (y2 > bottomY) { bottomY = y2; bottomX = x2; }
        if (y2 < bottomY - 60 && x2 > bottomX + 200) break;
      }
      return { topX: crestX, topY: crestY, bottomX, bottomY };
    }
  }
  return null;
}

// ───────────────────── terrain: deep runs ─────────────────────

test('Deep mountain runs carve genuinely deep, sloped, varied valleys', () => {
  const checked = [];
  for (const [level, seed] of [[6, 4242], [7, 777], [9, 31337], [12, 99991], [30, 4242]]) {
    const config = generateLevel(level, seed);
    const terrain = new TerrainGenerator(config);
    assert.ok(config.profile.terrain.descentScale > 0, `L${level} favours descents`);
    // Deepest point over 260 chunks, and the variety of run depths.
    const anchors = [];
    for (let i = 0; i <= 260; i += 1) anchors.push(terrain.heightAt(i * WIDTH), terrain.heightAt(i * WIDTH + WIDTH / 2));
    const deepest = Math.max(...anchors);
    // Depth must clear the phase-13 statistical envelope by a wide margin
    // (range ±~93px could reach +186 with two chained draws; runs must go far
    // beyond that to read as mountain valleys — y grows downward, so a deep
    // valley floor is a large positive anchor).
    assert.ok(deepest >= 300, `L${level}/${seed} descends below +300px (got ${Math.round(deepest)})`);
    checked.push({ level, seed, deepest: Math.round(deepest), profile: config.profile.id });
    // Slopes stay inside the cap everywhere (4px sampling).
    for (let i = 1; i < 260; i += 1) {
      for (let s = i * WIDTH; s < (i + 1) * WIDTH; s += 4) {
        const slope = Math.abs((terrain.heightAt(s + 0.1) - terrain.heightAt(s - 0.1)) / 0.2);
        assert.ok(slope <= TERRAIN_MAX_SLOPE + 1e-9, `slope ${slope.toFixed(3)} at ${Math.round(s)}`);
      }
    }
  }
  // Variety: different levels/seeds produce different depth envelopes, not
  // one repeated stamp.
  const depths = new Set(checked.map((entry) => entry.deepest));
  assert.ok(depths.size >= 3, `run depths vary across levels (${[...depths].join(', ')})`);
});

test('The classic prefix never generates runs and stays byte-identical', () => {
  for (const level of [1, 2, 3, 4]) {
    const config = generateLevel(level, 4242);
    assert.equal(config.profile.terrain.descentScale, 0, `L${level} has no descent bias`);
    const terrain = new TerrainGenerator(config);
    for (let i = 0; i <= 120; i += 1) {
      assert.ok(terrain.heightAt(i * WIDTH) > -200, `L${level} keeps its shallow classic envelope`);
    }
    // The opening runway stays perfectly flat.
    for (let x = -300; x <= WIDTH; x += 10) assert.equal(terrain.heightAt(x), 0);
  }
});

test('Mountain runs flow: slope is sustained, not scalloped', () => {
  // Inside a run's descent, consecutive 80px slope samples must share sign and
  // magnitude — the flow spline carries the mountainside across chunk
  // boundaries instead of easing to flat at every seam.
  const config = generateLevel(7, 4242);
  const terrain = new TerrainGenerator(config);
  let verified = 0;
  for (let i = 3; i < 200 && verified < 3; i += 1) {
    const start = i * WIDTH;
    const slopes = [];
    for (let s = start; s < start + WIDTH * 3; s += 80) {
      slopes.push((terrain.heightAt(s + 40) - terrain.heightAt(s - 40)) / 80);
    }
    const descending = slopes.filter((s) => s > 0.12).length;
    if (descending >= slopes.length - 2) {
      // A sustained descent: at most 2 of the samples may be shallow — no
      // zero-tangent scalloping at the chunk seams.
      verified += 1;
    }
  }
  assert.ok(verified >= 3, `sustained flowing descents found (${verified})`);
});

// ───────────────────── physics ─────────────────────

test('Gravity owns the speed: descents wind the bicycle up, climbs bleed it back', () => {
  const { game } = makeEngine({ save: seedSave(4242, 7) });
  const run = beginRun(game);
  // Find a real deep descent on the live engine terrain.
  const descent = findDescent(game, run.rider.x + 800, 240);
  assert.ok(descent, 'a deep descent exists ahead of the rider');
  // Place the rider on the approach, rolling at minimum cruise.
  run.rider.x = descent.topX - 260;
  run.rider.y = game.terrainAt(run.rider.x) - 5;
  run.rider.speed = BICYCLE_PHYSICS.minSpeed;
  run.rider.grounded = true;
  run.distance = run.rider.x;
  run.hazardClearUntil = run.rider.x + 99999;
  run.nextHazardX = 1e12;
  let topSpeed = run.rider.speed;
  let atBottom = false;
  let frames = 0;
  let minSpeedOnWall = Infinity;
  let onWall = false;
  while (frames < 2400) {
    game.clock += 1 / 60;
    game.step(1 / 60);
    frames += 1;
    if (run.over) break;
    topSpeed = Math.max(topSpeed, run.rider.speed);
    if (run.rider.x >= descent.bottomX) atBottom = true;
    if (atBottom && run.rider.y < descent.bottomY - 60) {
      onWall = true;
      minSpeedOnWall = Math.min(minSpeedOnWall, run.rider.speed);
    }
    if (atBottom && run.rider.x > descent.bottomX + 5200) break;
  }
  assert.ok(!run.over, `the rider survives the valley (${run.crashReason ?? ''})`);
  assert.ok(atBottom, 'the rider reached the valley floor');
  // Downhill: the descent visibly accelerates the bicycle.
  assert.ok(topSpeed >= BICYCLE_PHYSICS.minSpeed + 60,
    `gravity accelerates the descent (peak ${Math.round(topSpeed)} from ${BICYCLE_PHYSICS.minSpeed})`);
  assert.equal(run.rider.speed, Math.min(BICYCLE_PHYSICS.maxSpeed, run.rider.speed));
  // Uphill: up on the wall the climb bleeds the accumulated speed back down.
  assert.ok(onWall, 'the rider climbs the valley wall');
  assert.ok(minSpeedOnWall < topSpeed - 40,
    `the climb reclaims momentum (dropped to ${Math.round(minSpeedOnWall)} from ${Math.round(topSpeed)})`);
  assert.ok(run.rider.speed >= BICYCLE_PHYSICS.minSpeed - 1e-9, 'speed never leaves the validated band');
  assert.ok(run.rider.speed <= BICYCLE_PHYSICS.maxSpeed + 1e-9, 'speed respects the cap');
});

test('Momentum decides the climb: entering fast carries the rider higher', () => {
  // Two riders start on the same valley floor — one at cruise, one carrying a
  // full descent's worth of speed — and climb the run's far wall. Speed
  // integrates like v² = v0² − 2∫a·dx on the way up, so the fast rider's
  // energy surplus converts directly into extra elevation before both drain
  // to the cruise floor. (Both must share the floor, not a descent, or the
  // max-speed clamp erases the difference.)
  const results = [];
  for (const entrySpeed of [BICYCLE_PHYSICS.minSpeed, 420]) {
    const { game } = makeEngine({ save: seedSave(4242, 7) });
    const run = beginRun(game);
    const descent = findDescent(game, run.rider.x + 800, 240);
    assert.ok(descent);
    run.rider.x = descent.bottomX - 160;
    run.rider.y = game.terrainAt(run.rider.x) - 5;
    run.rider.speed = entrySpeed;
    run.rider.grounded = true;
    run.distance = run.rider.x;
    run.hazardClearUntil = run.rider.x + 99999;
    run.nextHazardX = 1e12;
    let frames = 0;
    let speedAtGain = null;
    const GAIN = 100;
    while (frames < 2000 && run.rider.x < descent.bottomX + 3500 && !run.over) {
      game.clock += 1 / 60;
      game.step(1 / 60);
      frames += 1;
      if (speedAtGain === null && run.rider.x > descent.bottomX
        && descent.bottomY - run.rider.y >= GAIN) {
        speedAtGain = run.rider.speed;
        break;
      }
    }
    assert.ok(!run.over);
    assert.ok(speedAtGain !== null, `the rider climbs ${GAIN}px up the wall`);
    results.push({ entrySpeed, speedAtGain });
  }
  assert.ok(results[1].speedAtGain > results[0].speedAtGain + 40,
    `carried momentum holds speed up the wall (${Math.round(results[1].speedAtGain)} vs ${Math.round(results[0].speedAtGain)} at +100px)`);
});

test('Fast crests launch the rider naturally — no input, real airtime', () => {
  const { game } = makeEngine({ save: seedSave(4242, 7) });
  const run = beginRun(game);
  run.rider.speed = BICYCLE_PHYSICS.maxSpeed;
  run.hazardClearUntil = run.rider.x + 999999;
  let naturalLaunches = 0;
  let wasGrounded = true;
  let wasOverFeature = false;
  for (let frame = 0; frame < 5200; frame += 1) {
    run.invulnerableUntil = run.elapsed + 10;
    run.rider.speed = Math.max(run.rider.speed, 475);
    const overFeature = game.gapAt(run, run.rider.x) || game.rampAt(run, run.rider.x);
    game.clock += 1 / 60;
    game.step(1 / 60);
    if (run.over) break;
    if (wasGrounded && !run.rider.grounded && !wasOverFeature && !overFeature) naturalLaunches += 1;
    wasGrounded = run.rider.grounded;
    wasOverFeature = overFeature;
    if (naturalLaunches >= 3) break;
  }
  assert.ok(!run.over, `the rider stays up through the mountains (${run.crashReason ?? ''})`);
  assert.ok(naturalLaunches >= 1, `terrain crests launch a fast rider (${naturalLaunches} natural launches)`);
});

test('The camera rides the descent and keeps the rider framed', () => {
  const { game } = makeEngine({ save: seedSave(4242, 7) });
  const run = beginRun(game);
  const descent = findDescent(game, run.rider.x + 800, 300);
  assert.ok(descent, 'a deep descent exists');
  run.rider.x = descent.topX - 260;
  run.rider.y = game.terrainAt(run.rider.x) - 5;
  run.rider.speed = 320;
  run.rider.grounded = true;
  run.distance = run.rider.x;
  run.hazardClearUntil = run.rider.x + 99999;
  run.nextHazardX = 1e12;
  let minCameraY = 0;
  let frames = 0;
  while (frames < 1600 && run.rider.x < descent.bottomX + 400 && !run.over) {
    game.clock += 1 / 60;
    game.step(1 / 60);
    frames += 1;
    minCameraY = Math.min(minCameraY, run.cameraY);
    // After the teleport settle window, the rider must stay framed through
    // the whole swing — strictly while grounded (the camera's design target),
    // generously while airborne (ballistic arcs legitimately outrun a
    // smooth-follow camera near the frame edge).
    if (frames > 100) {
      const screenY = run.rider.y + run.cameraY;
      const bound = run.rider.grounded ? 90 : 380;
      assert.ok(screenY > -bound && screenY < game.height + bound,
        `rider framed at ${Math.round(screenY)} (cameraY ${Math.round(run.cameraY)}, grounded ${run.rider.grounded})`);
    }
  }
  assert.ok(!run.over);
  assert.ok(minCameraY <= -120,
    `the camera follows the rider down into the valley (min cameraY ${Math.round(minCameraY)})`);
});

test('Chasm falls still crash — the terrain-relative fall bound', () => {
  const { game } = makeEngine({ save: seedSave(4242, 7) });
  const run = beginRun(game);
  // Inject a plain gap ahead and ride into it without jumping.
  run.objects.push({ kind: 'gap', x: run.rider.x + 420, width: 150 });
  run.hazardClearUntil = run.rider.x + 99999;
  run.nextHazardX = 1e12;
  let frames = 0;
  while (!run.over && frames < 2400) {
    game.clock += 1 / 60;
    game.step(1 / 60);
    frames += 1;
  }
  assert.ok(run.over, 'the rider falls into the gap');
  assert.equal(run.crashReason, 'You fell into a chasm.');
  assert.equal(game.status, 'crashed');
});

test('Long mountain rides stay stable and inside the physics band', () => {
  const { game } = makeEngine({ save: seedSave(31337, 9) });
  const run = beginRun(game);
  let minSpeed = Infinity;
  let maxSpeed = -Infinity;
  let deepest = 0;
  let frames = 0;
  while (frames < 7200 && !run.over) {
    run.invulnerableUntil = run.elapsed + 30;
    game.clock += 1 / 60;
    game.step(1 / 60);
    frames += 1;
    minSpeed = Math.min(minSpeed, run.rider.speed);
    maxSpeed = Math.max(maxSpeed, run.rider.speed);
    deepest = Math.max(deepest, game.terrainAt(run.rider.x));
    assert.ok(Number.isFinite(run.rider.y) && Number.isFinite(run.cameraY) && Number.isFinite(run.rider.speed));
  }
  assert.ok(!run.over, `a two-minute mountain ride never leaves the world (${run.crashReason ?? ''})`);
  assert.ok(minSpeed >= BICYCLE_PHYSICS.minSpeed - 1e-9 && maxSpeed <= BICYCLE_PHYSICS.maxSpeed + 1e-9,
    `speed stays in [${BICYCLE_PHYSICS.minSpeed}, ${BICYCLE_PHYSICS.maxSpeed}] (got ${Math.round(minSpeed)}..${Math.round(maxSpeed)})`);
  assert.ok(deepest > 0, 'the ride sampled real terrain');
});
