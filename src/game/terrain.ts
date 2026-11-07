import { BICYCLE_PHYSICS, flipProgress } from './riderPhysics';
import { OBSTACLE_REGISTRY } from './obstacleRegistry';
export { BICYCLE_PHYSICS } from './riderPhysics';
import { createLevelRandom, type EnvironmentTheme, type LevelConfiguration, type TerrainBias } from './levelManager';

export const TERRAIN_CHUNK_WIDTH = 640;
export const TERRAIN_MAX_SLOPE = 0.34;
export type TerrainPattern = 'rolling-hill' | 'downhill' | 'uphill' | 'recovery' | 'valley' | 'ramp';
export interface TerrainChunk {
  index: number;
  pattern: TerrainPattern;
  startHeight: number;
  endHeight: number;
  bump: number;
}
export interface TerrainOrigin { level: number; x: number; offset: number }

const PROFILES: Record<EnvironmentTheme, { range: number; bump: number; recovery: number }> = {
  countryside: { range: 28, bump: 25, recovery: 0.23 },
  'snowy-mountains': { range: 38, bump: 32, recovery: 0.2 },
  'misty-mountains': { range: 33, bump: 28, recovery: 0.24 },
  'moonlit-forest': { range: 25, bump: 22, recovery: 0.28 },
  jungle: { range: 30, bump: 26, recovery: 0.24 },
};
/** Phase 9C — the neutral bias keeps levels 1–4 byte-identical to Phase 8. */
const NEUTRAL_TERRAIN_BIAS: TerrainBias = { rangeScale: 1, bumpScale: 1, recoveryScale: 1, valleyBias: 0 };
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export class TerrainGenerator {
  private readonly chunks = new Map<number, TerrainChunk>();
  generatedChunks = 0;
  /** Phase 9C — per-level statistical bias (neutral for levels 1–4). */
  private readonly bias: TerrainBias;

  constructor(readonly configuration: LevelConfiguration) {
    this.bias = configuration.profile?.terrain ?? NEUTRAL_TERRAIN_BIAS;
  }

  get cachedChunks(): number { return this.chunks.size; }

  private random(index: number, salt: number): number {
    return createLevelRandom(this.configuration.terrain.variationSeed ^ Math.imul(index, 0x9e3779b9) ^ salt)();
  }

  private recovery(index: number): boolean {
    if (index <= 0) return true;
    const base = PROFILES[this.configuration.environment].recovery * this.bias.recoveryScale;
    if (this.random(index, 0x43f12) >= clamp(base, 0.08, 0.42)) return false;
    // Phase 9E — cap flat valleys at five consecutive chunks (~3.2 km) so the
    // silhouette keeps breathing. Recovery probability itself is untouched;
    // only statistically excessive streaks are trimmed.
    for (let back = 1; back <= 5; back += 1) {
      if (!this.recovery(index - back)) return true;
    }
    return false;
  }

  private anchor(index: number): number {
    if (index <= 1 || this.recovery(index) || this.recovery(index - 1)) return 0;
    const range = PROFILES[this.configuration.environment].range * this.configuration.terrain.heightScale * this.bias.rangeScale;
    return (this.random(index, 0xabc37) * 2 - 1) * range;
  }

  chunk(index: number): TerrainChunk {
    const cached = this.chunks.get(index);
    if (cached) return cached;
    const startHeight = this.anchor(index);
    const endHeight = this.anchor(index + 1);
    const delta = endHeight - startHeight;
    const choice = this.random(index, 0x581b);
    const recovery = this.recovery(index);
    // Phase 9C — the profile's valley bias shifts the valley/rolling/ramp split
    // while every branch remains reachable.
    const valleyCut = 0.38 + this.bias.valleyBias;
    const rampCut = 0.84 - this.bias.valleyBias * 0.5;
    const pattern: TerrainPattern = recovery ? 'recovery'
      : delta > 16 ? 'downhill' : delta < -16 ? 'uphill'
      : choice < valleyCut ? 'valley' : choice < rampCut ? 'rolling-hill' : 'ramp';
    // The quintic interpolation has max derivative 1.875; the bump is
    // conservatively bounded by 6. Their combined slope stays below the cap.
    const slopeBudget = Math.max(0, TERRAIN_MAX_SLOPE - Math.abs(delta) * 1.875 / TERRAIN_CHUNK_WIDTH);
    const desired = PROFILES[this.configuration.environment].bump * this.bias.bumpScale
      * (0.65 + this.configuration.difficulty.progression * 0.35) * (0.65 + choice * 0.35);
    const amplitude = Math.min(desired, slopeBudget * TERRAIN_CHUNK_WIDTH / 6);
    const bump = recovery || pattern === 'uphill' || pattern === 'downhill' ? 0 : amplitude * (pattern === 'valley' ? 1 : -1);
    const chunk = { index, pattern, startHeight, endHeight, bump };
    this.chunks.set(index, chunk);
    this.generatedChunks += 1;
    return chunk;
  }

  heightAt(x: number): number {
    if (x <= 0) return 0;
    const index = Math.floor(x / TERRAIN_CHUNK_WIDTH);
    const t = (x - index * TERRAIN_CHUNK_WIDTH) / TERRAIN_CHUNK_WIDTH;
    const chunk = this.chunk(index);
    const bump = 64 * t ** 3 * (1 - t) ** 3;
    return chunk.startHeight + (chunk.endHeight - chunk.startHeight) * smooth(t) + chunk.bump * bump;
  }

  /** Phase 5A diagnostics: the chunk index and pattern at a position. */
  describe(x: number): { index: number; pattern: TerrainPattern } {
    const index = Math.max(0, Math.floor(x / TERRAIN_CHUNK_WIDTH));
    return { index, pattern: this.chunk(index).pattern };
  }

  /**
   * Phase 5 difficulty input: 0..1 roughness of the terrain across a window.
   * Recovery chunks are near zero; working chunks blend slope and bump
   * amplitude against the environment's profile bounds. Deterministic and
   * viewport-independent (the caller picks a fixed window).
   */
  complexity(fromX: number, toX: number): number {
    const first = Math.max(0, Math.floor(fromX / TERRAIN_CHUNK_WIDTH));
    const last = Math.max(first, Math.ceil(toX / TERRAIN_CHUNK_WIDTH) - 1);
    const profile = PROFILES[this.configuration.environment];
    let total = 0;
    let count = 0;
    for (let index = first; index <= last; index += 1) {
      const chunk = this.chunk(index);
      if (chunk.pattern === 'recovery') total += 0.05;
      else {
        const slope = Math.min(1, Math.abs(chunk.endHeight - chunk.startHeight) / Math.max(1, profile.range));
        const roughness = Math.min(1, Math.abs(chunk.bump) / Math.max(1, profile.bump));
        total += 0.3 + 0.35 * slope + 0.35 * roughness;
      }
      count += 1;
    }
    return count ? total / count : 0;
  }

  maintain(left: number, right: number): void {
    const first = Math.max(0, Math.floor(left / TERRAIN_CHUNK_WIDTH) - 1);
    const last = Math.max(first, Math.ceil(right / TERRAIN_CHUNK_WIDTH) + 1);
    for (const index of this.chunks.keys()) if (index < first || index > last) this.chunks.delete(index);
    for (let index = first; index <= last; index += 1) this.chunk(index);
  }
}

