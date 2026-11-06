import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 8 — crash, revive, checkpoint and game recovery.

const { LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));
const { RECOVERY_CONFIG } = await import(moduleUrl('src/game/recovery.ts'));
const { AdService, ADMOB_CONFIG } = await import(moduleUrl('src/game/ads.ts'));

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
  const callbacks = { crashes: 0, gameOvers: 0, statuses: [] };
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

/** Crashes the rider into an injected rock ahead of them. */
function crashIntoRock(game, run, offset = 70) {
  // Ride out any active revive protection first (protection is real).
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

function driveToArrival(game) {
  const run = game.run;
  run.elapsed = Math.max(5, run.elapsed);
  run.bonus += 50_000;
  game.step(0);
  assert.equal(run.levelPhase, 'approach');
}

function driveScenes(game, maxSeconds = 40) {
  const run = game.run;
  let seconds = 0;
  while (run.levelPhase !== 'riding' && seconds < maxSeconds) {
    game.clock += 1 / 120;
    game.step(1 / 120);
    seconds += 1 / 120;
  }
  assert.equal(run.levelPhase, 'riding');
}

const HAZARD_FOOTPRINT = (game, run) => run.objects.filter((object) =>
  ['rock', 'tree', 'log', 'swinging-log'].includes(object.kind));

// ───────────────────────── crash detection ─────────────────────────

test('Every fatal event crashes exactly once; ordinary riding never does', () => {
  const { game, callbacks } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);

  // A short hop with a clean landing is not a crash.
  game.press();
  game.release();
  for (let frame = 0; frame < 90; frame += 1) { game.clock += 1 / 60; game.step(1 / 60); }
  assert.equal(run.over, false, 'an ordinary jump is not a crash');
  assert.equal(game.status, 'playing');

  crashIntoRock(game, run);
  assert.equal(game.status, 'crashed');
  assert.equal(callbacks.crashes, 1, 'one crash event');
  assert.equal(callbacks.gameOvers, 0, 'game-over only fires on finalize');

  // Further stepping cannot trigger a second game-over.
  for (let frame = 0; frame < 120; frame += 1) { game.clock += 1 / 60; game.step(1 / 60); }
  assert.equal(callbacks.crashes, 1, 'still exactly one crash event');
  assert.equal(run.crashesThisLevel, 1);

  // Finalize → exactly one game-over, and never twice.
  game.finalizeRun();
  game.finalizeRun();
  assert.equal(callbacks.gameOvers, 1);
  assert.equal(game.status, 'gameover');
});

test('Falling into a gap is fatal even while revive protection is active', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  // Protection must never make unsupported surfaces artificially safe.
  run.invulnerableUntil = run.elapsed + 30;
  run.objects.push({ kind: 'gap', x: run.rider.x + 90, width: 260 });
  let frames = 0;
  while (!run.over && frames < 2400) { game.clock += 1 / 120; game.step(1 / 120); frames += 1; }
  assert.equal(run.over, true, 'the gap stays fatal during protection');
  assert.match(run.crashReason, /chasm|open air/);
});

// ───────────────────────── crash animation ─────────────────────────

test('The crash tumble is physical, settles, and never moves the camera', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  crashIntoRock(game, run, 90);

  const cameraAtCrash = run.cameraX;
  const startX = run.rider.x;
  const startRotation = run.rider.rotation;
  assert.ok(run.crashReaction, 'tumble state exists');

  // Drive the crashed scene through the real frame pipeline.
  game.frame(16);
  let timestamp = 16;
  let previousX = run.rider.x;
  let moved = false;
  for (let frame = 0; frame < 90; frame += 1) {
    timestamp += 1000 / 60;
    game.frame(timestamp);
    assert.equal(run.cameraX, cameraAtCrash, 'the camera never jumps during the crash');
    assert.ok(run.rider.x >= previousX - 1e-9, 'the rider only slides forward');
    if (run.rider.x > previousX + 0.01) moved = true;
    previousX = run.rider.x;
  }
  assert.ok(moved, 'the rider slides with the crash momentum');
  assert.ok(run.rider.rotation !== startRotation, 'the rider tumbles');
  assert.ok(run.rider.x - startX < 160, 'the slide stays within the view');

  // After the tumble window the rider settles and stays put.
  const settledX = run.rider.x;
  for (let frame = 0; frame < 30; frame += 1) { timestamp += 1000 / 60; game.frame(timestamp); }
  assert.ok(Math.abs(run.rider.x - settledX) < 1e-6, 'fully settled');
  if (!run.rider.fallingInto) {
    assert.ok(Math.abs(run.rider.y - (game.rideHeight(run, run.rider.x) - 5)) < 1e-6, 'resting on the surface');
  }
  assert.ok(Number.isFinite(run.rider.x) && Number.isFinite(run.rider.y) && Number.isFinite(run.rider.rotation));
});

