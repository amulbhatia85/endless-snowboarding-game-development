import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 10D — procedural generation sweep over the exact requested milestone
// levels (1, 2, 3, 4, 10, 25, 50, 100, 500, 1000) across the canonical seeds,
// checking environments, difficulty progression, determinism, checkpoints and
// physically validated safe approaches. Complements the broader audit9e bands
// (which step past levels 500 and 1000).

const { generateLevel, LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { TerrainGenerator } = await import(moduleUrl('src/game/terrain.ts'));
const { ObstaclePlanner } = await import(moduleUrl('src/game/obstaclePlanner.ts'));
const { DifficultyManager } = await import(moduleUrl('src/game/difficulty.ts'));
const { summarizePlacements } = await import(moduleUrl('src/game/feasibility.ts'));

/** Same planning harness shape audit9e drives the planner with. */
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
  return output.flatMap((plan) => plan.obstacles);
}

const MILESTONES = [1, 2, 3, 4, 10, 25, 50, 100, 500, 1000];
const SEEDS = [7, 4242, 999999];
const THEMES = new Set(['countryside', 'snowy-mountains', 'misty-mountains', 'moonlit-forest']);

test('milestone levels generate valid, deterministic, physically fair worlds across seeds', () => {
  const seenThemes = new Map();
  let checked = 0;
  const violations = [];
  let minReaction = Number.POSITIVE_INFINITY;
  const difficultyAt = [];

  for (const number of MILESTONES) {
    for (const seed of SEEDS) {
      const level = generateLevel(number, seed);
      assert.ok(level, `level ${number} seed ${seed} generates`);
      assert.ok(THEMES.has(level.environment), `level ${number} has a known environment (${level.environment})`);
      seenThemes.set(level.environment, (seenThemes.get(level.environment) ?? 0) + 1);

      // Determinism: same seed regenerates the identical world description.
      const twin = generateLevel(number, seed);
      assert.deepEqual(twin, level, `level ${number} seed ${seed} regenerates identically`);

      // Terrain is finite-slope and generates across the whole target span.
      const terrain = new TerrainGenerator(level);
      let maxSlope = 0;
      for (let x = 0; x < 4000; x += 13) {
        const slope = Math.abs(terrain.heightAt(x + 0.1) - terrain.heightAt(x - 0.1)) / 0.2;
        maxSlope = Math.max(maxSlope, slope);
      }
      assert.ok(Number.isFinite(maxSlope), `level ${number} terrain is finite`);
      assert.ok(maxSlope < 6, `level ${number} terrain slopes stay bounded (${maxSlope.toFixed(2)})`);

      // Obstacle placements pass the independent physics validator.
      const surface = (x) => 360 + terrain.heightAt(x);
      const placed = planSequence(level, 24, surface);
      const summary = summarizePlacements(placed, surface);
      checked += summary.checked;
      violations.push(...summary.violations.map((v) => ({ level: number, seed, ...v })));
      minReaction = Math.min(minReaction, summary.minReactionSeconds);

      // Checkpoint metadata is valid when present.
      if (level.checkpoint) {
        assert.ok(typeof level.checkpoint.x === 'number' && level.checkpoint.x > 0, `level ${number} checkpoint has a position`);
      }
    }
    difficultyAt.push({ number, pressure: new DifficultyManager().levelIntensity(number) });
  }

  // Difficulty rises monotonically from a gentle level 1, saturates at the
  // cap, and never climbs faster than ~0.14 per level (no cliffs).
  for (let i = 1; i < difficultyAt.length; i += 1) {
    const step = difficultyAt[i].pressure - difficultyAt[i - 1].pressure;
    const gap = difficultyAt[i].number - difficultyAt[i - 1].number;
    assert.ok(step >= -1e-9, `difficulty is monotone at level ${difficultyAt[i].number} (${step.toFixed(3)})`);
    assert.ok(step / gap <= 0.14, `difficulty per-level rate at level ${difficultyAt[i].number} (${(step / gap).toFixed(3)}/level)`);
  }
  assert.ok(difficultyAt[0].pressure <= 0.2, 'level 1 starts gentle');
  assert.ok(difficultyAt[difficultyAt.length - 1].pressure <= 0.9 + 1e-9, 'difficulty never exceeds the cap');

  assert.equal(violations.length, 0, `physics violations: ${JSON.stringify(violations.slice(0, 3))}`);
  assert.ok(checked >= 600, `broad sample (${checked} placements)`);
  assert.ok(minReaction >= 0.9, `minimum reaction window ${minReaction.toFixed(2)}s`);

  // Milestones cover multiple distinct environments.
  assert.ok(seenThemes.size >= 3, `milestone levels span several environments (${[...seenThemes.keys()].join(', ')})`);
  console.log('milestone themes:', [...seenThemes.entries()].map(([k, v]) => `${k}×${v}`).join(' '));
  console.log('difficulty pressure:', difficultyAt.map((d) => `L${d.number}=${d.pressure.toFixed(2)}`).join(' '));
});

test('milestone levels keep their safe-house approach clear and smooth', () => {
  for (const number of MILESTONES) {
    const level = generateLevel(number, 4242);
    const terrain = new TerrainGenerator(level);
    // The approach runway flattens near the end of the level span.
    const endX = level.length - 600;
    for (let x = endX - 360; x < endX + 360; x += 24) {
      const slope = Math.abs(terrain.heightAt(x + 0.1) - terrain.heightAt(x - 0.1)) / 0.2;
      assert.ok(slope <= 1.2, `level ${number} approach slope ${slope.toFixed(2)} at ${Math.round(x)}`);
    }
  }
});
