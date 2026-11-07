// Phase 9E — independent physics-feasibility auditing of generated placements.
//
// The ObstaclePlanner validates every placement before scheduling it (its own
// ballistic simulation in terrain.ts). This module re-verifies the *placed*
// metadata with a second, independent simulation built directly from the live
// BICYCLE_PHYSICS constants and the runtime collision rules in
// SnowGameEngine.checkCollision, and adds the checks the planner does not
// perform: moving-hazard timing sweeps (can every arrival phase be survived?),
// reaction-distance floors, deck continuity for bridges and platforms, and
// coin reachability.
//
// It is used by the Phase 9E audit tests across thousands of placements and by
// the developer diagnostics (`?dev=1`) to surface fairness violations live.
// Pure functions only — no engine state is touched.

import { BICYCLE_PHYSICS } from './riderPhysics';
import {
  OBSTACLE_REGISTRY, branchPose, iciclePose, platformBob, snowballPose, swingingLogPose,
} from './obstacleRegistry';

/** Anything the planner can place (subset of PlannedObstacle fields). */
export interface FeasibleObstacle {
  kind: 'rock' | 'log' | 'tree' | 'gap' | 'ramp' | 'swinging-log'
    | 'root' | 'fence' | 'ice' | 'icicle' | 'snowball' | 'branch';
  x: number;
  width?: number;
  bridged?: boolean;
  phase?: number;
  plan?: {
    patternId: string;
    obstacleId: string;
    takeoff: { start: number; end: number };
    landing: { start: number; end: number };
    clearUntil: number;
    warningStart: number;
    spacing: number;
  };
}

export interface FeasibilityViolation {
  x: number;
  kind: string;
  reason: string;
}

/** Independent ballistic arc using the live physics constants. */
export interface JumpSimulation {
  landingX: number;
  landingY: number;
  /** Highest the rider's bottom rises above the local ground (px). */
  apexAboveGround: number;
}

const SPEED_GRID = [205, 240, 280, 320, 360, 400, 440, 475] as const;
const DELTA = 1 / 120;

/**
 * Integrates a jump with the live step() semantics: horizontal at constant
 * speed (plus the small airborne acceleration), gravity 920, ground contact
 * when the rider's bottom reaches the surface.
 */
export function simulateJump(
  surface: (x: number) => number,
  x0: number,
  y0: number,
  speed: number,
): JumpSimulation {
  const boost = Math.min(BICYCLE_PHYSICS.maxJumpBoost, speed * BICYCLE_PHYSICS.jumpSpeedFactor);
  let vy = -(BICYCLE_PHYSICS.jumpVelocity + boost);
  let x = x0;
  let y = y0;
  let apexAboveGround = 0;
  for (let frame = 0; frame < 480; frame += 1) {
    x += speed * DELTA;
    speed = Math.min(BICYCLE_PHYSICS.maxSpeed, speed + BICYCLE_PHYSICS.airborneAcceleration * DELTA);
    vy += BICYCLE_PHYSICS.gravity * DELTA;
    y += vy * DELTA;
    apexAboveGround = Math.max(apexAboveGround, surface(x) - (y + BICYCLE_PHYSICS.collisionBottom));
    const ground = surface(x) - BICYCLE_PHYSICS.groundOffset;
    if (y >= ground && vy > 0) {
      return { landingX: x, landingY: y, apexAboveGround };
    }
  }
  return { landingX: x, landingY: y, apexAboveGround };
}

/** Rider's grounded y at x (same convention as the engine: surface − 5). */
const groundedY = (surface: (x: number) => number, x: number) => surface(x) - BICYCLE_PHYSICS.groundOffset;

function staticCollision(surface: (x: number) => number, obstacle: FeasibleObstacle, x: number, y: number): boolean {
  const entry = OBSTACLE_REGISTRY[obstacle.kind as 'rock'];
  if (!entry?.collision) return false;
  const { radius, height } = entry.collision;
  if (Math.abs(x - obstacle.x) > radius + BICYCLE_PHYSICS.collisionPadding) return false;
  return y + BICYCLE_PHYSICS.collisionBottom > surface(obstacle.x) - height + BICYCLE_PHYSICS.collisionInset;
}

/**
 * Re-validates one placement. `surface` is the absolute ground-height function
 * (the same one the engine's terrainAt provides). Returns every violation.
 */