export class TerrainWorld {
  private readonly generators = new Map<number, TerrainGenerator>();
  constructor(
    readonly origins: TerrainOrigin[],
    private readonly configuration: (level: number) => LevelConfiguration,
  ) {}

  private generator(origin: TerrainOrigin): TerrainGenerator {
    let generator = this.generators.get(origin.level);
    if (!generator) {
      generator = new TerrainGenerator(this.configuration(origin.level));
      this.generators.set(origin.level, generator);
    }
    return generator;
  }

  heightAt(x: number): number {
    let origin = this.origins[0];
    for (let index = this.origins.length - 1; index >= 0; index -= 1) {
      if (x >= this.origins[index].x) { origin = this.origins[index]; break; }
    }
    return origin.offset + this.generator(origin).heightAt(x - origin.x);
  }

  /** Terrain complexity across a window, delegated to the owning generator. */
  complexity(fromX: number, toX: number): number {
    let origin = this.origins[0];
    for (let index = this.origins.length - 1; index >= 0; index -= 1) {
      if (fromX >= this.origins[index].x) { origin = this.origins[index]; break; }
    }
    return this.generator(origin).complexity(fromX - origin.x, toX - origin.x);
  }

  /** Phase 5A diagnostics: the terrain chunk and pattern under a position. */
  describe(x: number): { level: number; index: number; pattern: TerrainPattern } | undefined {
    let origin = this.origins[0];
    for (let index = this.origins.length - 1; index >= 0; index -= 1) {
      if (x >= this.origins[index].x) { origin = this.origins[index]; break; }
    }
    const chunk = this.generator(origin).describe(x - origin.x);
    return { level: origin.level, index: chunk.index, pattern: chunk.pattern };
  }

