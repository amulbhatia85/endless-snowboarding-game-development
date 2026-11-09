import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 6 — cinematic house arrival & seamless level transitions.

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
  const coords = [];
  let operations = 0;
  const gradient = { addColorStop() {} };
  const record = (...values) => { operations += 1; coords.push(...values.filter((value) => typeof value === 'number')); };
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
    arc: (...v) => record(v[0], v[1], v[2]), ellipse: (...v) => record(...v.slice(0, 4)),
    fill() { operations += 1; }, stroke() { operations += 1; },
    fillText: (...v) => record(v[1], v[2]), strokeText: (...v) => record(v[1], v[2]),
    drawImage() { operations += 1; },
  };
  return { context, coords, get operations() { return operations; } };
}

function makeEngine({ search = '', save = storage(), onHud } = {}) {
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
  }, { onStatus() {}, onHud: onHud ?? (() => {}), onGameOver() {} });
  return { game, recorder, save };
}

const HAZARDS = (object) => ['rock', 'log', 'tree', 'gap', 'ramp', 'swinging-log'].includes(object.kind);

/** Reach the target through the legitimate scoring path and start the arrival. */
function driveToArrival(game) {
  const run = game.run;
  run.elapsed = Math.max(5, run.elapsed);
  run.bonus += 50_000;
  game.step(0);
  assert.equal(run.levelPhase, 'approach', 'target reached starts the final approach');
  return run.houses[run.houses.length - 1];
}

/**
 * Drive the engine through its real frame pipeline (fixed steps, environment
 * update, full draw) at 120 fps until the cinematic reaches `until`.
 */
function driveScenes(game, { until = 'riding', maxSeconds = 40, sample } = {}) {
  const run = game.run;
  const house = run.houses[run.houses.length - 1];
  const telemetry = { phases: [run.levelPhase], xs: [run.rider.x], opacities: [run.riderOpacity], doors: [], seconds: 0 };
  game.frame(16); // first frame only sets the timestamp
  while (run.levelPhase !== until && telemetry.seconds < maxSeconds) {
    game.frame(16 + telemetry.seconds * 1000 + 1000 / 120);
    telemetry.seconds += 1 / 120;
    telemetry.phases.push(run.levelPhase);
    telemetry.xs.push(run.rider.x);
    telemetry.opacities.push(run.riderOpacity);
    if (house) telemetry.doors.push(game.houseDoorOpenness(run, house));
    sample?.(run, telemetry.seconds, game);
    assert.equal(run.over, false, `the rider must not crash mid-cinematic (${run.crashReason})`);
  }
  return telemetry;
}

const orderedPhases = (phases) => phases.filter((phase, index) => index === 0 || phase !== phases[index - 1]);

// ───────────────────────── arrival & house placement ─────────────────────────

test('Level 1 completes at the target and the house appears naturally ahead', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  game.start();
  const run = game.run;
  const before = run.rider.x;
  const house = driveToArrival(game);
  assert.equal(game.levels.targetReached, true);

  // The house spawns beyond the visible screen edge — it scrolls in, never pops.
  const distance = house.x - before;
  assert.ok(distance >= 760 && distance >= 900 * 1.05, `house spawns off-screen (got +${Math.round(distance)}px)`);
  assert.ok(distance > 900 * 0.72, 'beyond the right edge for a rider at 28 % of the screen');

  // Terrain blends smoothly to a flat runway at the house.
  assert.ok(Math.abs(game.terrainAt(house.x) - house.groundY) < 1e-6, 'flat at the door');
  for (let x = house.x - 360; x < house.x + 360; x += 4) {
    const slope = (game.terrainAt(x + 0.1) - game.terrainAt(x - 0.1)) / 0.2;
    assert.ok(Math.abs(slope) <= 0.4, `smooth approach slope ${slope.toFixed(2)} at ${Math.round(x)}`);
  }
  // The path ahead is clear: no hazards anywhere in front of the rider.
  assert.ok(!run.objects.some((object) => HAZARDS(object) && object.x > run.rider.x));
});

