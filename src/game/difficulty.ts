// Phase 5 — intelligent difficulty & obstacle pacing engine.
//
// The DifficultyManager turns "how hard should this moment be?" into a single
// data-only directive. It considers:
//
//   • the level number  (a saturating between-level curve with a hard cap),
//   • progress through the 50 000-point level (pacing zones + difficulty waves),
//   • the terrain ahead (a complexity damp so rough ground never stacks with
//     dense obstacles),
//   • the rider's physics envelope (reaction time and jump reach), and
//   • the level theme (the planner already restricts obstacles per
//     environment; the directive only adjusts pacing, never the allowed set).
//
// Everything is a pure function of its inputs and every number lives in one
// configurable object — no per-level hardcoding. The engine feeds the
// directive to the existing ObstaclePlanner; the planner keeps doing the
// physics validation, so a directive can only ever choose *between* already
// validated, achievable placements. Bicycle speed limits are never touched:
// difficulty comes from pattern selection, spacing and reaction budgets.

import type { LevelConfiguration } from './levelManager';
import { BICYCLE_PHYSICS } from './riderPhysics';

export interface PacingZoneDefinition {
  /** Exclusive upper bound as a fraction of the level target (last zone: ≥ 1). */
  upTo: number;
  multiplier: number;
  label: string;
}

export interface DifficultyConfig {
  /** Asymptotic upper bound of the between-level intensity curve. */
  levelCap: number;
  /** Level count at which the curve reaches ~63 % of the cap. */
  levelTau: number;
  /** Pacing zones across the level, ordered by progress fraction. */
  zones: readonly PacingZoneDefinition[];
  /** Difficulty wave cycles across the level's middle stretch. */
  waves: number;
  /** How strongly wave valleys soften the intensity (0 = off, 1 = deep). */
  waveWeight: number;
  /** Tension floor inside a wave's recovery valley. */
  waveRecoveryTension: number;
  /** Obstacle-intensity reduction per unit of terrain complexity. */
  terrainDamping: number;
  /** Base spacing between obstacle groups at intensity 0 / 1 (px). */
  spacingEasy: number;
  spacingHard: number;
  /** Extra recovery corridor after dangerous patterns (px). */
  dangerRecovery: number;
  /** Reaction-time bounds (seconds) — the floor matches the planner legacy. */
  reactionEasy: number;
  reactionHard: number;
  /** Chance a planning slot becomes an intentional recovery section. */
  recoveryChanceEasy: number;
  recoveryChanceHard: number;
  /** Added recovery chance while inside a wave valley. */
  recoveryValleyBonus: number;
  /** Progress fraction from which the final approach is forced safe. */
  safeApproachFrom: number;
  /** How many recent pattern ids the repetition memory keeps. */
  recentPatternMemory: number;
}

export const DEFAULT_DIFFICULTY_CONFIG: DifficultyConfig = {
  // Saturates at 0.9: L1 0.00 · L2 0.13 · L3 0.24 · L5 0.41 · L6 0.45 ·
  // L10 0.58 · L11 0.61 · L20 0.74 · L21 0.75 · L40 0.83 · ∞ → 0.90.
  levelCap: 0.9,
  levelTau: 6.5,
  zones: [
    { upTo: 0.2, multiplier: 0.5, label: 'WARM-UP' },        // 0–10k: introduction
    { upTo: 0.4, multiplier: 0.75, label: 'BUILD-UP' },      // 10–20k: gradual increase
    { upTo: 0.6, multiplier: 0.9, label: 'MODERATE' },       // 20–30k: combinations
    { upTo: 0.8, multiplier: 1.0, label: 'MAIN CHALLENGE' }, // 30–40k: main challenge
    { upTo: 0.9, multiplier: 1.06, label: 'FINAL SEQUENCES' }, // 40–45k: peak
    { upTo: 1.0, multiplier: 0.32, label: 'SAFE APPROACH' }, // 45–50k: taper off
  ],
  waves: 3,
  waveWeight: 0.4,
  waveRecoveryTension: 0.3,
  terrainDamping: 0.3,
  spacingEasy: 210,
  spacingHard: 105,
  dangerRecovery: 240,
  reactionEasy: 1.3,
  reactionHard: 0.95,
  recoveryChanceEasy: 0.3,
  recoveryChanceHard: 0.1,
  recoveryValleyBonus: 0.5,
  safeApproachFrom: 0.9,
  recentPatternMemory: 8,
};

