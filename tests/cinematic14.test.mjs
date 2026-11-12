import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 14 — the crash cinematic and the ice boulder's felt weight.
//
// Crash flow: the "Keep going?" card is no longer revealed at the instant of
// impact. The engine now runs a hit-stop (a held impact frame), a slow-motion
// window that stretches the tumble, and a settle hold — all integrated as
// scaled time in updateEffects — and exports CRASH_CINEMATIC_MS so the App
// layer can reveal the card exactly when the scene has frozen. onCrash still
// fires immediately (the audio cue and the ad preload must not wait).
//
// Boulder flow: the roll now displaces snow with real mass — a bulldozed
// plume at the contact point, a churned wake, a drawn trail of mounds and
// scattered chunks, and a proximity tremor through the ground.

const { LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { SnowGameEngine, CRASH_CINEMATIC_MS, CRASH_BLUR_LEAD_MS } = await import(moduleUrl('src/game/engine.ts'));
const { RECOVERY_CONFIG } = await import(moduleUrl('src/game/recovery.ts'));
const { ICE_BOULDER, iceBoulderPose } = await import(moduleUrl('src/game/obstacleRegistry.ts'));

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

/** Mock context that tallies the draw calls the trail tests care about. */
function countingContext() {
  const base = mockContext();
  const counts = { arc: 0, ellipse: 0, stroke: 0, fill: 0 };
  const wrapped = { ...base };
  for (const key of Object.keys(counts)) {
    wrapped[key] = (...args) => { counts[key] += 1; return base[key](...args); };
  }
  return { context: wrapped, counts };
}

function makeEngine({ search = '', save = storage() } = {}) {
  const callbacks = { crashes: 0, gameOvers: 0, statuses: [] };
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
  }, {
    onStatus: (status) => callbacks.statuses.push(status),
    onHud: () => {},
    onGameOver: () => { callbacks.gameOvers += 1; },
    onCrash: () => { callbacks.crashes += 1; },
  });
  return { game, save, callbacks };
}

function beginRun(game) {
  game.start();
  const run = game.run;
  run.elapsed = Math.max(5, run.elapsed);
  run.nextCoinX = run.nextHazardX = run.nextPowerX = 1e12;
  run.objects = [];
  return run;
}

function crashIntoRock(game, run, offset = 70) {
  let warmup = 0;
  while (run.elapsed < run.invulnerableUntil + 0.05 && warmup < 1200) {
    game.clock += 1 / 120;
    game.step(1 / 120);
    warmup += 1;
  }
  run.objects.push({ kind: 'rock', x: run.rider.x + offset });
  let frames = 0;
  while (!run.over && frames < 900) { game.clock += 1 / 120; game.step(1 / 120); frames += 1; }
  assert.equal(run.over, true, 'the rider crashed');
  return run;
}

/** Drive the crashed scene through the real frame pipeline at 60fps. */
function frames(game, seconds) {
  const steps = Math.round(seconds * 60);
  for (let index = 0; index < steps; index += 1) {
    game.frame((game.__time = (game.__time ?? 16) + 1000 / 60));
  }
}

// ───────────────────── the crash cinematic ─────────────────────

test('The crash cinematic timing is sane and exported for the App layer', () => {
  assert.equal(typeof CRASH_CINEMATIC_MS, 'number');
  assert.ok(CRASH_CINEMATIC_MS >= 1500 && CRASH_CINEMATIC_MS <= 2600,
    `the cinematic runs roughly two seconds (got ${CRASH_CINEMATIC_MS}ms)`);
  assert.ok(CRASH_BLUR_LEAD_MS >= 300 && CRASH_BLUR_LEAD_MS <= 700,
    `the blur leads the card by a beat (got ${CRASH_BLUR_LEAD_MS}ms)`);
  assert.ok(CRASH_BLUR_LEAD_MS < CRASH_CINEMATIC_MS, 'the blur starts before the card appears');
  // The exported duration must actually cover the configured profile:
  // hit-stop + slow-mo + the un-scaled remainder of the tumble + settle hold.
  const scaled = RECOVERY_CONFIG.crashHitStopSeconds * 0.06
    + RECOVERY_CONFIG.crashSlowMoSeconds * RECOVERY_CONFIG.crashSlowMoScale;
  const expected = RECOVERY_CONFIG.crashHitStopSeconds + RECOVERY_CONFIG.crashSlowMoSeconds
    + Math.max(0, RECOVERY_CONFIG.crashTumbleSeconds - scaled) + RECOVERY_CONFIG.crashSettleHoldSeconds;
  assert.ok(Math.abs(CRASH_CINEMATIC_MS / 1000 - expected) < 0.02,
    'CRASH_CINEMATIC_MS matches the integrated profile');
});