test('The rider enters the house without clipping, teleporting or spawning hazards', () => {
  const { game, recorder } = makeEngine({ save: seedSave(4242, 1) });
  game.start();
  const house = driveToArrival(game);
  const doorX = house.x + 24;

  const telemetry = driveScenes(game, {
    sample: (state) => {
      // Rendering stays alive through every phase of the cinematic.
      assert.ok(Number.isFinite(state.rider.y) && Math.abs(state.rider.y - (game.terrainAt(state.rider.x) - 5)) < 1e-6,
        'the rider stays glued to the surface');
      if (state.levelPhase !== 'riding') {
        assert.ok(!state.objects.some((object) => HAZARDS(object) && object.x > state.rider.x),
          'no hazard spawns during the cinematic');
      }
    },
  });

  assert.deepEqual(orderedPhases(telemetry.phases), ['approach', 'entering', 'celebrating', 'exiting', 'riding']);
  assert.ok(recorder.operations > 10_000, 'the scene rendered throughout the cinematic');

  // Movement is monotonic, smooth and human-scale — no teleportation.
  for (let index = 1; index < telemetry.xs.length; index += 1) {
    const step = telemetry.xs[index] - telemetry.xs[index - 1];
    assert.ok(step >= -1e-9, 'the rider never moves backwards');
    assert.ok(step < 8, `no teleportation (step ${step.toFixed(2)}px at 120fps)`);
  }
  // The fade in and out is gradual on both sides of the celebration.
  for (let index = 1; index < telemetry.opacities.length; index += 1) {
    assert.ok(Math.abs(telemetry.opacities[index] - telemetry.opacities[index - 1]) <= 0.1,
      'opacity changes gradually');
  }
  assert.equal(Math.max(...telemetry.opacities), 1);
  assert.equal(Math.min(...telemetry.opacities), 0);
  // At the celebration the rider is inside the doorway, fully faded.
  const celebratingAt = telemetry.phases.indexOf('celebrating');
  const riderAtCelebration = telemetry.xs[celebratingAt];
  assert.ok(riderAtCelebration >= doorX - 18 && riderAtCelebration <= doorX + 8, 'inside the doorway');
  assert.equal(telemetry.opacities[celebratingAt], 0, 'fully faded as they enter');
});

test('The door animates open → closed → open → closed across the cinematic', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  game.start();
  driveToArrival(game);
  const run = game.run;
  const door = () => game.houseDoorOpenness(run, run.houses[run.houses.length - 1]);

  // Closed while the house is far away; opens as the rider closes in.
  assert.equal(door(), 0);
  while (run.levelPhase === 'approach') { game.clock += 1 / 120; game.step(1 / 120); }
  assert.equal(door(), 1, 'fully open as the rider reaches the door');
  // Stays open through the entry, then closes behind them.
  while (run.levelPhase === 'entering') { game.clock += 1 / 120; game.step(1 / 120); }
  assert.equal(door(), 1);
  while (run.levelPhase === 'celebrating' && run.sceneTime < 1.6) { game.clock += 1 / 120; game.step(1 / 120); }
  assert.equal(door(), 0, 'closed behind the rider during the celebration');
  // Reopens for the exit and closes once the rider has ridden clear.
  while (run.levelPhase === 'celebrating') { game.clock += 1 / 120; game.step(1 / 120); }
  assert.equal(door(), 1, 'reopened for the exit');
  const telemetry = driveScenes(game);
  assert.equal(telemetry.doors[telemetry.doors.length - 1], 0, 'closed after the rider leaves');
  assert.equal(door(), 0, 'closed in normal play');
});

// ───────────────────────── completion & continuation ─────────────────────────

