import { BICYCLE_PHYSICS, flipProgress } from './riderPhysics';
import { OBSTACLE_REGISTRY } from './obstacleRegistry';
export { BICYCLE_PHYSICS } from './riderPhysics';
import { createLevelRandom, type EnvironmentTheme, type LevelConfiguration } from './levelManager';

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
};
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export class TerrainGenerator {
  private readonly chunks = new Map<number, TerrainChunk>();
  generatedChunks = 0;

  constructor(readonly configuration: LevelConfiguration) {}

  get cachedChunks(): number { return this.chunks.size; }

  private random(index: number, salt: number): number {
    return createLevelRandom(this.configuration.terrain.variationSeed ^ Math.imul(index, 0x9e3779b9) ^ salt)();
  }

  private recovery(index: number): boolean {
    return index <= 0 || this.random(index, 0x43f12) < PROFILES[this.configuration.environment].recovery;
  }

  private anchor(index: number): number {
    if (index <= 1 || this.recovery(index) || this.recovery(index - 1)) return 0;
    const range = PROFILES[this.configuration.environment].range * this.configuration.terrain.heightScale;
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
    const pattern: TerrainPattern = recovery ? 'recovery'
      : delta > 16 ? 'downhill' : delta < -16 ? 'uphill'
      : choice < 0.38 ? 'valley' : choice < 0.84 ? 'rolling-hill' : 'ramp';
    // The quintic interpolation has max derivative 1.875; the bump is
    // conservatively bounded by 6. Their combined slope stays below the cap.
    const slopeBudget = Math.max(0, TERRAIN_MAX_SLOPE - Math.abs(delta) * 1.875 / TERRAIN_CHUNK_WIDTH);
    const desired = PROFILES[this.configuration.environment].bump
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
  return validateLanding(heightAt, takeoff, heightAt(takeoff) - 5, x + width, undefined, options);
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
  heightAt: (x: number) => number, x: number, kind: 'rock' | 'tree' | 'log', options?: TraversalOptions,
): LandingValidation {
  const { radius, height } = OBSTACLE_REGISTRY[kind].collision!;
  const takeoff = x - (kind === 'tree' ? 100 : 65);
  return validateLanding(heightAt, takeoff, heightAt(takeoff) - 5, x + radius,
    { x, radius, height }, options);
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
