export type ObstacleGroup = 'static' | 'terrain' | 'environmental' | 'moving' | 'combination';
export type ActiveObstacleId =
  | 'rock'
  | 'log'
  | 'tree'
  | 'root'
  | 'fence'
  | 'gap'
  | 'bridge'
  | 'ramp'
  | 'cliff'
  | 'broken-bridge'
  | 'ice'
  | 'icicle'
  | 'snowball'
  | 'swinging-log'
  | 'moving-platform'
  | 'branch'
  | 'gorge'
  | 'ice-boulder';
export type ObstacleId = ActiveObstacleId;

export interface ObstacleDefinition {
  id: ObstacleId;
  group: ObstacleGroup;
  capabilities: { asset: boolean; rendering: boolean; collision: boolean; rules: boolean };
  collision?: { radius: number; height: number };
  requiresWarning: boolean;
}
const ready = { asset: true, rendering: true, collision: true, rules: true };

export const OBSTACLE_REGISTRY: Readonly<Record<ObstacleId, ObstacleDefinition>> = {
  rock: { id: 'rock', group: 'static', capabilities: ready, collision: { radius: 19, height: 23 }, requiresWarning: false },
  log: { id: 'log', group: 'static', capabilities: ready, collision: { radius: 29, height: 26 }, requiresWarning: false },
  // Height 64 (the drawn pine is ~77px): the hitbox covers the trunk and
  // the lower tiers; the thin snowy top tier is forgiving. Radius stays 17.
  tree: { id: 'tree', group: 'static', capabilities: ready, collision: { radius: 17, height: 64 }, requiresWarning: false },
  root: { id: 'root', group: 'static', capabilities: ready, collision: { radius: 22, height: 11 }, requiresWarning: false },
  fence: { id: 'fence', group: 'static', capabilities: ready, collision: { radius: 13, height: 44 }, requiresWarning: true },
  gap: { id: 'gap', group: 'terrain', capabilities: ready, requiresWarning: false },
  bridge: { id: 'bridge', group: 'terrain', capabilities: ready, requiresWarning: false },
  ramp: { id: 'ramp', group: 'terrain', capabilities: ready, requiresWarning: false },
  cliff: { id: 'cliff', group: 'terrain', capabilities: ready, requiresWarning: true },
  'broken-bridge': { id: 'broken-bridge', group: 'terrain', capabilities: ready, requiresWarning: true },
  ice: { id: 'ice', group: 'environmental', capabilities: ready, requiresWarning: false },
  icicle: { id: 'icicle', group: 'environmental', capabilities: ready, collision: { radius: 13, height: 26 }, requiresWarning: true },
  snowball: { id: 'snowball', group: 'environmental', capabilities: ready, collision: { radius: 17, height: 30 }, requiresWarning: true },
  'swinging-log': { id: 'swinging-log', group: 'moving', capabilities: ready, collision: { radius: 30, height: 34 }, requiresWarning: true },
  'moving-platform': { id: 'moving-platform', group: 'moving', capabilities: ready, requiresWarning: true },
  branch: { id: 'branch', group: 'moving', capabilities: ready, collision: { radius: 26, height: 16 }, requiresWarning: true },
  // Phase 13 — deep valleys: a wide gorge variant of the validated gap
  // envelope. Like cliff/broken-bridge it is scheduled as a `gap` obstacle
  // whose plan.obstacleId names the variant; the pit itself is the hazard
  // (falling in is fatal), so there is no extra collision box.
  gorge: { id: 'gorge', group: 'terrain', capabilities: ready, requiresWarning: true },
  // Phase 13 — giant rolling ice boulder: a stateful moving hazard that
  // gravity-accelerates down the terrain toward the rider. Height 58 keeps it
  // comfortably jump-over-able (the jump apex is ~120 px above takeoff).
  'ice-boulder': { id: 'ice-boulder', group: 'moving', capabilities: ready, collision: { radius: 29, height: 58 }, requiresWarning: true },
};

export function obstacleReady(id: ObstacleId): id is ActiveObstacleId;
export function obstacleReady(id: string): boolean;
export function obstacleReady(id: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(OBSTACLE_REGISTRY, id as ObstacleId)) return false;
  const capabilities = OBSTACLE_REGISTRY[id as ObstacleId].capabilities;
  return capabilities.asset && capabilities.rendering && capabilities.collision && capabilities.rules;
}