export interface ZoneSnapshot {
  label: string;
  multiplier: number;
  index: number;
  fromPoints: number;
  toPoints: number;
}

export interface WaveSnapshot {
  index: number;
  count: number;
  tension: number;
  recovery: boolean;
}

export interface DifficultyDirective {
  level: number;
  environment: string;
  /** Level-score progress through the current level, 0..1. */
  progress: number;
  /** Between-level intensity from the saturating curve (0..levelCap). */
  levelIntensity: number;
  zone: ZoneSnapshot;
  wave: WaveSnapshot;
  /** Terrain complexity input, 0..1 (echoed for the debug overlay). */
  terrainComplexity: number;
  /** Final obstacle intensity after zone, wave and terrain shaping, 0..1. */
  intensity: number;
  /** Target challenge rating the planner should select patterns for, 0..1. */
  patternIntensity: number;
  reactionSeconds: number;
  recoveryChance: number;
  /** Base spacing between obstacle groups (px), added on top of reaction distance. */
  minSpacing: number;
  /** Extra recovery corridor after dangerous patterns (px). */
  dangerRecovery: number;
  /** True from 45 k: dangerous sequences stop and the arrival path is kept clear. */
  safeApproach: boolean;
  /** Points until the next wave-recovery valley (null when already safe). */
  nextRecoveryPoints: number | null;
  recentPatternMemory: number;
  /** Rider capability snapshot derived from the shared physics constants. */
  riderEnvelope: { minJumpDistance: number; maxJumpDistance: number; maxSpeed: number };
}

export interface DifficultyInputs {
  level: LevelConfiguration;
  /** 0..1 fraction of the level target scored so far. */
  progress: number;
  /** 0..1 terrain complexity ahead of the rider (fixed window, viewport-free). */
  terrainComplexity?: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (t: number) => t * t * (3 - 2 * t);

function riderEnvelope(): DifficultyDirective['riderEnvelope'] {
  // Symmetric ballistic estimate of the tap-jump reach at the speed bounds.
  const reach = (speed: number) => {
    const boost = Math.min(BICYCLE_PHYSICS.maxJumpBoost, speed * BICYCLE_PHYSICS.jumpSpeedFactor);
    const airTime = (2 * (BICYCLE_PHYSICS.jumpVelocity + boost)) / BICYCLE_PHYSICS.gravity;
    return Math.round(speed * airTime);
  };
  return {
    minJumpDistance: reach(BICYCLE_PHYSICS.minSpeed),
    maxJumpDistance: reach(BICYCLE_PHYSICS.maxSpeed),
    maxSpeed: BICYCLE_PHYSICS.maxSpeed,
  };
}

export class DifficultyManager {
  readonly config: DifficultyConfig;
  private readonly envelope = riderEnvelope();

  constructor(config: Partial<DifficultyConfig> = {}) {
    const merged: DifficultyConfig = { ...DEFAULT_DIFFICULTY_CONFIG, ...config };
    if (!Number.isFinite(merged.levelCap) || merged.levelCap <= 0 || merged.levelCap > 1) {
      throw new RangeError('levelCap must be within (0, 1].');
    }
    if (!Number.isFinite(merged.levelTau) || merged.levelTau <= 0) {
      throw new RangeError('levelTau must be positive.');
    }
    if (!Number.isFinite(merged.waves) || merged.waves < 1 || !Number.isSafeInteger(merged.waves)) {
      throw new RangeError('waves must be a positive integer.');
    }
    if (merged.safeApproachFrom <= 0 || merged.safeApproachFrom > 1) {
      throw new RangeError('safeApproachFrom must be within (0, 1].');
    }
    if (!merged.zones.length || merged.zones[0].upTo <= 0) throw new RangeError('zones must start above 0.');
    for (let index = 1; index < merged.zones.length; index += 1) {
      if (merged.zones[index].upTo <= merged.zones[index - 1].upTo) {
        throw new RangeError('zones must be ordered by increasing upTo.');
      }
    }
    if (merged.zones[merged.zones.length - 1].upTo < 1) throw new RangeError('the last zone must cover progress 1.');
    this.config = merged;
  }

