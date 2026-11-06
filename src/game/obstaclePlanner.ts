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
  { id: 'icicle-drop', minLevel: 6, weight: 8, requires: ['icicle'], sequence: ['icicle'], rating: 0.62 },
  { id: 'snowball-roll', minLevel: 5, weight: 8, requires: ['snowball'], sequence: ['snowball'], rating: 0.74 },
  { id: 'cliff-jump', minLevel: 7, weight: 7, requires: ['cliff'], sequence: ['cliff'], rating: 0.85 },
  { id: 'broken-bridge', minLevel: 6, weight: 7, requires: ['broken-bridge'], sequence: ['broken-bridge'], rating: 0.8 },
  { id: 'moving-platform', minLevel: 6, weight: 6, requires: ['moving-platform'], sequence: ['moving-platform'], rating: 0.66 },
  { id: 'falling-branch', minLevel: 6, weight: 8, requires: ['branch'], sequence: ['branch'], rating: 0.78 },
  // Moving hazards require a complete renderer, collider, warning and validated envelope.
  { id: 'warned-swinging-log', minLevel: 8, weight: 10, requires: ['swinging-log'], sequence: ['swinging-log'], rating: 0.85 },
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
   *  budget, flat weights, 17 % recovery) so existing callers are unchanged. */
  directive?: DifficultyDirective;
  /** Recently scheduled pattern ids, oldest first — drives repetition control. */
  recentPatterns?: readonly string[];
}

export function patternAvailability(level: LevelConfiguration): { id: string; category: ObstacleGroup; available: boolean; reason?: string }[] {
  return OBSTACLE_PATTERNS.map(pattern => {
    const missing = pattern.requires.find(id => !obstacleReady(id));
    const incompatible = pattern.requires.find(id => !level.allowedObstacles.includes(id));
    const reason = missing ? `${missing} implementation incomplete`
      : incompatible ? `${incompatible} not allowed in ${level.environment}`
      : level.number < pattern.minLevel ? `Requires level ${pattern.minLevel}` : undefined;
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
    const reactionDistance = Math.max(BICYCLE_PHYSICS.maxSpeed, projectedSpeed) * reactionSeconds;
    const options: TraversalOptions = {
      speeds: [...new Set([BICYCLE_PHYSICS.minSpeed, 300, BICYCLE_PHYSICS.maxSpeed, projectedSpeed])],
      modes: ['tap', 'hold'], timingMargin: 8,
    };
    const rejected: PlacementRejection[] = [];
    const recover = (reason?: string): ObstaclePlan => ({
      patternId: 'recovery', obstacles: [], clearUntil: context.clearUntil,
      nextX: Math.max(context.candidateX + 720 + random() * 320, context.clearUntil + reactionDistance),
      rejected: reason ? [...rejected, { x: context.candidateX, patternId: 'recovery', reason }] : rejected,
    });

    // Wave valleys and low-intensity zones schedule deliberate recovery
    // sections; the legacy flat chance keeps directive-less callers unchanged.
    if (random() < (directive?.recoveryChance ?? 0.17)) return recover();
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
    const weights = candidates.map(pattern => {
      let weight = pattern.weight;
      if (directive) {
        const delta = pattern.rating - directive.patternIntensity;
        weight *= Math.max(0.12, Math.exp(-(delta * delta) / (2 * 0.22 * 0.22)));
        const repeats = recent.reduce((count, id) => count + (id === pattern.id ? 1 : 0), 0);
        weight *= 0.5 ** repeats;
      }
      if (focus && focus.length) {
        weight *= pattern.requires.some(id => focus.includes(id)) ? 1.9 : 0.72;
      }
      return weight;
    });
    for (let attempt = 0; attempt < 3 && candidates.length; attempt++) {
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let pick = random() * total;
      let index = 0;
      while (index < weights.length - 1 && pick >= weights[index]) pick -= weights[index++];
      const pattern = candidates.splice(index, 1)[0];
      weights.splice(index, 1);
      const plan = this.build(pattern, context, options, reactionDistance, random);
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
      return {
        patternId: pattern.id, obstacles: plan.obstacles, clearUntil: plan.clearUntil,
        nextX: plan.clearUntil + reactionDistance + spacingBase + extraRecovery + dangerPad + stackingPad + random() * 180,
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
