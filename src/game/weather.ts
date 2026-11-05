/**
 * Reusable, purely cosmetic weather effects: snow, rain, fog and wind.
 *
 * Weather NEVER influences rider physics — speed, friction, traction and
 * jump forces stay in riderPhysics.ts. Any future gameplay coupling must be
 * introduced through explicit, tested gameplay configurations.
 *
 * Particles live in fixed-size pools: after warm-up no objects are allocated
 * per frame, active counts are clamped to configured caps, and lowering the
 * target intensity retires particles immediately so memory stays bounded.
 */
export type WeatherKind = 'clear' | 'snow' | 'rain' | 'fog' | 'wind';

export interface WeatherEffectConfig {
  kind: WeatherKind;
  /** 0..1 — scales particle counts / band opacity. Configurable by level. */
  intensity: number;
}

interface WeatherParticle {
  x: number;
  y: number;
  /** 0 (far/small/slow) .. 1 (near/large/fast) for depth variation. */
  depth: number;
  size: number;
  phase: number;
  speed: number;
}

export interface WeatherUpdateInfo {
  delta: number;
  width: number;
  height: number;
  /** Horizontal camera movement this frame, for subtle world-anchored drift. */
  cameraDx: number;
  /** Resolved gust strength 0..1. Cosmetic only. */
  wind: number;
  lighter: boolean;
}

type ParticleKind = 'snow' | 'rain';

const TAU = Math.PI * 2;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

// Cinematic, gentle motion — deliberately slower than arcade snow.
const SNOW_FALL = 30;
const SNOW_FALL_RANGE = 42;
const SNOW_SWAY = 15;
const RAIN_FALL = 540;
const RAIN_RANGE = 260;

export class WeatherSystem {
  private readonly pools: Record<ParticleKind, WeatherParticle[]> = { snow: [], rain: [] };
  private readonly active: Record<ParticleKind, number> = { snow: 0, rain: 0 };
  private readonly targets: Record<ParticleKind, number> = { snow: 0, rain: 0 };
  private readonly caps: Record<ParticleKind, number>;
  /** Current fog density 0..1 (bands are drawn by the environment layers). */
  fog = 0;
  /** Current configured wind intensity 0..1 (gust shaping happens upstream). */
  wind = 0;
  private time = 0;

  constructor(options: { particleCap?: number } = {}) {
    const cap = Math.max(48, Math.floor(options.particleCap ?? 170));
    this.caps = { snow: cap, rain: Math.floor(cap * 0.85) };
  }

  /** Sets the target intensity for every weather kind at once. */
  configure(effects: readonly WeatherEffectConfig[]): void {
    const strongest = (kind: WeatherKind) => clamp01(
      effects.filter((effect) => effect.kind === kind).reduce((max, effect) => Math.max(max, effect.intensity), 0),
    );
    this.targets.snow = strongest('snow');
    this.targets.rain = strongest('rain');
    this.fog = strongest('fog');
    this.wind = strongest('wind');
  }

  intensity(kind: WeatherKind): number {
    if (kind === 'fog') return this.fog;
    if (kind === 'wind') return this.wind;
    if (kind === 'snow') return this.targets.snow;
    if (kind === 'rain') return this.targets.rain;
    return 1 - Math.max(this.fog, Math.max(this.targets.snow, this.targets.rain));
  }

  activeParticles(kind: ParticleKind): number {
    return this.active[kind];
  }

  /** Total allocated particles — constant after warm-up, proving pool reuse. */
  poolSize(kind: ParticleKind): number {
    return this.pools[kind].length;
  }

  update(info: WeatherUpdateInfo): void {
    this.time += info.delta;
    const quality = info.lighter ? 0.55 : 1;
    this.reconcile('snow', Math.floor(this.caps.snow * quality * this.targets.snow), info);
    this.reconcile('rain', Math.floor(this.caps.rain * quality * this.targets.rain), info);
    this.integrate('snow', info);
    this.integrate('rain', info);
  }

  private reconcile(kind: ParticleKind, target: number, info: WeatherUpdateInfo): void {
    const pool = this.pools[kind];
    while (this.active[kind] < target && this.active[kind] < this.caps[kind]) {
      if (this.active[kind] === pool.length) {
        if (pool.length >= this.caps[kind]) break;
        pool.push(this.create(kind, info));
      } else {
        this.reset(pool[this.active[kind]], kind, info);
      }
      this.active[kind] += 1;
    }
    if (this.active[kind] > target) this.active[kind] = target;
  }

  private create(kind: ParticleKind, info: WeatherUpdateInfo): WeatherParticle {
    const particle: WeatherParticle = { x: 0, y: 0, depth: 0, size: 1, phase: 0, speed: 1 };
    this.reset(particle, kind, info);
    return particle;
  }

  private reset(particle: WeatherParticle, kind: ParticleKind, info: WeatherUpdateInfo): void {
    particle.x = Math.random() * info.width;
    particle.y = -20 - Math.random() * info.height * 0.6;
    particle.depth = Math.random();
    particle.phase = Math.random() * TAU;
    particle.speed = 0.7 + Math.random() * 0.6;
    particle.size = kind === 'snow' ? 0.7 + Math.random() * 1.8 : 0.8 + particle.depth * 0.5;
  }

  private integrate(kind: ParticleKind, info: WeatherUpdateInfo): void {
    const pool = this.pools[kind];
    for (let index = 0; index < this.active[kind]; index += 1) {
      const particle = pool[index];
      if (kind === 'snow') {
        particle.y += (SNOW_FALL + particle.depth * SNOW_FALL_RANGE + info.wind * 24) * particle.speed * info.delta;
        particle.x += (Math.sin(particle.phase + this.time * (0.4 + particle.depth * 0.8)) * SNOW_SWAY * (0.35 + particle.depth)
          + info.wind * 52 * (0.3 + particle.depth)) * info.delta
          - info.cameraDx * 0.05 * particle.depth;
      } else {
        particle.y += (RAIN_FALL + particle.depth * RAIN_RANGE) * info.delta;
        particle.x += info.wind * 130 * info.delta - info.cameraDx * 0.06;
      }
      if (particle.y > info.height + 26) {
        particle.y -= info.height + 52;
        particle.x = Math.random() * info.width;
      }
      if (particle.y < -52) particle.y += info.height + 52;
      if (particle.x < -34) particle.x += info.width + 68;
      else if (particle.x > info.width + 34) particle.x -= info.width + 68;
    }
  }

  drawSnow(context: CanvasRenderingContext2D, night: number): void {
    const count = this.active.snow;
    if (!count) return;
    context.save();
    context.fillStyle = '#ffffff';
    for (let index = 0; index < count; index += 1) {
      const particle = this.pools.snow[index];
      context.globalAlpha = (0.28 + particle.depth * 0.42) * (0.8 + night * 0.2);
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size * (0.55 + particle.depth * 0.75), 0, TAU);
      context.fill();
    }
    context.restore();
  }

  drawRain(context: CanvasRenderingContext2D, wind: number): void {
    const count = this.active.rain;
    if (!count) return;
    context.save();
    context.strokeStyle = 'rgba(178, 198, 226, 0.4)';
    context.lineWidth = 1.1;
    context.beginPath();
    for (let index = 0; index < count; index += 1) {
      const particle = this.pools.rain[index];
      const length = 10 + particle.depth * 10;
      context.moveTo(particle.x, particle.y);
      context.lineTo(particle.x - wind * 34 * particle.speed, particle.y - length);
    }
    context.stroke();
    context.restore();
  }
}