export function validateObstaclePlacement(
  obstacle: FeasibleObstacle,
  surface: (x: number) => number,
): FeasibilityViolation[] {
  const violations: FeasibilityViolation[] = [];
  const fail = (reason: string) => violations.push({ x: obstacle.x, kind: obstacle.kind, reason });
  const plan = obstacle.plan;
  const width = obstacle.width ?? 0;

  // Bridges and moving platforms: no jump required — verify deck continuity,
  // slope and (for platforms) bob amplitude against the terrain they replace.
  if (obstacle.kind === 'gap' && obstacle.bridged) {
    if (width <= 0) { fail('bridged gap has no width'); return violations; }
    const deckSlope = Math.abs((surface(obstacle.x + width) - surface(obstacle.x)) / width);
    if (deckSlope > 0.34) fail(`bridge deck slope ${deckSlope.toFixed(2)} exceeds terrain limit`);
    if (obstacle.plan?.obstacleId === 'moving-platform') {
      // Deck = straight lerp between the ends; the bob must stay a rideable step.
      const bob = Math.abs(platformBob(0, obstacle.phase ?? 0));
      if (bob > 5.01) fail(`platform bob amplitude ${bob.toFixed(1)}px exceeds design`);
    }
    return violations;
  }

  // Ice patches are crossed on the ground: the terrain under them must stay
  // gentle so reduced traction remains controllable.
  if (obstacle.kind === 'ice') {
    const w = obstacle.width ?? 150;
    for (let x = obstacle.x - 20; x <= obstacle.x + w + 20; x += 20) {
      const slope = Math.abs((surface(x + 20) - surface(x - 20)) / 40);
      if (slope > 0.25) { fail(`ice patch terrain slope ${slope.toFixed(2)} at +${Math.round(x - obstacle.x)}px`); break; }
    }
    return violations;
  }

  // Moving hazards: timing sweeps. For every arrival phase there must exist a
  // survivable strategy — ride through at some speed in the envelope, or jump
  // over (every hazard is shorter than the jump apex) and land inside the
  // validated clear corridor.
  if (obstacle.kind === 'icicle' || obstacle.kind === 'branch' || obstacle.kind === 'snowball' || obstacle.kind === 'swinging-log') {
    const cycle = obstacle.kind === 'icicle' ? 4.2
      : obstacle.kind === 'branch' ? 5.0
        : obstacle.kind === 'snowball' ? (Math.PI * 2) / 0.85
          : (Math.PI * 2) / 1.5;
    const radius = OBSTACLE_REGISTRY[obstacle.kind].collision!.radius;
    const height = OBSTACLE_REGISTRY[obstacle.kind].collision!.height;
    const phase = obstacle.phase ?? 0;
    const groundY = surface(obstacle.x);
    const clearUntil = plan?.clearUntil ?? obstacle.x + 90;
    const collide = (x: number, y: number, elapsed: number) => {
      if (obstacle.kind === 'icicle' || obstacle.kind === 'branch') {
        const pose = obstacle.kind === 'icicle'
          ? iciclePose(groundY, elapsed, phase)
          : branchPose(groundY, elapsed, phase);
        if (pose.state !== 'falling') return false;
        if (Math.abs(x - obstacle.x) > radius + BICYCLE_PHYSICS.collisionPadding) return false;
        const tip = obstacle.kind === 'icicle' ? pose.y : pose.y + 12;
        return tip > y - 36 && tip < y + 8;
      }
      if (obstacle.kind === 'snowball') {
        const slope = (surface(obstacle.x + 40) - surface(obstacle.x - 40)) / 80;
        const pose = snowballPose(obstacle.x, slope, elapsed, phase);
        if (Math.abs(x - pose.x) > radius + BICYCLE_PHYSICS.collisionPadding) return false;
        return y + BICYCLE_PHYSICS.collisionBottom > surface(pose.x) - height + BICYCLE_PHYSICS.collisionInset;
      }
      const pose = swingingLogPose(obstacle.x, groundY, elapsed, phase);
      if (Math.abs(x - pose.x) > radius + BICYCLE_PHYSICS.collisionPadding) return false;
      if (y - 30 >= pose.y + height / 2) return false;
      return y + BICYCLE_PHYSICS.collisionBottom > pose.y - height / 2 + BICYCLE_PHYSICS.collisionInset;
    };
    const samples = obstacle.kind === 'snowball' || obstacle.kind === 'swinging-log' ? 24 : 28;
    let safeRide = 0;
    let safeOverall = 0;
    for (let index = 0; index < samples; index += 1) {
      const arrival = (index / samples) * cycle;
      const rideOk = SPEED_GRID.some((speed) => {
        let x = obstacle.x - 360;
        let elapsed = arrival - 360 / speed;
        for (let frame = 0; frame < Math.ceil(800 / speed / DELTA) + 8; frame += 1) {
          x += speed * DELTA;
          elapsed += DELTA;
          if (collide(x, groundedY(surface, x), elapsed)) return false;
        }
        return true;
      });
      if (rideOk) safeRide += 1;
      // Jump strategy: take off 140px early. The arc clears the hazard
      // vertically (every hazard is far shorter than the ~186px apex) and must
      // land inside the validated clear corridor before the next plan.
      const jumpOk = SPEED_GRID.some((speed) => {
        const takeoff = obstacle.x - 140;
        const boost = Math.min(BICYCLE_PHYSICS.maxJumpBoost, speed * BICYCLE_PHYSICS.jumpSpeedFactor);
        let vy = -(BICYCLE_PHYSICS.jumpVelocity + boost);
        let x = takeoff;
        let y = groundedY(surface, x);
        let elapsed = arrival - 140 / speed;
        for (let frame = 0; frame < 480; frame += 1) {
          x += speed * DELTA;
          vy += BICYCLE_PHYSICS.gravity * DELTA;
          y += vy * DELTA;
          elapsed += DELTA;
          if (y >= surface(x) - BICYCLE_PHYSICS.groundOffset && vy > 0) break;
          if (collide(x, y, elapsed)) return false;
        }
        const landingSlope = Math.abs((surface(x + 20) - surface(x - 20)) / 40);
        return x <= clearUntil + 450 && landingSlope <= 0.42;
      });
      if (rideOk || jumpOk) safeOverall += 1;
    }
    if (safeOverall / samples < 0.999) fail(`${samples - safeOverall} of ${samples} arrival phases have no survivable strategy`);
    return violations;
  }

  if (!plan) { fail('placement missing plan metadata'); return violations; }

  // Reaction floor: the warning must be visible for at least ~0.95 s of
  // riding at maximum speed (the engine's legacy reaction floor).
  const reaction = (plan.takeoff.start - plan.warningStart) / BICYCLE_PHYSICS.maxSpeed;
  if (reaction < 0.9) fail(`reaction window ${reaction.toFixed(2)}s below the 0.9s floor`);

  // Jump checks. The planner guarantees the takeoff band ± the timing margin
  // (8px); this validator samples a slightly wider ±10 and, for gaps, also the
  // far edge of the band (the pit edge is where a late jump matters most).
  const starts: { x: number; y: number; label: string }[] = [];
  if (obstacle.kind === 'ramp') {
    starts.push({ x: obstacle.x + 100, y: surface(obstacle.x + 100) - 43, label: 'lip' });
  } else if (obstacle.kind === 'gap') {
    starts.push({ x: plan.takeoff.start - 10, y: groundedY(surface, plan.takeoff.start - 10), label: 'early' });
    starts.push({ x: plan.takeoff.start + 10, y: groundedY(surface, plan.takeoff.start + 10), label: 'mid' });
    starts.push({ x: plan.takeoff.end, y: groundedY(surface, plan.takeoff.end), label: 'edge' });
  } else {
    starts.push({ x: plan.takeoff.start - 10, y: groundedY(surface, plan.takeoff.start - 10), label: 'early' });
    starts.push({ x: plan.takeoff.start + 10, y: groundedY(surface, plan.takeoff.start + 10), label: 'mid' });
  }

  for (const start of starts) {
    for (const speed of SPEED_GRID) {
      const flight = simulateJump(surface, start.x, start.y, speed);
      const landingSlope = Math.abs((surface(flight.landingX + 20) - surface(flight.landingX - 20)) / 40);
      if (landingSlope > 0.42) {
        fail(`${start.label} takeoff @${speed}: landing slope ${landingSlope.toFixed(2)}`);
      }
      if (flight.landingX < plan.landing.start - 25 || flight.landingX > plan.landing.end + 25) {
        fail(`${start.label} takeoff @${speed}: lands at ${Math.round(flight.landingX)} outside the validated band [${Math.round(plan.landing.start)}, ${Math.round(plan.landing.end)}]`);
        continue;
      }
      if (obstacle.kind === 'gap') {
        // The pit itself must be cleared, not flown into.
        if (flight.landingX >= obstacle.x - 5 && flight.landingX <= obstacle.x + width + 5) {
          fail(`${start.label} takeoff @${speed}: lands inside the gap`);
        }
        continue;
      }
      if (staticCollision(surface, obstacle, flight.landingX, flight.landingY)) {
        fail(`${start.label} takeoff @${speed}: lands on the ${obstacle.kind}`);
      }
      // While crossing the obstacle's horizontal collision window the rider
      // must be above it (jump-over clearance with the runtime collision rule).
      const entry = OBSTACLE_REGISTRY[obstacle.kind as 'rock'];
      if (entry?.collision) {
        const { radius, height } = entry.collision;
        const windowStart = obstacle.x - radius - BICYCLE_PHYSICS.collisionPadding;
        const windowEnd = obstacle.x + radius + BICYCLE_PHYSICS.collisionPadding;
        if (windowStart > start.x && windowEnd < flight.landingX) {
          // sample the arc across the window
          const boost = Math.min(BICYCLE_PHYSICS.maxJumpBoost, speed * BICYCLE_PHYSICS.jumpSpeedFactor);
          let vy = -(BICYCLE_PHYSICS.jumpVelocity + boost);
          let x = start.x;
          let y = start.y;
          let clear = true;
          for (let frame = 0; frame < 480 && x < flight.landingX; frame += 1) {
            x += speed * DELTA;
            vy += BICYCLE_PHYSICS.gravity * DELTA;
            y += vy * DELTA;
            if (x >= windowStart && x <= windowEnd
              && y + BICYCLE_PHYSICS.collisionBottom > surface(obstacle.x) - height + BICYCLE_PHYSICS.collisionInset) {
              clear = false;
              break;
            }
          }
          if (!clear) fail(`${start.label} takeoff @${speed}: clips the ${obstacle.kind} mid-arc`);
        }
      }
    }
  }
  return violations;
}