export function swingingLogPose(x: number, groundY: number, elapsed: number, phase = 0): { x: number; y: number; angle: number } {
  // Smaller jumps (Phase 11 playtest tuning): the log swings less far and
  // hangs lower, so the shorter arc clears it with margin at both speed
  // extremes and on sloped ground.
  const swing = Math.sin(elapsed * 1.5 + phase);
  return { x: x + swing * 14, y: groundY - 24 + Math.cos(elapsed * 1.5 + phase) * 6, angle: swing * 0.25 };
}

/** Deterministic icicle pose over a 4.2s cycle: hang -> shake warning -> fall -> shattered. */
export interface IciclePose {
  y: number;
  state: 'hanging' | 'shaking' | 'falling' | 'shattered';
}

export function iciclePose(groundY: number, elapsed: number, phase = 0): IciclePose {
  const cycle = 4.2;
  const t = (((elapsed + phase) % cycle) + cycle) % cycle;
  const hangY = groundY - 108;
  if (t < 2.0) return { y: hangY, state: 'hanging' };
  if (t < 2.6) return { y: hangY, state: 'shaking' };
  if (t < 2.95) {
    const p = (t - 2.6) / 0.35;
    return { y: hangY + p * p * (groundY - hangY), state: 'falling' };
  }
  return { y: groundY, state: 'shattered' };
}

/** Deterministic falling-branch pose over a 5s cycle: hang -> shake warning -> fall -> landed. */
export interface BranchPose {
  y: number;
  angle: number;
  state: 'hanging' | 'shaking' | 'falling' | 'landed';
}

export function branchPose(groundY: number, elapsed: number, phase = 0): BranchPose {
  const cycle = 5.0;
  const t = (((elapsed + phase) % cycle) + cycle) % cycle;
  const hangY = groundY - 96;
  if (t < 2.8) return { y: hangY, angle: 0.12, state: 'hanging' };
  if (t < 3.5) return { y: hangY, angle: 0.12 + Math.sin(t * 34) * 0.05, state: 'shaking' };
  if (t < 3.9) {
    const p = (t - 3.5) / 0.4;
    return { y: hangY + p * p * (groundY - hangY), angle: 0.12 + p * 1.1, state: 'falling' };
  }
  return { y: groundY, angle: 1.25, state: 'landed' };
}

/**
 * Deterministic snowball patrol: the ball sweeps ±48px around its anchor, with a
 * downhill bias (±16px) derived from the sampled local slope (positive slope =
 * terrain descends toward +x). Rotation follows the sweep so it reads as rolling.
 */
export function snowballPose(x: number, slope: number, elapsed: number, phase = 0): { x: number; rotation: number } {
  // Flatter jump arcs: a tighter patrol (sweep 28 + bias 8 + radius 17 =
  // 53 px corridor) stays clearable in one jump at minimum speed.
  const bias = slope * 8 > 8 ? 8 : slope * 8 < -8 ? -8 : slope * 8;
  const sweep = Math.sin(elapsed * 0.85 + phase) * 28;
  return { x: x + sweep + bias, rotation: -(elapsed * 0.85 + phase) - Math.PI / 2 };
}

/** Vertical bob for moving platforms: ±5px on a ~3.3s period, pure (elapsed, phase). */
export function platformBob(elapsed: number, phase = 0): number {
  return Math.sin(elapsed * 1.9 + phase) * 5;
}

/**
 * Phase 13 — giant rolling ice boulders.
 *
 * Unlike the snowball's deterministic patrol, the boulder is a genuine
 * gravity integration: it is released from its spawn ledge, accelerates down
 * the terrain tangent toward the rider (−x), and its rotation advances by the
 * travelled distance over the radius so it visibly rolls. The pose is a pure
 * function of (spawn x, surface, elapsed, phase) with `phase` acting as the
 * release timestamp — the engine, the feasibility auditor and the renderer all
 * evaluate the identical trajectory, exactly like every other moving hazard.
 */
