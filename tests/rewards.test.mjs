import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 7 — rewards, coins, abilities and unlockables.

const { LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));
const { Wallet, REWARD_CONFIG } = await import(moduleUrl('src/game/wallet.ts'));
const {
  BIKES, RIDERS, TRAILS, isUnlocked, requirementsMet, requirementText, resolveSelections,
} = await import(moduleUrl('src/game/progression.ts'));

const WALLET_KEY = 'afterglow-wallet-v1';
const HAZARD_KINDS = ['rock', 'tree', 'log', 'swinging-log', 'root', 'fence', 'snowball', 'icicle', 'branch'];

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
      return { width: 192, height: 192, getContext: () => inner };
    },
  };
  const game = new SnowGameEngine({
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    getContext: () => mockContext(),
  }, { onStatus() {}, onHud: onHud ?? (() => {}), onGameOver() {} });
  return { game, save };
}

function beginRun(game) {
  game.start();
  const run = game.run;
  run.elapsed = Math.max(5, run.elapsed);
  // Keep generation quiet so injected pickups and hazards are deterministic.
  run.nextCoinX = run.nextHazardX = run.nextPowerX = 1e12;
  run.objects = [];
  return run;
}

function driveToArrival(game) {
  const run = game.run;
  run.elapsed = Math.max(5, run.elapsed);
  run.bonus += 50_000;
  game.step(0);
  assert.equal(run.levelPhase, 'approach');
  return run.houses[run.houses.length - 1];
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

// ───────────────────────── coin collection & wallet ─────────────────────────

test('Coins collect exactly once and only bank into the wallet at transaction points', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);

  run.objects.push({ kind: 'coin', x: run.rider.x + 8, offset: 25 });
  game.step(1 / 60);
  assert.equal(run.coins, 1, 'the coin was collected');
  assert.equal(run.bonus, 125, 'score value awarded');
  assert.ok(!run.objects.some((object) => object.kind === 'coin'), 'the coin is gone');
  assert.equal(game.getWalletView().balance, 0, 'not banked mid-run');

  for (let frame = 0; frame < 30; frame += 1) { game.clock += 1 / 60; game.step(1 / 60); }
  assert.equal(run.coins, 1, 'no double award for the same coin');

  // The double-glowstone power multiplies the pickup, not the wallet math.
  run.doubleUntil = run.elapsed + 5;
  run.objects.push({ kind: 'coin', x: run.rider.x + 8, offset: 25 });
  game.step(1 / 60);
  assert.equal(run.coins, 3, 'double grants two glowstones');
  assert.equal(run.bonus, 375);

  // Abandoning the run banks exactly the collected stones — once.
  game.returnToMenu();
  assert.equal(game.getWalletView().balance, 3);
  game.returnToMenu();
  assert.equal(game.getWalletView().balance, 3, 'idempotent commit');
});

test('The coin balance persists across engine restarts and reloads', () => {
  const save = seedSave(4242, 1);
  const first = makeEngine({ save }).game;
  const run = beginRun(first);
  run.objects.push({ kind: 'coin', x: run.rider.x + 8, offset: 25 });
  first.step(1 / 60);
  run.objects.push({ kind: 'coin', x: run.rider.x + 8, offset: 25 });
  first.step(1 / 60);
  first.returnToMenu();
  assert.equal(first.getWalletView().balance, 2);

  const second = makeEngine({ save }).game;
  assert.equal(second.getWalletView().balance, 2, 'balance survives a reload');

  // Corrupt or invalid wallet saves degrade to an empty wallet, never a throw.
  save.values.set(WALLET_KEY, '{not json');
  assert.equal(makeEngine({ save }).game.getWalletView().balance, 0);
  save.values.set(WALLET_KEY, JSON.stringify({ version: 1, coins: -50, lifetimeEarned: -50, rewardedThrough: 0, owned: [] }));
  assert.equal(makeEngine({ save }).game.getWalletView().balance, 0, 'negative balances are rejected on load');
});