test('The completion event fires once and a press continues to the next level', () => {
  const phases = [];
  const { game } = makeEngine({ save: seedSave(4242, 1), onHud: (snapshot) => phases.push(snapshot.level?.phase) });
  game.start();
  driveToArrival(game);
  const run = game.run;
  while (run.levelPhase !== 'celebrating') { game.clock += 1 / 120; game.step(1 / 120); }

  const edges = (list) => list.filter((phase, index) => phase !== list[index - 1]);
  const checkpointAtCelebration = JSON.stringify(game.levels.progress.checkpoint);
  // A premature press (within the grace window) must not skip the screen.
  game.press();
  for (let index = 0; index < 48; index += 1) { game.clock += 1 / 120; game.step(1 / 120); }
  assert.equal(run.levelPhase, 'celebrating', 'early taps do not skip the completion screen');
  assert.equal(run.riderOpacity, 0);
  assert.equal(JSON.stringify(game.levels.progress.checkpoint), checkpointAtCelebration,
    'no checkpoint is written during the celebration');

  // The completion is granted exactly once — a second grant is rejected.
  assert.equal(game.levels.markSafeHouseReached(), false, 'completion cannot be granted twice');
  assert.equal(game.levels.completedThrough, 0, 'nothing is persisted before the screen resolves');
  assert.equal(edges(phases).filter((phase) => phase === 'celebrating').length, 1);

  // After the grace window a press continues early.
  while (run.sceneTime < 1.3) { game.clock += 1 / 120; game.step(1 / 120); }
  game.press();
  let waited = 0;
  while (run.levelPhase === 'celebrating' && waited < 0.5) { game.clock += 1 / 120; game.step(1 / 120); waited += 1 / 120; }
  assert.equal(run.levelPhase, 'exiting', 'a press after the grace window continues');
  assert.equal(game.levels.progress.checkpoint, null, 'the advance clears the stale checkpoint');
  assert.equal(edges(phases).filter((phase) => phase === 'exiting').length, 1, 'the exit starts once');

  // Without a press the scene auto-continues (existing behaviour).
  driveScenes(game);
  assert.equal(run.levelPhase, 'riding');
  assert.equal(game.levels.completedThrough, 1, 'exactly one completion recorded');
  assert.equal(edges(phases).filter((phase) => phase === 'celebrating').length, 1, 'still exactly one completion');
});

test('The completion card holds long enough to read the level rewards', () => {
  // Playtest fix — the card used to auto-advance after 3.1s, which came and
  // went before the reward lines (glowstones, completion bonus, clean run,
  // backflips, milestone, total) could be read. Without a press it must now
  // hold for a comfortable read; early-press skipping is covered above.
  const { game } = makeEngine({ save: seedSave(7719, 1) });
  game.start();
  driveToArrival(game);
  const run = game.run;
  while (run.levelPhase !== 'celebrating') { game.clock += 1 / 120; game.step(1 / 120); }
  let held = 0;
  while (run.levelPhase === 'celebrating' && held < 16) {
    game.clock += 1 / 120;
    game.step(1 / 120);
    held += 1 / 120;
  }
  assert.equal(run.levelPhase, 'exiting', 'the card still auto-continues without a press');
  assert.ok(held >= 9.5, `the completion card held for ${held.toFixed(1)}s — readable (was 3.1s)`);
});

// ───────────────────────── the next level ─────────────────────────

