/**
 * Phase 4 — dynamic environment and weather system.
 *
 * The EnvironmentManager owns everything visual that distinguishes a level's
 * world: sky palettes and lighting, parallax layers, clouds, fog, weather,
 * ground decorations and ambient particles (fireflies, pollen). The engine
 * delegates drawing to it; gameplay code (terrain shape, obstacle planning,
 * collisions, rider physics) never reads from it, so environments can only
 * change how the game looks, never how it plays.
 *
 * All placement is deterministic: decorations are generated from the level
 * seed in fixed-size chunks that are cached and culled, and palettes are pure
 * functions of the level's theme and a slow day-phase. Level changes blend
 * smoothly (numeric parameter interpolation + colour mixing), so backgrounds
 * cross-fade without gaps, flicker or pops.
 */
import { createLevelRandom, generateLevel, type EnvironmentTheme, type LevelConfiguration, type ObstacleCategory } from './levelManager';
import type { EventEnvironmentBias } from './events';
import { WeatherSystem, type WeatherEffectConfig, type WeatherKind } from './weather';

// ───────────────────────── shared types ─────────────────────────

export interface Palette {
  top: string;
  horizon: string;
  far: string;
  middle: string;
  near: string;
  snow: string;
  snowShade: string;
  glow: string;
  moon: string;
  night: number;
}

export type DecorationKind =
  | 'grass' | 'flower' | 'bush' | 'snowy-bush'
  | 'pine' | 'snowy-pine' | 'silhouette-pine'
  | 'drift' | 'stone' | 'mossy-rock' | 'fern' | 'reed' | 'glow-shroom';

export interface Decoration {
  x: number;
  kind: DecorationKind;
  scale: number;
  flip: boolean;
  phase: number;
  tint: number;
}

export interface ParallaxLayerStyle {
  /** 0..1 fraction of camera movement applied to this layer. */
  parallax: number;
  /** Ridge baseline as a fraction of canvas height. */
  baseY: number;
  /** Ridge amplitude as a fraction of canvas height. */
  amplitude: number;
  /** 0 = smooth rolling hills, 1 = jagged peaks. */
  roughness: number;
  /** 0..1 white highlight strength on ridges. */
  snowcap: number;
  /** 0..1 density of silhouette trees along the ridge. */
  treeline: number;
  color: string;
}

export interface AmbientStyle {
  count: number;
  color: string;
  glow: number;
  sizeMin: number;
  sizeMax: number;
  hoverMin: number;
  hoverMax: number;
  flickerMin: number;
  flickerMax: number;
  drift: number;
  /** Particles only appear once night falls (fireflies). */
  nightOnly?: boolean;
  /** Particles fade out as night falls (pollen). */
  dayOnly?: boolean;
}

/**
 * Phase 9B — per-environment ground *appearance*. Purely cosmetic: the engine
 * still samples the very same collision surface; these styles only decorate
 * the crest line that physics already rides on.
 */
export interface GroundStyle {
  kind: 'grass' | 'snow' | 'rocky' | 'forest';
  /** 0..1 density of crest detail (blades / sparkles / pebbles / roots). */
  detail: number;
  /** Accent colour drawn along the surface crest. */
  crest: string;
  /** Secondary speckle colour for dots and strokes. */
  speckle: string;
}

export interface EnvironmentDefinition {
  id: EnvironmentTheme;
  /** Cyclic day-phase stops; the first and last values match for a seamless wrap. */
  stops: ReadonlyArray<{ at: number; palette: Palette }>;
  layers: readonly [ParallaxLayerStyle, ParallaxLayerStyle, ParallaxLayerStyle, ParallaxLayerStyle];
  fogColor: string;
  /** Extra fog veil applied over each parallax layer (far → near). */
  fogVeil: readonly [number, number, number, number];
  weather: readonly WeatherEffectConfig[];
  clouds: { count: number; opacity: number; speed: number; tint: string };
  sun: number;
  moon: number;
  stars: number;
  shootingStars: boolean;
  flock: boolean;
  decorations: { entries: ReadonlyArray<{ kind: DecorationKind; weight: number }>; spacing: number };
  decorationColors: { foliage: string; foliageDark: string; accent: string; stone: string };
  ambient: AmbientStyle | null;
  /** Phase 9B — cosmetic ground appearance (never touches collision). */
  ground: GroundStyle;
  /** Phase 9B — 0..1 strength of drifting mist hugging the terrain crest. */
  groundMist: number;
  /** Phase 9B — 0..1 strength of soft light shafts filtering through. */
  lightShafts: number;
  /** Wheel spray / landing burst tuning — colours only, never physics. */
  spray: { color: string; rate: number; size: number };
  burst: { heavy: string; soft: string };
}

export interface EnvironmentView {
  width: number;
  height: number;
  cameraX: number;
  cameraY: number;
  clock: number;
  phase: number;
  riderX: number;
  isMenu: boolean;
  lighter: boolean;
  groundAt: (x: number) => number;
}

export interface EnvironmentUpdateInfo {
  width: number;
  height: number;
  cameraX: number;
  cameraDx: number;
  storm: number;
  lighter: boolean;
  groundAt?: (x: number) => number;
  /** Current day-cycle phase 0..1 (drives night-only ambience). */
  phase?: number;
  /** Resolved night factor 0..1 for this frame (defaults to phase lookup). */
  night?: number;
  /**
   * Phase 9D — live special-event bias (weather, wind, mist, light warmth,
   * ambient density, leaf tint), already scaled by the event envelope.
   * Null when no event is running.
   */
  event?: EventEnvironmentBias | null;
}

export const PARALLAX_LAYER_COUNT = 4;
export const DECORATION_CHUNK_WIDTH = 260;
const AMBIENT_CAP = 24;
const TAU = Math.PI * 2;

// ───────────────────────── small helpers ─────────────────────────

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (t: number) => t * t * (3 - 2 * t);