export const ICE_BOULDER = {
  radius: 29,
  height: 58,
  /** Release speed toward the rider (px/s) before gravity takes over. */
  releaseSpeed: 150,
  /** Floor on the roll speed: a spotted boulder never stalls mid-screen. */
  minSpeed: 150,
  /** Terminal roll speed (px/s). */
  maxSpeed: 540,
  /** Slope-driven acceleration scale: a = gravity·h′/√(1+h′²) (rolling ball ≈ 5/7 g). */
  gravity: 620,
  /** Seconds the boulder teeters on the spawn ledge before release. */
  warmup: 0.55,
  /** Travel (px) after which the boulder has left the validated corridor for good. */
  range: 1400,
  /** Fixed integration step for the clock-driven pose. */
  step: 1 / 90,
  /** Slope sampling half-width for the terrain tangent (px). */
  sample: 34,
} as const;

export interface IceBoulderState {
  /** Spawn ledge x — the settle point is exactly spawn − range. */
  spawn: number;
  x: number;
  /** Roll velocity; negative = toward the rider. */
  vx: number;
  /** Cumulative rotation in radians (advances by distance/radius). */
  rotation: number;
  /** Total distance rolled (px). */
  distance: number;
}

/** Fresh boulder state at a spawn ledge. */
export function iceBoulderState(x: number): IceBoulderState {
  return { spawn: x, x, vx: -ICE_BOULDER.releaseSpeed, rotation: 0, distance: 0 };
}

/**
 * One fixed-step physics advance. `surface` is the absolute ground-height
 * function (canvas convention: larger y = lower on screen, so a negative
 * slope means the ground rises toward +x — the rider's uphill, and the
 * boulder's downhill toward the rider).
 */
export function iceBoulderStep(
  state: IceBoulderState,
  surface: (x: number) => number,
  delta: number,
): IceBoulderState {
  if (delta <= 0 || state.distance >= ICE_BOULDER.range - 1e-9) return state;
  const slope = (surface(state.x + ICE_BOULDER.sample) - surface(state.x - ICE_BOULDER.sample)) / (ICE_BOULDER.sample * 2);
  // Gravity along the +x tangent; a negative slope accelerates the boulder −x.
  const along = ICE_BOULDER.gravity * slope / Math.sqrt(1 + slope * slope);
  const vx = Math.max(-ICE_BOULDER.maxSpeed, Math.min(-ICE_BOULDER.minSpeed, state.vx + along * delta));
  let travel = vx * delta;
  // Leave the corridor exactly at the range boundary, so the settled pose
  // (x, rotation, distance) is independent of the caller's step schedule.
  const remaining = ICE_BOULDER.range - state.distance;
  if (Math.abs(travel) >= remaining) {
    return {
      spawn: state.spawn,
      x: state.spawn - ICE_BOULDER.range,
      vx,
      rotation: state.rotation - Math.max(0, remaining) / ICE_BOULDER.radius,
      distance: ICE_BOULDER.range,
    };
  }
  return {
    spawn: state.spawn,
    x: state.x + travel,
    vx,
    rotation: state.rotation + travel / ICE_BOULDER.radius,
    distance: state.distance + Math.abs(travel),
  };
}

/**
 * Clock-driven boulder pose: released at `phase + warmup`, integrated from the
 * spawn ledge with fixed steps. Pure and deterministic — the same call in the
 * engine, the feasibility sweep and the debug overlay yields the same boulder.
 */
export function iceBoulderPose(
  spawnX: number,
  surface: (x: number) => number,
  elapsed: number,
  phase = 0,
): { x: number; rotation: number; speed: number; distance: number; released: boolean } {
  const held = elapsed - phase;
  if (held <= ICE_BOULDER.warmup) {
    return { x: spawnX, rotation: 0, speed: 0, distance: 0, released: false };
  }
  const travelTime = held - ICE_BOULDER.warmup;
  let state = iceBoulderState(spawnX);
  const steps = Math.min(720, Math.ceil(travelTime / ICE_BOULDER.step));
  const delta = travelTime / steps;
  for (let index = 0; index < steps; index += 1) {
    const next = iceBoulderStep(state, surface, delta);
    if (next === state) break;
    state = next;
  }
  return { x: state.x, rotation: state.rotation, speed: Math.abs(state.vx), distance: state.distance, released: true };
}
