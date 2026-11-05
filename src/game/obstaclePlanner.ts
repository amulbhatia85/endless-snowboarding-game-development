import { createLevelRandom, type LevelConfiguration } from './levelManager';
import { OBSTACLE_REGISTRY, obstacleReady, type ActiveObstacleId, type ObstacleId, type ObstacleGroup } from './obstacleRegistry';
import { BICYCLE_PHYSICS } from './riderPhysics';
import {
  validateGap, validateRamp, validateBridge, validateObstacle, validateRampGap, validateSwingingLog,
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
  kind: 'rock' | 'log' | 'tree' | 'gap' | 'ramp' | 'swinging-log';
  x: number;
  width?: number;
  bridged?: boolean;
  phase?: number;
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
  downhill?: boolean;
  coupled?: boolean;
}
export const OBSTACLE_PATTERNS: readonly Pattern[] = [
  { id: 'single-rock', minLevel: 1, weight: 24, requires: ['rock'], sequence: ['rock'] },
  { id: 'single-log', minLevel: 1, weight: 19, requires: ['log'], sequence: ['log'] },
  { id: 'single-tree', minLevel: 1, weight: 10, requires: ['tree'], sequence: ['tree'] },
  { id: 'log-recovery', minLevel: 1, weight: 10, requires: ['log'], sequence: ['log'] },
  { id: 'small-gap', minLevel: 1, weight: 9, requires: ['gap'], sequence: ['gap'] },
  { id: 'rope-bridge', minLevel: 1, weight: 3, requires: ['bridge'], sequence: ['bridge'] },
  { id: 'controlled-ramp', minLevel: 1, weight: 3, requires: ['ramp'], sequence: ['ramp'] },
  { id: 'downhill-rock', minLevel: 2, weight: 7, requires: ['rock'], sequence: ['rock'], downhill: true },
  { id: 'double-logs', minLevel: 3, weight: 16, requires: ['log'], sequence: ['log', 'log'] },
  { id: 'ramp-gap', minLevel: 4, weight: 9, requires: ['ramp', 'gap'], sequence: ['ramp', 'gap'], coupled: true },
  { id: 'advanced-static-sequence', minLevel: 6, weight: 13, requires: ['rock', 'log'], sequence: ['rock', 'log', 'rock'] },
  // Moving hazards require a complete renderer, collider, warning and validated envelope.
  { id: 'warned-swinging-log', minLevel: 8, weight: 10, requires: ['swinging-log'], sequence: ['swinging-log'] },
];

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
    const reactionSeconds = Math.max(0.95, 1.25 - context.level.difficulty.progression * 0.3);
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

    if (random() < 0.17) return recover();
    const availability = patternAvailability(context.level);
    const candidates = OBSTACLE_PATTERNS.filter(pattern => availability.find(item => item.id === pattern.id)?.available)
      .filter(pattern => !pattern.requires.includes('bridge') || context.candidateX >= context.bridgeAllowedAfter)
      .filter(pattern => !pattern.requires.includes('ramp') || context.candidateX >= context.rampAllowedAfter);
    const weights = candidates.map(pattern => pattern.weight);
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
      return {
        patternId: pattern.id, obstacles: plan.obstacles, clearUntil: plan.clearUntil,
        nextX: plan.clearUntil + reactionDistance + 110 + extraRecovery + random() * 180,
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
      obstacles.push({ kind, x, width, bridged, plan: metadata, phase: id === 'swinging-log' ? random() * Math.PI * 2 : undefined });
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
      if (!['rock', 'tree', 'log', 'gap', 'ramp', 'swinging-log'].includes(nearby.kind)) continue;
      const occupied = { start: nearby.plan?.takeoff.start ?? nearby.x - 120, end: nearby.plan?.clearUntil ?? nearby.x + (nearby.width ?? 40) + 150 };
      if (overlap(footprint, occupied)) return 'Nearby obstacle conflicts with this traversal corridor';
    }
    return undefined;
  }
}
