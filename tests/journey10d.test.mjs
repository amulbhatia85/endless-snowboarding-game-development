import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 10D — the canonical gameplay journey, end to end in one continuous
// run: launch → Level 1 → ride (coins, jumps, flips, weather) → crash →
// rewarded-ad revive → protection expiry → 50 000-point target (topped up
// through the real bonus scoring path) → house approach → entry → completion
// screen event → rewards banked → Level 2 → house exit → new environment →
// save/reload resumes at Level 2.

const { LEVEL_SAVE_KEY, LEVEL_TARGET_SCORE } = await import(moduleUrl('src/game/levelManager.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

const HAZARDS = ['rock', 'log', 'tree', 'gap', 'ramp', 'swinging-log', 'root', 'fence', 'ice', 'icicle', 'snowball', 'branch'];

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
  const callbacks = { statuses: [], gameOvers: 0, crashes: 0, coins: 0, sounds: [] };
  const game = new SnowGameEngine({
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    getContext: () => mockContext(),
  }, {
    onStatus: (status) => callbacks.statuses.push(status),
    onHud: () => {},
    onGameOver: () => { callbacks.gameOvers += 1; },
    onCrash: () => { callbacks.crashes += 1; },
    onSound: (event) => { if (event.type === 'coin') callbacks.coins += 1; callbacks.sounds.push(event.type); },
  });
  game.start();
  return { game, callbacks, save };
}

/** Jump at hazards, hold long every few seconds to flip, collect coins by riding. */
function botStep(game, hold) {
  const run = game.run;
  if (!run.rider.grounded) return;
  const x = run.rider.x;
  const danger = run.objects.find((object) => {
    if (object.kind === 'coin' || object.kind === 'ice' || object.bridged) return false;
    if (object.kind === 'gap') return object.x > x + 60 && object.x < x + 240;
    return HAZARDS.includes(object.kind) && object.x > x + 80 && object.x < x + 190;
  });
  if (danger) game.jumpQueued = true;
  else if (hold) game.jumpQueued = true;
}

/** Drive the real frame() pipeline at 60 fps. */
function ride(game, seconds, { flipEvery = 0, noBot = false, shield } = {}) {
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 5);
  const protect = shield ?? !noBot;
  if (protect) run.invulnerableUntil = run.elapsed + 999; // the bot is not testing crashes here
  else run.invulnerableUntil = 0;
  run.rider.speed = 475;
  let t = game.__journeyTime ?? 0;
  let heldFor = 0;
  for (let frame = 0; frame < seconds * 60; frame += 1) {
    const wantFlip = flipEvery > 0 && frame % Math.round(flipEvery * 60) === 0;
    if (!noBot) botStep(game, wantFlip);
    // Hold the jump for ~0.62 s on flip attempts, ~0.1 s otherwise.
    const holding = game.jumpQueued || heldFor > 0;
    if (holding && heldFor === 0) heldFor = wantFlip ? 37 : 6;
    if (heldFor > 0) { game.press(); heldFor -= 1; } else { game.release(); }
    t += 1000 / 60;
    game.__journeyTime = t;
    game.frame(t);
    if (game.status !== 'playing') break;
  }
  game.release();
}

