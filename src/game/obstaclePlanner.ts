import { createLevelRandom, type LevelConfiguration } from './levelManager';
import { OBSTACLE_REGISTRY, obstacleReady, type ActiveObstacleId, type ObstacleId, type ObstacleGroup } from './obstacleRegistry';
import { BICYCLE_PHYSICS } from './riderPhysics';
import type { DifficultyDirective } from './difficulty';
import {
  validateGap, validateRamp, validateBridge, validateObstacle, validateRampGap, validateSwingingLog,
  validateIcePatch, validateFallingHazard, validateSnowball,
  type LandingValidation, type TraversalOptions,
} from './terrain';

export interface Region { start: number; end: number }
export interface PlacementMetadata {
  patternId: string;
  obstacleId: ActiveObstacleId;
  takeoff: Region;
  landing: Region;
  clearUntil: number;
  warningStart: number;
  spacing: number;
}
export interface PlannedObstacle {
  kind: 'rock' | 'log' | 'tree' | 'gap' | 'ramp' | 'swinging-log'
    | 'root' | 'fence' | 'ice' | 'icicle' | 'snowball' | 'branch';
  x: number;
  width?: number;
  bridged?: boolean;
  phase?: number;
  /** Seeded 0..1 draw driving per-instance visual variation (sizes, shapes, rails). */
  variant?: number;
  plan: PlacementMetadata;
}
export interface PlacementRejection { x: number; patternId: string; reason: string }
export interface ObstaclePlan {
  patternId: string;
  obstacles: PlannedObstacle[];
  clearUntil: number;
  nextX: number;
  rejected: PlacementRejection[];
}
interface Pattern {
  id: string;
  minLevel: number;
  /**
   * Phase 11 — environments whose identity is built on this family may show
   * it earlier than the global ladder (misty shows broken bridges from L3,
   * moonlit shows branches from L4, …). The full-strength version still
   * follows the global `minLevel` everywhere else.
   */
  envMinLevel?: Partial<Record<LevelConfiguration['environment'], number>>;
  weight: number;
  requires: readonly ObstacleId[];
  sequence: readonly ActiveObstacleId[];
  /** Phase 5 challenge rating, 0 (trivial) .. 1 (demanding): the pacing engine
   *  selects patterns whose rating matches the current difficulty target. */
  rating: number;
  downhill?: boolean;
  coupled?: boolean;
}
export const OBSTACLE_PATTERNS: readonly Pattern[] = [
  { id: 'single-rock', minLevel: 1, weight: 24, requires: ['rock'], sequence: ['rock'], rating: 0.08 },
  { id: 'single-log', minLevel: 1, weight: 19, requires: ['log'], sequence: ['log'], rating: 0.12 },
  { id: 'single-tree', minLevel: 1, weight: 10, requires: ['tree'], sequence: ['tree'], rating: 0.18 },
  { id: 'log-recovery', minLevel: 1, weight: 10, requires: ['log'], sequence: ['log'], rating: 0.05 },
  { id: 'small-gap', minLevel: 1, weight: 9, requires: ['gap'], sequence: ['gap'], rating: 0.42 },
  { id: 'rope-bridge', minLevel: 1, weight: 3, requires: ['bridge'], sequence: ['bridge'], rating: 0.25 },
  { id: 'controlled-ramp', minLevel: 1, weight: 3, requires: ['ramp'], sequence: ['ramp'], rating: 0.5 },
  { id: 'downhill-rock', minLevel: 2, weight: 7, requires: ['rock'], sequence: ['rock'], rating: 0.3, downhill: true },
  { id: 'double-logs', minLevel: 3, weight: 16, requires: ['log'], sequence: ['log', 'log'], rating: 0.55 },
  { id: 'ramp-gap', minLevel: 4, weight: 9, requires: ['ramp', 'gap'], sequence: ['ramp', 'gap'], rating: 0.78, coupled: true },
  { id: 'advanced-static-sequence', minLevel: 6, weight: 13, requires: ['rock', 'log'], sequence: ['rock', 'log', 'rock'], rating: 0.7 },
  // Phase 9A — expanded library. Roots and fences are static jump obstacles,
  // ice is a reduced-traction ground patch, icicles/branches/snowballs are
  // timed moving hazards with visible warning cues, cliffs and broken bridges
  // are gap variants, and the moving platform is a bobbing bridged gap.
  { id: 'single-root', minLevel: 1, weight: 18, requires: ['root'], sequence: ['root'], rating: 0.06 },
  { id: 'root-pair', minLevel: 3, weight: 10, requires: ['root'], sequence: ['root', 'root'], rating: 0.34 },
  { id: 'single-fence', minLevel: 2, weight: 13, requires: ['fence'], sequence: ['fence'], rating: 0.3 },
  { id: 'fence-then-rock', minLevel: 5, weight: 7, requires: ['fence', 'rock'], sequence: ['fence', 'rock'], rating: 0.6 },
  { id: 'ice-patch', minLevel: 2, weight: 9, requires: ['ice'], sequence: ['ice'], rating: 0.18 },
  { id: 'icicle-drop', minLevel: 6, envMinLevel: { 'snowy-mountains': 3 }, weight: 8, requires: ['icicle'], sequence: ['icicle'], rating: 0.62 },
  { id: 'snowball-roll', minLevel: 5, envMinLevel: { 'snowy-mountains': 5, jungle: 5 }, weight: 8, requires: ['snowball'], sequence: ['snowball'], rating: 0.74 },
  { id: 'cliff-jump', minLevel: 7, envMinLevel: { 'misty-mountains': 5, jungle: 5 }, weight: 7, requires: ['cliff'], sequence: ['cliff'], rating: 0.85 },
  { id: 'broken-bridge', minLevel: 6, envMinLevel: { 'misty-mountains': 5, jungle: 5 }, weight: 7, requires: ['broken-bridge'], sequence: ['broken-bridge'], rating: 0.8 },
  // Phase 9E balance: moving platforms and falling branches were staggered to
  // level 7 so level 6 no longer introduces five patterns at once — the
  // learning curve gains a new family at a time.
  { id: 'moving-platform', minLevel: 7, envMinLevel: { 'misty-mountains': 5, jungle: 4 }, weight: 6, requires: ['moving-platform'], sequence: ['moving-platform'], rating: 0.66 },
  { id: 'falling-branch', minLevel: 7, envMinLevel: { 'moonlit-forest': 5, jungle: 5 }, weight: 8, requires: ['branch'], sequence: ['branch'], rating: 0.78 },
  // Moving hazards require a complete renderer, collider, warning and validated envelope.
  { id: 'warned-swinging-log', minLevel: 8, envMinLevel: { 'moonlit-forest': 6, jungle: 4 }, weight: 10, requires: ['swinging-log'], sequence: ['swinging-log'], rating: 0.85 },
];