  maintain(cameraX: number, width: number): void {
    const left = cameraX - width - 640;
    const right = cameraX + width * 2 + 1000;
    const active = new Set<number>();
    for (let index = 0; index < this.origins.length; index += 1) {
      const origin = this.origins[index];
      const end = this.origins[index + 1]?.x ?? Infinity;
      if (end < left || origin.x > right) continue;
      active.add(origin.level);
      this.generator(origin).maintain(Math.max(left, origin.x) - origin.x, Math.min(right, end) - origin.x);
    }
    for (const level of this.generators.keys()) if (!active.has(level)) this.generators.delete(level);
  }

  get cachedChunks(): number {
    let count = 0;
    for (const generator of this.generators.values()) count += generator.cachedChunks;
    return count;
  }
}

export interface TraversalOptions {
  speeds?: readonly number[];
  modes?: readonly ('tap' | 'hold')[];
  timingMargin?: number;
}
export interface LandingValidation {
  safe: boolean;
  clearUntil: number;
  reason?: string;
  takeoff?: { start: number; end: number };
  landing?: { start: number; end: number };
}

function validateLanding(
  heightAt: (x: number) => number, start: number, y: number, mustClear: number,
  obstacle?: { x: number; radius: number; height: number },
  options: TraversalOptions = {},
): LandingValidation {
  let clearUntil = start;
  let firstLanding = Infinity;
  let lastLanding = -Infinity;
  const fail = (reason: string): LandingValidation => ({ safe: false, clearUntil: start, reason });
  const speeds = [...new Set(options.speeds ?? [BICYCLE_PHYSICS.minSpeed, 300, BICYCLE_PHYSICS.maxSpeed])];
  if (!speeds.length || speeds.some(speed => !Number.isFinite(speed) || speed < BICYCLE_PHYSICS.minSpeed || speed > BICYCLE_PHYSICS.maxSpeed)) {
    return fail('Invalid speed envelope');
  }
  const modes = options.modes ?? ['tap'];
  if (!modes.length) return fail('No traversal mode');
  const margin = Math.max(0, options.timingMargin ?? 0);
  const offsets = margin > 0 ? [-margin, 0, margin] : [0];
  for (const initialSpeed of speeds) {
    for (const mode of modes) {
      for (const offset of offsets) {
        let x = start + offset;
        let riderY = y + heightAt(x) - heightAt(start);
        let speed = initialSpeed;
        let vy = -(BICYCLE_PHYSICS.jumpVelocity + Math.min(BICYCLE_PHYSICS.maxJumpBoost, speed * BICYCLE_PHYSICS.jumpSpeedFactor));
        let rotation = Math.atan2(heightAt(x + 8) - heightAt(x - 8), 16);
        let spin = 0;
        let angularVelocity = 0;
        let flipTime: number | undefined;
        let landed = false;
        let crossed = false;
        const delta = 1 / 120;
        for (let frame = 0; frame < 300; frame += 1) {
          const beforeX = x;
          const beforeY = riderY;
          x += speed * delta;
          speed = Math.min(BICYCLE_PHYSICS.maxSpeed, speed + BICYCLE_PHYSICS.airborneAcceleration * delta);
          vy += BICYCLE_PHYSICS.gravity * delta;
          riderY += vy * delta;
          const surfaceAngle = Math.atan2(heightAt(x + 8) - heightAt(x - 8), 16);
          const previousSpin = spin;
          if (mode === 'hold' && (frame + 1) * delta >= BICYCLE_PHYSICS.flipHoldSeconds) flipTime ??= 0;
          if (flipTime !== undefined && spin < Math.PI * 2) {
            flipTime += delta;
            spin = Math.PI * 2 * flipProgress(flipTime);
          }
          angularVelocity = -(spin - previousSpin) / delta;
          const neutralAngle = rotation + previousSpin;
          const angleDifference = Math.atan2(Math.sin(surfaceAngle - neutralAngle), Math.cos(surfaceAngle - neutralAngle));
          rotation = neutralAngle + angleDifference * (1 - Math.exp(-7.5 * delta)) - spin;

          if (obstacle && Math.abs(x - obstacle.x) < obstacle.radius + BICYCLE_PHYSICS.collisionPadding
            && riderY + BICYCLE_PHYSICS.collisionBottom > heightAt(obstacle.x) - obstacle.height + BICYCLE_PHYSICS.collisionInset) {
            return fail('Rider intersects obstacle during jump');
          }
          if (!crossed && x >= mustClear) {
            const t = clamp((mustClear - beforeX) / (x - beforeX), 0, 1);
            const crossingY = beforeY + (riderY - beforeY) * t;
            if (crossingY > heightAt(mustClear) - 17) return fail('Insufficient far-edge clearance');
            crossed = true;
          }
          if (vy > 0 && riderY >= heightAt(x) - BICYCLE_PHYSICS.groundOffset) {
            if (x < mustClear + 24) return fail('Landing occurs before the recovery area');
            const error = Math.abs(Math.atan2(Math.sin(rotation - surfaceAngle), Math.cos(rotation - surfaceAngle)));
            if (Math.abs(Math.tan(surfaceAngle)) > 0.27 || vy > 900
              || error > BICYCLE_PHYSICS.landingAngleLimit || Math.abs(angularVelocity) > BICYCLE_PHYSICS.landingSpinLimit) {
              return fail('Unsafe landing angle, spin or impact speed');
            }
            if (mode === 'hold' && spin < Math.PI * 2) return fail('Held flip cannot finish before landing');
            firstLanding = Math.min(firstLanding, x);
            lastLanding = Math.max(lastLanding, x);
            clearUntil = Math.max(clearUntil, x + 135);
            landed = true;
            break;
          }
        }
        if (!landed || !crossed) return fail('No reachable landing within the physics horizon');
      }
    }
  }
  return {
    safe: true, clearUntil,
    takeoff: { start: start - margin, end: start + margin },
    landing: { start: firstLanding, end: lastLanding + 50 },
  };
}

