// Shared by live physics and procedural validation. Values match the existing rider.
export const BICYCLE_PHYSICS = {
  minSpeed: 205,
  maxSpeed: 475,
  gravity: 920,
  jumpVelocity: 585,
  jumpSpeedFactor: 0.18,
  maxJumpBoost: 85,
  airborneAcceleration: 2.5,
  collisionPadding: 10,
  collisionBottom: 7,
  groundOffset: 5,
  collisionInset: 3,
  landingAngleLimit: 1.22,
  landingSpinLimit: 4.2,
  flipHoldSeconds: 0.14,
  flipSeconds: 1.1,
  flipEaseFraction: 0.12,
} as const;

export function flipProgress(time: number): number {
  const t = Math.min(time / BICYCLE_PHYSICS.flipSeconds, 1);
  const ease = BICYCLE_PHYSICS.flipEaseFraction;
  if (t < ease) return t * t / (2 * ease * (1 - ease));
  if (t > 1 - ease) return 1 - (1 - t) ** 2 / (2 * ease * (1 - ease));
  return (t - ease / 2) / (1 - ease);
}