/** Challenge rating of a pattern id (undefined for 'recovery'/unknown). */
export function patternRating(id: string): number | undefined {
  return OBSTACLE_PATTERNS.find(pattern => pattern.id === id)?.rating;
}

/** Obstacle ids whose patterns demand a clean takeoff corridor or sweep/telegraph a hazard. */
const DANGEROUS_REQUIRES: ReadonlySet<string> = new Set([
  'gap', 'ramp', 'swinging-log', 'cliff', 'broken-bridge', 'moving-platform',
  'snowball', 'icicle', 'branch',
]);

/**
 * Dangerous patterns demand a clean takeoff corridor or sweep a moving hazard:
 * gaps, ramps, swinging logs, cliff/bridge variants, timed hazards and
 * multi-obstacle combinations. The safe final approach (45 k → house) refuses
 * to schedule any of them.
 */
export function patternIsDangerous(id: string): boolean {
  const pattern = OBSTACLE_PATTERNS.find(item => item.id === id);
  if (!pattern) return false;
  return pattern.coupled === true || pattern.sequence.length > 1
    || pattern.requires.some(id => DANGEROUS_REQUIRES.has(id));
}

export interface PlanningContext {
  level: LevelConfiguration;
  candidateX: number;
  riderX: number;
  riderSpeed: number;
  riderAcceleration: number;
  surface: (x: number) => number;
  clearUntil: number;
  bridgeAllowedAfter: number;
  rampAllowedAfter: number;
  reserved: readonly Region[];
  nearby: readonly { kind: string; x: number; width?: number; plan?: PlacementMetadata }[];
  /** Phase 5 pacing directive. Absent → legacy behaviour (fixed reaction
   * budget, flat weights, 17 % recovery) so existing callers are unchanged. */
  directive?: DifficultyDirective;
  /** Recently scheduled pattern ids, oldest first — drives repetition control. */
  recentPatterns?: readonly string[];
  /**
   * Phase 9D — special-event pattern preference. Ids listed here get a weight
   * boost while the event window runs; availability, validation and spacing
   * are never relaxed, so hinted patterns stay as safe as any other.
   */
  hint?: { readonly prefer: readonly string[] };
}

