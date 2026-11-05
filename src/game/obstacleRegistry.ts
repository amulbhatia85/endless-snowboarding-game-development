export type ObstacleGroup = 'static' | 'terrain' | 'environmental' | 'moving' | 'combination';
export type ActiveObstacleId = 'rock' | 'log' | 'tree' | 'gap' | 'bridge' | 'ramp' | 'swinging-log';
export type ObstacleId = ActiveObstacleId | 'root' | 'fence' | 'cliff' | 'broken-bridge'
  | 'ice' | 'icicle' | 'snowball' | 'moving-platform' | 'branch';

export interface ObstacleDefinition {
  id: ObstacleId;
  group: ObstacleGroup;
  capabilities: { asset: boolean; rendering: boolean; collision: boolean; rules: boolean };
  collision?: { radius: number; height: number };
  requiresWarning: boolean;
}
const ready = { asset: true, rendering: true, collision: true, rules: true };
const pending = { asset: false, rendering: false, collision: false, rules: false };

export const OBSTACLE_REGISTRY: Readonly<Record<ObstacleId, ObstacleDefinition>> = {
  rock: { id: 'rock', group: 'static', capabilities: ready, collision: { radius: 19, height: 23 }, requiresWarning: false },
  log: { id: 'log', group: 'static', capabilities: ready, collision: { radius: 29, height: 26 }, requiresWarning: false },
  tree: { id: 'tree', group: 'static', capabilities: ready, collision: { radius: 17, height: 74 }, requiresWarning: false },
  root: { id: 'root', group: 'static', capabilities: pending, requiresWarning: false },
  fence: { id: 'fence', group: 'static', capabilities: pending, requiresWarning: false },
  gap: { id: 'gap', group: 'terrain', capabilities: ready, requiresWarning: false },
  bridge: { id: 'bridge', group: 'terrain', capabilities: ready, requiresWarning: false },
  ramp: { id: 'ramp', group: 'terrain', capabilities: ready, requiresWarning: false },
  cliff: { id: 'cliff', group: 'terrain', capabilities: pending, requiresWarning: true },
  'broken-bridge': { id: 'broken-bridge', group: 'terrain', capabilities: pending, requiresWarning: true },
  ice: { id: 'ice', group: 'environmental', capabilities: pending, requiresWarning: true },
  icicle: { id: 'icicle', group: 'environmental', capabilities: pending, requiresWarning: true },
  snowball: { id: 'snowball', group: 'environmental', capabilities: pending, requiresWarning: true },
  'swinging-log': { id: 'swinging-log', group: 'moving', capabilities: ready, collision: { radius: 34, height: 38 }, requiresWarning: true },
  'moving-platform': { id: 'moving-platform', group: 'moving', capabilities: pending, requiresWarning: true },
  branch: { id: 'branch', group: 'moving', capabilities: pending, requiresWarning: true },
};

export function obstacleReady(id: ObstacleId): id is ActiveObstacleId {
  if (!Object.prototype.hasOwnProperty.call(OBSTACLE_REGISTRY, id)) return false;
  const capabilities = OBSTACLE_REGISTRY[id].capabilities;
  return capabilities.asset && capabilities.rendering && capabilities.collision && capabilities.rules;
}


export function swingingLogPose(x: number, groundY: number, elapsed: number, phase = 0): { x: number; y: number; angle: number } {
  const swing = Math.sin(elapsed * 1.5 + phase);
  return { x: x + swing * 24, y: groundY - 42 + Math.cos(elapsed * 1.5 + phase) * 10, angle: swing * 0.25 };
}