export interface FeasibilitySummary {
  checked: number;
  violations: FeasibilityViolation[];
  /** Smallest observed reaction window (seconds) across checked placements. */
  minReactionSeconds: number;
  /** Smallest landing-band margin (px, negative = outside the band). */
  minLandingMargin: number;
}

const JUMP_TRAVERSED = new Set(['rock', 'log', 'tree', 'root', 'fence', 'gap', 'ramp']);

/** Validates a batch of placements and aggregates analytics for reporting. */
export function summarizePlacements(
  obstacles: readonly FeasibleObstacle[],
  surface: (x: number) => number,
): FeasibilitySummary {
  let minReaction = Number.POSITIVE_INFINITY;
  let minLandingMargin = Number.POSITIVE_INFINITY;
  let checked = 0;
  const violations: FeasibilityViolation[] = [];
  for (const obstacle of obstacles) {
    checked += 1;
    violations.push(...validateObstaclePlacement(obstacle, surface));
    const plan = obstacle.plan;
    if (plan) {
      minReaction = Math.min(minReaction, (plan.takeoff.start - plan.warningStart) / BICYCLE_PHYSICS.maxSpeed);
      if (JUMP_TRAVERSED.has(obstacle.kind)) {
        for (const start of [plan.takeoff.start, plan.takeoff.end]) {
          for (const speed of SPEED_GRID) {
            const flight = simulateJump(surface, start, groundedY(surface, start), speed);
            minLandingMargin = Math.min(
              minLandingMargin,
              flight.landingX - plan.landing.start,
              plan.landing.end - flight.landingX,
            );
          }
        }
      }
    }
  }
  return {
    checked,
    violations,
    minReactionSeconds: Number.isFinite(minReaction) ? minReaction : 0,
    minLandingMargin: Number.isFinite(minLandingMargin) ? minLandingMargin : 0,
  };
}

/** Maximum glowstone offset reachable by a grounded rider with one jump. */
export function maxReachableCoinOffset(): number {
  const boost = Math.min(BICYCLE_PHYSICS.maxJumpBoost, BICYCLE_PHYSICS.maxSpeed * BICYCLE_PHYSICS.jumpSpeedFactor);
  const apex = (BICYCLE_PHYSICS.jumpVelocity + boost) ** 2 / (2 * BICYCLE_PHYSICS.gravity);
  // Rider core sits 21px above the wheel contact; pickup needs |dy| < 31.
  return apex + BICYCLE_PHYSICS.groundOffset + 21 + 30;
}