test('Level 2 loads snowy, the rider exits naturally and the score resets', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  game.start();
  game.draw();
  const phaseBefore = game.environmentView.phase;
  const groundBefore = game.environment.palette(game.environmentView.phase).snow;
  const clockBefore = game.clock;
  driveToArrival(game);
  const house = game.run.houses[game.run.houses.length - 1];
  const telemetry = driveScenes(game);
  const run = game.run;

  assert.equal(game.levels.current.number, 2);
  assert.equal(game.levels.current.environment, 'snowy-mountains');
  assert.equal(run.levelIndex + 1, 2);
  assert.equal(game.levels.levelScore, 0, 'the new level score starts from zero');
  assert.equal(game.levels.completedThrough, 1, 'level 1 recorded as completed');
  assert.equal(run.levelPhase, 'riding');
  assert.ok(run.rider.x > house.x + 150, 'the rider has ridden clear of the house');
  assert.ok(run.nextCoinX > run.rider.x && run.nextHazardX > run.rider.x, 'generation resumes ahead of the rider');

  // The exit is a natural emergence: monotonic, accelerating, fading in.
  const exitingAt = telemetry.phases.indexOf('exiting');
  const exitSpeeds = [];
  for (let index = exitingAt; index < telemetry.xs.length; index += 1) exitSpeeds.push(telemetry.xs[index] - telemetry.xs[index - 1]);
  assert.ok(exitSpeeds.every((step) => step >= 0), 'the rider only moves forward');
  assert.ok(exitSpeeds[exitSpeeds.length - 1] > exitSpeeds[0] + 0.5, 'the exit accelerates');
  const fade = telemetry.opacities.slice(exitingAt);
  assert.equal(fade[0], 0);
  assert.equal(fade[fade.length - 1], 1);

  // The environment really switched (cross-fade finished) and the day/night
  // phase never reset — the global cycle just kept advancing.
  game.draw();
  const groundAfter = game.environment.palette(game.environmentView.phase).snow;
  const parse = (color) => color.match(/\d+/g).slice(0, 3).map(Number);
  const distance = Math.max(...parse(groundBefore).map((value, index) => Math.abs(value - parse(groundAfter)[index])));
  assert.ok(distance > 30, `the ground palette switched to the snowy theme (${groundBefore} → ${groundAfter})`);
  assert.ok(game.environmentView.phase > phaseBefore, 'the global day/night cycle kept advancing');
  assert.ok(game.clock > clockBefore);
  assert.ok(Number.isFinite(game.lastNight));

  // Controls and physics are fully back: a tap jumps, speed stays bounded.
  run.nextCoinX = run.nextHazardX = 1e12;
  run.objects = [];
  let airborne = false;
  let timestamp = 16;
  for (let frame = 0; frame < 300; frame += 1) {
    if (frame === 20 && run.rider.grounded) { game.press(); game.release(); }
    if (!run.rider.grounded) airborne = true;
    game.frame(timestamp);
    timestamp += 1000 / 60;
    assert.ok(run.rider.speed <= 475 && Number.isFinite(run.rider.x));
  }
  assert.ok(airborne, 'jumping works again after the transition');
  assert.equal(run.over, false);
});

// ───────────────────────── robustness ─────────────────────────

test('Pause, restart and reload during transitions keep progress valid', () => {
  // Pausing mid-cinematic preserves the scene until resumed.
  {
    const { game } = makeEngine({ save: seedSave(4242, 1) });
    game.start();
    driveToArrival(game);
    while (game.run.levelPhase === 'approach') { game.clock += 1 / 120; game.step(1 / 120); }
    game.togglePause();
    assert.equal(game.status, 'paused');
    game.resume();
    driveScenes(game);
    assert.equal(game.run.levelPhase, 'riding');
    assert.equal(game.levels.current.number, 2);
  }

  // Returning to the menu before the level is advanced replays the level…
  for (const stopAt of ['approach', 'entering', 'celebrating']) {
    const save = seedSave(4242, 1);
    const { game } = makeEngine({ save });
    game.start();
    driveToArrival(game);
    while (game.run.levelPhase !== stopAt) { game.clock += 1 / 120; game.step(1 / 120); }
    game.returnToMenu();
    assert.equal(game.status, 'menu');
    assert.equal(game.levels.current.number, 1, `${stopAt}: the un-advanced level is preserved`);
    const reloaded = makeEngine({ save }).game;
    assert.equal(reloaded.levels.current.number, 1, `${stopAt}: reload sees the original level`);
    reloaded.start();
    driveToArrival(reloaded);
    driveScenes(reloaded);
    assert.equal(reloaded.levels.current.number, 2, 'the transition completes after the interruption');
  }

  // …and after the advance (exiting) the completed level is kept, not replayed.
  {
    const save = seedSave(4242, 1);
    const { game } = makeEngine({ save });
    game.start();
    driveToArrival(game);
    while (game.run.levelPhase !== 'exiting') { game.clock += 1 / 120; game.step(1 / 120); }
    game.returnToMenu();
    assert.equal(game.levels.current.number, 2, 'the advanced level is kept');
    const reloaded = makeEngine({ save }).game;
    assert.equal(reloaded.levels.current.number, 2, 'progress survives a reload mid-exit');
    assert.equal(reloaded.hasParkedRun, false, 'no half-finished cinematic is restored');
  }

  // A reload during the entry resumes the last stable riding state (no dupes).
  {
    const save = seedSave(4242, 1);
    const { game } = makeEngine({ save });
    game.start();
    driveToArrival(game);
    while (game.run.levelPhase === 'entering') { game.clock += 1 / 120; game.step(1 / 120); }
    const reloaded = makeEngine({ save }).game;
    assert.equal(reloaded.levels.current.number, 1, 'the completion had not been saved yet');
    reloaded.resumeParkedRun();
    assert.equal(reloaded.run.levelPhase, 'riding', 'a parked riding state, never a cinematic');
    driveToArrival(reloaded); // the parked state replays and re-arrives naturally
    driveScenes(reloaded);
    assert.equal(reloaded.levels.current.number, 2);
    assert.equal(reloaded.levels.completedThrough, 1, 'exactly one completion despite the reload');
  }

  // The transition cannot execute twice.
  {
    const { game } = makeEngine({ save: seedSave(4242, 1) });
    game.start();
    driveToArrival(game);
    driveScenes(game);
    assert.equal(game.levels.markSafeHouseReached(), false, 'already marked');
    assert.throws(() => game.levels.advanceAfterTransition(), Error, 'advancing twice is rejected');
    assert.equal(game.levels.completedThrough, 1, 'the completion was counted exactly once');
  }
});