test('Glowstones never spawn inside obstacles or gaps and stay jump-reachable', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  let coins = 0;
  let hazardPairs = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    game.start();
    const run = game.run;
    run.elapsed = Math.max(5, run.elapsed); // natural generation stays on here
    for (let frame = 0; frame < 600 && !run.over; frame += 1) { game.clock += 1 / 60; game.step(1 / 60); }
    const hazards = run.objects.filter((object) => HAZARD_KINDS.includes(object.kind));
    for (const coin of run.objects.filter((object) => object.kind === 'coin')) {
      coins += 1;
      const offset = coin.offset ?? 25;
      assert.ok(offset >= 38 && offset <= 62, `jump-reachable height (${offset})`);
      assert.ok(game.terrainAt(coin.x) - offset < game.terrainAt(coin.x), 'never underground');
      for (const hazard of hazards) {
        hazardPairs += 1;
        assert.ok(Math.abs(hazard.x - coin.x) > 46, `coin at ${Math.round(coin.x)} not inside ${hazard.kind} at ${Math.round(hazard.x)}`);
      }
      for (const gap of run.objects.filter((object) => object.kind === 'gap' && !object.bridged)) {
        assert.ok(coin.x <= gap.x - 30 || coin.x >= gap.x + (gap.width ?? 60) + 30, 'no coin over an open gap');
      }
    }
  }
  assert.ok(coins > 10, `coins still spawn plentifully (${coins})`);
  assert.ok(hazardPairs > 10, `hazards were present to test against (${hazardPairs})`);
});

// ───────────────────────── level completion rewards ─────────────────────────

test('Wallet reward math: milestones, caps, validation and idempotence', () => {
  const wallet = new Wallet({ storage: storage() });
  assert.equal(wallet.grantLevelRewards({ level: 0, collected: 0, cleanRun: true, flips: 0 }), null, 'invalid level');
  const first = wallet.grantLevelRewards({ level: 1, collected: 7, cleanRun: true, flips: 2 });
  assert.deepEqual(first, { level: 1, collected: 7, completion: 100, cleanRun: 50, flips: 10, milestone: 0, total: 167 });
  assert.equal(wallet.balance, 167);
  assert.equal(wallet.lifetimeEarned, 167);
  assert.equal(wallet.grantLevelRewards({ level: 1, collected: 99, cleanRun: true, flips: 9 }), null, 'same level twice rejected');
  assert.equal(wallet.balance, 167, 'nothing changed');

  const milestone = wallet.grantLevelRewards({ level: 5, collected: 0, cleanRun: false, flips: 0 });
  assert.deepEqual(milestone, { level: 5, collected: 0, completion: 100, cleanRun: 0, flips: 0, milestone: 200, total: 300 });

  const capped = wallet.grantLevelRewards({ level: 6, collected: 0, cleanRun: true, flips: 99 });
  assert.equal(capped.flips, REWARD_CONFIG.flipRewardCap, 'flip rewards are capped');
  assert.equal(wallet.rewardedThrough, 6);
  assert.equal(wallet.lifetimeEarned, 167 + 300 + 100 + 50 + REWARD_CONFIG.flipRewardCap);

  // Purchases: exact deduction, no negatives, no double ownership.
  const balanceBeforePurchase = wallet.balance; // 167 + 300 + 175 = 642
  assert.equal(balanceBeforePurchase, 642);
  assert.equal(wallet.purchase('', 100), 'invalid');
  assert.equal(wallet.purchase('item-a', 0), 'invalid');
  assert.equal(wallet.purchase('item-a', 10_000), 'insufficient');
  assert.equal(wallet.balance, 642, 'failed purchases change nothing');
  assert.equal(wallet.purchase('item-a', 600), 'ok');
  assert.equal(wallet.balance, 42, 'exact deduction');
  assert.ok(wallet.owned.includes('item-a'));
  assert.equal(wallet.purchase('item-a', 1), 'owned');
  assert.equal(wallet.balance, 42, 'buying twice is a no-op');
  assert.ok(wallet.balance >= 0, 'never negative');
});