// ───────────────────────── revive gating ─────────────────────────

test('Revive is available only for a genuinely ended run, and never twice at once', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  assert.equal(game.reviveAvailable, false, 'no run');
  const run = beginRun(game);
  assert.equal(game.reviveAvailable, false, 'while playing');
  crashIntoRock(game, run);
  assert.equal(game.reviveAvailable, true, 'after a crash');

  assert.equal(game.revive(), true);
  assert.equal(game.reviveAvailable, false, 'not immediately again');
  assert.equal(game.revive(), false, 'a second simultaneous revive is rejected');
  assert.equal(game.status, 'playing');

  // Reviving is impossible during the level cinematics (status is playing,
  // the run is not over, and the scene owns the rider).
  driveToArrival(game);
  while (run.levelPhase === 'approach') { game.clock += 1 / 120; game.step(1 / 120); }
  assert.equal(game.revive(), false, 'no reviving while entering the house');
});

// ───────────────────────── safe revival ─────────────────────────

test('Revived riders spawn safe, aligned, protected — with a smooth camera', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  // Surround the crash site with hazards the revive must avoid.
  run.objects.push({ kind: 'rock', x: run.rider.x + 70 });
  run.objects.push({ kind: 'tree', x: run.rider.x + 240 });
  run.objects.push({ kind: 'gap', x: run.rider.x + 420, width: 200 });
  let frames = 0;
  while (!run.over && frames < 900) { game.clock += 1 / 120; game.step(1 / 120); frames += 1; }
  assert.equal(run.over, true);

  const cameraBefore = run.cameraX;
  assert.equal(game.revive(), true);
  const rider = run.rider;

  for (const hazard of HAZARD_FOOTPRINT(game, run)) {
    assert.ok(Math.abs(hazard.x - rider.x) > 30, `revived clear of the ${hazard.kind}`);
  }
  for (const gap of run.objects.filter((object) => object.kind === 'gap' && !object.bridged)) {
    assert.ok(rider.x <= gap.x - 30 || rider.x >= gap.x + (gap.width ?? 60) + 30, 'revived clear of the gap');
  }
  assert.ok(Math.abs(rider.y - (game.rideHeight(run, rider.x) - 5)) < 1e-6, 'sitting on the terrain');
  assert.equal(rider.rotation, game.rideAngle(run, rider.x), 'aligned with the slope');
  assert.equal(rider.vy, 0);
  assert.equal(rider.angularVelocity, 0);
  assert.equal(rider.grounded, true);
  assert.ok(rider.speed >= 300 && Number.isFinite(rider.speed));
  assert.ok(Math.abs(run.invulnerableUntil - (run.elapsed + RECOVERY_CONFIG.reviveInvulnerabilitySeconds)) < 1e-9,
    'protection follows the configuration');
  assert.equal(run.crashReaction, undefined, 'the tumble is cleared');
  assert.equal(run.crashesThisLevel, 1, 'the crash still counts for reward rules');

  // Camera: partial correction now, full convergence shortly — never a snap.
  const cameraTarget = rider.x - 900 * 0.28;
  assert.ok(run.cameraX > cameraBefore && run.cameraX < cameraTarget + 1, 'camera eased partway');
  const gapAfterRevive = Math.abs(run.cameraX - (rider.x - game.riderScreenPosition(run) * 900));
  let timestamp = 16;
  for (let frame = 0; frame < 90; frame += 1) { timestamp += 1000 / 60; game.frame(timestamp); }
  const gapAfterRiding = Math.abs(run.cameraX - (run.rider.x - game.riderScreenPosition(run) * 900));
  assert.ok(gapAfterRiding < gapAfterRevive * 0.25 + 18, `camera converges smoothly (${gapAfterRiding.toFixed(1)}px lag)`);
});

test('Protection blocks obstacle collisions, expires, and never repeats events', () => {
  const { game, callbacks } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  crashIntoRock(game, run);
  assert.equal(game.revive(), true);

  // Ride straight through an injected rock while protected.
  run.objects.push({ kind: 'rock', x: run.rider.x + 60 });
  let frames = 0;
  while (run.elapsed < run.invulnerableUntil + 0.05 && frames < 2400) { game.clock += 1 / 120; game.step(1 / 120); frames += 1; }
  assert.equal(run.over, false, 'no fatal collision while protected');
  assert.equal(callbacks.crashes, 1, 'no repeated crash events');
  assert.ok(run.elapsed >= run.invulnerableUntil, 'protection expired');

  // Once expired, an eligible collision is fatal again.
  run.objects.push({ kind: 'rock', x: run.rider.x + 70 });
  frames = 0;
  while (!run.over && frames < 900) { game.clock += 1 / 120; game.step(1 / 120); frames += 1; }
  assert.equal(run.over, true, 'protection ends correctly');
});