export function validateGap(heightAt: (x: number) => number, x: number, width: number, options?: TraversalOptions): LandingValidation {
  if (!Number.isFinite(width) || width < 50 || width > 170) return { safe: false, clearUntil: x, reason: 'Gap width outside validated limits' };
  const takeoff = x - 55;
  const approachSlope = Math.abs((heightAt(x) - heightAt(takeoff)) / 55);
  if (approachSlope > 0.18) return { safe: false, clearUntil: x, reason: 'Takeoff slope too steep' };
  const airborne = validateGapAgainstCrestLaunch(heightAt, x, width);
  if (!airborne.safe) return airborne;
  return validateLanding(heightAt, takeoff, heightAt(takeoff) - 5, x + width, undefined, options);
}

/**
 * Phase 11 — crest-launch guard. `validateLanding` simulates a grounded
 * takeoff at the lip; it cannot see a rider who crested a hill further back
 * and is already airborne with no way to jump again. This guard simulates
 * the two worst-case airborne approaches at top speed — a natural terrain
 * launch off the highest crest in the approach window, and a hold jump from
 * that same crest — and rejects the gap when either arc would come down
 * inside it. Pure validation: rejected placements are retried elsewhere with
 * the reason recorded, exactly like every other feasibility rule.
 */
export function validateGapAgainstCrestLaunch(
  heightAt: (x: number) => number, x: number, width: number,
): LandingValidation {
  const fail = (reason: string): LandingValidation => ({ safe: false, clearUntil: x, reason });
  // Highest crest in the approach window (beyond one full hold-jump range).
  const windowStart = x - 780;
  let crestX = -1;
  let crestY = -Infinity;
  for (let sample = windowStart; sample <= x - 60; sample += 20) {
    const y = heightAt(sample);
    if (y > crestY) { crestY = y; crestX = sample; }
  }
  if (crestX < 0) return { safe: true, clearUntil: x };
  // Only terrain that falls away behind the crest launches a rider.
  const dropPastCrest = crestY - heightAt(Math.min(crestX + 90, x - 20));
  if (dropPastCrest < 26) return { safe: true, clearUntil: x };
  const slopeAfterCrest = (heightAt(Math.min(crestX + 40, x - 20)) - crestY) / 40;
  const farEdge = x + width;
  const nearLipY = heightAt(x);
  for (const mode of ['coast', 'hold'] as const) {
    const speed = BICYCLE_PHYSICS.maxSpeed;
    let px = crestX;
    let py = crestY - BICYCLE_PHYSICS.groundOffset;
    let vy = Math.max(0, slopeAfterCrest * speed)
      - (mode === 'hold'
        ? BICYCLE_PHYSICS.jumpVelocity + Math.min(BICYCLE_PHYSICS.maxJumpBoost, speed * BICYCLE_PHYSICS.jumpSpeedFactor)
        : 0);
    const delta = 1 / 120;
    let reachedGapAirborne = false;
    for (let frame = 0; frame < 480; frame += 1) {
      px += speed * delta;
      vy += BICYCLE_PHYSICS.gravity * delta;
      py += vy * delta;
      if (px >= x) { reachedGapAirborne = true; break; }
      if (py >= heightAt(px) - BICYCLE_PHYSICS.groundOffset) break; // grounded again: the ground rules apply
    }
    if (!reachedGapAirborne) continue;
    // Airborne across the span: the arc must stay above the near lip and
    // clear the far lip with a readable margin.
    while (px < farEdge) {
      px += speed * delta;
      vy += BICYCLE_PHYSICS.gravity * delta;
      py += vy * delta;
      if (py >= nearLipY - BICYCLE_PHYSICS.groundOffset) {
        return fail('Crest-launch trajectory descends into the gap');
      }
    }
    if (py > heightAt(farEdge) - BICYCLE_PHYSICS.groundOffset - 20) {
      return fail('Crest-launch trajectory cannot clear the far lip');
    }
  }
  return { safe: true, clearUntil: x };
}