test('Level completion rewards match the configuration and are granted once', () => {
  const huds = [];
  const { game } = makeEngine({ save: seedSave(4242, 1), onHud: (snapshot) => huds.push(snapshot) });
  game.start();
  const run = game.run;
  run.elapsed = 5;
  run.nextCoinX = run.nextHazardX = run.nextPowerX = 1e12;
  run.flipsThisLevel = 4; // four landed backflips this level
  driveToArrival(game);

  while (run.levelPhase !== 'celebrating') { game.clock += 1 / 120; game.step(1 / 120); }
  // Settled the moment the completion condition was met:
  assert.deepEqual(run.levelReward, {
    level: 1, collected: 0, completion: 100, cleanRun: 50, flips: 20, milestone: 0, total: 170,
  });
  assert.equal(game.getWalletView().balance, 170, '100 completion + 50 clean + 4 flips × 5');
  assert.equal(game.getWalletView().rewardedThrough, 1);
  driveScenes(game);
  assert.equal(game.levels.current.number, 2);
  assert.equal(run.coinsAtLevelStart, run.coins, 'the new level starts from zero stones');
  assert.equal(run.crashesThisLevel, 0);
  assert.equal(run.flipsThisLevel, 0);
  assert.equal(run.levelReward, null);

  // Completing the next level adds its own rewards on top (flip cap applies).
  run.flipsThisLevel = 9;
  driveToArrival(game);
  driveScenes(game);
  assert.equal(game.getWalletView().balance, 170 + 100 + 50 + 25, 'flip reward is capped');
  assert.equal(game.levels.current.number, 3);

  // The HUD exposes the balance and the reward ledger for the completion card.
  const celebration = huds.find((snapshot) => snapshot.level?.phase === 'celebrating' && snapshot.level?.reward);
  assert.ok(celebration, 'a HUD snapshot carries the reward ledger');
  assert.equal(celebration.level.reward.total, 170);
  assert.equal(celebration.wallet.balance, 170);
});

test('A crash voids the clean-run bonus; coins still bank; revive keeps the crash counted', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);
  run.objects.push({ kind: 'coin', x: run.rider.x + 8, offset: 25 });
  game.step(1 / 60);
  assert.equal(run.coins, 1);

  // Crash into an injected rock.
  run.objects.push({ kind: 'rock', x: run.rider.x + 70 });
  let frames = 0;
  while (!run.over && frames < 900) { game.clock += 1 / 120; game.step(1 / 120); frames += 1; }
  assert.equal(run.over, true);
  assert.equal(run.crashesThisLevel, 1);
  assert.equal(game.status, 'crashed');

  // Abandoning the crashed run banks the collected stone.
  game.returnToMenu();
  assert.equal(game.getWalletView().balance, 1);

  // Revive path: crash, revive, still complete — clean-run bonus denied.
  const second = makeEngine({ save: seedSave(777, 1) }).game;
  const run2 = beginRun(second);
  run2.objects.push({ kind: 'rock', x: run2.rider.x + 70 });
  let frames2 = 0;
  while (!run2.over && frames2 < 900) { second.clock += 1 / 120; second.step(1 / 120); frames2 += 1; }
  assert.equal(second.revive(), true);
  assert.equal(run2.crashesThisLevel, 1, 'the crash still counts after reviving');
  driveToArrival(second);
  while (run2.levelPhase !== 'celebrating') { second.clock += 1 / 120; second.step(1 / 120); }
  assert.equal(run2.levelReward.cleanRun, 0, 'no clean-run bonus after a crash');
  assert.equal(run2.levelReward.completion, 100);
  const reward = run2.levelReward;
  driveScenes(second);
  assert.equal(second.getWalletView().balance, reward.total);
});

test('Interrupted transitions never duplicate rewards', () => {
  const save = seedSave(4242, 1);

  // Interruption right after the settle (during the celebration): the wallet
  // already holds the rewards, the level has not advanced. A replay must not
  // grant them again.
  const first = makeEngine({ save }).game;
  const run = beginRun(first);
  driveToArrival(first);
  while (run.levelPhase !== 'celebrating') { first.clock += 1 / 120; first.step(1 / 120); }
  assert.equal(first.getWalletView().balance, 150);
  assert.equal(first.levels.completedThrough, 0, 'the level itself has not advanced yet');

  const replay = makeEngine({ save }).game;
  assert.equal(replay.levels.current.number, 1, 'the completion replays');
  assert.equal(replay.getWalletView().balance, 150, 'the wallet already banked it');
  const run2 = beginRun(replay);
  driveToArrival(replay);
  while (run2.levelPhase !== 'celebrating') { replay.clock += 1 / 120; replay.step(1 / 120); }
  assert.deepEqual(run2.levelReward, { level: 1, collected: 0, completion: 0, cleanRun: 0, flips: 0, milestone: 0, total: 0 },
    'the replay card shows ordinary earnings only');
  driveScenes(replay);
  assert.equal(replay.levels.completedThrough, 1);
  assert.equal(replay.getWalletView().balance, 150, 'no second helping of one-time rewards');

  // Interruption during the exit: the advanced level is kept, rewards once.
  const third = makeEngine({ save }).game;
  const run3 = beginRun(third);
  driveToArrival(third);
  while (run3.levelPhase !== 'exiting') { third.clock += 1 / 120; third.step(1 / 120); }
  const persisted = makeEngine({ save }).game;
  assert.equal(persisted.levels.current.number, 3, 'level 2 was completed and advanced while exiting');
  assert.equal(persisted.getWalletView().balance, 300, 'exactly two levels worth of rewards');
});

