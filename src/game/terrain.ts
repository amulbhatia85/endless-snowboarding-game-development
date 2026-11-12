import { BICYCLE_PHYSICS, flipProgress } from './riderPhysics';
import { ICE_BOULDER, OBSTACLE_REGISTRY } from './obstacleRegistry';
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

/** Phase 15 — deep mountain runs: the longest a run can span (chunks), and the
 *  minimum spacing between run starts. The gap exceeds the max length so two
 *  runs can never overlap or abut. */
const RUN_MAX_LENGTH = 14;
const RUN_MIN_GAP = 16;
/** Phase 15 — tangents for the flow spline are clamped so a chunk's curve can
 *  never approach the slope cap from the tangent terms alone. */
const FLOW_TANGENT_LIMIT = 0.27;

const PROFILES: Record<EnvironmentTheme, { range: number; bump: number; recovery: number }> = {
  countryside: { range: 28, bump: 25, recovery: 0.23 },
  'snowy-mountains': { range: 38, bump: 32, recovery: 0.2 },
  'misty-mountains': { range: 33, bump: 28, recovery: 0.24 },
  'moonlit-forest': { range: 25, bump: 22, recovery: 0.28 },
  jungle: { range: 30, bump: 26, recovery: 0.24 },
};
/** Phase 9C — the neutral bias keeps levels 1–4 byte-identical to Phase 8. */
const NEUTRAL_TERRAIN_BIAS: TerrainBias = { rangeScale: 1, bumpScale: 1, recoveryScale: 1, valleyBias: 0, descentScale: 0 };
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export class TerrainGenerator {
  private readonly chunks = new Map<number, TerrainChunk>();
  /** Phase 13 — memoised clamped anchors (see anchor()). */
  private readonly anchors = new Map<number, number>();
  /** Phase 15 — deep mountain runs: run-start decisions (computed in order)
   *  and the shaped boundary heights of each started run. */
  private readonly runStartMemo = new Map<number, boolean>();
  private readonly runAnchors = new Map<number, number[]>();
  private readonly runLengths = new Map<number, number>();
  /** Phase 15 — crest lips per run start: short convex overlays at the entry
   *  and exit crests whose curvature unweights a fast rider into a natural
   *  launch (v²·κ > 0.85·g). */
  private readonly runLips = new Map<number, { xc: number; w: number; a: number }[]>();
  private readonly lipScratch = [-1, -1, -1];
  private runStartComputed = 5;
  generatedChunks = 0;
  /** Phase 9C — per-level statistical bias (neutral for levels 1–4). */
  private readonly bias: TerrainBias;
  /** Phase 15 — levels ≥ 5 interpolate anchors with a slope-flowing quintic
   *  Hermite spline (tangents from neighbouring anchors) instead of the
   *  zero-tangent smoothstep, so chained chunks form one continuous mountainside
   *  rather than a scalloped staircase. Levels 1–4 keep the classic curve. */
  private readonly flow: boolean;

  constructor(readonly configuration: LevelConfiguration) {
    this.bias = configuration.profile?.terrain ?? NEUTRAL_TERRAIN_BIAS;
    this.flow = configuration.number >= 5;
  }

  get cachedChunks(): number { return this.chunks.size; }

  private random(index: number, salt: number): number {
    return createLevelRandom(this.configuration.terrain.variationSeed ^ Math.imul(index, 0x9e3779b9) ^ salt)();
  }

  /** The statistical recovery decision, untouched by run suppression. */
  private recoveryRaw(index: number): boolean {
    if (index <= 0) return true;
    const base = PROFILES[this.configuration.environment].recovery * this.bias.recoveryScale;
    if (this.random(index, 0x43f12) >= clamp(base, 0.08, 0.42)) return false;
    // Phase 9E — cap flat valleys at five consecutive chunks (~3.2 km) so the
    // silhouette keeps breathing. Recovery probability itself is untouched;
    // only statistically excessive streaks are trimmed.
    for (let back = 1; back <= 5; back += 1) {
      if (!this.recoveryRaw(index - back)) return true;
    }
    return false;
  }

  /**
   * Phase 15 — recovery is suppressed through a mountain run and two chunks
   * past its exit, so the anchor chain is free to carry the deep valley and
   * climb back into the normal band before any flat reset can snap against a
   * still-deep anchor (a snap mid-run would be a cliff, not a valley).
   */
  private recovery(index: number): boolean {
    if (this.inRunZone(index)) return false;
    return this.recoveryRaw(index);
  }

  /** True when `index` sits inside a run's chunks or its two-chunk exit pad. */
  private inRunZone(index: number): boolean {
    if (this.bias.descentScale <= 0) return false;
    return this.runStartCoveringChunk(index) >= 0
      || this.runStartCoveringChunk(index - 1) >= 0
      || this.runStartCoveringChunk(index - 2) >= 0;
  }

  /** Phase 15 — deterministic run-start decisions, computed strictly in
   *  ascending index order so every query sees the same history. */
  private runStart(index: number): boolean {
    if (index < 6 || this.bias.descentScale <= 0) return false;
    if (!this.runStartMemo.has(index)) {
      for (let i = Math.max(6, this.runStartComputed + 1); i <= index; i += 1) {
        let start = false;
        if (this.bias.descentScale > 0) {
          let spaced = true;
          for (let back = 1; back <= RUN_MIN_GAP; back += 1) {
            if (this.runStartMemo.get(i - back) === true) { spaced = false; break; }
          }
          start = spaced && this.random(i, 0x5dee1) < 0.11 * (0.45 + 0.55 * this.bias.descentScale);
        }
        this.runStartMemo.set(i, start);
        this.runStartComputed = i;
      }
    }
    return this.runStartMemo.get(index) === true;
  }

  /** The run's shape parameters, drawn once from its start chunk. */
  private runSpec(start: number): { depth: number; deficit: number; bottom: number } {
    const depth = (275 + this.random(start, 0x77aa1) * 320) * (0.5 + 0.5 * this.bias.descentScale);
    const deficit = this.random(start, 0x77aa2) * Math.min(depth * 0.35, 130);
    const bottom = this.random(start, 0x77aa3) < 0.55 ? 1 : 2;
    return { depth, deficit, bottom };
  }

  /**
   * Eased ends concentrate up to ~56% of the total on a single step for the
   * shortest segment, so counts are chosen against the eased maximum step,
   * not the average — every shaped chunk stays well inside the slope cap.
   * Pure in the run's salts: the coverage machinery (runLength) and the
   * height construction (runHeights) must always agree on the counts without
   * ever re-entering the anchor walk.
   */
  private runStepCount(total: number): number {
    let count = Math.max(2, Math.ceil(total / 118));
    while (count < 6 && total * this.easeMaxFraction(count) > 126) count += 1;
    return Math.min(count, 6);
  }

  /** The largest single-step share of `total` for an eased segment of `count` steps. */
  private easeMaxFraction(count: number): number {
    if (count <= 1) return 1;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < count; i += 1) {
      const weight = i === 0 ? 0.55 : i === count - 1 ? 0.7 : 1;
      max = Math.max(max, weight);
      sum += weight;
    }
    return max / sum;
  }

  private runLength(start: number): number {
    const cached = this.runLengths.get(start);
    if (cached !== undefined) return cached;
    const { depth, deficit, bottom } = this.runSpec(start);
    // The climb spans depth − deficit by construction (the exit is simply
    // entry + deficit — see runHeights), so the length is pure in the salts.
    const length = this.runStepCount(depth) + bottom + this.runStepCount(Math.max(0, depth - deficit));
    this.runLengths.set(start, length);
    return length;
  }

  /** The start of the run owning chunk `index` (chunks start..start+length-1), or -1. */
  private runStartCoveringChunk(index: number): number {
    if (index < 6 || this.bias.descentScale <= 0) return -1;
    const earliest = Math.max(6, index - RUN_MAX_LENGTH + 1);
    for (let start = index; start >= earliest; start -= 1) {
      if (!this.runStart(start)) continue;
      if (start + this.runLength(start) > index) return start;
    }
    return -1;
  }

  /** The start of the run owning boundary `index` (boundaries start+1..start+length are shaped), or -1. */
  private runStartCoveringBoundary(index: number): number {
    if (index < 7 || this.bias.descentScale <= 0) return -1;
    const earliest = Math.max(6, index - RUN_MAX_LENGTH);
    for (let start = index - 1; start >= earliest; start -= 1) {
      if (!this.runStart(start)) continue;
      if (start + this.runLength(start) >= index) return start;
    }
    return -1;
  }

  /**
   * Phase 15 — public hazard-planning query: true when `x` sits in a run's
   * airborne corridor — the approach pad and crest lip at the entry, the
   * landing arc of the natural launch down the first descent chunks, and the
   * climb-out crest with its landing pad. Hazards are kept out of exactly
   * these zones: a rider thrown by the lip cannot honor a grounded approach
   * guarantee. The rest of the run (descent body, valley floor, climb wall)
   * stays hazard space — the rider is grounded there, and the planner already
   * models the slope-driven acceleration with the rider's own speed model.
   */
  inMountainRun(x: number): boolean {
    if (this.bias.descentScale <= 0) return false;
    const chunk = Math.floor(x / TERRAIN_CHUNK_WIDTH);
    // Entry zone: chunks start-1 .. start+2.
    for (let start = chunk + 1; start >= chunk - 2 && start >= 6; start -= 1) {
      if (this.runStart(start)) return true;
    }
    // Exit zone: chunks start+length-1 .. start+length+1.
    for (let start = chunk - 1; start >= chunk - RUN_MAX_LENGTH && start >= 6; start -= 1) {
      if (!this.runStart(start)) continue;
      const end = start + this.runLength(start);
      if (chunk >= end - 1 && chunk <= end + 1) return true;
    }
    return false;
  }

  /**
   * Phase 15 — the shaped boundary heights of a deep mountain run: an eased
   * descent of up to ~600 px, a short rounded bottom (never flat), and a climb
   * that may deliberately fall short of the entry height so momentum carried
   * from the descent decides how high the rider gets. All interior and exit
   * boundaries are memoised into the anchor cache so the normal chain walk
   * continues seamlessly from the run's exit.
   */
  private runHeights(runStart: number): number[] {
    const cached = this.runAnchors.get(runStart);
    if (cached) return cached;
    const { depth, deficit, bottom } = this.runSpec(runStart);
    const descent = this.runStepCount(depth);
    const climb = this.runStepCount(Math.max(0, depth - deficit));
    const entry = this.anchor(runStart);
    // The valley floor is capped in absolute depth: at the extreme (a low
    // entry anchor plus a max draw) the floor would otherwise push the rider
    // past what the camera clamp can frame on short viewports. The cap only
    // ever shrinks the shaped totals, so the salt-pure step counts above
    // remain an upper bound — never under-sized.
    const depthEff = Math.min(depth, Math.max(160, 480 - entry));
    // The exit is simply `deficit` below the entry: the climb deliberately
    // falls short, so momentum carried through the descent decides how high
    // the rider gets. No snap band is needed here — the normal chain's own
    // per-step limit bounds the walk away from any exit, and recovery stays
    // suppressed through the two-chunk exit pad (inRunZone).
    const exit = entry + deficit;
    const deltas: number[] = [];
    const pushEased = (count: number, total: number) => {
      if (count <= 0 || total === 0) return;
      // Eased first/last steps keep the curvature — and therefore the slope —
      // gentle where the run meets the normal terrain chain.
      const weights: number[] = [];
      for (let i = 0; i < count; i += 1) weights.push(i === 0 ? 0.55 : i === count - 1 ? 0.7 : 1);
      const sum = weights.reduce((a, b) => a + b, 0);
      for (let i = 0; i < count; i += 1) deltas.push((total * weights[i]) / sum);
    };
    // Down the mountainside: y grows on screen, so the descent deltas are
    // positive. A short rounded bottom (never flat) then climbs back toward
    // the exit, falling `deficit` short of the entry height.
    pushEased(descent, depthEff);
    let bottomRise = 0;
    if (bottom === 1) { deltas.push(-14); bottomRise += 14; }
    else { deltas.push(-6); deltas.push(-22); bottomRise += 28; }
    pushEased(climb, exit - (entry + depthEff - bottomRise));
    const heights = [entry];
    let height = entry;
    for (const delta of deltas) { height += delta; heights.push(height); }
    // Memoise every boundary the run shapes (interior + exit); the entry and
    // the chunk after the exit stay with the normal chain.
    for (let s = 1; s < heights.length; s += 1) this.anchors.set(runStart + s, heights[s]);
    this.runAnchors.set(runStart, heights);
    this.buildRunLips(runStart, heights.length - 1);
    return heights;
  }

  /**
   * Phase 15 — the crest lips of a run. A lip is a short (≈150 px) convex
   * cosine² dip centred just past a run boundary: at the entry it sharpens
   * the ridge the rider launches from into the descent, at the exit it turns
   * the climb-out crest into a momentum reward. The curvature at the crest is
   * 2π²·A/w² — with A ≈ 8 px and w ≈ 150 px a rider above ~335 px/s unweights
   * and flies; at cruise the wheels stay planted. The amplitude is clamped to
   * the local slope headroom so the cap holds everywhere.
   */
  private buildRunLips(runStart: number, length: number): void {
    const lips: { xc: number; w: number; a: number }[] = [];
    const width = 110 + this.random(runStart, 0x77aa4) * 25;
    const chunkSlope = (index: number) => Math.max(
      Math.abs(this.tangent(index)),
      Math.abs(this.tangent(index + 1)),
      Math.abs(this.anchor(index + 1) - this.anchor(index)) * 1.875 / TERRAIN_CHUNK_WIDTH,
    );
    const pushLip = (boundary: number, approach: number, steep: number, salt: number) => {
      const raw = 7.5 + this.random(runStart, salt) * 2.5;
      const headroom = Math.max(0, TERRAIN_MAX_SLOPE - Math.max(chunkSlope(approach), chunkSlope(steep)));
      const a = Math.min(raw, headroom * 0.9 * width / Math.PI);
      if (a >= 1.5) lips.push({ xc: boundary * TERRAIN_CHUNK_WIDTH + width * 0.12, w: width, a });
    };
    pushLip(runStart, runStart - 1, runStart, 0x77aa5);
    pushLip(runStart + length, runStart + length - 1, runStart + length, 0x77aa6);
    this.runLips.set(runStart, lips);
  }

  /** Phase 15 — the lip overlay at a sample position (flow levels only). */
  private lipAt(index: number, x: number): number {
    if (this.bias.descentScale <= 0) return 0;
    const scratch = this.lipScratch;
    let count = 0;
    const ahead = this.runStartCoveringChunk(index + 1);
    const here = this.runStartCoveringChunk(index);
    const behind = this.runStartCoveringChunk(index - 1);
    if (ahead >= 0) scratch[count++] = ahead;
    if (here >= 0 && here !== ahead) scratch[count++] = here;
    if (behind >= 0 && behind !== ahead && behind !== here) scratch[count++] = behind;
    let total = 0;
    for (let i = 0; i < count; i += 1) {
      const lips = this.runLips.get(scratch[i]);
      if (!lips) continue;
      for (const lip of lips) {
        const u = x - lip.xc;
        if (u > -lip.w * 0.5 && u < lip.w * 0.5) total -= lip.a * Math.cos(Math.PI * u / lip.w) ** 2;
      }
    }
    return total;
  }

  /**
   * Chunk-boundary anchor height. Phase 13 — the quintic's max derivative
   * (1.875) bounds each chunk's slope by |Δ|·1.875/640, so adjacent anchors
   * are clamped to the slope-safe span (TERRAIN_MAX_SLOPE·640/1.875 ≈ 116px).
   * Deep mountain biases can now chain full-range draws into sustained
   * peak-and-valley runs without ever breaching the cap — including the very
   * high levels where the grown heightScale used to creep past it. The chain
   * is walked iteratively and memoised, and recovery-adjacent bases return 0
   * exactly as before, so determinism and levels 1–4 are unchanged.
   */
  private anchor(index: number): number {
    if (index <= 1) return 0;
    // Phase 15 — shaped boundaries of a deep mountain run are authoritative:
    // neither the recovery reset nor the random draw may touch them.
    const runStart = this.runStartCoveringBoundary(index);
    if (runStart >= 0) return this.runHeights(runStart)[index - runStart];
    if (this.recovery(index) || this.recovery(index - 1)) return 0;
    const cached = this.anchors.get(index);
    if (cached !== undefined) return cached;
    const range = PROFILES[this.configuration.environment].range * this.configuration.terrain.heightScale * this.bias.rangeScale;
    const limit = (TERRAIN_MAX_SLOPE * TERRAIN_CHUNK_WIDTH) / 1.875;
    // Walk down to the nearest known base, then clamp forward.
    const chain: number[] = [];
    let current = index;
    while (current > 1 && !this.anchors.has(current) && !this.recovery(current) && !this.recovery(current - 1)) {
      // Phase 15 — never walk *through* an unbuilt run: building it memoises
      // its shaped anchors, which become the known base for this walk.
      const covering = this.runStartCoveringBoundary(current);
      if (covering >= 0) {
        this.runHeights(covering);
        continue;
      }
      chain.push(current);
      current -= 1;
    }
    let previous = current <= 1 || this.recovery(current) || this.recovery(current - 1) ? 0 : this.anchors.get(current)!;
    for (const step of chain.reverse()) {
      const draw = (this.random(step, 0xabc37) * 2 - 1) * range;
      previous = Math.max(previous - limit, Math.min(previous + limit, draw));
      this.anchors.set(step, previous);
    }
    return previous;
  }

  /**
   * Phase 15 — the flow-spline tangent at a chunk boundary: the centred
   * difference of the neighbouring anchors, clamped well inside the slope cap.
   * Boundary 0 (the level seam) stays flat so adjacent level terrains join
   * exactly as they did with the classic curve.
   */
  private tangent(index: number): number {
    // The level's opening runway (and the seam at local x = 0) stays perfectly
    // flat: the start house, windmill and rollout all live there.
    if (index <= 2) return 0;
    const raw = (this.anchor(index + 1) - this.anchor(index - 1)) / (2 * TERRAIN_CHUNK_WIDTH);
    return clamp(raw, -FLOW_TANGENT_LIMIT, FLOW_TANGENT_LIMIT);
  }

  chunk(index: number): TerrainChunk {
    const cached = this.chunks.get(index);
    if (cached) return cached;
    const startHeight = this.anchor(index);
    const endHeight = this.anchor(index + 1);
    const delta = endHeight - startHeight;
    const choice = this.random(index, 0x581b);
    const recovery = this.recovery(index);
    const inRun = this.runStartCoveringChunk(index) >= 0;
    // Phase 9C — the profile's valley bias shifts the valley/rolling/ramp split
    // while every branch remains reachable. Phase 15 — chunks inside a deep
    // mountain run always read as descent/climb: their drama is the run
    // itself, and a local bump would only chop the flow.
    const valleyCut = 0.38 + this.bias.valleyBias;
    const rampCut = 0.84 - this.bias.valleyBias * 0.5;
    const pattern: TerrainPattern = recovery ? 'recovery'
      : inRun ? (delta >= 0 ? 'downhill' : 'uphill')
      : delta > 16 ? 'downhill' : delta < -16 ? 'uphill'
      : choice < valleyCut ? 'valley' : choice < rampCut ? 'rolling-hill' : 'ramp';
    // The classic quintic interpolation has max derivative 1.875; the flow
    // spline adds the boundary tangents. In both cases the bump is
    // conservatively bounded by 6 against the anchor slope actually in play,
    // so the combined slope stays below the cap.
    const anchorSlope = this.flow
      ? Math.max(
        Math.abs(this.tangent(index)),
        Math.abs(this.tangent(index + 1)),
        Math.abs(delta) * 1.875 / TERRAIN_CHUNK_WIDTH,
      )
      : Math.abs(delta) * 1.875 / TERRAIN_CHUNK_WIDTH;
    const slopeBudget = Math.max(0, TERRAIN_MAX_SLOPE - anchorSlope);
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
    if (!this.flow) {
      return chunk.startHeight + (chunk.endHeight - chunk.startHeight) * smooth(t) + chunk.bump * bump;
    }
    // Phase 15 — the flow spline: a quintic Hermite carrying the boundary
    // tangent m = (h[i+1] − h[i−1]) / 2W. Curvature is zero at both ends of
    // every chunk (the k terms are pinned to 0), so adjacent chunks match in
    // position, slope AND curvature — chained anchors render as one continuous
    // mountainside. With equal consecutive deltas the curve degenerates to a
    // perfectly straight slope; with alternating anchors it eases like the
    // classic smoothstep.
    const t2 = t * t;
    const t3 = t2 * t;
    const t4 = t3 * t;
    const t5 = t4 * t;
    const m0 = this.tangent(index) * TERRAIN_CHUNK_WIDTH;
    const m1 = this.tangent(index + 1) * TERRAIN_CHUNK_WIDTH;
    return chunk.startHeight * (1 - 10 * t3 + 15 * t4 - 6 * t5)
      + chunk.endHeight * (10 * t3 - 15 * t4 + 6 * t5)
      + m0 * (t - 6 * t3 + 8 * t4 - 3 * t5)
      + m1 * (-4 * t3 + 7 * t4 - 3 * t5)
      + chunk.bump * bump
      + this.lipAt(index, x);
  }

  /** Phase 5A diagnostics: the chunk index and pattern at a position. */
  describe(x: number): { index: number; pattern: TerrainPattern; inRun: boolean } {
    const index = Math.max(0, Math.floor(x / TERRAIN_CHUNK_WIDTH));
    // Phase 15 — run membership lets the repetition audit tell designed
    // mountain runs (long same-pattern stretches by construction) apart from
    // the classic variety machinery it polices.
    return { index, pattern: this.chunk(index).pattern, inRun: this.runStartCoveringChunk(index) >= 0 };
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

  /** Phase 15 — deep-mountain-run query, delegated to the owning generator. */
  inMountainRun(x: number): boolean {
    let origin = this.origins[0];
    for (let index = this.origins.length - 1; index >= 0; index -= 1) {
      if (x >= this.origins[index].x) { origin = this.origins[index]; break; }
    }
    return this.generator(origin).inMountainRun(x - origin.x);
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
  describe(x: number): { level: number; index: number; pattern: TerrainPattern; inRun: boolean } | undefined {
    let origin = this.origins[0];
    for (let index = this.origins.length - 1; index >= 0; index -= 1) {
      if (x >= this.origins[index].x) { origin = this.origins[index]; break; }
    }
    const chunk = this.generator(origin).describe(x - origin.x);
    return { level: origin.level, index: chunk.index, pattern: chunk.pattern, inRun: chunk.inRun };
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
  // Takeoff distances leave the near corridor edge deep enough into the
  // flight for the slower-rising shortened arc to have reached the required
  // clearance at maximum speed with a late (+margin) tap, on top of the
  // takeoff jitter — while the landing pad stays inside the minimum-speed
  // reach (226 px).
  const takeoff = x - (kind === 'tree' ? 132 : kind === 'fence' ? 85 : kind === 'root' ? 58 : kind === 'log' ? 80 : 70);
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
  // Patrol sweep 28 + downhill bias 8 + ball radius 17 = 53px corridor —
  // clearable in one jump at minimum speed wherever the patrol has carried
  // the ball (retuned for the shorter Phase 11 jump reach: takeoff x-120).
  return validateLanding(heightAt, x - 120, heightAt(x - 120) - 5, x + 53,
    { x, radius: 53, height: 30 }, options);
}

/**
 * Phase 13 — deep valley gorge: a wide, fatal gap placed only where the
 * terrain genuinely forms a valley neck. The far side must rise into the next
 * mountain section (canvas convention: higher altitude = smaller y), the far
 * lip's immediate landing ground must stay gentle, and the standard gap
 * guarantees — takeoff slope, crest-launch arcs at top speed, reachable
 * landing at every speed in the envelope — all apply unchanged. Riders who
 * miss the jump fall in and crash, exactly like every other gap.
 */
export function validateGorge(
  heightAt: (x: number) => number, x: number, width: number, options?: TraversalOptions,
): LandingValidation {
  if (!Number.isFinite(width) || width < 88 || width > 150) {
    return { safe: false, clearUntil: x, reason: 'Gorge width outside validated limits' };
  }
  const takeoff = x - 55;
  const approachSlope = Math.abs((heightAt(x) - heightAt(takeoff)) / 55);
  if (approachSlope > 0.18) return { safe: false, clearUntil: x, reason: 'Takeoff slope too steep' };
  // The valley neck: the next mountain section's wall must stand at least
  // 14px above this lip within ~130px past the far edge.
  const farLift = heightAt(x) - Math.min(heightAt(x + width + 60), heightAt(x + width + 130));
  if (farLift < 14) return { safe: false, clearUntil: x, reason: 'Far side does not rise into a mountain wall' };
  const landingSlope = Math.abs((heightAt(x + width + 90) - heightAt(x + width + 10)) / 80);
  if (landingSlope > 0.22) return { safe: false, clearUntil: x, reason: 'Far lip landing ground too steep' };
  const airborne = validateGapAgainstCrestLaunch(heightAt, x, width);
  if (!airborne.safe) return airborne;
  return validateLanding(heightAt, takeoff, heightAt(takeoff) - 5, x + width, undefined, options);
}

/**
 * Phase 13 — giant rolling ice boulder. The spawn ledge must fall away toward
 * the rider (the rider's uphill: heightAt decreasing with x) so gravity
 * genuinely carries the boulder into the approach, and the whole meeting
 * corridor must be clearable in one jump wherever rider and boulder cross:
 * three representative meeting spots, each validated as a static
 * radius+padding-wide, height-tall envelope with a takeoff 140px earlier —
 * the same envelope the runtime collision uses.
 */
export function validateIceBoulder(
  heightAt: (x: number) => number, x: number, options?: TraversalOptions,
): LandingValidation {
  const slope = (heightAt(x + 80) - heightAt(x - 80)) / 160;
  if (slope > -0.05) return { safe: false, clearUntil: x, reason: 'Boulder ledge does not fall away toward the rider' };
  if (slope < -0.3) return { safe: false, clearUntil: x, reason: 'Boulder ledge too steep to read' };
  const corridor = { radius: ICE_BOULDER.radius + BICYCLE_PHYSICS.collisionPadding, height: ICE_BOULDER.height };
  for (const meet of [x - 420, x - 280, x - 140]) {
    const envelope = { x: meet, radius: corridor.radius, height: corridor.height };
    const check = validateLanding(heightAt, meet - 140, heightAt(meet - 140) - 5, meet + corridor.radius, envelope, options);
    if (!check.safe) {
      return { safe: false, clearUntil: x, reason: `Boulder meeting zone @${Math.round(meet)}: ${check.reason ?? 'trajectory rejected'}` };
    }
  }
  return {
    safe: true,
    clearUntil: x + 60,
    takeoff: { start: x - 560, end: x - 140 },
    landing: { start: x - 420, end: x + 60 },
  };
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
  // Swing 14 + log half-length 30 = 44px corridor; clearance height 50
  // (validator requires rider >= 54px above ground) covers the log hung at
  // ground-24±6 with a 34px collision box (top at ground-47) plus the
  // rider's bottom and inset. Takeoff x-128 keeps the whole corridor inside
  // the >=54px-clearance span of the shortened jump at BOTH speed extremes
  // and on sloped ground, with the 24px recovery pad inside the
  // minimum-speed reach (226px).
  return validateLanding(heightAt, x - 128, heightAt(x - 128) - 5, x + 44,
    { x, radius: 44, height: 50 }, options);
}