test('The crash hits with a held impact frame — the hit-stop', () => {
  const { game, callbacks } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  crashIntoRock(game, run);
  // The event contract is unchanged: onCrash fires at the moment of impact.
  assert.equal(callbacks.crashes, 1, 'onCrash fires immediately');
  assert.equal(game.status, 'crashed');
  assert.ok(run.crashReaction.real === 0, 'the cinematic clock starts at zero');

  const impactX = run.rider.x;
  frames(game, 0.17); // just inside the 0.2s hit-stop window
  assert.ok(run.crashReaction.elapsed < 0.03,
    `the tumble barely advances through the hit-stop (elapsed ${run.crashReaction.elapsed.toFixed(3)})`);
  assert.ok(run.rider.x - impactX < 4,
    `the rider is held at the impact point (moved ${run.rider.x - impactX}px)`);
  assert.ok(game.crashTimeScale < 0.15, 'the time scale is nearly frozen');
});

test('The fall stretches through the slow-motion window', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  crashIntoRock(game, run);
  frames(game, 0.5); // past the hit-stop, inside the slow-mo window
  assert.equal(game.crashTimeScale, RECOVERY_CONFIG.crashSlowMoScale,
    'the scene integrates at the configured slow-motion scale');
  const elapsedAtHalf = run.crashReaction.elapsed;
  const expected = RECOVERY_CONFIG.crashHitStopSeconds * 0.06
    + (0.5 - RECOVERY_CONFIG.crashHitStopSeconds) * RECOVERY_CONFIG.crashSlowMoScale;
  assert.ok(Math.abs(elapsedAtHalf - expected) < 0.03,
    `tumble time tracks the scaled clock (${elapsedAtHalf.toFixed(3)} vs ${expected.toFixed(3)})`);

  // Time recovers after the window: the scale returns to 1 and the tumble
  // finishes, leaving the rider settled in the frozen impact scene.
  frames(game, CRASH_CINEMATIC_MS / 1000 + 0.3);
  assert.equal(game.crashTimeScale, 1, 'time recovers after the slow-motion');
  assert.ok(run.crashReaction.elapsed >= RECOVERY_CONFIG.crashTumbleSeconds, 'the tumble completed');
  const settledX = run.rider.x;
  frames(game, 0.4);
  assert.ok(Math.abs(run.rider.x - settledX) < 1e-6, 'the rider stays frozen at the impact scene');
});

test('The impact shake rides the cinematic scale, then decays', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  crashIntoRock(game, run);
  assert.ok(run.shake >= 12, 'the crash lands a heavy shake');
  frames(game, 0.1);
  const heldShake = run.shake;
  frames(game, 2.2);
  assert.ok(run.shake < 0.05, `the shake decays away once time recovers (left ${run.shake})`);
  assert.ok(heldShake > 3, 'the shake survives the hit-stop (slow decay)');
});

// ───────────────────── the boulder's felt weight ─────────────────────

/** A released boulder whose pose sits `closing` px ahead of the rider. */
function rollingBoulder(run, closing, travel = 2.35) {
  const surface = (x) => 0; // placeholder — replaced by the engine terrain below
  void surface;
  const anchor = run.rider.x + closing + 340;
  const phase = run.elapsed - (ICE_BOULDER.warmup + travel);
  return { kind: 'ice-boulder', x: anchor, phase };
}