test('Developer sandboxes never touch the saved wallet', () => {
  const save = seedSave(4242, 1);
  const { game } = makeEngine({ search: '?dev=1', save });
  game.start();
  const run = game.run;
  run.elapsed = 5;
  assert.equal(game.devFinishLevel(), true);
  game.step(0);
  driveScenes(game);
  assert.equal(game.levels.current.number, 2);
  assert.equal(game.getWalletView().balance, 150, 'rewards visible in the sandbox');
  assert.equal(save.values.get(WALLET_KEY) ?? null, null, 'nothing was written to the real wallet');
});

// ───────────────────────── temporary abilities ─────────────────────────

test('Abilities activate, expire and follow their configuration', () => {
  assert.equal(REWARD_CONFIG.abilities.magnetSeconds, 10);
  assert.equal(REWARD_CONFIG.abilities.doubleSeconds, 12);
  assert.equal(REWARD_CONFIG.abilities.shieldUses, 1);

  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const run = beginRun(game);

  const elapsedBefore = run.elapsed;
  run.objects.push({ kind: 'magnet', x: run.rider.x + 8 });
  game.step(1 / 60);
  assert.ok(run.magnetUntil > elapsedBefore + 9 && run.magnetUntil <= run.elapsed + 10, 'magnet lasts the configured duration');

  run.objects.push({ kind: 'double', x: run.rider.x + 8 });
  game.step(1 / 60);
  assert.ok(run.doubleUntil > run.elapsed + 11, 'double lasts the configured duration');

  // Expiry: past the deadline the HUD no longer lists the powers.
  while (run.elapsed < Math.max(run.magnetUntil, run.doubleUntil) + 0.1) { game.clock += 1 / 120; game.step(1 / 120); }
  const hud = game.makeHud(run);
  assert.ok(!hud.powers.some((power) => power.kind === 'magnet' || power.kind === 'double'), 'powers expire');

  // The shield absorbs exactly one eligible collision.
  run.objects.push({ kind: 'shield', x: run.rider.x + 8 });
  game.step(1 / 60);
  assert.equal(run.shield, true);
  run.objects.push({ kind: 'rock', x: run.rider.x + 70 });
  let frames = 0;
  while (run.shield && !run.over && frames < 900) { game.clock += 1 / 120; game.step(1 / 120); frames += 1; }
  assert.equal(run.over, false, 'the first collision was absorbed');
  assert.equal(run.shield, false, 'the shield was consumed');
  assert.ok(run.invulnerableUntil > run.elapsed, 'brief protection follows');

  while (run.elapsed < run.invulnerableUntil + 0.1) { game.clock += 1 / 120; game.step(1 / 120); }
  run.objects.push({ kind: 'rock', x: run.rider.x + 70 });
  let frames2 = 0;
  while (!run.over && frames2 < 900) { game.clock += 1 / 120; game.step(1 / 120); frames2 += 1; }
  assert.equal(run.over, true, 'a second collision crashes without the shield');
});

// ───────────────────────── unlockables & purchases ─────────────────────────