test('Gameplay speed and controls return to normal after a revive', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  crashIntoRock(game, run);
  assert.equal(game.revive(), true);

  const elapsedAtRevive = run.elapsed;
  let airborne = false;
  let previousX = run.rider.x;
  for (let frame = 0; frame < 150; frame += 1) {
    if (frame === 30 && run.rider.grounded) { game.press(); game.release(); }
    if (!run.rider.grounded) airborne = true;
    game.clock += 1 / 60;
    game.step(1 / 60);
    const step = run.rider.x - previousX;
    previousX = run.rider.x;
    assert.ok(step > 0.5 && step < 12, `normal speed restored (step ${step.toFixed(2)})`);
    assert.ok(run.rider.speed >= 205 && run.rider.speed <= 475, 'speed within physics bounds');
  }
  assert.ok(airborne, 'controls respond again');
  assert.ok(run.elapsed - elapsedAtRevive > 2, 'no slow-motion: game time advances');
  assert.equal(run.over, false);
});

// ───────────────────────── restart behaviour ─────────────────────────

test('Restart from a crash resets the attempt and preserves progression', () => {
  const { game } = makeEngine({ save: seedSave(4242, 2) });
  const run = beginRun(game);
  run.objects.push({ kind: 'coin', x: run.rider.x + 8, offset: 25 });
  game.step(1 / 60);
  assert.equal(run.coins, 1);
  crashIntoRock(game, run, 120);

  // The App's crash-screen restart: finalize exactly once, then restart.
  game.finalizeRun();
  assert.equal(game.status, 'gameover');
  assert.equal(game.getWalletView().balance, 1, 'coins banked once');
  game.start();

  assert.equal(game.levels.current.number, 2, 'still the current level');
  assert.equal(game.levels.completedThrough, 1, 'completed levels preserved');
  assert.equal(game.levels.levelScore, 0, 'attempt score reset');
  assert.equal(game.wallet.balance, 1, 'coin balance preserved');
  assert.equal(game.run.coins, 0, 'fresh attempt starts at zero stones');
  assert.equal(game.run.rider.x, 0, 'back at the level start');
  assert.equal(game.status, 'playing');
  assert.ok(game.run.objects.every((object) => object.x > 0 || object.kind !== 'rock'),
    'no stale collision objects from the crashed attempt');
  // Terrain and generation reinitialised and playable.
  for (let frame = 0; frame < 120; frame += 1) { game.clock += 1 / 60; game.step(1 / 60); }
  assert.equal(game.run.over, false);
});

// ───────────────────────── checkpoints ─────────────────────────

test('Checkpoints save only in safe riding spots and match the terrain on reload', () => {
  const save = seedSave(4242, 1);
  const first = makeEngine({ save }).game;
  const run = beginRun(first);
  // A rock sitting within the danger window must block any checkpoint.
  run.objects.push({ kind: 'rock', x: run.rider.x + 78 });
  run.invulnerableUntil = run.elapsed + 30;
  for (let frame = 0; frame < 240; frame += 1) { first.clock += 1 / 60; first.step(1 / 60); }
  const checkpoint = first.levels.checkpoint;
  assert.ok(checkpoint, 'a checkpoint exists once the rider is clear');
  for (const hazard of checkpoint.objects.filter((object) => ['rock', 'tree', 'log', 'swinging-log'].includes(object.kind))) {
    assert.ok(Math.abs(hazard.x - checkpoint.rider.x) > 80,
      `checkpoint not saved inside the ${hazard.kind} danger window`);
  }
  assert.equal(checkpoint.levelPhase, 'riding');
  assert.ok(checkpoint.rider.grounded && !checkpoint.rider.fallingInto);
  assert.ok(!checkpoint.crashReaction, 'crash tumbles are never checkpointed');
  const savedScore = first.levels.levelScore;

  // Reload: the parked run resumes on identical terrain with its score.
  const second = makeEngine({ save }).game;
  assert.equal(second.hasParkedRun, true);
  const restored = second.run;
  assert.equal(restored.levelPhase, 'riding');
  assert.ok(second.levels.levelScore > 0 && second.levels.levelScore <= savedScore,
    'score preserved from the last safe checkpoint');
  assert.equal(second.levels.levelScore,
    Math.min(second.levels.current.targetScore, second.levels.savedRunScore - restored.levelStartScore),
    'level score stays consistent with the saved run score');
  assert.ok(Math.abs(second.terrainAt(restored.rider.x) - (restored.rider.y + 5)) < 1e-6,
    'terrain matches the checkpointed position');
  second.resumeParkedRun();
  for (let frame = 0; frame < 60; frame += 1) { second.clock += 1 / 60; second.step(1 / 60); }
  assert.equal(second.status, 'playing');
  assert.equal(second.run.over, false);
});