function hash(value: number): number {
  const n = Math.sin(value * 127.1 + 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function parseColor(color: string): [number, number, number] {
  if (color.startsWith('#')) {
    return [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16)];
  }
  const channels = color.match(/[\d.]+/g);
  return channels ? [Number(channels[0]), Number(channels[1]), Number(channels[2])] : [255, 255, 255];
}

export function mixColor(a: string, b: string, amount: number): string {
  const first = parseColor(a);
  const second = parseColor(b);
  return `rgb(${Math.round(lerp(first[0], second[0], amount))}, ${Math.round(lerp(first[1], second[1], amount))}, ${Math.round(lerp(first[2], second[2], amount))})`;
}

export function alphaColor(color: string, alpha: number): string {
  const [r, g, b] = parseColor(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function paletteFor(def: EnvironmentDefinition, phase: number): Palette {
  const value = ((phase % 1) + 1) % 1;
  const stops = def.stops;
  let left = stops[0];
  let right = stops[stops.length - 1];
  for (let index = 0; index < stops.length - 1; index += 1) {
    if (value >= stops[index].at && value <= stops[index + 1].at) {
      left = stops[index];
      right = stops[index + 1];
      break;
    }
  }
  const mix = (value - left.at) / (right.at - left.at || 1);
  const a = left.palette;
  const b = right.palette;
  return {
    top: mixColor(a.top, b.top, mix),
    horizon: mixColor(a.horizon, b.horizon, mix),
    far: mixColor(a.far, b.far, mix),
    middle: mixColor(a.middle, b.middle, mix),
    near: mixColor(a.near, b.near, mix),
    snow: mixColor(a.snow, b.snow, mix),
    snowShade: mixColor(a.snowShade, b.snowShade, mix),
    glow: mixColor(a.glow, b.glow, mix),
    moon: mixColor(a.moon, b.moon, mix),
    night: lerp(a.night, b.night, mix),
  };
}

function mixPalette(a: Palette, b: Palette, amount: number): Palette {
  return {
    top: mixColor(a.top, b.top, amount),
    horizon: mixColor(a.horizon, b.horizon, amount),
    far: mixColor(a.far, b.far, amount),
    middle: mixColor(a.middle, b.middle, amount),
    near: mixColor(a.near, b.near, amount),
    snow: mixColor(a.snow, b.snow, amount),
    snowShade: mixColor(a.snowShade, b.snowShade, amount),
    glow: mixColor(a.glow, b.glow, amount),
    moon: mixColor(a.moon, b.moon, amount),
    night: lerp(a.night, b.night, amount),
  };
}

// ───────────────────────── gameplay-footprint filter ─────────────────────────

export interface GameplayFootprint {
  kind: string;
  x: number;
  width?: number;
}

/**
 * Pure predicate used by the engine to keep decorations away from gameplay
 * objects. Decorations are never collidable — this only guards legibility.
 */
export function decorationOverlapsGameplay(
  x: number,
  halfWidth: number,
  objects: readonly GameplayFootprint[],
  houses: readonly { x: number }[] = [],
  spawnClearUntil = 420,
): boolean {
  if (x < spawnClearUntil + halfWidth) return true;
  for (const object of objects) {
    let footprint = 60;
    if (object.kind === 'coin' || object.kind === 'magnet' || object.kind === 'shield' || object.kind === 'double') footprint = 30;
    else if (object.kind === 'gap') footprint = (object.width ?? 0) + 55;
    else if (object.kind === 'ramp') footprint = 145;
    if (Math.abs(x - object.x) < footprint + halfWidth) return true;
  }
  for (const house of houses) {
    if (Math.abs(x - house.x) < 340 + halfWidth) return true;
  }
  return false;
}

// ───────────────────────── deterministic decoration fields ─────────────────────────

/**
 * Seeded, chunked decoration placement. The same level seed always produces
 * the same decorations; chunks outside the active window are dropped from the
 * cache so memory stays bounded on endless runs.
 */
export class DecorationField {
  private readonly chunks = new Map<number, Decoration[]>();
  private readonly cumulative: ReadonlyArray<{ kind: DecorationKind; threshold: number }>;
  generatedDecorations = 0;

  constructor(
    private readonly seed: number,
    entries: ReadonlyArray<{ kind: DecorationKind; weight: number }>,
    private readonly spacing: number,
    private readonly originX: number,
  ) {
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0) || 1;
    let accumulated = 0;
    this.cumulative = entries.map((entry) => {
      accumulated += entry.weight / total;
      return { kind: entry.kind, threshold: accumulated };
    });
  }

  private pick(value: number): DecorationKind {
    for (const entry of this.cumulative) {
      if (value < entry.threshold) return entry.kind;
    }
    return this.cumulative[this.cumulative.length - 1].kind;
  }

  private chunk(index: number): Decoration[] {
    const cached = this.chunks.get(index);
    if (cached) return cached;
    const random = createLevelRandom((this.seed ^ Math.imul(index, 0x9e3779b9) ^ 0xdec0a1) >>> 0);
    const start = index * DECORATION_CHUNK_WIDTH;
    const density = DECORATION_CHUNK_WIDTH / Math.max(24, this.spacing);
    const count = Math.floor(density * (0.7 + random() * 0.6));
    const decorations: Decoration[] = [];
    for (let index2 = 0; index2 < count; index2 += 1) {
      const x = start + random() * DECORATION_CHUNK_WIDTH;
      if (x < this.originX) continue;
      decorations.push({
        x,
        kind: this.pick(random()),
        scale: 0.75 + random() * 0.55,
        flip: random() < 0.5,
        phase: random() * TAU,
        tint: random(),
      });
    }
    this.chunks.set(index, decorations);
    this.generatedDecorations += decorations.length;
    return decorations;
  }

  /** Generates the active window and prunes chunks that fell behind. */
  maintain(cameraX: number, width: number): void {
    const first = Math.floor((cameraX - width) / DECORATION_CHUNK_WIDTH) - 1;
    const last = Math.floor((cameraX + width * 2) / DECORATION_CHUNK_WIDTH) + 1;
    for (const index of this.chunks.keys()) {
      if (index < first || index > last) this.chunks.delete(index);
    }
    for (let index = Math.max(0, first); index <= last; index += 1) this.chunk(index);
  }

  forEachVisible(cameraX: number, width: number, visit: (decoration: Decoration) => void): void {
    const first = Math.max(0, Math.floor((cameraX - 90) / DECORATION_CHUNK_WIDTH));
    const last = Math.floor((cameraX + width + 90) / DECORATION_CHUNK_WIDTH);
    for (let index = first; index <= last; index += 1) {
      for (const decoration of this.chunk(index)) visit(decoration);
    }
  }

  /** Test/diagnostic accessor — deterministic sample of a horizontal range. */
  sample(fromX: number, toX: number): Decoration[] {
    const result: Decoration[] = [];
    const first = Math.max(0, Math.floor(fromX / DECORATION_CHUNK_WIDTH));
    const last = Math.floor(toX / DECORATION_CHUNK_WIDTH);
    for (let index = first; index <= last; index += 1) result.push(...this.chunk(index));
    return result;
  }

  get cachedChunks(): number {
    return this.chunks.size;
  }
}

// ───────────────────────── environment definitions ─────────────────────────

const COUNTRYSIDE: EnvironmentDefinition = {
  id: 'countryside',
  // Phase 9B — a full day: dawn meadow, bright afternoon, golden sunset and
  // a soft summer night, wrapping seamlessly back to dawn.
  stops: [
    {
      at: 0,
      palette: { top: '#7fb0d8', horizon: '#ffd9e0', far: '#9cb2cd', middle: '#7aa582', near: '#64916c', snow: '#9cc880', snowShade: '#6aab60', glow: '#ffd9b0', moon: '#fff2df', night: 0.18 },
    },
    {
      at: 0.38,
      palette: { top: '#6fb9e7', horizon: '#eef7e2', far: '#a4c1d4', middle: '#82ab86', near: '#689570', snow: '#98cd7c', snowShade: '#66a75f', glow: '#fff4cf', moon: '#fff6df', night: 0 },
    },
    {
      at: 0.64,
      palette: { top: '#7d9fd0', horizon: '#ffcf96', far: '#a2b7c8', middle: '#7c9f7d', near: '#648f68', snow: '#b1cf88', snowShade: '#74a463', glow: '#ffc890', moon: '#fff0d8', night: 0.12 },
    },
    {
      at: 0.82,
      palette: { top: '#2c3f68', horizon: '#6a5c8e', far: '#55688c', middle: '#46607a', near: '#3a5464', snow: '#6d9470', snowShade: '#46704c', glow: '#c8b98f', moon: '#fff4dc', night: 0.55 },
    },
    {
      at: 0.9,
      palette: { top: '#1c2c52', horizon: '#43466f', far: '#3c4f74', middle: '#31475e', near: '#294052', snow: '#5c8462', snowShade: '#3a6142', glow: '#b9c6a8', moon: '#fdf6e3', night: 0.66 },
    },
    {
      at: 0.965,
      palette: { top: '#709cc4', horizon: '#e3c3cf', far: '#8ea3c0', middle: '#6f977d', near: '#5b8568', snow: '#92be7c', snowShade: '#63a05c', glow: '#f5d6af', moon: '#fff2df', night: 0.25 },
    },
    {
      at: 1,
      palette: { top: '#7fb0d8', horizon: '#ffd9e0', far: '#9cb2cd', middle: '#7aa582', near: '#64916c', snow: '#9cc880', snowShade: '#6aab60', glow: '#ffd9b0', moon: '#fff2df', night: 0.18 },
    },
  ],
  layers: [
    { parallax: 0.05, baseY: 0.42, amplitude: 0.17, roughness: 0.8, snowcap: 0.1, treeline: 0, color: '#9db8cd' },
    { parallax: 0.12, baseY: 0.55, amplitude: 0.11, roughness: 0.35, snowcap: 0, treeline: 0.05, color: '#7ba381' },
    { parallax: 0.24, baseY: 0.66, amplitude: 0.075, roughness: 0.15, snowcap: 0, treeline: 0.3, color: '#63906a' },
    { parallax: 0.38, baseY: 0.75, amplitude: 0.05, roughness: 0.08, snowcap: 0, treeline: 0.45, color: '#57855f' },
  ],
  fogColor: '#e9f0e2',
  fogVeil: [0.12, 0.07, 0.04, 0.02],
  weather: [{ kind: 'wind', intensity: 0.22 }],
  clouds: { count: 7, opacity: 0.2, speed: 1, tint: '#fffaf0' },
  sun: 1,
  moon: 0.55,
  stars: 26,
  shootingStars: false,
  flock: true,
  decorations: {
    entries: [{ kind: 'grass', weight: 40 }, { kind: 'flower', weight: 10 }, { kind: 'bush', weight: 8 }, { kind: 'pine', weight: 5 }, { kind: 'stone', weight: 2 }],
    spacing: 74,
  },
  decorationColors: { foliage: '#4f8f52', foliageDark: '#3c7442', accent: '#f6e9b2', stone: '#98a5a8' },
  ambient: { count: 9, color: '#fff4c8', glow: 0, sizeMin: 0.8, sizeMax: 1.5, hoverMin: 14, hoverMax: 110, flickerMin: 0.05, flickerMax: 0.22, drift: 7, dayOnly: true },
  ground: { kind: 'grass', detail: 1, crest: '#dff0b8', speckle: '#577a3e' },
  groundMist: 0.06,
  lightShafts: 0,
  spray: { color: '#e7edc9', rate: 0.45, size: 0.8 },
  burst: { heavy: '#eef3da', soft: '#f2f7e2' },
};

const SNOWY: EnvironmentDefinition = {
  id: 'snowy-mountains',
  // Phase 9B — alpine day, alpenglow sunset and a crisp starry night.
  stops: [
    {
      at: 0,
      palette: { top: '#93b4d6', horizon: '#f2d8e2', far: '#c0d0e2', middle: '#d0ddec', near: '#dee9f2', snow: '#f4f8fc', snowShade: '#c6d6e4', glow: '#ffd9c4', moon: '#fff4df', night: 0.22 },
    },
    {
      at: 0.4,
      palette: { top: '#9cc6e4', horizon: '#f2f8fb', far: '#cfe0ee', middle: '#dde9f3', near: '#e9f1f8', snow: '#fbfdfe', snowShade: '#d3e2ed', glow: '#fff6da', moon: '#fff4df', night: 0 },
    },
    {
      at: 0.64,
      palette: { top: '#8fa5cf', horizon: '#f7c9a8', far: '#bfc9de', middle: '#ccd8e6', near: '#dbe4ef', snow: '#f2eff0', snowShade: '#c5cddd', glow: '#ffcf9e', moon: '#fff0d8', night: 0.2 },
    },
    {
      at: 0.82,
      palette: { top: '#22335c', horizon: '#4c5a86', far: '#6d7fa4', middle: '#8b9cb8', near: '#a3b3ca', snow: '#ccd9ec', snowShade: '#9fb2ca', glow: '#b9c8e6', moon: '#f6f4ff', night: 0.6 },
    },
    {
      at: 0.9,
      palette: { top: '#14224a', horizon: '#333f66', far: '#5d709a', middle: '#7f92b2', near: '#98a9c4', snow: '#c2d2ea', snowShade: '#93a7c4', glow: '#adbfe4', moon: '#f2f0ff', night: 0.7 },
    },
    {
      at: 0.965,
      palette: { top: '#809ec1', horizon: '#d5c1cf', far: '#b1c2d7', middle: '#c4d2e3', near: '#d4dfeb', snow: '#edf2f9', snowShade: '#becfdf', glow: '#f3d5c9', moon: '#fff0d8', night: 0.29 },
    },
    {
      at: 1,
      palette: { top: '#93b4d6', horizon: '#f2d8e2', far: '#c0d0e2', middle: '#d0ddec', near: '#dee9f2', snow: '#f4f8fc', snowShade: '#c6d6e4', glow: '#ffd9c4', moon: '#fff4df', night: 0.22 },
    },
  ],
  layers: [
    { parallax: 0.05, baseY: 0.4, amplitude: 0.2, roughness: 0.9, snowcap: 0.85, treeline: 0, color: '#c6d7e6' },
    { parallax: 0.12, baseY: 0.54, amplitude: 0.13, roughness: 0.6, snowcap: 0.6, treeline: 0.05, color: '#d6e3ef' },
    { parallax: 0.24, baseY: 0.66, amplitude: 0.085, roughness: 0.35, snowcap: 0.35, treeline: 0.25, color: '#e3edf5' },
    { parallax: 0.38, baseY: 0.75, amplitude: 0.055, roughness: 0.2, snowcap: 0.15, treeline: 0.4, color: '#eef4fa' },
  ],
  fogColor: '#eef4f8',
  fogVeil: [0.1, 0.05, 0.03, 0.02],
  weather: [{ kind: 'snow', intensity: 0.55 }, { kind: 'wind', intensity: 0.3 }],
  clouds: { count: 6, opacity: 0.22, speed: 1.1, tint: '#ffffff' },
  sun: 0.9,
  moon: 0.85,
  stars: 64,
  shootingStars: true,
  flock: false,
  decorations: {
    entries: [{ kind: 'snowy-pine', weight: 16 }, { kind: 'snowy-bush', weight: 8 }, { kind: 'drift', weight: 13 }, { kind: 'stone', weight: 3 }],
    spacing: 105,
  },
  decorationColors: { foliage: '#3f6f5a', foliageDark: '#2f5747', accent: '#f4f9fc', stone: '#8fa2b0' },
  ambient: null,
  ground: { kind: 'snow', detail: 0.9, crest: '#ffffff', speckle: '#dcebf7' },
  groundMist: 0.1,
  lightShafts: 0,
  spray: { color: '#f4fbff', rate: 1, size: 1 },
  burst: { heavy: '#eaf6f8', soft: '#f4fbfc' },
};

const MISTY: EnvironmentDefinition = {
  id: 'misty-mountains',
  // Phase 9B — soft veiled morning, hazy golden afternoon, moonlit mist at night.
  stops: [
    {
      at: 0,
      palette: { top: '#9fb3c2', horizon: '#e8ddda', far: '#c4ccc8', middle: '#b4c1ba', near: '#a5b4a8', snow: '#c6d0c1', snowShade: '#98a894', glow: '#f0e8d8', moon: '#f6f4e8', night: 0.2 },
    },
    {
      at: 0.5,
      palette: { top: '#b7c9d4', horizon: '#eef1ea', far: '#cdd5cd', middle: '#bdc9c1', near: '#aebcaa', snow: '#cdd7c9', snowShade: '#a0b09c', glow: '#f6f3e6', moon: '#f6f4e8', night: 0.1 },
    },
    {
      at: 0.64,
      palette: { top: '#a0aebd', horizon: '#e0cdb2', far: '#c2c8c2', middle: '#b2bfb6', near: '#a3b2a4', snow: '#c2ccc0', snowShade: '#94a48f', glow: '#e8d4ae', moon: '#f2f0e4', night: 0.22 },
    },
    {
      at: 0.82,
      palette: { top: '#35435e', horizon: '#5c6478', far: '#79848c', middle: '#8b968f', near: '#7c887e', snow: '#9fac9c', snowShade: '#6f7f6c', glow: '#b4bcc4', moon: '#eef2e8', night: 0.52 },
    },
    {
      at: 0.9,
      palette: { top: '#242f4a', horizon: '#414a60', far: '#6a747c', middle: '#7d8780', near: '#6e7a70', snow: '#909c8e', snowShade: '#64736a', glow: '#a8b0be', moon: '#eaeef0', night: 0.6 },
    },
    {
      at: 0.965,
      palette: { top: '#8d9fb0', horizon: '#cfc7c8', far: '#b6bfbd', middle: '#acb8b1', near: '#9daba0', snow: '#bec8b9', snowShade: '#90a08e', glow: '#ddd2c0', moon: '#f4f2e8', night: 0.26 },
    },
    {
      at: 1,
      palette: { top: '#9fb3c2', horizon: '#e8ddda', far: '#c4ccc8', middle: '#b4c1ba', near: '#a5b4a8', snow: '#c6d0c1', snowShade: '#98a894', glow: '#f0e8d8', moon: '#f6f4e8', night: 0.2 },
    },
  ],
  layers: [
    { parallax: 0.05, baseY: 0.43, amplitude: 0.16, roughness: 0.7, snowcap: 0, treeline: 0.1, color: '#c6cfc9' },
    { parallax: 0.12, baseY: 0.55, amplitude: 0.11, roughness: 0.45, snowcap: 0, treeline: 0.3, color: '#b6c3bb' },
    { parallax: 0.24, baseY: 0.66, amplitude: 0.075, roughness: 0.3, snowcap: 0, treeline: 0.45, color: '#a7b6aa' },
    { parallax: 0.38, baseY: 0.75, amplitude: 0.05, roughness: 0.2, snowcap: 0, treeline: 0.55, color: '#99a89b' },
  ],
  fogColor: '#e7ede6',
  fogVeil: [0.85, 0.6, 0.38, 0.2],
  weather: [{ kind: 'fog', intensity: 0.55 }, { kind: 'wind', intensity: 0.14 }],
  clouds: { count: 5, opacity: 0.12, speed: 0.6, tint: '#eef2ec' },
  sun: 0.45,
  moon: 0.4,
  stars: 14,
  shootingStars: false,
  flock: true,
  decorations: {
    entries: [{ kind: 'fern', weight: 15 }, { kind: 'reed', weight: 9 }, { kind: 'silhouette-pine', weight: 11 }, { kind: 'mossy-rock', weight: 6 }],
    spacing: 98,
  },
  decorationColors: { foliage: '#6c8574', foliageDark: '#57705f', accent: '#cfd8c6', stone: '#8d9a92' },
  ambient: { count: 8, color: '#e8eee4', glow: 0, sizeMin: 1, sizeMax: 1.8, hoverMin: 10, hoverMax: 90, flickerMin: 0.08, flickerMax: 0.25, drift: 9 },
  ground: { kind: 'rocky', detail: 0.8, crest: '#cfd8c6', speckle: '#6c7a70' },
  groundMist: 0.42,
  lightShafts: 0.22,
  spray: { color: '#e6eee7', rate: 0.55, size: 0.85 },
  burst: { heavy: '#e7eee9', soft: '#eff5ef' },
};

const MOONLIT: EnvironmentDefinition = {
  id: 'moonlit-forest',
  // Phase 9B — the forest now follows the full day cycle: a moody blue-green
  // daytime, violet dusk, its signature deep-indigo night (fireflies, moon
  // and shooting stars) and a muted pre-dawn. Identity is carried by the
  // blue-green hues and dense silhouettes, not by freezing the clock.
  stops: [
    {
      at: 0,
      palette: { top: '#46538c', horizon: '#8a6f96', far: '#46518a', middle: '#35406e', near: '#2a3454', snow: '#8b95b8', snowShade: '#5d6890', glow: '#cdb8d8', moon: '#f2f0ff', night: 0.5 },
    },
    {
      at: 0.38,
      palette: { top: '#4f86a6', horizon: '#b8c9a2', far: '#4d7a72', middle: '#3c5e5a', near: '#2f4744', snow: '#6f9a8c', snowShade: '#4c7268', glow: '#d8e4c0', moon: '#fff6ec', night: 0.3 },
    },
    {
      at: 0.64,
      palette: { top: '#454a86', horizon: '#a2768e', far: '#3d4478', middle: '#2d3560', near: '#232a48', snow: '#8390b4', snowShade: '#56628c', glow: '#d0a2b0', moon: '#f4f2ff', night: 0.5 },
    },
    {
      at: 0.82,
      palette: { top: '#101640', horizon: '#45407e', far: '#232a58', middle: '#1b2248', near: '#151a3a', snow: '#b8c4e8', snowShade: '#8290c0', glow: '#c0ccf6', moon: '#f2f0ff', night: 0.82 },
    },
    {
      at: 0.9,
      palette: { top: '#060a28', horizon: '#3a3572', far: '#1d2452', middle: '#181f45', near: '#131837', snow: '#c6cfee', snowShade: '#8d99c8', glow: '#b9c6f2', moon: '#f2f0ff', night: 0.92 },
    },
    {
      at: 0.965,
      palette: { top: '#3c487d', horizon: '#7e6691', far: '#404a82', middle: '#313b68', near: '#273050', snow: '#949ec0', snowShade: '#646f98', glow: '#cabadc', moon: '#f2f0ff', night: 0.56 },
    },
    {
      at: 1,
      palette: { top: '#46538c', horizon: '#8a6f96', far: '#46518a', middle: '#35406e', near: '#2a3454', snow: '#8b95b8', snowShade: '#5d6890', glow: '#cdb8d8', moon: '#f2f0ff', night: 0.5 },
    },
  ],
  layers: [
    { parallax: 0.05, baseY: 0.42, amplitude: 0.17, roughness: 0.75, snowcap: 0, treeline: 0.5, color: '#1d2452' },
    { parallax: 0.12, baseY: 0.55, amplitude: 0.11, roughness: 0.5, snowcap: 0, treeline: 0.7, color: '#181f45' },
    { parallax: 0.24, baseY: 0.66, amplitude: 0.075, roughness: 0.35, snowcap: 0, treeline: 0.85, color: '#131837' },
    { parallax: 0.38, baseY: 0.75, amplitude: 0.05, roughness: 0.25, snowcap: 0, treeline: 1, color: '#0e122a' },
  ],
  fogColor: '#252c52',
  fogVeil: [0.3, 0.18, 0.1, 0.05],
  weather: [{ kind: 'wind', intensity: 0.2 }, { kind: 'fog', intensity: 0.12 }],
  clouds: { count: 4, opacity: 0.14, speed: 0.8, tint: '#2a3155' },
  sun: 0.85,
  moon: 1,
  stars: 84,
  shootingStars: true,
  flock: false,
  decorations: {
    entries: [{ kind: 'silhouette-pine', weight: 20 }, { kind: 'glow-shroom', weight: 7 }, { kind: 'stone', weight: 4 }],
    spacing: 92,
  },
  decorationColors: { foliage: '#1b2440', foliageDark: '#141b31', accent: '#9fb4ff', stone: '#39415e' },
  ambient: { count: 15, color: '#d8f2a0', glow: 9, sizeMin: 1.2, sizeMax: 2.4, hoverMin: 26, hoverMax: 130, flickerMin: 0.12, flickerMax: 0.95, drift: 15, nightOnly: true },
  ground: { kind: 'forest', detail: 0.9, crest: '#9aa8cc', speckle: '#2c3560' },
  groundMist: 0.5,
  lightShafts: 0.55,
  spray: { color: '#ccd8f7', rate: 0.6, size: 0.85 },
  burst: { heavy: '#dee6ff', soft: '#e6ecff' },
};

export const ENVIRONMENTS: Readonly<Record<EnvironmentTheme, EnvironmentDefinition>> = {
  countryside: COUNTRYSIDE,
  'snowy-mountains': SNOWY,
  'misty-mountains': MISTY,
  'moonlit-forest': MOONLIT,
};

/** Folds the level's own weather block into the environment's effects. */
function foldLevelWeather(effects: readonly WeatherEffectConfig[], level: LevelConfiguration): WeatherEffectConfig[] {
  return effects.map((effect) => {
    const related = (level.weather.kind === 'snow' && effect.kind === 'snow')
      || (level.weather.kind === 'mist' && effect.kind === 'fog');
    return related
      ? { kind: effect.kind, intensity: clamp01(effect.intensity * (0.55 + level.weather.intensity * 0.9)) }
      : { kind: effect.kind, intensity: effect.intensity };
  });
}

interface ActiveEnvironment {
  level: LevelConfiguration;
  def: EnvironmentDefinition;
  weather: WeatherEffectConfig[];
  field: DecorationField;
}

interface AmbientParticle {
  x: number;
  y: number;
  hover: number;
  phase: number;
  size: number;
}

const EMPTY_AMBIENT: AmbientStyle = { count: 0, color: '#ffffff', glow: 0, sizeMin: 1, sizeMax: 1, hoverMin: 20, hoverMax: 60, flickerMin: 0.1, flickerMax: 0.4, drift: 8 };

// ───────────────────────── the manager ─────────────────────────

export class EnvironmentManager {
  private from: ActiveEnvironment;
  private to: ActiveEnvironment | null = null;
  private blend = 1;
  private blendSeconds = 1;

  private readonly weather = new WeatherSystem();
  private readonly resolvedLayers: ParallaxLayerStyle[] = [];
  private readonly resolvedVeil: [number, number, number, number] = [0, 0, 0, 0];
  private resolvedClouds = { count: 0, opacity: 0, speed: 0, tint: '#ffffff' };
  private resolvedLight = { sun: 0, moon: 0, stars: 0, shootingStars: false, flock: false };
  private resolvedWeather: WeatherEffectConfig[] = [];
  private resolvedAmbient: AmbientStyle = { ...EMPTY_AMBIENT };
  private resolvedColors = { fog: '#ffffff', foliage: '#4f8f52', foliageDark: '#3c7442', accent: '#f6e9b2', stone: '#98a5a8', ambient: '#ffffff' };
  /** Phase 10C — reusable scratch for the per-frame shaded decoration set. */
  private shadedDecorationColors: { foliage: string; foliageDark: string; accent: string; stone: string } = {
    foliage: '', foliageDark: '', accent: '', stone: '',
  };
  private resolvedSpray = { color: '#ffffff', rate: 0.5, size: 1 };
  private resolvedBurst = { heavy: '#ffffff', soft: '#ffffff' };

  private readonly ambientPool: AmbientParticle[] = [];
  private ambientActive = 0;
  private windValue = 0;
  private time = 0;
  private shootingStar?: { start: number; x: number; y: number; direction: number };
  private morningFlock?: { start: number; y: number; count: number; direction: number };
  /** Phase 9B dev preview override for weather; null restores level config. */
  private weatherPreview: WeatherEffectConfig[] | null = null;

  private readonly resolvedGround: GroundStyle = { kind: 'grass', detail: 1, crest: '#ffffff', speckle: '#ffffff' };
  private resolvedGroundMist = 0;
  private resolvedLightShafts = 0;
  /** Phase 9D — live event bias (null when no special event is running). */
  private event: EventEnvironmentBias | null = null;

  constructor(options: { particleCap?: number } = {}) {
    this.weather = new WeatherSystem(options);
    this.from = this.createActive(generateLevel(1, 1), 0);
    this.resolve();
  }

  /** Instantly switches the active environment (menu, run start, restore). */
  setLevel(level: LevelConfiguration): void {
    if (this.from.level.number === level.number && !this.to) {
      this.resolve();
      return;
    }
    this.from = this.createActive(level, 0);
    this.to = null;
    this.blend = 1;
    this.resolve();
  }

  /**
   * Begins a smooth cross-fade to another level's environment over `seconds`.
   * `originX` is where the new environment's decorations may start appearing.
   */
  transitionTo(level: LevelConfiguration, seconds: number, originX = 0): void {
    if (this.to?.level.number === level.number) return;
    if (level.number === this.from.level.number) {
      if (this.to) {
        this.to = null;
        this.blend = 1;
        this.resolve();
      }
      return;
    }
    this.to = this.createActive(level, originX);
    this.blendSeconds = Math.max(0.001, seconds);
    this.blend = 0;
    this.resolve();
  }

  private createActive(level: LevelConfiguration, originX: number): ActiveEnvironment {
    const def = ENVIRONMENTS[level.environment];
    return {
      level,
      def,
      weather: foldLevelWeather(def.weather, level),
      field: new DecorationField(level.seed, def.decorations.entries, def.decorations.spacing, originX),
    };
  }

  update(delta: number, info: EnvironmentUpdateInfo): void {
    this.time += delta;
    if (this.to) {
      this.blend = Math.min(1, this.blend + delta / this.blendSeconds);
      if (this.blend >= 1) {
        this.from = this.to;
        this.to = null;
      }
      this.resolve();
    }
    // Phase 9D — the active special event nudges weather, wind and ambience.
    // Everything is numeric bias on the resolved configuration, so the change
    // is gradual (the engine pre-scales it by the event envelope) and
    // automatically fades back when the event ends.
    this.event = info.event ?? null;
    this.weather.configure(this.event ? this.eventWeather() : this.resolvedWeather);
    this.windValue = clamp01(this.computeWind(info.storm) + (this.event?.wind ?? 0));
    this.weather.update({
      delta,
      width: info.width,
      height: info.height,
      cameraDx: info.cameraDx,
      wind: this.windValue,
      lighter: info.lighter,
    });
    const night = info.night ?? paletteFor(this.from.def, info.phase ?? 0).night;
    this.updateAmbient(delta, info, night);
    this.from.field.maintain(info.cameraX, info.width);
    this.to?.field.maintain(info.cameraX, info.width);
  }

  /** Resolved weather with the event bias folded in (visibility kept sane). */
  private eventWeather(): WeatherEffectConfig[] {
    const bias = this.event!;
    return this.resolvedWeather.map((effect) => {
      let intensity = effect.intensity;
      if (effect.kind === 'snow') intensity = clamp01(intensity + bias.snow);
      else if (effect.kind === 'fog') intensity = Math.min(0.68, Math.max(0, intensity + bias.fog));
      else if (effect.kind === 'wind') intensity = clamp01(intensity + bias.wind);
      return { kind: effect.kind, intensity };
    });
  }

  /** Cosmetic gust strength: configured wind shaped by smooth noise + storms. */
  private computeWind(storm: number): number {
    const gust = 0.5 + 0.5 * Math.sin(this.time * 0.6) * 0.6 + Math.sin(this.time * 1.7 + 1.3) * 0.25 + Math.sin(this.time * 0.23 + 4) * 0.15;
    return clamp01(this.weather.wind * (0.35 + 0.65 * clamp01(gust)) + storm * 0.55);
  }

  private updateAmbient(delta: number, info: EnvironmentUpdateInfo, night: number): void {
    const style = this.resolvedAmbient;
    if (style.count <= 0) {
      this.ambientActive = 0;
      return;
    }
    // Phase 9B — fireflies wait for night, pollen fades with it. Counts are
    // shaped (never the pool) so particles are reused, not reallocated.
    let visible = style.count;
    if (style.nightOnly) visible *= smoothstep(clamp01((night - 0.42) / 0.34));
    else if (style.dayOnly) visible *= 1 - 0.8 * smoothstep(clamp01((night - 0.34) / 0.36));
    // Phase 9D — a running event (forest wind, golden hour) thickens the
    // ambient particle field within the same reused pool.
    visible *= 1 + (info.event?.ambient ?? 0);
    const target = Math.min(Math.round(visible), AMBIENT_CAP);
    if (target <= 0) {
      this.ambientActive = 0;
      return;
    }
    while (this.ambientPool.length < Math.min(style.count, AMBIENT_CAP)) {
      this.ambientPool.push({
        x: info.cameraX + Math.random() * info.width,
        y: info.height * 0.4,
        hover: lerp(style.hoverMin, style.hoverMax, Math.random()),
        phase: Math.random() * TAU,
        size: lerp(style.sizeMin, style.sizeMax, Math.random()),
      });
    }
    this.ambientActive = Math.min(target, this.ambientPool.length);
    const left = info.cameraX - 90;
    const right = info.cameraX + info.width + 90;
    for (let index = 0; index < this.ambientActive; index += 1) {
      const particle = this.ambientPool[index];
      particle.x += (Math.sin(this.time * 0.5 + particle.phase) * style.drift + style.drift * 0.4) * delta;
      const groundY = info.groundAt ? info.groundAt(particle.x) : info.height * 0.55;
      const targetY = groundY - particle.hover;
      particle.y += (targetY - particle.y) * Math.min(1, delta * 1.6) + Math.sin(this.time * 1.7 + particle.phase * 2) * 6 * delta;
      if (particle.x < left || particle.x > right) {
        particle.x = particle.x < left ? right - 12 : left + 12;
        particle.hover = lerp(style.hoverMin, style.hoverMax, Math.random());
      }
      if (particle.y > groundY - 4) particle.y = groundY - 4;
    }
  }

  /** Recomputes every blended visual parameter from `from` → `to`. */
  private resolve(): void {
    const t = this.to ? smoothstep(this.blend) : 1;
    const fromDef = this.from.def;
    const toDef = this.to?.def ?? null;
    const number = (a: number, b: number) => lerp(a, toDef ? b : a, t);
    const color = (a: string, b: string) => (toDef ? mixColor(a, b, t) : a);

    for (let index = 0; index < PARALLAX_LAYER_COUNT; index += 1) {
      const fromLayer = fromDef.layers[index];
      const toLayer = toDef?.layers[index];
      this.resolvedLayers[index] = {
        parallax: number(fromLayer.parallax, toLayer?.parallax ?? fromLayer.parallax),
        baseY: number(fromLayer.baseY, toLayer?.baseY ?? fromLayer.baseY),
        amplitude: number(fromLayer.amplitude, toLayer?.amplitude ?? fromLayer.amplitude),
        roughness: number(fromLayer.roughness, toLayer?.roughness ?? fromLayer.roughness),
        snowcap: number(fromLayer.snowcap, toLayer?.snowcap ?? fromLayer.snowcap),
        treeline: number(fromLayer.treeline, toLayer?.treeline ?? fromLayer.treeline),
        color: color(fromLayer.color, toLayer?.color ?? fromLayer.color),
      };
      this.resolvedVeil[index] = number(fromDef.fogVeil[index], toDef?.fogVeil[index] ?? fromDef.fogVeil[index]);
    }

    this.resolvedClouds = {
      count: Math.round(number(fromDef.clouds.count, toDef?.clouds.count ?? fromDef.clouds.count)),
      opacity: number(fromDef.clouds.opacity, toDef?.clouds.opacity ?? fromDef.clouds.opacity),
      speed: number(fromDef.clouds.speed, toDef?.clouds.speed ?? fromDef.clouds.speed),
      tint: color(fromDef.clouds.tint, toDef?.clouds.tint ?? fromDef.clouds.tint),
    };

    this.resolvedLight = {
      sun: number(fromDef.sun, toDef?.sun ?? fromDef.sun),
      moon: number(fromDef.moon, toDef?.moon ?? fromDef.moon),
      stars: number(fromDef.stars, toDef?.stars ?? fromDef.stars),
      shootingStars: t >= 0.5 ? (toDef ?? fromDef).shootingStars : fromDef.shootingStars,
      flock: t >= 0.5 ? (toDef ?? fromDef).flock : fromDef.flock,
    };

    const fromWeather = this.from.weather;
    const toWeather = this.to?.weather;
    const kinds = new Set<WeatherKind>([...fromWeather, ...(toWeather ?? [])].map((effect) => effect.kind));
    const intensityOf = (list: WeatherEffectConfig[], kind: WeatherKind) =>
      list.filter((effect) => effect.kind === kind).reduce((max, effect) => Math.max(max, effect.intensity), 0);
    this.resolvedWeather = this.weatherPreview
      ? this.weatherPreview.map((effect) => ({ ...effect }))
      : [...kinds].map((kind) => ({
        kind,
        intensity: lerp(intensityOf(fromWeather, kind), toWeather ? intensityOf(toWeather, kind) : intensityOf(fromWeather, kind), t),
      }));

    const fromAmbient = fromDef.ambient ?? EMPTY_AMBIENT;
    const toAmbient = toDef?.ambient ?? fromAmbient;
    this.resolvedAmbient = {
      count: number(fromAmbient.count, toAmbient.count),
      color: color(fromAmbient.color, toAmbient.color),
      glow: number(fromAmbient.glow, toAmbient.glow),
      sizeMin: number(fromAmbient.sizeMin, toAmbient.sizeMin),
      sizeMax: number(fromAmbient.sizeMax, toAmbient.sizeMax),
      hoverMin: number(fromAmbient.hoverMin, toAmbient.hoverMin),
      hoverMax: number(fromAmbient.hoverMax, toAmbient.hoverMax),
      flickerMin: number(fromAmbient.flickerMin, toAmbient.flickerMin),
      flickerMax: number(fromAmbient.flickerMax, toAmbient.flickerMax),
      drift: number(fromAmbient.drift, toAmbient.drift),
      nightOnly: t >= 0.5 ? toAmbient.nightOnly : fromAmbient.nightOnly,
      dayOnly: t >= 0.5 ? toAmbient.dayOnly : fromAmbient.dayOnly,
    };

    const fromGround = fromDef.ground;
    const toGround = toDef?.ground ?? fromGround;
    this.resolvedGround.kind = t >= 0.5 ? toGround.kind : fromGround.kind;
    this.resolvedGround.detail = number(fromGround.detail, toGround.detail);
    this.resolvedGround.crest = color(fromGround.crest, toGround.crest);
    this.resolvedGround.speckle = color(fromGround.speckle, toGround.speckle);
    this.resolvedGroundMist = number(fromDef.groundMist, toDef?.groundMist ?? fromDef.groundMist);
    this.resolvedLightShafts = number(fromDef.lightShafts, toDef?.lightShafts ?? fromDef.lightShafts);

    this.resolvedColors = {
      fog: color(fromDef.fogColor, toDef?.fogColor ?? fromDef.fogColor),
      foliage: color(fromDef.decorationColors.foliage, toDef?.decorationColors.foliage ?? fromDef.decorationColors.foliage),
      foliageDark: color(fromDef.decorationColors.foliageDark, toDef?.decorationColors.foliageDark ?? fromDef.decorationColors.foliageDark),
      accent: color(fromDef.decorationColors.accent, toDef?.decorationColors.accent ?? fromDef.decorationColors.accent),
      stone: color(fromDef.decorationColors.stone, toDef?.decorationColors.stone ?? fromDef.decorationColors.stone),
      ambient: color(fromAmbient.color, toAmbient.color),
    };
    this.resolvedSpray = {
      color: color(fromDef.spray.color, toDef?.spray.color ?? fromDef.spray.color),
      rate: number(fromDef.spray.rate, toDef?.spray.rate ?? fromDef.spray.rate),
      size: number(fromDef.spray.size, toDef?.spray.size ?? fromDef.spray.size),
    };
    this.resolvedBurst = {
      heavy: color(fromDef.burst.heavy, toDef?.burst.heavy ?? fromDef.burst.heavy),
      soft: color(fromDef.burst.soft, toDef?.burst.soft ?? fromDef.burst.soft),
    };
  }

  // ───────────────────────── introspection ─────────────────────────

  /** The environment gameplay is currently authored for (target while blending). */
  get theme(): EnvironmentTheme {
    return (this.to ?? this.from).def.id;
  }

  /** Obstacles allowed by the active level — delegated to LevelManager config. */
  get allowedObstacles(): readonly ObstacleCategory[] {
    return (this.to ?? this.from).level.allowedObstacles;
  }

  get snowIntensity(): number {
    return this.weather.intensity('snow');
  }

  get groundSpray(): { color: string; rate: number; size: number } {
    return this.resolvedSpray;
  }

  get burstColors(): { heavy: string; soft: string } {
    return this.resolvedBurst;
  }

  get windStrength(): number {
    return this.windValue;
  }

  /** Phase 9B — resolved cosmetic ground style (never affects collision). */
  get groundStyle(): GroundStyle {
    return this.resolvedGround;
  }

  /** Phase 9B — number of ambient particles currently visible (fireflies…). */
  get activeAmbientParticles(): number {
    return this.ambientActive;
  }

  /**
   * Phase 9B dev preview — pins the weather to a fixed effect list so every
   * condition can be audited regardless of level config. `null` restores the
   * level's configured weather (including any in-flight transition blend).
   */
  setWeatherPreview(effects: readonly WeatherEffectConfig[] | null): void {
    this.weatherPreview = effects ? effects.map((effect) => ({ ...effect })) : null;
    this.resolve();
  }

  palette(phase: number): Palette {
    const from = paletteFor(this.from.def, phase);
    if (!this.to) return from;
    return mixPalette(from, paletteFor(this.to.def, phase), smoothstep(this.blend));
  }

  weatherEffects(): WeatherEffectConfig[] {
    // Phase 9D — report the live weather (event bias included) so the debug
    // overlay and audits see what is actually falling.
    if (this.event) return this.eventWeather().map((effect) => ({ ...effect }));
    return this.resolvedWeather.map((effect) => ({ ...effect }));
  }

  parallaxLayers(): readonly ParallaxLayerStyle[] {
    return this.resolvedLayers;
  }

  decorationsNear(fromX: number, toX: number): Decoration[] {
    return [...this.from.field.sample(fromX, toX), ...(this.to ? this.to.field.sample(fromX, toX) : [])];
  }

  get decorationChunkCount(): number {
    return this.from.field.cachedChunks + (this.to?.field.cachedChunks ?? 0);
  }

  // ───────────────────────── sky ─────────────────────────

  drawSky(context: CanvasRenderingContext2D, view: EnvironmentView, palette: Palette): void {
    const { width, height } = view;
    // Phase 9D — golden hour warms the low sky toward amber. The runtime
    // night guard keeps the day/night clock untouched: at night the bias is
    // simply ignored (and the event itself never activates then).
    const warm = (this.event?.warmLight ?? 0) * (1 - palette.night);
    const horizon = warm > 0.01 ? mixColor(palette.horizon, '#ffb45e', warm * 0.5) : palette.horizon;
    const glow = warm > 0.01 ? mixColor(palette.glow, '#ffd9a0', warm * 0.6) : palette.glow;
    const sky = context.createLinearGradient(0, 0, 0, height * 0.72);
    sky.addColorStop(0, palette.top);
    sky.addColorStop(0.62, mixColor(palette.top, horizon, 0.54));
    sky.addColorStop(1, horizon);
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);

    const haloStrength = 0.2 * (0.4 + this.resolvedLight.sun * 0.6 + this.resolvedLight.moon * 0.5) + warm * 0.1;
    const halo = context.createRadialGradient(width * 0.72, height * 0.34, 0, width * 0.72, height * 0.34, height * 0.58);
    halo.addColorStop(0, alphaColor(glow, haloStrength));
    halo.addColorStop(1, alphaColor(glow, 0));
    context.fillStyle = halo;
    context.fillRect(0, 0, width, height * 0.8);

    if (warm > 0.01) {
      // A soft amber wash riding just above the horizon line.
      const wash = context.createLinearGradient(0, height * 0.3, 0, height * 0.72);
      wash.addColorStop(0, alphaColor('#ff9e4f', 0));
      wash.addColorStop(1, alphaColor('#ff9e4f', warm * 0.1));
      context.fillStyle = wash;
      context.fillRect(0, height * 0.3, width, height * 0.42);
    }

    const phase = view.phase;
    const sunOpacity = (1 - palette.night) * this.resolvedLight.sun;
    if (sunOpacity > 0.02) {
      const sunX = width * (0.68 + Math.sin(phase * TAU) * 0.11);
      const sunY = height * (0.27 + Math.cos(phase * TAU) * 0.075);
      context.save();
      context.globalAlpha = sunOpacity;
      const sunGlow = context.createRadialGradient(sunX, sunY, 4, sunX, sunY, height * 0.18);
      sunGlow.addColorStop(0, alphaColor(palette.glow, 0.55));
      sunGlow.addColorStop(1, alphaColor(palette.glow, 0));
      context.fillStyle = sunGlow;
      context.beginPath();
      context.arc(sunX, sunY, height * 0.18, 0, TAU);
      context.fill();
      context.fillStyle = '#fff0d3';
      context.globalAlpha = sunOpacity * 0.9;
      context.beginPath();
      context.arc(sunX, sunY, Math.max(14, height * 0.027), 0, TAU);
      context.fill();
      context.restore();
    }

    if (palette.night > 0.12 && this.resolvedLight.moon > 0.02) {
      const moonX = width * (0.77 - Math.sin(phase * TAU) * 0.09);
      const moonY = height * 0.19;
      context.save();
      context.globalAlpha = palette.night * 0.86 * this.resolvedLight.moon;
      context.shadowColor = palette.moon;
      context.shadowBlur = view.lighter ? 0 : 28;
      context.fillStyle = palette.moon;
      context.beginPath();
      context.arc(moonX, moonY, Math.max(10, height * 0.018), 0, TAU);
      context.fill();
      context.shadowBlur = 0;
      context.fillStyle = mixColor(palette.top, palette.horizon, 0.18);
      context.globalAlpha = palette.night * 0.32 * this.resolvedLight.moon;
      context.beginPath();
      context.arc(moonX - 5, moonY - 2, Math.max(9, height * 0.017), 0, TAU);
      context.fill();
      context.restore();
    }

    const starCount = Math.round(this.resolvedLight.stars * clamp01(palette.night * 1.4));
    if (starCount > 0) {
      context.save();
      for (let index = 0; index < starCount; index += 1) {
        const x = hash(index * 4.3 + 8) * width;
        const y = hash(index * 7.1 + 22) * height * 0.48;
        const twinkle = 0.35 + (Math.sin(view.clock * 1.5 + index * 2.3) + 1) * 0.25;
        context.globalAlpha = palette.night * twinkle;
        context.fillStyle = index % 7 === 0 ? '#ffe8c8' : '#e4f2f8';
        context.beginPath();
        context.arc(x, y, index % 5 === 0 ? 1.35 : 0.8, 0, TAU);
        context.fill();
      }
      context.restore();
    }

    if (this.resolvedLight.shootingStars) this.drawShootingStar(context, view, palette.night);
    if (this.resolvedLight.flock) this.drawMorningFlock(context, view, phase);
  }

  private drawShootingStar(context: CanvasRenderingContext2D, view: EnvironmentView, night: number): void {
    const { width, height, clock } = view;
    if (night < 0.58) {
      this.shootingStar = undefined;
      return;
    }
    if (!this.shootingStar || clock - this.shootingStar.start > 1.4) {
      this.shootingStar = {
        start: clock + 2 + Math.random() * 7,
        x: 0.3 + Math.random() * 0.4,
        y: 0.04 + Math.random() * 0.12,
        direction: Math.random() < 0.5 ? -1 : 1,
      };
    }
    const star = this.shootingStar;
    const progress = (clock - star.start) / 1.4;
    if (progress < 0) return;
    const travel = Math.min(width * 0.29, height * 0.55);
    const x = star.x * width + progress * travel * star.direction;
    const y = star.y * height + progress * travel * 0.4;
    const tail = Math.min(Math.max(width * 0.16, 70), 220) * Math.min(progress * 5, 1);
    const tailX = x - tail * star.direction;
    const tailY = y - tail * 0.4;
    const trail = context.createLinearGradient(tailX, tailY, x, y);
    trail.addColorStop(0, 'rgba(137, 190, 255, 0)');
    trail.addColorStop(0.65, 'rgba(160, 207, 255, 0.55)');
    trail.addColorStop(1, '#fff4dc');
    context.save();
    context.globalAlpha = night * Math.sin(progress * Math.PI);
    context.shadowColor = '#a5ceff';
    context.shadowBlur = view.lighter ? 0 : 12;
    context.strokeStyle = trail;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(tailX, tailY);
    context.lineTo(x, y);
    context.stroke();
    context.fillStyle = '#fff4dc';
    context.beginPath();
    context.arc(x, y, 2.2, 0, TAU);
    context.fill();
    context.restore();
  }

  private drawMorningFlock(context: CanvasRenderingContext2D, view: EnvironmentView, phase: number): void {
    const { width, height, clock } = view;
    if (phase < 0.12 || phase > 0.38) {
      this.morningFlock = undefined;
      return;
    }
    if (!this.morningFlock || clock - this.morningFlock.start > 9) {
      this.morningFlock = {
        start: clock + 1 + Math.random() * 6,
        y: 0.18 + Math.random() * 0.16,
        count: 3 + Math.floor(Math.random() * 4),
        direction: Math.random() < 0.5 ? -1 : 1,
      };
    }
    const flock = this.morningFlock;
    const elapsed = clock - flock.start;
    if (elapsed < 0) return;
    const lead = lerp(-20, width + 110, elapsed / 9);
    context.save();
    context.strokeStyle = '#293d51';
    context.lineWidth = 1.45;
    context.lineCap = 'round';
    context.globalAlpha = 0.7 * clamp01(Math.min((phase - 0.12) / 0.035, (0.38 - phase) / 0.035));
    for (let index = 0; index < flock.count; index += 1) {
      const spacing = lead - index * 17;
      const x = flock.direction > 0 ? spacing : width - spacing;
      const y = height * flock.y + (index % 2 ? -1 : 1) * index * 4 + Math.sin(elapsed + index) * 3;
      const wing = Math.sin(elapsed * 16 + index * 1.7) * 4;
      context.beginPath();
      context.moveTo(x - 6, y - wing);
      context.quadraticCurveTo(x - 3, y - wing - 2, x, y);
      context.quadraticCurveTo(x + 3, y - wing - 2, x + 6, y - wing);
      context.stroke();
    }
    context.restore();
  }

  // ───────────────────────── parallax background ─────────────────────────

  drawBackground(context: CanvasRenderingContext2D, view: EnvironmentView, palette: Palette): void {
    for (let index = 0; index < PARALLAX_LAYER_COUNT; index += 1) {
      this.drawParallaxLayer(context, view, this.resolvedLayers[index], index, palette);
      const veil = this.resolvedVeil[index] * this.weather.fog;
      if (veil > 0.02) this.drawFogBand(context, view, index, veil);
    }
    this.drawClouds(context, view, palette);
    if (Math.min(1, this.resolvedLightShafts + (this.event?.shafts ?? 0)) > 0.02 && !view.lighter) this.drawLightShafts(context, view, palette);
    if (this.weather.fog > 0.03) this.drawHorizonHaze(context, view);
  }

  /**
   * Phase 9B — soft light filtering between trees: a few slow-drifting
   * translucent beams. Sun-driven by day, moon-lit at night; disabled on the
   * lighter graphics tier.
   */
  private drawLightShafts(context: CanvasRenderingContext2D, view: EnvironmentView, palette: Palette): void {
    const lit = Math.max((1 - palette.night) * this.resolvedLight.sun, palette.night * this.resolvedLight.moon * 0.6);
    // Phase 9D — golden hour / forest wind add extra shafts through the haze.
    const strength = Math.min(1, this.resolvedLightShafts + (this.event?.shafts ?? 0)) * lit;
    if (strength <= 0.02) return;
    const { width, height, clock } = view;
    context.save();
    for (let index = 0; index < 3; index += 1) {
      const anchor = 0.16 + index * 0.27 + Math.sin(clock * 0.045 + index * 2.1) * 0.05;
      const beamWidth = width * (0.05 + hash(index * 9.13 + 5) * 0.05);
      const alpha = strength * (0.05 + hash(index * 3.7 + 11) * 0.05);
      const gradient = context.createLinearGradient(0, 0, 0, height * 0.72);
      gradient.addColorStop(0, alphaColor(palette.glow, alpha));
      gradient.addColorStop(0.65, alphaColor(palette.glow, alpha * 0.45));
      gradient.addColorStop(1, alphaColor(palette.glow, 0));
      context.save();
      context.translate(width * anchor, 0);
      context.rotate(0.14 + index * 0.05);
      context.fillStyle = gradient;
      context.fillRect(-beamWidth * 0.5, -height * 0.1, beamWidth, height * 0.85);
      context.restore();
    }
    context.restore();
  }

  private drawParallaxLayer(
    context: CanvasRenderingContext2D,
    view: EnvironmentView,
    layer: ParallaxLayerStyle,
    layerIndex: number,
    palette: Palette,
  ): void {
    const { width, height, cameraX } = view;
    const step = 150;
    const offset = cameraX * layer.parallax;
    const first = Math.floor(offset / step) - 1;
    const last = Math.ceil((offset + width) / step) + 1;
    const baseY = height * layer.baseY;
    const amplitude = height * layer.amplitude;
    const seed = 4 + layerIndex * 15;

    let fill = mixColor(layer.color, palette.top, palette.night * 0.3);
    // Phase 10A — aerial perspective: the farthest ridges haze toward the
    // horizon tone even under clear skies, so the near terrain separates
    // crisply from the distance (depth without new draw passes).
    const aerial = Math.max(0, 0.38 - layer.parallax) * 0.5;
    fill = mixColor(fill, palette.horizon, aerial);
    fill = mixColor(fill, this.resolvedColors.fog, this.resolvedVeil[layerIndex] * this.weather.fog);

    context.beginPath();
    context.moveTo(first * step - offset, height + 20);
    for (let index = first; index <= last; index += 1) {
      const ridge = 0.2 + hash(index * 3.71 + seed) * 0.8;
      const shoulder = 0.25 + hash(index * 8.11 + seed + 7) * 0.5;
      const centerX = index * step - offset;
      const peakY = baseY - amplitude * ridge;
      const leftY = baseY - amplitude * ridge * (0.5 - layer.roughness * 0.42);
      const rightY = baseY - amplitude * (0.2 + hash(index + seed + 4) * 0.55) * (1 - layer.roughness * 0.45);
      context.lineTo(centerX - step * shoulder, leftY);
      context.lineTo(centerX, peakY);
      context.lineTo(centerX + step * (1 - shoulder), rightY);
    }
    context.lineTo((last + 1) * step - offset, height + 20);
    context.closePath();
    context.fillStyle = fill;
    context.fill();

    context.beginPath();
    for (let index = first; index <= last; index += 1) {
      const ridge = 0.2 + hash(index * 3.71 + seed) * 0.8;
      const shoulder = 0.25 + hash(index * 8.11 + seed + 7) * 0.5;
      const centerX = index * step - offset;
      const peakY = baseY - amplitude * ridge;
      const leftY = baseY - amplitude * ridge * (0.5 - layer.roughness * 0.42);
      const rightY = baseY - amplitude * (0.2 + hash(index + seed + 4) * 0.55) * (1 - layer.roughness * 0.45);
      if (index === first) context.moveTo(centerX - step * shoulder, leftY);
      context.lineTo(centerX, peakY);
      context.lineTo(centerX + step * (1 - shoulder), rightY);
    }
    context.strokeStyle = `rgba(255,255,255,${0.1 + palette.night * 0.04 + layer.snowcap * 0.5})`;
    context.lineWidth = 1.1 + layer.snowcap * 1.2;
    context.stroke();

    if (layer.treeline > 0.02) this.drawTreeline(context, view, layer, seed, fill, baseY, amplitude, offset, first, last);
  }

  private drawTreeline(
    context: CanvasRenderingContext2D,
    view: EnvironmentView,
    layer: ParallaxLayerStyle,
    seed: number,
    fill: string,
    baseY: number,
    amplitude: number,
    offset: number,
    first: number,
    last: number,
  ): void {
    const step = 150;
    const sway = Math.sin(view.clock * 0.9 + seed) * this.windValue * 2.4;
    context.save();
    context.globalAlpha = clamp01(layer.treeline);
    context.fillStyle = mixColor(fill, '#0a0f1e', 0.32);
    const scale = Math.min(1.5, Math.max(0.7, amplitude / (view.height * 0.14)));
    for (let index = first; index <= last; index += 1) {
      const ridge = 0.2 + hash(index * 3.71 + seed) * 0.8;
      const baseLineY = baseY - amplitude * ridge * 0.42;
      const x = index * step - offset + (hash(index * 5.3 + seed) - 0.5) * 70 + sway;
      const treeHeight = (12 + hash(index * 6.1 + seed + 2) * 16) * scale;
      this.drawRidgeTree(context, x, baseLineY, treeHeight);
      if (layer.treeline > 0.55 && hash(index * 9.7 + seed + 5) < layer.treeline - 0.35) {
        this.drawRidgeTree(context, x + 46 + hash(index * 3.9 + seed) * 30, baseLineY + 4, treeHeight * 0.78);
      }
    }
    context.restore();
  }

  private drawRidgeTree(context: CanvasRenderingContext2D, x: number, y: number, height: number): void {
    context.beginPath();
    context.moveTo(x, y - height);
    context.lineTo(x + height * 0.42, y);
    context.lineTo(x - height * 0.42, y);
    context.closePath();
    context.fill();
    context.beginPath();
    context.moveTo(x, y - height * 1.35);
    context.lineTo(x + height * 0.3, y - height * 0.4);
    context.lineTo(x - height * 0.3, y - height * 0.4);
    context.closePath();
    context.fill();
  }

  private drawFogBand(context: CanvasRenderingContext2D, view: EnvironmentView, bandIndex: number, alpha: number): void {
    const { width, height, clock } = view;
    const layer = this.resolvedLayers[bandIndex];
    const y = height * layer.baseY - height * layer.amplitude * 0.35;
    const color = this.resolvedColors.fog;
    const top = y - height * 0.09;
    const gradient = context.createLinearGradient(0, top, 0, y + height * 0.1);
    gradient.addColorStop(0, alphaColor(color, 0));
    gradient.addColorStop(0.5, alphaColor(color, alpha * 0.5));
    gradient.addColorStop(1, alphaColor(color, 0));
    context.fillStyle = gradient;
    context.fillRect(0, top, width, height * 0.19);

    const speed = (8 + bandIndex * 5) * (1 + this.windValue * 1.3);
    context.fillStyle = alphaColor(color, alpha * 0.28);
    for (let index = 0; index < 2; index += 1) {
      const span = width * 1.6;
      const drift = (clock * (speed + index * 4) + hash(bandIndex * 7.3 + index) * 4000) % span;
      const x = ((drift % span) + span) % span - width * 0.3;
      context.beginPath();
      context.ellipse(x, y + Math.sin(clock * 0.4 + index * 2 + bandIndex) * 6, width * 0.33, height * 0.035 + index * 5, 0, 0, TAU);
      context.fill();
    }
  }

  private drawHorizonHaze(context: CanvasRenderingContext2D, view: EnvironmentView): void {
    const gradient = context.createLinearGradient(0, 0, 0, view.height * 0.62);
    gradient.addColorStop(0, alphaColor(this.resolvedColors.fog, this.weather.fog * 0.34));
    gradient.addColorStop(1, alphaColor(this.resolvedColors.fog, 0));
    context.fillStyle = gradient;
    context.fillRect(0, 0, view.width, view.height * 0.62);
  }

  private drawClouds(context: CanvasRenderingContext2D, view: EnvironmentView, palette: Palette): void {
    const { count, opacity, speed, tint } = this.resolvedClouds;
    if (count <= 0 || opacity <= 0.01) return;
    const { width, height, clock, cameraX } = view;
    context.save();
    // Phase 9B — clouds shade with the day cycle instead of staying bright.
    context.fillStyle = mixColor(mixColor(tint, palette.glow, 0.32), palette.top, palette.night * 0.5);
    context.globalAlpha = opacity * (1 - palette.night * 0.35);
    for (let index = 0; index < count; index += 1) {
      const span = width + 280;
      const drift = clock * (7 + (index % 3) * 3) * speed * (1 + this.windValue * 1.4) + cameraX * 0.035;
      const x = ((index * 247 + 30 - drift) % span + span) % span - 120;
      const y = height * (0.14 + hash(index * 13) * 0.22);
      const scale = 0.55 + hash(index * 17 + 2) * 0.85;
      context.save();
      context.translate(x, y);
      context.scale(scale, scale * 0.54);
      context.beginPath();
      context.ellipse(0, 0, 48, 12, 0, 0, TAU);
      context.ellipse(-24, -6, 20, 12, 0, 0, TAU);
      context.ellipse(0, -11, 24, 17, 0, 0, TAU);
      context.ellipse(26, -4, 20, 12, 0, 0, TAU);
      context.fill();
      context.restore();
    }
    context.restore();
  }

  // ───────────────────────── ground decorations ─────────────────────────

  drawDecorations(
    context: CanvasRenderingContext2D,
    view: EnvironmentView,
    reserved: (x: number, halfWidth: number) => boolean,
    palette: Palette,
  ): void {
    const fromAlpha = this.to ? 1 - this.blend : 1;
    this.drawDecorationField(context, view, this.from.field, fromAlpha, reserved, palette);
    if (this.to) this.drawDecorationField(context, view, this.to.field, this.blend, reserved, palette);
  }

  private drawDecorationField(
    context: CanvasRenderingContext2D,
    view: EnvironmentView,
    field: DecorationField,
    alpha: number,
    reserved: (x: number, halfWidth: number) => boolean,
    palette: Palette,
  ): void {
    if (alpha <= 0.01) return;
    // Phase 9B — vegetation now shades with the day cycle (accents keep their
    // luminescence so glow-shrooms and flowers still read at night).
    // Phase 10C — the colour set mutates one persistent object instead of
    // allocating a fresh one per field per frame.
    const base = this.resolvedColors;
    const shade = palette.night * 0.5;
    const colors = this.shadedDecorationColors;
    colors.foliage = mixColor(base.foliage, palette.near, shade);
    colors.foliageDark = mixColor(base.foliageDark, palette.near, shade);
    colors.accent = base.accent;
    colors.stone = mixColor(base.stone, palette.near, shade);
    field.forEachVisible(view.cameraX, view.width, (decoration) => {
      const halfWidth = DECORATION_HALF_WIDTH[decoration.kind] * decoration.scale;
      if (reserved(decoration.x, halfWidth)) return;
      const x = decoration.x - view.cameraX;
      if (x < -90 || x > view.width + 90) return;
      const groundY = view.groundAt(decoration.x);
      const sway = Math.sin(view.clock * 1.5 + decoration.phase) * (0.05 + this.windValue * 0.09);
      context.save();
      context.translate(x, groundY + 1);
      context.rotate(sway * 0.35);
      context.scale(decoration.scale * (decoration.flip ? -1 : 1), decoration.scale);
      context.globalAlpha = alpha;
      this.drawDecorationArt(context, decoration, sway, view, colors);
      context.restore();
    });
  }

  private drawDecorationArt(
    context: CanvasRenderingContext2D,
    decoration: Decoration,
    sway: number,
    view: EnvironmentView,
    colors: { foliage: string; foliageDark: string; accent: string; stone: string },
  ): void {
    switch (decoration.kind) {
      case 'grass': {
        context.strokeStyle = colors.foliageDark;
        context.lineWidth = 1.5;
        context.lineCap = 'round';
        context.beginPath();
        for (let blade = -2; blade <= 2; blade += 1) {
          const lean = blade * 2.4 + sway * 10;
          context.moveTo(blade * 2.4, 0);
          context.quadraticCurveTo(blade * 2.4 + lean * 0.35, -6, blade * 2.4 + lean, -10 - (2 - Math.abs(blade)) * 2);
        }
        context.stroke();
        break;
      }
      case 'flower': {
        const petal = ['#ffffff', '#ffd9e8', '#ffe9a8'][Math.floor(decoration.tint * 3) % 3];
        context.strokeStyle = colors.foliageDark;
        context.lineWidth = 1.2;
        context.beginPath();
        context.moveTo(0, 0);
        context.quadraticCurveTo(sway * 4, -6, sway * 7, -11);
        context.stroke();
        context.fillStyle = petal;
        for (let petalIndex = 0; petalIndex < 5; petalIndex += 1) {
          const angle = (petalIndex / 5) * TAU + decoration.tint * TAU;
          context.beginPath();
          context.arc(sway * 7 + Math.cos(angle) * 2.6, -11 + Math.sin(angle) * 2.6, 1.7, 0, TAU);
          context.fill();
        }
        context.fillStyle = colors.accent;
        context.beginPath();
        context.arc(sway * 7, -11, 1.4, 0, TAU);
        context.fill();
        break;
      }
      case 'bush':
      case 'snowy-bush': {
        context.fillStyle = colors.foliage;
        for (const [cx, cy, radius] of [[-6, -4, 6], [1, -7, 7], [8, -4, 5.5]] as const) {
          context.beginPath();
          context.arc(cx, cy, radius, 0, TAU);
          context.fill();
        }
        if (decoration.kind === 'snowy-bush') {
          context.strokeStyle = colors.accent;
          context.lineWidth = 2.5;
          context.lineCap = 'round';
          context.beginPath();
          context.arc(1, -8, 6.5, Math.PI * 1.05, Math.PI * 1.95);
          context.stroke();
        }
        break;
      }
      case 'pine':
      case 'snowy-pine': {
        context.fillStyle = colors.foliageDark;
        context.fillRect(-1.6, -8, 3.2, 8);
        const tiers = [
          { y: -7, w: 12, h: 12 },
          { y: -16, w: 9.5, h: 11 },
          { y: -24, w: 7, h: 10 },
        ];
        for (const tier of tiers) {
          context.fillStyle = colors.foliage;
          context.beginPath();
          context.moveTo(0, tier.y - tier.h);
          context.lineTo(tier.w, tier.y + 3);
          context.lineTo(-tier.w, tier.y + 3);
          context.closePath();
          context.fill();
          if (decoration.kind === 'snowy-pine') {
            context.strokeStyle = colors.accent;
            context.lineWidth = 2;
            context.lineCap = 'round';
            context.beginPath();
            context.moveTo(-tier.w * 0.55, tier.y - tier.h * 0.45);
            context.quadraticCurveTo(0, tier.y - tier.h * 0.95, tier.w * 0.55, tier.y - tier.h * 0.4);
            context.stroke();
          }
        }
        break;
      }
      case 'silhouette-pine': {
        context.fillStyle = colors.foliage;
        context.beginPath();
        context.moveTo(0, -34);
        context.lineTo(9, -12);
        context.lineTo(-9, -12);
        context.closePath();
        context.fill();
        context.beginPath();
        context.moveTo(0, -26);
        context.lineTo(12, 0);
        context.lineTo(-12, 0);
        context.closePath();
        context.fill();
        break;
      }
      case 'drift': {
        context.fillStyle = mixColor(colors.accent, '#ffffff', 0.35);
        context.beginPath();
        context.ellipse(0, -2, 22, 7, 0, Math.PI, TAU);
        context.fill();
        context.fillStyle = mixColor(colors.accent, '#9fb4c4', 0.4);
        context.beginPath();
        context.ellipse(0, 0, 22, 4, 0, 0, Math.PI);
        context.fill();
        break;
      }
      case 'stone':
      case 'mossy-rock': {
        context.fillStyle = colors.stone;
        context.beginPath();
        context.moveTo(-8, 0);
        context.lineTo(-6, -6);
        context.lineTo(0, -8);
        context.lineTo(7, -5);
        context.lineTo(9, 0);
        context.closePath();
        context.fill();
        context.fillStyle = mixColor(colors.stone, '#ffffff', 0.4);
        context.beginPath();
        context.moveTo(-6, -6);
        context.lineTo(0, -8);
        context.lineTo(-1, -4);
        context.closePath();
        context.fill();
        if (decoration.kind === 'mossy-rock') {
          context.fillStyle = colors.foliage;
          for (const [cx, cy] of [[-3, -4], [4, -3]] as const) {
            context.beginPath();
            context.ellipse(cx, cy, 2.6, 1.6, 0.3, 0, TAU);
            context.fill();
          }
        }
        break;
      }
      case 'fern': {
        context.strokeStyle = colors.foliage;
        context.lineWidth = 1.4;
        context.lineCap = 'round';
        for (let frond = -2; frond <= 2; frond += 1) {
          context.beginPath();
          context.moveTo(0, 0);
          context.quadraticCurveTo(frond * 4 + sway * 6, -8, frond * 7 + sway * 10, -13 - (2 - Math.abs(frond)) * 2);
          context.stroke();
        }
        break;
      }
      case 'reed': {
        context.strokeStyle = colors.foliageDark;
        context.lineWidth = 1.2;
        context.fillStyle = colors.foliage;
        for (let stem = -1; stem <= 1; stem += 1) {
          const top = 18 + Math.abs(stem) * 4 + decoration.tint * 4;
          const tipX = stem * 3 + sway * 14;
          context.beginPath();
          context.moveTo(stem * 3, 0);
          context.quadraticCurveTo(stem * 3 + sway * 8, -top * 0.6, tipX, -top);
          context.stroke();
          context.beginPath();
          context.ellipse(tipX, -top, 1.4, 3.6, 0, 0, TAU);
          context.fill();
        }
        break;
      }
      case 'glow-shroom': {
        const pulse = 0.6 + 0.4 * Math.sin(view.clock * 2.1 + decoration.phase * 3);
        context.fillStyle = '#cdd5f0';
        context.fillRect(-1.2, -6, 2.4, 6);
        context.fillStyle = colors.accent;
        if (!view.lighter) {
          context.shadowColor = colors.accent;
          context.shadowBlur = 7 * pulse;
        }
        context.beginPath();
        context.ellipse(0, -6, 4.4, 2.8, 0, Math.PI, TAU);
        context.fill();
        context.shadowBlur = 0;
        break;
      }
    }
  }

  // ───────────────────────── ground detail (Phase 9B) ─────────────────────────

  /**
   * Phase 9B — environment-specific ground appearance drawn *along the exact
   * collision surface* the engine samples (`view.groundAt`): grass blades,
   * snow sparkles, rocky pebbles and cracks, forest roots and leaf litter.
   * Purely cosmetic — wheels stay on the untouched physics surface.
   */
  drawGroundDetail(context: CanvasRenderingContext2D, view: EnvironmentView, palette: Palette): void {
    if (typeof view.groundAt !== 'function') return;
    const style = this.resolvedGround;
    const density = style.detail * (view.lighter ? 0.45 : 1);
    if (density <= 0.05) return;
    const { width, cameraX, clock } = view;
    const crest = mixColor(style.crest, palette.top, palette.night * 0.45);
    const speckle = mixColor(style.speckle, palette.top, palette.night * 0.5);
    const step = view.lighter ? 18 : 12;
    const first = Math.floor((cameraX - 24) / step);
    const last = Math.ceil((cameraX + width + 24) / step);
    const sway = Math.sin(clock * 1.8) * (1.5 + this.windValue * 3.5);

    context.save();
    context.lineCap = 'round';
    for (let index = first; index <= last; index += 1) {
      const roll = hash(index * 12.9898 + 78.233);
      if (roll > density) continue;
      const worldX = index * step;
      const x = worldX - cameraX;
      const y = view.groundAt(worldX);
      const jitter = (hash(index * 4.113 + 9.7) - 0.5) * step * 0.9;
      const roll2 = hash(index * 7.91 + 31.7);
      switch (style.kind) {
        case 'grass': {
          const height = 4 + roll2 * 6;
          context.strokeStyle = roll2 > 0.72 ? crest : speckle;
          context.lineWidth = 1.4;
          context.beginPath();
          context.moveTo(x, y + 1);
          context.quadraticCurveTo(x + jitter * 0.4, y - height * 0.55, x + jitter + sway, y - height);
          context.stroke();
          break;
        }
        case 'snow': {
          if (roll2 < 0.16) {
            // Wind-smoothed streak just under the crest.
            context.strokeStyle = alphaColor(speckle, 0.5 - palette.night * 0.2);
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(x - 5, y + 3 + jitter * 0.2);
            context.quadraticCurveTo(x, y + 1.5, x + 6, y + 3);
            context.stroke();
          } else {
            // Glinting sparkle.
            context.fillStyle = alphaColor(crest, 0.55 - palette.night * 0.25);
            context.fillRect(x + jitter * 0.5, y - 1 - roll2 * 3, 1.6, 1.6);
          }
          break;
        }
        case 'rocky': {
          if (roll2 < 0.22) {
            // A hairline crack running down from the crest.
            context.strokeStyle = alphaColor(speckle, 0.55);
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(x, y);
            context.lineTo(x + jitter * 0.5 + 2, y + 5 + roll2 * 9);
            context.lineTo(x + jitter * 0.5 + 1, y + 9 + roll2 * 12);
            context.stroke();
          } else {
            // Pebble resting on the surface.
            context.fillStyle = alphaColor(speckle, 0.75);
            context.beginPath();
            context.ellipse(x + jitter * 0.4, y - 0.5, 1.8 + roll2 * 1.6, 1.2 + roll2, 0, 0, TAU);
            context.fill();
          }
          break;
        }
        case 'forest': {
          if (roll2 < 0.4) {
            // Root crossing the crest.
            context.strokeStyle = alphaColor(speckle, 0.7);
            context.lineWidth = 1.6;
            context.beginPath();
            context.moveTo(x - 6, y + 2);
            context.quadraticCurveTo(x + jitter * 0.5, y - 3, x + 6, y + 2.5);
            context.stroke();
          } else {
            // Leaf litter scattered just below the crest.
            context.fillStyle = alphaColor(roll2 > 0.7 ? crest : speckle, 0.6);
            context.fillRect(x + jitter * 0.5, y + 2 + roll2 * 4, 1.8, 1.4);
            context.fillRect(x + jitter * 0.5 + 3, y + 3.5 + roll2 * 3, 1.4, 1.2);
          }
          break;
        }
      }
    }
    context.restore();
  }

  // ───────────────────────── foreground silhouettes (Phase 9B) ─────────────────────────

  /**
   * Phase 9B — sparse near-camera silhouettes that sweep past *in front* of
   * the gameplay: the closest rung of the parallax ladder. Hash-seeded (no
   * state, fully deterministic), culled to the visible span, alpha-kept low
   * so obstacles and the rider stay perfectly readable.
   */
  drawForeground(context: CanvasRenderingContext2D, view: EnvironmentView, palette: Palette): void {
    const cell = 620;
    const parallax = 1.18;
    const offset = view.cameraX * parallax;
    const first = Math.floor((offset - 140) / cell);
    const last = Math.ceil((offset + view.width + 140) / cell);
    if (first > last) return;
    const tint = mixColor(this.resolvedGround.speckle, palette.top, 0.35 + palette.night * 0.25);
    const alpha = 0.34 - palette.night * 0.08;
    const sway = Math.sin(view.clock * 1.2) * (2 + this.windValue * 4);

    context.save();
    for (let index = first; index <= last; index += 1) {
      const roll = hash(index * 4.517 + 17.29);
      if (roll > 0.5) continue;
      const x = index * cell + hash(index * 7.73 + 3.1) * cell * 0.72 - offset;
      const size = 0.7 + hash(index * 9.31 + 44.9) * 0.6;
      context.save();
      context.translate(x, view.height + 2);
      context.rotate((hash(index * 3.3 + 8) - 0.5) * 0.06);
      context.scale(size, size);
      context.globalAlpha = alpha;
      context.fillStyle = tint;
      context.strokeStyle = tint;
      switch (this.resolvedGround.kind) {
        case 'grass': {
          // Tall grass tuft leaning into the wind.
          context.lineWidth = 2.4;
          for (let blade = 0; blade < 4; blade += 1) {
            const lean = sway + (blade - 1.5) * 7;
            context.beginPath();
            context.moveTo(blade * 5 - 8, 0);
            context.quadraticCurveTo(blade * 5 - 8 + lean * 0.4, -46, blade * 5 - 8 + lean, -88 - blade * 7);
            context.stroke();
          }
          break;
        }
        case 'snow': {
          // Wind-sculpted snow lump.
          context.beginPath();
          context.moveTo(-70, 0);
          context.quadraticCurveTo(-30, -34, 12, -20);
          context.quadraticCurveTo(52, -8, 74, 0);
          context.closePath();
          context.fill();
          break;
        }
        case 'rocky': {
          // Reeds swaying over a stone.
          context.lineWidth = 2;
          for (let reed = 0; reed < 3; reed += 1) {
            const lean = sway * 1.4 + (reed - 1) * 6;
            context.beginPath();
            context.moveTo(reed * 9 - 9, 0);
            context.quadraticCurveTo(reed * 9 - 9 + lean * 0.3, -44, reed * 9 - 9 + lean, -74 - reed * 9);
            context.stroke();
          }
          context.beginPath();
          context.ellipse(4, -4, 26, 12, 0, Math.PI, TAU);
          context.fill();
          break;
        }
        case 'forest': {
          // Dark trunk with a low branch.
          context.fillRect(-9, -120, 18, 122);
          context.lineWidth = 10;
          context.lineCap = 'round';
          context.beginPath();
          context.moveTo(-2, -78);
          context.quadraticCurveTo(34, -66, 52 + sway, -34);
          context.stroke();
          break;
        }
      }
      context.restore();
    }
    context.restore();
  }

  // ───────────────────────── ambient particles ─────────────────────────

  drawAmbient(context: CanvasRenderingContext2D, view: EnvironmentView): void {
    if (this.ambientActive <= 0) return;
    const style = this.resolvedAmbient;
    // Phase 9D — forest wind recolours the ambient particles toward drifting
    // autumn leaves while the event runs.
    const leafTint = this.event?.leafTint ?? 0;
    const ambientColor = leafTint > 0.01 ? mixColor(this.resolvedColors.ambient, '#d8a24a', Math.min(1, leafTint) * 0.75) : this.resolvedColors.ambient;
    context.save();
    context.fillStyle = ambientColor;
    if (style.glow > 0 && !view.lighter) {
      context.shadowColor = ambientColor;
      context.shadowBlur = style.glow;
    }
    for (let index = 0; index < this.ambientActive; index += 1) {
      const particle = this.ambientPool[index];
      const flicker = style.flickerMin + (0.5 + 0.5 * Math.sin(this.time * 2.4 + particle.phase * 3.1)) * (style.flickerMax - style.flickerMin);
      context.globalAlpha = clamp01(flicker);
      context.beginPath();
      context.arc(particle.x - view.cameraX, particle.y, particle.size, 0, TAU);
      context.fill();
    }
    context.shadowBlur = 0;
    context.restore();
  }

  // ───────────────────────── screen-space weather ─────────────────────────

  drawWeather(context: CanvasRenderingContext2D, view: EnvironmentView, palette: Palette): void {
    this.weather.drawSnow(context, palette.night);
    this.weather.drawRain(context, this.windValue);
    // Phase 9D — a mist surge thickens the ground band (cap 0.9 so wheels and
    // nearby obstacles always stay readable).
    const groundMist = Math.min(0.9, this.resolvedGroundMist + (this.event?.groundMist ?? 0));
    if (groundMist > 0.03 && typeof view.groundAt === 'function') this.drawGroundMist(context, view, palette, groundMist);
    if (this.weather.fog > 0.02) {
      // A faint, uniform haze. It is deliberately subtle so nearby obstacles
      // stay clearly readable — heavy veiling happens behind the terrain only.
      context.fillStyle = alphaColor(this.resolvedColors.fog, this.weather.fog * 0.09);
      context.fillRect(0, 0, view.width, view.height);
    }
  }

  /**
   * Phase 9B — ground-level mist hugging the terrain crest: one soft band
   * following the surface plus two slow drifting pockets. Slightly thinner
   * at night so wheels and obstacles remain readable.
   */
  private drawGroundMist(context: CanvasRenderingContext2D, view: EnvironmentView, palette: Palette, strengthOverride: number): void {
    const { width, height, clock, cameraX } = view;
    const strength = strengthOverride * (1 - palette.night * 0.22);
    const color = mixColor(this.resolvedColors.fog, palette.horizon, 0.35);
    const step = 64;
    const samples = Math.ceil(width / step) + 2;
    const crestAt = (screenX: number) => view.groundAt(cameraX + screenX)
      + Math.sin(clock * 0.45 + (cameraX + screenX) * 0.004) * 5;

    context.save();
    context.beginPath();
    context.moveTo(-step, height + 40);
    for (let index = 0; index <= samples; index += 1) {
      const screenX = -step + index * step;
      context.lineTo(screenX, crestAt(screenX) - 24);
    }
    for (let index = samples; index >= 0; index -= 1) {
      const screenX = -step + index * step;
      context.lineTo(screenX, crestAt(screenX) + 30);
    }
    context.closePath();
    const gradient = context.createLinearGradient(0, height * 0.45, 0, height);
    gradient.addColorStop(0, alphaColor(color, 0));
    gradient.addColorStop(0.55, alphaColor(color, strength * 0.34));
    gradient.addColorStop(1, alphaColor(color, strength * 0.12));
    context.fillStyle = gradient;
    context.fill();

    // Two pockets of mist drifting along the valley floor.
    context.fillStyle = alphaColor(color, strength * 0.16);
    for (let index = 0; index < 2; index += 1) {
      const span = width * 1.7;
      const drift = (clock * (10 + index * 6) * (1 + this.windValue) + hash(index * 11.3 + 7) * 5000) % span;
      const x = ((drift % span) + span) % span - width * 0.35;
      const y = crestAt(x) + 6;
      context.beginPath();
      context.ellipse(x, y, width * 0.3, 16 + index * 7, 0, 0, TAU);
      context.fill();
    }
    context.restore();
  }
}

const DECORATION_HALF_WIDTH: Record<DecorationKind, number> = {
  grass: 14,
  flower: 8,
  bush: 16,
  'snowy-bush': 16,
  pine: 18,
  'snowy-pine': 18,
  'silhouette-pine': 16,
  drift: 24,
  stone: 12,
  'mossy-rock': 14,
  fern: 14,
  reed: 10,
  'glow-shroom': 6,
};