test('Purchases deduct exactly once and the balance can never go negative', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  game.wallet.deposit(300);
  assert.equal(game.getWalletView().balance, 300);

  assert.equal(game.purchaseUnlockable('rider-willow'), 'ok');
  assert.equal(game.getWalletView().balance, 50, 'exact deduction');
  assert.ok(game.getWalletView().owned.includes('rider-willow'));

  assert.equal(game.purchaseUnlockable('rider-willow'), 'owned', 'cannot buy twice');
  assert.equal(game.getWalletView().balance, 50);

  assert.equal(game.purchaseUnlockable('bike-midnight'), 'insufficient', '400 > 50');
  assert.equal(game.getWalletView().balance, 50, 'failed purchases change nothing');

  assert.equal(game.purchaseUnlockable('rider-ash'), 'locked', 'requires 3 completed levels');
  assert.equal(game.purchaseUnlockable('trail-gilded'), 'locked', 'requires the Glowkeeper achievement');
  assert.equal(game.purchaseUnlockable('nope'), 'invalid');
  assert.ok(game.getWalletView().balance >= 0, 'never negative');
});

test('Locked cosmetics can never be equipped; purchases and stats unlock them', () => {
  const empty = { bestDistance: 0, bestTricks: 0, completedLevels: 0, owned: [], achievements: [] };
  const want = { bike: 'Aurora', rider: 'Ash', trail: 'Gilded' };

  let resolved = resolveSelections(want, empty);
  assert.equal(resolved.bike.name, 'Amber', 'locked bike falls back');
  assert.equal(resolved.rider.name, 'Scout', 'locked rider falls back');
  assert.equal(resolved.trail.name, 'Classic', 'locked trail falls back');

  const earned = {
    ...empty,
    bestDistance: 800,
    bestTricks: 3,
    owned: ['bike-aurora', 'rider-ash', 'trail-gilded'],
    achievements: ['glowkeeper'],
  };
  resolved = resolveSelections(want, earned);
  assert.equal(resolved.bike.name, 'Aurora', 'purchased');
  assert.equal(resolved.rider.name, 'Ash', 'purchased rider equips');
  assert.equal(resolved.trail.name, 'Gilded', 'achievement + purchase unlocked');

  // Stat unlocks equip through their thresholds; locked ones fall back.
  resolved = resolveSelections({ ...want, rider: 'Nova' }, { ...earned, owned: [] });
  assert.equal(resolved.rider.name, 'Nova', 'stat-unlocked path respects thresholds');
  resolved = resolveSelections({ ...want, rider: 'Nova', bike: 'Glacier' }, { ...earned, owned: [], bestTricks: 1, bestDistance: 100 });
  assert.equal(resolved.rider.name, 'Scout', 'falls back when the stat falls short');
  assert.equal(resolved.bike.name, 'Amber', 'locked bike falls back');

  // Requirement text is human-readable for every catalog entry.
  for (const entry of [...BIKES, ...RIDERS, ...TRAILS]) {
    const text = requirementText(entry);
    assert.ok(typeof text === 'string' && text.length > 0);
  }
  assert.match(requirementText(TRAILS[3]), /Glowkeeper achievement/);
  assert.match(requirementText(RIDERS[4]), /3 levels completed/);

  // The engine applies the same rules for its equipped skins.
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  const context = game.unlockContext();
  assert.equal(isUnlocked(RIDERS[4], context), false);
  assert.equal(requirementsMet(RIDERS[4], context), false);
  assert.equal(isUnlocked(BIKES[0], context), true, 'starters are unlocked');
});

// ───────────────────────── everything still works together ─────────────────────────

test('Physics, generation and transitions keep working with rewards active', () => {
  const { game } = makeEngine({ save: seedSave(4242, 1) });
  game.start();
  const run = game.run;
  run.elapsed = 5;
  driveToArrival(game);
  driveScenes(game);
  assert.equal(game.levels.current.number, 2);
  assert.equal(run.levelPhase, 'riding');
  // Post-transition physics sanity: bounded speed, finite state, jump works.
  run.nextCoinX = run.nextHazardX = run.nextPowerX = 1e12;
  run.objects = [];
  let airborne = false;
  for (let frame = 0; frame < 240; frame += 1) {
    if (frame === 20 && run.rider.grounded) { game.press(); game.release(); }
    if (!run.rider.grounded) airborne = true;
    game.clock += 1 / 60;
    game.step(1 / 60);
    assert.ok(run.rider.speed <= 475 && Number.isFinite(run.rider.x));
  }
  assert.ok(airborne);
  assert.equal(run.over, false);
  assert.equal(game.getWalletView().balance, 150, 'rewards from the completed level remain');
});