// ───────────────────────── rewards & transitions after recovery ─────────────────────────

test('Rewards are never duplicated across crash, revive and restart cycles', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  const collect = () => {
    run.objects.push({ kind: 'coin', x: run.rider.x + 8, offset: 25 });
    game.step(1 / 60);
  };
  collect();
  crashIntoRock(game, run, 120);
  assert.equal(game.revive(), true);
  collect();
  crashIntoRock(game, run, 120);
  game.finalizeRun();
  assert.equal(game.getWalletView().balance, 2, 'each collected stone banked exactly once');

  // Restart, then complete the level — rewards granted exactly once.
  game.start();
  const run2 = game.run;
  run2.elapsed = 5;
  run2.nextCoinX = run2.nextHazardX = run2.nextPowerX = 1e12;
  driveToArrival(game);
  driveScenes(game);
  assert.equal(game.levels.current.number, 2);
  assert.equal(game.getWalletView().balance, 2 + 100 + 50, 'completion rewards on top, once');
});

test('Level completion transitions still work after a mid-level revive', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  crashIntoRock(game, run, 120);
  assert.equal(game.revive(), true);
  run.nextCoinX = run.nextHazardX = run.nextPowerX = 1e12;
  driveToArrival(game);
  driveScenes(game);
  assert.equal(game.levels.current.number, 2);
  assert.equal(run.levelPhase, 'riding');
  assert.equal(run.levelReward, null, 'the new level starts with a clean slate');
});

test('Repeated crash and revive cycles do not leak state', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  for (let cycle = 0; cycle < 6; cycle += 1) {
    crashIntoRock(game, run, 120);
    assert.equal(game.revive(), true, `cycle ${cycle} revived`);
    game.clock += 1 / 60;
    game.step(1 / 60);
  }
  assert.ok(run.objects.length < 60, `object count stays bounded (${run.objects.length})`);
  assert.ok(run.particles.length <= 200, `particles bounded (${run.particles.length})`);
  assert.ok(run.trail.length <= 22 && run.popups.length <= 50);
  assert.ok([run.rider.x, run.rider.y, run.rider.rotation, run.rider.speed].every(Number.isFinite));
  // The run can still end and finalize normally afterwards.
  crashIntoRock(game, run, 120);
  game.finalizeRun();
  assert.equal(game.status, 'gameover');
});

// ───────────────────────── pause / visibility / ads ─────────────────────────

test('Pause and resume stay safe around crashes and protection', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  crashIntoRock(game, run, 120);

  // Pausing a crashed run changes nothing (no conflicting states).
  game.togglePause();
  assert.equal(game.status, 'crashed');
  assert.equal(game.revive(), true);

  game.togglePause();
  assert.equal(game.status, 'paused');
  const protectionLeft = run.invulnerableUntil - run.elapsed;
  game.resume();
  assert.equal(game.status, 'playing');
  // Time spent paused does not burn the protection window.
  assert.ok(run.invulnerableUntil - run.elapsed > protectionLeft - 0.5);
  for (let frame = 0; frame < 60; frame += 1) { game.clock += 1 / 60; game.step(1 / 60); }
  assert.equal(run.over, false);
});

test('Ads never reward without a completed native reward session', async () => {
  const ads = new AdService();
  // Non-native environments (tests, browser) can never earn a revive.
  assert.equal(ads.rewardedAvailable, false);
  assert.equal(await ads.showRewarded(), false, 'unavailable ads grant nothing');
  assert.equal(await ads.showInterstitialIfDue(), false, 'interstitials never fire off-device');

  // The every-third-run interstitial frequency matches the configuration.
  assert.equal(ADMOB_CONFIG.interstitialEveryRuns, 3);
  const save = storage();
  globalThis.localStorage = save;
  const counter = new AdService();
  assert.equal(counter.interstitialDue(), false, 'no runs recorded yet');
  counter.recordCompletedRun();
  counter.recordCompletedRun();
  assert.equal(counter.interstitialDue(), false);
  counter.recordCompletedRun();
  assert.equal(counter.interstitialDue(), true, 'due on the third completed run');
});