export function patternAvailability(level: LevelConfiguration): { id: string; category: ObstacleGroup; available: boolean; reason?: string }[] {
  return OBSTACLE_PATTERNS.map(pattern => {
    const missing = pattern.requires.find(id => !obstacleReady(id));
    const incompatible = pattern.requires.find(id => !level.allowedObstacles.includes(id));
    // Phase 11 — environments built on a family unlock its identity early;
    // everywhere else the global ladder applies unchanged.
    const effectiveMinLevel = pattern.envMinLevel?.[level.environment] ?? pattern.minLevel;
    const reason = missing ? `${missing} implementation incomplete`
      : incompatible ? `${incompatible} not allowed in ${level.environment}`
      : level.number < effectiveMinLevel ? `Requires level ${effectiveMinLevel}` : undefined;
    const category = pattern.sequence.length > 1 ? 'combination' : OBSTACLE_REGISTRY[pattern.requires[0]].group;
    return { id: pattern.id, category, available: !reason, reason };
  });
}

export function validPlacementMetadata(value: unknown): value is PlacementMetadata {
  if (!value || typeof value !== 'object') return false;
  const data = value as PlacementMetadata;
  const region = (item: Region) => item && Number.isFinite(item.start) && Number.isFinite(item.end) && item.start <= item.end;
  return typeof data.patternId === 'string' && OBSTACLE_PATTERNS.some(pattern => pattern.id === data.patternId)
    && typeof data.obstacleId === 'string' && Object.prototype.hasOwnProperty.call(OBSTACLE_REGISTRY, data.obstacleId) && obstacleReady(data.obstacleId)
    && region(data.takeoff) && region(data.landing) && Number.isFinite(data.clearUntil)
    && data.clearUntil >= data.landing.end && Number.isFinite(data.warningStart)
    && Number.isFinite(data.spacing) && data.spacing >= 0;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const overlap = (first: Region, second: Region) => first.start < second.end && second.start < first.end;

export class ObstaclePlanner {
  plan(context: PlanningContext): ObstaclePlan {
    if (![context.candidateX, context.riderX, context.riderSpeed, context.riderAcceleration, context.clearUntil]
      .every(Number.isFinite)) throw new RangeError('Planning positions and rider motion must be finite.');
    const random = createLevelRandom(context.level.seed ^ Math.floor(context.candidateX) ^ 0x7a2a4d);
    const directive = context.directive;
    // Reaction budget: pacing-driven when a directive is supplied, otherwise
    // the legacy progression-based bound (identical to pre-Phase-5 behaviour).
    const reactionSeconds = directive
      ? directive.reactionSeconds
      : Math.max(0.95, 1.25 - context.level.difficulty.progression * 0.3);
    const approachTime = Math.max(0, context.candidateX - context.riderX) / Math.max(205, context.riderSpeed);
    const projectedSpeed = clamp(context.riderSpeed + context.riderAcceleration * approachTime,
      BICYCLE_PHYSICS.minSpeed, BICYCLE_PHYSICS.maxSpeed);
    // Phase 11 — the planning corridor follows the rider's projected speed
    // (natural cruise ≈ 266–305 px/s) instead of always assuming max speed,
    // but never below the max-speed fairness floor: a sprinting rider must
    // still get a full reaction window (independent validator: ≥ 0.9 s at
    // max speed; we hold 0.95 s so metadata never sits on the line).
    // Traversal validation below still tests every placement across the full
    // speed envelope [minSpeed, 300, maxSpeed, projected].
    const reactionDistance = Math.max(
      BICYCLE_PHYSICS.maxSpeed * 0.95, projectedSpeed * reactionSeconds);
    const options: TraversalOptions = {
      speeds: [...new Set([BICYCLE_PHYSICS.minSpeed, 300, BICYCLE_PHYSICS.maxSpeed, projectedSpeed])],
      modes: ['tap', 'hold'], timingMargin: 8,
    };
    const rejected: PlacementRejection[] = [];
    // Phase 11 — obstacle-to-obstacle target from the directive's frequency
    // band (design target; physics floors below always win). Falls back to
    // the legacy random tail when no directive supplies a band.
    const nearbyEndX = context.nearby.reduce((furthest, obstacle) =>
      Math.max(furthest, obstacle.x + (obstacle.width ?? 40)), 0);
    const recover = (reason?: string): ObstaclePlan => {
      // Wave valleys schedule one deliberate scenic beat (pattern F: a longer
      // coin-filled stretch with no hazards); ordinary recovery rolls stay
      // short. Both are bounded by the caller's consecutive-slot guard so
      // empty stretches can never chain into the multi-thousand-pixel gaps
      // the Phase 11 audit measured.
      const scenic = directive?.scenicRecovery === true;
      // Phase 11 — an ordinary recovery slot consumes its band slot without
      // adding distance: the successor comes at normal band spacing from the
      // last placement (the old 0.9–1.15 × gapMax span stacked on top of the
      // band and doubled the effective gap). Scenic beats keep their
      // deliberate extra length, slightly tightened from 1.5–2.2 × to
      // 1.2–1.7 × gapMax so a valley breathes ~9–12 s, not 15. Every
      // recovery still advances the cursor (≥ 120 px, ≥ 240 px for the
      // no-feasible fallback) so populateAhead's planning loop can never
      // stall on unplaceable terrain.
      const span = directive?.gapMaxPx
        ? directive.gapMaxPx * (scenic ? 1.2 + random() * 0.5 : 0)
        : 720 + random() * 320;
      const base = Math.max(nearbyEndX + (directive?.gapMinPx ?? 500), context.clearUntil + reactionDistance);
      const advance = reason ? 240 : 120;
      return {
        patternId: 'recovery', obstacles: [], clearUntil: context.clearUntil,
        nextX: Math.max(base, context.candidateX + (scenic ? span : advance)),
        rejected: reason ? [...rejected, { x: context.candidateX, patternId: 'recovery', reason }] : rejected,
      };
    };

    // Wave valleys and low-intensity zones schedule deliberate recovery
    // sections; the legacy flat chance keeps directive-less callers unchanged.
    // Phase 11 — a recovery slot never follows another recovery slot, and at
    // most two may land inside the recent window: the audit measured chains
    // of up to nine consecutive empty slots (12.6 kpx) because recovery
    // plans were invisible to the repetition memory. A deliberate calm
    // stretch (calm-journey events drive recoveryChance to 1) is exempt:
    // its emptiness is the event's designed identity, not an accident.
    const recentForRecovery = directive ? (context.recentPatterns ?? []) : [];
    const recentRecoveries = recentForRecovery.slice(-5).filter(id => id === 'recovery').length;
    const previousWasRecovery = recentForRecovery[recentForRecovery.length - 1] === 'recovery';
    const deliberateCalm = (directive?.recoveryChance ?? 0) >= 0.95;
    const recoveryBlocked = !deliberateCalm && (previousWasRecovery || recentRecoveries >= 2);
    if (!recoveryBlocked && random() < (directive?.recoveryChance ?? 0.17)) return recover();
    const availability = patternAvailability(context.level);
    const candidates = OBSTACLE_PATTERNS.filter(pattern => availability.find(item => item.id === pattern.id)?.available)
      .filter(pattern => !pattern.requires.includes('bridge') || context.candidateX >= context.bridgeAllowedAfter)
      .filter(pattern => !pattern.requires.includes('ramp') || context.candidateX >= context.rampAllowedAfter)
      .filter(pattern => !directive?.safeApproach || !patternIsDangerous(pattern.id));
    // Weighted selection tuned to the pacing target: patterns whose challenge
    // rating matches the directive's intensity dominate, recent patterns are
    // exponentially discounted, and everything stays seeded and deterministic.
    // Phase 9C — the level's dominant obstacle families (obstacleFocus) get a
    // weight boost; availability and validation are never reduced.
    const recent = directive ? (context.recentPatterns ?? []) : [];
    const focus = context.level.obstacleFocus;
    // Phase 11 — family floors: families absent from the recent schedule get
    // a strong weight boost so every eligible family of the environment
    // genuinely appears (the audit measured snowballs/icicles/branches/
    // swinging logs at ~one per 100 kpx or less). Pure weight bias —
    // availability and validation are never relaxed.
    const recentPlacedIds = recent.filter(id => id !== 'recovery');
    const recentFamilies = new Set(recentPlacedIds.slice(-6).flatMap(id =>
      OBSTACLE_PATTERNS.find(pattern => pattern.id === id)?.requires ?? []));
    const weights = candidates.map(pattern => {
      let weight = pattern.weight;
      if (directive) {
        const band = directive.patternBand ?? 0.22;
        const delta = pattern.rating - directive.patternIntensity;
        weight *= Math.max(0.12, Math.exp(-(delta * delta) / (2 * band * band)));
        const repeats = recent.reduce((count, id) => count + (id === pattern.id ? 1 : 0), 0);
        weight *= 0.5 ** repeats;
        // Phase 9E — a pattern already scheduled twice back-to-back is benched
        // entirely while any alternative exists (high-level theme pools could
        // otherwise chain the same demanding pattern four times). Weights,
        // availability and validation are otherwise unchanged.
        if (
          recent.length >= 2
          && recent[recent.length - 1] === pattern.id
          && recent[recent.length - 2] === pattern.id
          && candidates.some((other) => other.id !== pattern.id)
        ) {
          weight = 0;
        }
        // Phase 11 — family floor boost.
        if (!pattern.requires.some(id => recentFamilies.has(id))) weight *= 3.2;
      }
      if (focus && focus.length) {
        weight *= pattern.requires.some(id => focus.includes(id)) ? 1.5 : 0.8;
      }
      // Phase 9D — event preference (mountain crossing → bridges, rare
      // challenge → big lines, falling hazards → timed drops). Pure weight
      // bias: the full validation pipeline still applies.
      if (context.hint && context.hint.prefer.length) {
        weight *= context.hint.prefer.includes(pattern.id) ? 6 : 0.55;
      }
      return weight;
    });
    for (let attempt = 0; attempt < 3 && candidates.length; attempt++) {
      // Phase 9D — the first attempt of a hinted plan draws from the event's
      // preferred patterns (weighted, so crossings still vary between rope
      // bridges, broken bridges and platforms). Later attempts fall back to
      // the full weighted pool. Availability and validation are unchanged.
      const pool = attempt === 0 && context.hint?.prefer.length
        ? candidates.map((pattern, position) => ({ pattern, position }))
          .filter((entry) => context.hint!.prefer.includes(entry.pattern.id))
        : null;
      let index: number;
      if (pool && pool.length) {
        const total = pool.reduce((sum, entry) => sum + weights[entry.position], 0);
        let pick = random() * total;
        let chosen = pool[pool.length - 1];
        for (const entry of pool) {
          if (pick < weights[entry.position]) {
            chosen = entry;
            break;
          }
          pick -= weights[entry.position];
        }
        index = chosen.position;
      } else {
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        let pick = random() * total;
        index = 0;
        while (index < weights.length - 1 && pick >= weights[index]) pick -= weights[index++];
      }
      const pattern = candidates.splice(index, 1)[0];
      weights.splice(index, 1);
      let plan = this.build(pattern, context, options, reactionDistance, random);
      // Phase 9D — event-preferred patterns earn positional retries so a
      // themed window delivers its flavour even where the terrain at the
      // candidate spot is hostile. The shifts span more than a terrain chunk
      // (640 px) so at least one retry lands in a different slope zone. Same
      // validation, shifted spot.
      if (typeof plan === 'string' && context.hint?.prefer.includes(pattern.id)) {
        for (const shift of [200, 420, 700, 1000]) {
          plan = this.build(pattern, { ...context, candidateX: context.candidateX + shift }, options, reactionDistance, random);
          if (typeof plan !== 'string') break;
        }
      }
      if (typeof plan === 'string') {
        rejected.push({ x: context.candidateX, patternId: pattern.id, reason: plan });
        continue;
      }
      const extraRecovery = pattern.id === 'log-recovery' ? 600 : 0;
      // Inter-group spacing: pacing-driven base plus conservative corridors —
      // dangerous patterns earn extra recovery room, and a dangerous pattern
      // directly after another dangerous landing is spaced further still.
      const spacingBase = directive ? directive.minSpacing : 110;
      const dangerPad = directive
        ? directive.dangerRecovery * (patternIsDangerous(pattern.id) ? 1 : 0.3)
        : 0;
      const previous = recent.length ? recent[recent.length - 1] : undefined;
      const stackingPad = directive && previous !== undefined
        && patternIsDangerous(previous) && patternIsDangerous(pattern.id)
        ? directive.dangerRecovery * 0.6
        : 0;
      // Phase 9D — while an event prefers certain patterns, a non-preferred
      // plan schedules its successor sooner so the event gets another shot
      // inside its window. Safety is unaffected: every placement still runs
      // the full validation pipeline and honours the reaction distance.
      const hinted = context.hint && context.hint.prefer.length > 0;
      const offHint = hinted && !context.hint!.prefer.includes(pattern.id);
      // Phase 11 — the successor is scheduled inside the directive's
      // frequency band (wave peaks aim at the tight end, calm stretches at
      // the loose end), but never closer than the physics floors: reaction
      // corridor, validation clear pads and the danger/stacking recovery.
      const floorX = plan.clearUntil + reactionDistance + spacingBase + extraRecovery + dangerPad + stackingPad;
      const lastPlacedX = plan.obstacles.length
        ? plan.obstacles[plan.obstacles.length - 1].x
        : Math.max(context.candidateX, nearbyEndX);
      const nextX = directive?.gapMinPx && directive?.gapMaxPx
        ? Math.max(floorX, lastPlacedX + lerp(directive.gapMaxPx, directive.gapMinPx,
          clamp01(directive.wave?.tension ?? 0.7)) * (0.85 + random() * 0.3))
        : floorX + random() * 180;
      return {
        patternId: pattern.id, obstacles: plan.obstacles, clearUntil: plan.clearUntil,
        nextX: offHint
          ? Math.max(plan.clearUntil + reactionDistance + 240 + random() * 200, context.candidateX + 620)
          : nextX,
        rejected,
      };
    }
    return recover('No feasible pattern in the bounded retry budget');
  }

  private build(
    pattern: Pattern, context: PlanningContext, options: TraversalOptions,
    reactionDistance: number, random: () => number,
  ): { obstacles: PlannedObstacle[]; clearUntil: number } | string {
    const { surface } = context;
    if (pattern.downhill && (surface(context.candidateX + 8) - surface(context.candidateX - 8)) / 16 < 0.04) {
      return 'Downhill pattern needs a descending surface';
    }
    const obstacles: PlannedObstacle[] = [];
    let x = context.candidateX;
    let clearUntil = context.clearUntil;

    for (const id of pattern.sequence) {
      let validation: LandingValidation;
      let width: number | undefined;
      let kind: PlannedObstacle['kind'];
      let bridged: boolean | undefined;
      if (id === 'bridge') {
        width = 220 + random() * 70;
        if (!validateBridge(surface, x, width)) return 'Bridge deck slope outside safe limits';
        validation = {
          safe: true, clearUntil: x + width + 180,
          takeoff: { start: x - 35, end: x },
          landing: { start: x + width, end: x + width + 90 },
        };
        kind = 'gap';
        bridged = true;
      } else if (id === 'moving-platform') {
        // A bobbing platform fully covers its gap: same guaranteed-support
        // mechanics as the rope bridge, with a vertical bob for timing read.
        width = 128 + random() * 34;
        if (!validateBridge(surface, x, width)) return 'Moving-platform deck slope outside safe limits';
        validation = {
          safe: true, clearUntil: x + width + 180,
          takeoff: { start: x - 35, end: x },
          landing: { start: x + width, end: x + width + 90 },
        };
        kind = 'gap';
        bridged = true;
      } else if (id === 'cliff' || id === 'broken-bridge') {
        // Sheer-face and plank-stub variants of the validated gap envelope.
        width = id === 'cliff' ? 106 + random() * 44 : 88 + random() * 34;
        validation = validateGap(surface, x, width, options);
        kind = 'gap';
      } else if (id === 'ice') {
        width = 150 + random() * 110;
        validation = validateIcePatch(surface, x, width);
        kind = 'ice';
      } else if (id === 'icicle' || id === 'branch') {
        validation = validateFallingHazard(surface, x);
        kind = id;
      } else if (id === 'snowball') {
        validation = validateSnowball(surface, x, options);
        kind = id;
      } else if (id === 'gap') {
        width = 82 + random() * 48;
        validation = validateGap(surface, x, width, options);
        kind = 'gap';
      } else if (id === 'swinging-log') {
        validation = validateSwingingLog(surface, x, options);
        kind = id;
      } else if (id === 'ramp') {
        validation = validateRamp(surface, x, options);
        kind = 'ramp';
      } else {
        validation = validateObstacle(surface, x, id, options);
        kind = id;
      }

      if (pattern.coupled) {
        // Build the ramp and its gap as a single trajectory, not two conflicting jumps.
        const gapX = x + 135;
        const gapWidth = 82 + random() * 20;
        validation = validateRampGap(surface, x, gapX, gapWidth, options);
        if (!validation.safe) return validation.reason ?? 'Ramp-gap trajectory rejected';
        const metadata = this.metadata(pattern.id, id, validation, x, context, reactionDistance);
        const rejection = this.conflict(metadata, x, gapX + gapWidth, context, clearUntil, reactionDistance);
        if (rejection) return rejection;
        obstacles.push({ kind: 'ramp', x, plan: metadata });
        obstacles.push({ kind: 'gap', x: gapX, width: gapWidth, plan: { ...metadata, obstacleId: 'gap' } });
        clearUntil = validation.clearUntil;
        break;
      }

      if (!validation.safe) return validation.reason ?? 'Trajectory rejected';
      const metadata = this.metadata(pattern.id, id, validation, x, context, reactionDistance);
      const rejection = this.conflict(metadata, x, x + (width ?? 40), context, clearUntil, reactionDistance);
      if (rejection) return rejection;
      if (obstacles.length) {
        const previous = obstacles[obstacles.length - 1];
        metadata.spacing = x - previous.x - (previous.width ?? 40);
      }
      obstacles.push({
        kind, x, width, bridged, plan: metadata, variant: random(),
        phase: id === 'swinging-log' || id === 'icicle' || id === 'snowball' || id === 'branch' || id === 'moving-platform'
          ? random() * Math.PI * 2
          : undefined,
      });
      clearUntil = validation.clearUntil;
      // Separate the next obstacle's takeoff from the previous landing and recovery.
      x = clearUntil + reactionDistance + 110;
    }
    if (!obstacles.length) return 'Pattern has no active implementations';
    return { obstacles, clearUntil };
  }

  private metadata(
    patternId: string, id: ActiveObstacleId, validation: LandingValidation, x: number,
    context: PlanningContext, reactionDistance: number,
  ): PlacementMetadata {
    const previousX = context.nearby.reduce((position, obstacle) =>
      obstacle.kind === 'coin' ? position : Math.max(position, obstacle.x + (obstacle.width ?? 40)), context.riderX);
    return {
      patternId, obstacleId: id, takeoff: validation.takeoff!, landing: validation.landing!,
      clearUntil: validation.clearUntil,
      warningStart: Math.min(x, validation.takeoff!.start) - reactionDistance,
      spacing: Math.max(0, x - previousX),
    };
  }

  private conflict(
    plan: PlacementMetadata, x: number, end: number, context: PlanningContext,
    clearUntil: number, reactionDistance: number,
  ): string | undefined {
    const responsePoint = Math.min(x - 40, plan.takeoff.start);
    if (responsePoint - context.riderX < reactionDistance) return 'Insufficient visible reaction distance';
    if (plan.takeoff.start < clearUntil) return 'Takeoff overlaps the preceding landing/recovery corridor';
    const footprint = { start: Math.min(x - 40, plan.takeoff.start), end: Math.max(end, plan.clearUntil) };
    if (context.reserved.some(region => overlap(footprint, region))) return 'Pattern overlaps a protected start/house area';
    for (const nearby of context.nearby) {
      if (!['rock', 'tree', 'log', 'gap', 'ramp', 'swinging-log', 'root', 'fence', 'ice', 'icicle', 'snowball', 'branch'].includes(nearby.kind)) continue;
      const occupied = { start: nearby.plan?.takeoff.start ?? nearby.x - 120, end: nearby.plan?.clearUntil ?? nearby.x + (nearby.width ?? 40) + 150 };
      if (overlap(footprint, occupied)) return 'Nearby obstacle conflicts with this traversal corridor';
    }
    return undefined;
  }
}