export function validateRamp(heightAt: (x: number) => number, x: number, options?: TraversalOptions): LandingValidation {
  const end = x + 100;
  const slope = (heightAt(end) - 38 - heightAt(x)) / 100;
  if (Math.abs(slope) > 0.45) return { safe: false, clearUntil: x, reason: 'Ramp approach too steep' };
  return validateLanding(heightAt, end, heightAt(end) - 43, end, undefined, { ...options, timingMargin: 0 });
}

export function validateBridge(heightAt: (x: number) => number, x: number, width: number): boolean {
  return Number.isFinite(width) && width > 0 && Math.abs((heightAt(x + width) - heightAt(x)) / width) <= TERRAIN_MAX_SLOPE;
}

export function validateObstacle(
  heightAt: (x: number) => number, x: number, kind: 'rock' | 'tree' | 'log' | 'root' | 'fence', options?: TraversalOptions,
): LandingValidation {
  const { radius, height } = OBSTACLE_REGISTRY[kind].collision!;
  const takeoff = x - (kind === 'tree' ? 100 : kind === 'fence' ? 85 : kind === 'root' ? 58 : 65);
  return validateLanding(heightAt, takeoff, heightAt(takeoff) - 5, x + radius,
    { x, radius, height }, options);
}

/**
 * Ground-level environmental patches (ice): the rider crosses on the ground, so
 * no jump is simulated. The patch demands gentle, step-free terrain so the
 * reduced-traction physics stays controllable at every point of the crossing.
 */