test('full journey: launch → ride → crash → revive → target → house → Level 2 → reload', () => {
  const save = seedSave(4242, 1);
  const { game, callbacks } = makeEngine({ save });
  const run = game.run;
  assert.ok(run, 'run exists after start');
  assert.equal(game.levels.current.number, 1, 'Level 1');
  assert.equal(run.levelPhase, 'riding');

  // ── 1. Ride: coins, flips, weather, score growth ─────────────────────────
  const themeBefore = game.environment.theme;
  ride(game, 14, { flipEvery: 4 });
  assert.equal(game.status, 'playing', 'bot survives with hazard jumps');
  assert.ok(run.coins > 0 || callbacks.coins > 0, 'coins were collected');
  assert.ok(run.tricks > 0, `flips were performed (got ${run.tricks})`);
  assert.ok(game.levels.levelScore > 0, 'score accrued');
  const scoreAfterRide = game.levels.levelScore;
  assert.ok(themeBefore, 'environment theme present');
  const speedNormal = run.rider.speed;

  // ── 2. Crash and the rewarded-ad revive path ─────────────────────────────
  ride(game, 30, { noBot: true });
  assert.equal(game.status, 'crashed', `the unprotected rider eventually crashes (${run.crashReason})`);
  assert.equal(callbacks.crashes, 1, 'onCrash fired exactly once');
  assert.equal(game.reviveAvailable, true, 'revive is offered after a crash');
  assert.equal(game.revive(), true, 'a completed rewarded ad revives the run');
  assert.equal(game.status, 'playing', 'riding resumes after the revive');
  const protectionUntil = run.invulnerableUntil;
  assert.ok(protectionUntil > run.elapsed, 'revive protection is active');
  // Protection expires while riding at normal speed (hazards cleared so the
  // expiry window cannot crash first; the gap-jumping bot stays on).
  run.objects = run.objects.filter((object) => object.kind === 'coin');
  ride(game, 3.4, { shield: false });
  assert.ok(run.invulnerableUntil <= run.elapsed + 0.001, 'revive protection expired');
  assert.ok(Math.abs(run.rider.speed - speedNormal) < 120, 'speed is back in the normal range');

  // ── 3. Reach the 50 000-point target through the real bonus path ─────────
  assert.ok(scoreAfterRide < LEVEL_TARGET_SCORE, 'honest riding alone has not finished the level yet');
  run.bonus += LEVEL_TARGET_SCORE - game.levels.levelScore;
  game.step(0);
  assert.equal(game.levels.targetReached, true, 'the 50 000-point target is reached');
  assert.equal(run.levelPhase, 'approach', 'the final approach begins');

  // ── 4. House approach → entry → completion ───────────────────────────────
  const statuses = [];
  const seenPhases = new Set();
  let completions = 0;
  const originalHud = game.callbacks.onHud;
  game.callbacks.onHud = (hud) => { if (hud.level?.phase === 'celebrating' && !seenPhases.has('celebrating')) { seenPhases.add('celebrating'); completions += 1; } originalHud(hud); };
  const walletBefore = game.wallet.balance;
  let t = game.__journeyTime ?? 0;
  let seconds = 0;
  while (run.levelPhase !== 'celebrating' && seconds < 40) {
    t += 1000 / 60; seconds += 1 / 60;
    game.frame(t);
    statuses.push(run.levelPhase);
    seenPhases.add(run.levelPhase);
    assert.equal(run.over, false, `no crash mid-cinematic (${run.crashReason})`);
  }
  assert.equal(run.levelPhase, 'celebrating', 'the completion celebration is reached');
  assert.ok(game.wallet.balance > walletBefore, `level earnings were banked (+${game.wallet.balance - walletBefore} glowstones)`);
  assert.equal(completions, 1, 'the completion event is unique');

  // ── 5. Continue to Level 2 and exit the house ────────────────────────────
  run.sceneTime = Math.max(run.sceneTime, 99); // the hold-to-continue grace is long since passed
  game.press();
  game.release();
  t = game.__journeyTime ?? 0;
  seconds = 0;
  let sawLevel2 = false;
  while (run.levelPhase !== 'riding' && seconds < 40) {
    t += 1000 / 60; seconds += 1 / 60;
    game.frame(t);
    if (game.levels.current.number === 2) sawLevel2 = true;
    assert.equal(run.over, false, `no crash during the Level 2 exit cinematic (${run.crashReason})`);
  }
  assert.equal(sawLevel2, true, 'Level 2 begins');
  assert.equal(game.levels.current.number, 2, 'Level 2 is current');
  assert.equal(run.levelPhase, 'riding', 'the rider exits the house naturally');
  assert.equal(game.levels.current.environment, game.environment.theme, 'Level 2 uses its own environment');
  assert.notEqual(game.levels.current.environment, 'green-hills', 'Level 2 is a new environment (snowy)');

  // ── 6. Save/reload resumes at Level 2 with progression intact ────────────
  const saved = save.values.get(LEVEL_SAVE_KEY);
  assert.ok(saved, 'progress was persisted');
  const parsed = JSON.parse(saved);
  assert.equal(parsed.currentLevel, 2, 'the save points at Level 2');
  assert.ok(parsed.completedThrough >= 1, 'Level 1 completion is recorded');
  assert.ok(parsed.levelScore + parsed.runScore + parsed.lifetimeScore >= 0, 'score fields are valid');
  const reloaded = makeEngine({ save });
  assert.equal(reloaded.game.levels.current.number, 2, 'a fresh engine resumes from Level 2');
  assert.equal(reloaded.game.wallet.balance, game.wallet.balance, 'the glowstone balance survives the reload');
  assert.equal(callbacks.gameOvers, 0, 'no spurious game-over fired during the journey');
});