test('Transitions work across levels and procedural seeds', () => {
  const cases = [
    [1, 4242, 'snowy-mountains'],
    [2, 777, 'misty-mountains'],
    [3, 99, 'moonlit-forest'],
  ];
  for (const [level, journeySeed, nextEnvironment] of cases) {
    const { game } = makeEngine({ save: seedSave(journeySeed, level) });
    game.start();
    driveToArrival(game);
    const telemetry = driveScenes(game);
    assert.equal(game.levels.current.number, level + 1, `L${level} → L${level + 1} (seed ${journeySeed})`);
    assert.equal(game.levels.current.environment, nextEnvironment);
    assert.equal(game.levels.levelScore, 0);
    assert.deepEqual(orderedPhases(telemetry.phases), ['approach', 'entering', 'celebrating', 'exiting', 'riding']);
    // The new level plays: terrain under the rider, generation ahead, physics bounded.
    // Phase 11 — level openings now guarantee early gameplay, so the rider
    // responds to it like any player would instead of idling into the first
    // hazard.
    const run = game.run;
    let timestamp = 16;
    for (let frame = 0; frame < 240; frame += 1) {
      if (run.rider.grounded) {
        const x = run.rider.x;
        const danger = run.objects.find((object) => {
          if (object.kind === 'coin' || object.kind === 'ice' || object.bridged) return false;
          if (object.kind === 'gap') return !object.bridged && object.x > x + 60 && object.x < x + 240;
          return ['rock', 'tree', 'log', 'gap', 'ramp', 'swinging-log', 'root', 'fence', 'icicle', 'snowball', 'branch']
            .includes(object.kind) && object.x > x + 80 && object.x < x + 190;
        });
        if (danger) game.jumpQueued = true;
      }
      game.frame(timestamp);
      timestamp += 1000 / 60;
      assert.ok(Number.isFinite(run.rider.x) && Number.isFinite(run.rider.y));
    }
    assert.ok(run.nextHazardX > run.rider.x);
    assert.equal(run.over, false);
  }
});

test('The developer finish option triggers the natural final approach', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  assert.equal(game.devFinishLevel(), false, 'no run yet');
  game.start();
  for (let frame = 0; frame < 60; frame += 1) { game.clock += 1 / 60; game.step(1 / 60); }
  assert.equal(game.devFinishLevel(), true);
  game.step(0);
  assert.equal(game.run.levelPhase, 'approach', 'the normal cinematic path takes over');
  assert.equal(game.devFinishLevel(), false, 'not while already arriving');
  driveScenes(game);
  assert.equal(game.levels.current.number, 2);
});