export function validateIcePatch(
  heightAt: (x: number) => number, x: number, width: number,
): LandingValidation {
  if (!Number.isFinite(width) || width < 90 || width > 280) {
    return { safe: false, clearUntil: x, reason: 'Ice patch width outside validated limits' };
  }
  for (let sample = x; sample <= x + width; sample += 35) {
    const slope = Math.abs((heightAt(Math.min(sample + 35, x + width)) - heightAt(sample)) / 35);
    if (slope > 0.16) return { safe: false, clearUntil: x, reason: 'Ice patch terrain too steep for reduced traction' };
  }
  if (Math.abs(heightAt(x + width) - heightAt(x)) / width > 0.1) {
    return { safe: false, clearUntil: x, reason: 'Ice patch drifts across elevation bands' };
  }
  return {
    safe: true,
    clearUntil: x + width + 100,
    takeoff: { start: x - 30, end: x },
    landing: { start: x + width, end: x + width + 70 },
  };
}

/**
 * Overhead falling hazards (icicles, branches): the rider passes underneath on
 * the ground. Validation only demands a readable, rideable corridor through the
 * fall zone — no forced jumps, no steep steps while the player watches the cycle.
 */
export function validateFallingHazard(
  heightAt: (x: number) => number, x: number,
): LandingValidation {
  for (let sample = x - 90; sample <= x + 90; sample += 30) {
    const slope = Math.abs((heightAt(sample + 30) - heightAt(sample)) / 30);
    if (slope > 0.2) return { safe: false, clearUntil: x, reason: 'Falling-hazard corridor too steep to read' };
  }
  return {
    safe: true,
    clearUntil: x + 90,
    takeoff: { start: x - 60, end: x - 20 },
    landing: { start: x + 30, end: x + 80 },
  };
}

/**
 * Rolling ground hazards (snowballs): like the swinging log, the validation
 * covers the full patrol corridor — one jump clears the ball wherever it is.
 */
export function validateSnowball(
  heightAt: (x: number) => number, x: number, options?: TraversalOptions,
): LandingValidation {
  // Patrol amplitude 48 + downhill bias 16 + ball radius 17 = 81px corridor —
  // the same proven profile as the swinging log, clearable in one jump at
  // minimum speed wherever the patrol has carried the ball.
  return validateLanding(heightAt, x - 160, heightAt(x - 160) - 5, x + 81,
    { x, radius: 81, height: 30 }, options);
}

export function validateRampGap(
  heightAt: (x: number) => number, rampX: number, gapX: number, width: number, options?: TraversalOptions,
): LandingValidation {
  const ramp = validateRamp(heightAt, rampX, options);
  if (!ramp.safe) return ramp;
  if (gapX < rampX + 120 || width < 50 || width > 120) {
    return { safe: false, clearUntil: rampX, reason: 'Gap does not fit the ramp launch corridor' };
  }
  const end = rampX + 100;
  return validateLanding(heightAt, end, heightAt(end) - 43, gapX + width, undefined, { ...options, timingMargin: 0 });
}

export function validateSwingingLog(
  heightAt: (x: number) => number, x: number, options?: TraversalOptions,
): LandingValidation {
  // Covers every swing phase, rotation, and local ground-height difference.
  return validateLanding(heightAt, x - 160, heightAt(x - 160) - 5, x + 58,
    { x, radius: 58, height: 90 }, options);
}