  /** Saturating between-level curve: monotonic, bounded by levelCap, 0 at level 1. */
  levelIntensity(levelNumber: number): number {
    if (!Number.isFinite(levelNumber) || levelNumber < 1) {
      throw new RangeError('levelNumber must be ≥ 1.');
    }
    return this.config.levelCap * (1 - Math.exp(-(levelNumber - 1) / this.config.levelTau));
  }

  zoneAt(progress: number, targetScore: number): ZoneSnapshot {
    const p = clamp01(progress);
    let index = this.config.zones.findIndex(zone => p < zone.upTo);
    if (index < 0) index = this.config.zones.length - 1;
    const from = index === 0 ? 0 : this.config.zones[index - 1].upTo;
    const to = Math.min(1, this.config.zones[index].upTo);
    const zone = this.config.zones[index];
    return {
      label: zone.label, multiplier: zone.multiplier, index,
      fromPoints: Math.round(from * targetScore), toPoints: Math.round(to * targetScore),
    };
  }

  /**
   * Wave tension across the level's active stretch (before the safe approach).
   * Each wave ramps easy → challenging, dips into a recovery valley and holds
   * it, so difficulty breathes instead of climbing monotonically.
   */
  waveAt(progress: number): WaveSnapshot {
    const { waves, safeApproachFrom, waveRecoveryTension } = this.config;
    const p = clamp01(progress);
    if (p >= safeApproachFrom) {
      return { index: waves - 1, count: waves, tension: waveRecoveryTension, recovery: true };
    }
    const span = safeApproachFrom / waves;
    const index = Math.min(waves - 1, Math.floor(p / span));
    const fraction = (p - index * span) / span;
    const tension = fraction < 0.62
      ? 0.45 + 0.55 * smoothstep(fraction / 0.62)
      : fraction < 0.78
        ? lerp(1, waveRecoveryTension, (fraction - 0.62) / 0.16)
        : waveRecoveryTension;
    return { index, count: waves, tension, recovery: tension <= 0.42 };
  }

  directive(inputs: DifficultyInputs): DifficultyDirective {
    const { level } = inputs;
    if (!Number.isFinite(inputs.progress)) throw new RangeError('progress must be finite.');
    const progress = clamp01(inputs.progress);
    const terrainComplexity = clamp01(inputs.terrainComplexity ?? 0);
    const levelIntensity = this.levelIntensity(level.number);
    const zone = this.zoneAt(progress, level.targetScore);
    const wave = this.waveAt(progress);
    const waveFactor = 1 - this.config.waveWeight * (1 - wave.tension);
    const terrainFactor = 1 - this.config.terrainDamping * terrainComplexity;
    const intensity = clamp01(levelIntensity * zone.multiplier * waveFactor * terrainFactor);
    // Reaction time tightens only between levels (never inside one) and loosens
    // slightly on complex terrain; the floor matches the planner's legacy bound.
    const reactionSeconds = Math.max(0.95,
      lerp(this.config.reactionEasy, this.config.reactionHard, levelIntensity / Math.max(1e-6, this.config.levelCap))
      * (1 + terrainComplexity * 0.2));
    const recoveryChance = Math.min(0.85,
      lerp(this.config.recoveryChanceEasy, this.config.recoveryChanceHard, intensity)
      + (wave.recovery ? this.config.recoveryValleyBonus : 0));
    return {
      level: level.number,
      environment: level.environment,
      progress,
      levelIntensity,
      zone,
      wave,
      terrainComplexity,
      intensity,
      patternIntensity: Math.max(0.05, intensity),
      reactionSeconds,
      recoveryChance,
      minSpacing: lerp(this.config.spacingEasy, this.config.spacingHard, intensity),
      dangerRecovery: this.config.dangerRecovery,
      safeApproach: progress >= this.config.safeApproachFrom,
      nextRecoveryPoints: this.nextRecoveryPoints(progress, level.targetScore),
      recentPatternMemory: this.config.recentPatternMemory,
      riderEnvelope: this.envelope,
    };
  }

  /** Points remaining until the next recovery valley (0 = inside one now). */
  private nextRecoveryPoints(progress: number, targetScore: number): number | null {
    if (progress >= this.config.safeApproachFrom) return null;
    if (this.waveAt(progress).recovery) return 0;
    for (let p = progress + 0.002; p < this.config.safeApproachFrom; p += 0.002) {
      if (this.waveAt(p).recovery) return Math.max(0, Math.round((p - progress) * targetScore));
    }
    return null;
  }
}
