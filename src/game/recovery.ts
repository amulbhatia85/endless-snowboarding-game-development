/**
 * Phase 8 — crash & recovery tuning. Every value here is deliberately
 * conservative so the recovery experience stays fair:
 *
 * - Revive protection shields against obstacle collisions only. Gaps and
 *   unsupported surfaces stay fatal — protection never makes the terrain
 *   itself safe.
 * - The crash tumble is a brief, physics-flavoured reaction (slide, pop and
 *   spin with exponential decay). It is purely cosmetic: the score is frozen
 *   at the moment of the crash and the camera does not move.
 */
export const RECOVERY_CONFIG = {
  /** Invulnerability window after a successful revive (seconds). */
  reviveInvulnerabilitySeconds: 3,
  /** How long the crash tumble animates before the rider settles. */
  crashTumbleSeconds: 0.9,
  /** Fraction of the riding speed carried into the crash slide. */
  crashTumbleSlideFactor: 0.55,
  /** Upward pop when crashing on the ground (px/s, negative is up). */
  crashTumblePopVelocity: -170,
  /** Forward rotation speed at crash start (rad/s, over-the-bars tumble). */
  crashTumbleSpin: 4.6,
  /** Exponential decay rates for slide, spin and camera catch-up. */
  crashTumbleSlideDecay: 3.4,
  crashTumbleSpinDecay: 2.4,
  /** How much of the revive camera correction is applied instantly; the
   * regular smoothed follow completes the rest (no snap, no jump). */
  reviveCameraCatchUp: 0.6,
} as const;
