// Shared by live physics and procedural validation. Values match the existing rider.
export const BICYCLE_PHYSICS = {
  minSpeed: 205,
  maxSpeed: 475,
  // Playtest tuning (jump size): tap-jump impulse cut 585 -> 470 with
  // gravity unchanged, so natural crest launches keep their exact feel.
  // Apex at max speed 244 px -> 167 px, at cruise 220 px -> 148 px; airtime
  // 1.46 s -> 1.21 s; reach @475 692 px -> 574 px. The backflip tightens
  // (hold 0.12 s + spin 0.82 s = 0.94 s) so it still completes with margin
  // inside the shortest airtime the terrain allows at minimum speed
  // (~1.01 s on the steepest validated downhill). Hazard
  // corridors (swinging log, snowball patrol, wide gap variants) were
  // retuned for the shorter reach; every consumer derives from these
  // constants, so validation and the live physics stay in lockstep.
  gravity: 920,
  jumpVelocity: 470,
  jumpSpeedFactor: 0.18,
  maxJumpBoost: 85,
  airborneAcceleration: 2.5,
  collisionPadding: 10,
  collisionBottom: 7,
  groundOffset: 5,
  collisionInset: 3,
  landingAngleLimit: 1.22,
  landingSpinLimit: 4.2,
  flipHoldSeconds: 0.12,
  flipSeconds: 0.82,
  flipEaseFraction: 0.12,
} as const;

export function flipProgress(time: number): number {
  const t = Math.min(time / BICYCLE_PHYSICS.flipSeconds, 1);
  const ease = BICYCLE_PHYSICS.flipEaseFraction;
  if (t < ease) return t * t / (2 * ease * (1 - ease));
  if (t > 1 - ease) return 1 - (1 - t) ** 2 / (2 * ease * (1 - ease));
  return (t - ease / 2) / (1 - ease);
}