test('The rolling boulder tremors the ground and displaces snow as it closes', () => {
  const { game } = makeEngine({ save: seedSave(4242, 7) });
  const run = beginRun(game);
  run.cameraX = run.rider.x - 300;

  // Far away: within the corridor but far past the tremor band and off
  // screen — no shake, no spray.
  const far = rollingBoulder(run, 1500);
  run.objects.push(far);
  run.shake = 0;
  game.updateIceBoulders(run);
  game.updateIceBoulders(run);
  assert.equal(run.shake, 0, 'no tremor while the boulder is far');
  assert.equal(run.particles.length, 0, 'no spray while the boulder is off screen');

  // Closing: on screen and inside the 900px tremor band.
  const near = rollingBoulder(run, 400);
  run.objects = [near];
  run.shake = 0;
  game.updateIceBoulders(run);
  const pose = iceBoulderPose(near.x, (x) => game.terrainAt(x), run.elapsed, near.phase);
  assert.ok(pose.released, 'the boulder is rolling');
  assert.ok(pose.x - run.rider.x > 300 && pose.x - run.rider.x < 500, 'the boulder sits 400px ahead');
  assert.ok(run.shake > 0 && run.shake <= 1.4 + 1e-9,
    `a subtle proximity tremor (got ${run.shake.toFixed(3)})`);
  // The spray fires on roll cadence: advance the clock so the pose travels.
  const particlesBefore = run.particles.length;
  run.elapsed += 0.3;
  game.updateIceBoulders(run);
  assert.ok(run.particles.length > particlesBefore + 3,
    `snow is kicked up as the boulder rolls (${run.particles.length - particlesBefore} particles)`);
});

test('The drawn trail: churned track, side mounds and scattered chunks', () => {
  const { game } = makeEngine({ save: seedSave(4242, 7) });
  const run = beginRun(game);
  const palette = game.environment.palette(0.4);

  // Fresh boulder, still teetering on its spawn ledge: no trail yet.
  const fresh = rollingBoulder(run, 400, 0);
  fresh.phase = run.elapsed; // held = 0 → not released
  const freshCounter = countingContext();
  game.drawIceBoulder(freshCounter.context, fresh, fresh.x - 450, run, palette);

  // The same boulder after ~2.35s of rolling: the track is drawn behind it.
  const rolled = rollingBoulder(run, 400);
  const rolledPose = iceBoulderPose(rolled.x, (x) => game.terrainAt(x), run.elapsed, rolled.phase);
  assert.ok(rolledPose.distance > 200, `the boulder has rolled a visible distance (${Math.round(rolledPose.distance)}px)`);
  const rolledCounter = countingContext();
  game.drawIceBoulder(rolledCounter.context, rolled, rolled.x - 450, run, palette);

  const dArc = rolledCounter.counts.arc - freshCounter.counts.arc;
  const dEllipse = rolledCounter.counts.ellipse - freshCounter.counts.ellipse;
  const dStroke = rolledCounter.counts.stroke - freshCounter.counts.stroke;
  assert.ok(dArc >= 10, `side mounds dot the track (${dArc} extra arcs)`);
  assert.ok(dEllipse >= 4, `chunks are scattered clear of the roll (${dEllipse} extra ellipses)`);
  assert.ok(dStroke >= 2, `the churned base band and bright ridge are stroked (${dStroke} extra strokes)`);
  assert.ok(rolledCounter.counts.fill > 0, 'the pushed-snow wedge fills ahead of the contact point');
});

test('An invulnerable rider can watch a boulder roll by without the engine destabilising', () => {
  const { game } = makeEngine({ save: seedSave(4242, 7) });
  const run = beginRun(game);
  run.objects.push(rollingBoulder(run, 760, 0.2));
  let sawTremor = false;
  let sawSpray = false;
  for (let index = 0; index < 400; index += 1) {
    run.invulnerableUntil = run.elapsed + 10;
    run.rider.speed = 300;
    game.frame((game.__time = (game.__time ?? 16) + 1000 / 60));
    if (run.shake > 0.05) sawTremor = true;
    if (run.particles.length > 4) sawSpray = true;
    assert.ok(Number.isFinite(run.rider.x) && Number.isFinite(run.rider.y));
    if (game.status !== 'playing') break;
  }
  assert.equal(game.status, 'playing', 'the invulnerable rider survives the boulder');
  assert.ok(sawTremor, 'the ground tremor is felt during the approach');
  assert.ok(sawSpray, 'snow is displaced while the boulder rolls on screen');
});
