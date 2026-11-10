/**
 * Phase 12 — motorcycle physics core.
 *
 * The rider is now a two-wheel rigid body: a chassis (position, velocity,
 * pitch angle, angular velocity) with front and rear wheel circles attached
 * at fixed axle offsets. Every wheel interacts with the world through a
 * spring-damper contact against the exact track geometry (heightfield ground,
 * curved ramps and bridges, and the new parametric track segments), so the
 * suspension, the torque about the centre of mass and the loss of contact on
 * convex curves or slow loops all emerge from the physics rather than from
 * scripting.
 *
 * Compatibility contract with the validated obstacle world (see terrain.ts
 * validators): on heightfield ground the tangential speed dynamics reproduce
 * the classic rider ODE — slope · 230 (×1.35 on ice) + base push, a 205 px/s
 * floor while not braking and the 470 px/s hop impulse — so every placement
 * the planners validated stays passable. On track segments (loops, bowls,
 * arcs) the tangential dynamics are energy-honest: gravity trades against
 * height, throttle fights it, and insufficient momentum means the bike leaves
 * the curve. The normal dynamics are physical everywhere.
 */

import { flipProgress, BICYCLE_PHYSICS } from './riderPhysics';

const FLIP_SECONDS = BICYCLE_PHYSICS.flipSeconds;

export interface WheelContact {
  /** Contact point on the surface (world space). */
  px: number;
  py: number;
  /** Unit normal at the contact, pointing from the surface toward the wheel. */
  nx: number;
  ny: number;
  /** Penetration depth in pixels (> 0 means touching). */
  depth: number;
  /** Unit tangent at the contact, oriented toward +x where possible. */
  tx: number;
  ty: number;
  /** True when the contact belongs to a track segment (energy-honest mode). */
  feature: boolean;
  /** Parametric position along a track-segment curve (caps at 0 and 1). */
  t?: number;
  /** Traction multiplier at the contact (ice patches reduce it). */
  traction: number;
}

export interface Surface {
  /**
   * Reports every surface contact for a wheel circle at (x, y) with radius r.
   * Ground, ramps, bridges and track curves are all mixed in; contacts are
   * mutually independent so overlapping surfaces simply add their forces.
   */
  forEachContact(x: number, y: number, r: number, visit: (contact: WheelContact) => void): void;
}

export interface MotoControls {
  /** 0..1 throttle (hold). */
  throttle: number;
  /** 0..1 brake. */
  brake: number;
  /** −1 (lean back) .. +1 (lean forward). */
  lean: number;
  /** True while the rider holds the classic press in the air (flip intent). */
  flipHold: boolean;
}

export interface MotoStepEvents {
  /** Set on the transition airborne → grounded (any wheel) after real flight. */
  landed: null | { surfaceAngle: number; angleError: number; impact: number; spin: number };
  /** Set when the rider's head circle touched a surface this step. */
  headHit: boolean;
  /** Signed pitch change this step (radians, positive = nose down). */
  spinDelta: number;
}

export const MOTO_PHYSICS = {
  /** Shared with the classic rider model — all validators keep using it. */
  gravity: 920,
  wheelRadius: 10,
  wheelBase: 44,
  /** Axle line this far below the centre of mass (local +y). */
  axleY: 6,
  /** Head circle offset along the chassis up axis and its radius. */
  headOffset: 30,
  headRadius: 8,
  mass: 1,
  inertia: 260,
  contactStiffness: 135,
  contactDamping: 7,
  /** Bottom-out caps keep extreme landings finite instead of explosive. */
  maxDepth: 13,
  maxNormalForce: 2800,
  /** Heightfield (validated world) tangential model — matches the classic ODE. */
  slopeDrive: 230,
  iceSlopeFactor: 1.35,
  basePush: 8,
  basePushPerDifficulty: 9,
  minSpeed: 205,
  /** Feature (energy-honest) tangential model. */
  featureDrive: 430,
  /** Baseline cruise push on feature curves (passive-play keep-alive). */
  featureCruise: 240,
  /** Uphill gravity compensation on track segments is capped at this
   *  tangent-|ty| (≈44°). Steeper faces still cost speed, and loops stay
   *  momentum-gated by contact physics itself: below ~√(g·r) the bike
   *  cannot stay pressed onto an inverted or near-vertical riding line and
   *  falls off regardless of drive. */
  featureSlopeCompCap: 0.7,
  /** Suspension blowoff: contact forces above this keep their full linear
   *  effect but transmit only `blowoffShare` of the excess as rotation. */
  blowoffForce: 1400,
  blowoffShare: 0.22,
  featureRolling: 20,
  featureBrake: 540,
  tractionMu: 1.7,
  iceTraction: 0.4,
  /** Throttle opens the flat-ground band beyond the classic cruise. */
  throttleAccel: 520,
  cruiseSpeed: 320,
  /** Heightfield cruise — the pacing system's design cruise (cruiseSpeedPx):
   *  hazard bands, waves and the safe approach are all timed against it. */
  groundCruise: 285,
  maxSpeed: 640,
  hardSpeedCap: 720,
  capDrag: 2.4,
  /** Air control. */
  airThrottleAccel: 120,
  airBrakeAccel: 90,
  leanTorqueAir: 2600,
  leanTorqueGround: 480,
  /** Flight stabiliser (spring/damper toward the flight direction). */
  alignSpring: 7.5,
  alignDamping: 5.5,
  /** Flip assist: a ≥0.12 s air hold programs one backflip that completes in
   *  flipSeconds, matching the classic rider's certified flip arcs. */
  flipHoldSeconds: 0.12,
  /** The program runs slightly ahead so the physical rotation completes
   *  within the classic 0.94 s certified flip window. */
  flipLead: 0.08,
  flipServoSpring: 300,
  flipServoDamping: 14,
  /** Hop (tap) — identical impulse family to the classic jump. */
  hopVelocity: 470,
  hopSpeedFactor: 0.18,
  hopMaxBoost: 85,
  substeps: 3,
} as const;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const TAU = Math.PI * 2;
const shortestAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Classic slope-drive ODE acceleration on heightfield ground. */
function groundDrive(speedAlongTangent: number, slope: number, onIce: boolean, difficulty: number, controls: MotoControls): number {
  let accel = Math.tan(slope) * MOTO_PHYSICS.slopeDrive * (onIce ? MOTO_PHYSICS.iceSlopeFactor : 1)
    + MOTO_PHYSICS.basePush + difficulty * MOTO_PHYSICS.basePushPerDifficulty;
  // Throttle extends the reachable band; the classic floor holds while the
  // brakes are released so validated obstacles stay passable at cruise.
  if (controls.throttle > 0) {
    accel += controls.throttle * MOTO_PHYSICS.throttleAccel * Math.max(0, 1 - speedAlongTangent / MOTO_PHYSICS.maxSpeed);
  }
  if (controls.brake > 0) {
    accel -= controls.brake * 560 * Math.min(1, Math.abs(speedAlongTangent) / 90 + 0.25);
  } else if (controls.throttle <= 0) {
    // Cruise attractor: the classic ODE eased toward the zone cruise (the
    // pacing config's cruiseSpeedPx — every hazard band, wave and approach
    // is calibrated against it). Without it the chassis creeps at the
    // minimum-speed floor and every journey takes half again as long as
    // designed. Throttle overrides the attractor (speed builds toward
    // maxSpeed for loops and gaps); brakes are handled above.
    if (speedAlongTangent < MOTO_PHYSICS.minSpeed) {
      accel += Math.min(280, (MOTO_PHYSICS.minSpeed - speedAlongTangent) * 3);
    } else if (speedAlongTangent < MOTO_PHYSICS.groundCruise) {
      accel += (MOTO_PHYSICS.groundCruise - speedAlongTangent) * 0.9;
    } else {
      accel -= (speedAlongTangent - MOTO_PHYSICS.groundCruise) * 1.4;
    }
  }
  return accel;
}

export class MotoBody {
  x = 0;
  y = 0;
  angle = 0;
  vx = 0;
  vy = 0;
  omega = 0;
  airTime = 0;
  grounded = false;
  rearGrounded = false;
  frontGrounded = false;
  /** Smoothed suspension compression 0..1 per wheel (render hint). */
  rearCompression = 0;
  frontCompression = 0;
  /** True while any contact this step belonged to a track segment. */
  onFeature = false;
  headHit = false;

  private readonly halfBase = MOTO_PHYSICS.wheelBase / 2;
  /** Reused per-substep scratch list — the hot path allocates nothing. */
  private readonly hits: WheelContact[] = [];
  /** Assisted backflip program (one per air hold, like the classic rider). */
  private flipAssist: { baseAngle: number; elapsed: number } | null = null;
  private holdAirTime = 0;
  /** True once this airborne period's assisted flip has been delivered — a
   *  continued hold must not keep torquing the chassis after the flip. */
  private flipDone = false;

  place(x: number, y: number, angle: number, vx: number, vy: number, omega: number): void {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.vx = vx;
    this.vy = vy;
    this.omega = omega;
    this.airTime = 0;
    this.rearCompression = 0;
    this.frontCompression = 0;
    this.flipAssist = null;
    this.holdAirTime = 0;
    this.flipDone = false;
  }

  /** Tap hop: replaces the vertical velocity, exactly like the classic jump. */
  hop(speed: number): void {
    const boost = Math.min(MOTO_PHYSICS.hopMaxBoost, speed * MOTO_PHYSICS.hopSpeedFactor);
    this.vy = -(MOTO_PHYSICS.hopVelocity + boost);
    this.omega *= 0.35;
  }

  private wheelWorld(offsetX: number): { x: number; y: number } {
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    return {
      x: this.x + offsetX * cos - MOTO_PHYSICS.axleY * sin,
      y: this.y + offsetX * sin + MOTO_PHYSICS.axleY * cos,
    };
  }

  step(delta: number, controls: MotoControls, surface: Surface, difficulty = 0, onIceAt?: (x: number) => boolean): MotoStepEvents {
    const events: MotoStepEvents = { landed: null, headHit: false, spinDelta: 0 };
    const sub = delta / MOTO_PHYSICS.substeps;
    const airTimeAtStart = this.airTime;
    let landedThisStep = false;
    let landingAngle = 0;
    let landingContact: WheelContact | null = null;
    let landingImpact = 0;
    let landingSpin = 0;
    this.headHit = false;
    this.onFeature = false;
    let rearDepthMax = 0;
    let frontDepthMax = 0;

    for (let pass = 0; pass < MOTO_PHYSICS.substeps; pass += 1) {
      const impactVy = this.vy;
      let fx = 0;
      let fy = MOTO_PHYSICS.mass * MOTO_PHYSICS.gravity;
      let torque = 0;
      let anyContact = false;
      let rearContact = false;
      let frontContact = false;
      let groundContact: WheelContact | null = null;
      let featureContact: WheelContact | null = null;
      let deepContact = false;

      for (let wheel = 0; wheel < 2; wheel += 1) {
        const offsetX = wheel === 0 ? -this.halfBase : this.halfBase;
        const wheelPos = this.wheelWorld(offsetX);
        const rx = wheelPos.x - this.x;
        const ry = wheelPos.y - this.y;
        // Velocity of the wheel point (rigid body): v + ω × r.
        const pointVx = this.vx - this.omega * ry;
        const pointVy = this.vy + this.omega * rx;

        this.hits.length = 0;
        surface.forEachContact(wheelPos.x, wheelPos.y, MOTO_PHYSICS.wheelRadius, (contact) => {
          if (contact.depth > 0) this.hits.push(contact);
        });

        for (const contact of this.hits) {
          if (contact.depth > 6) deepContact = true;
          const depth = Math.min(contact.depth, MOTO_PHYSICS.maxDepth);
          const vn = pointVx * contact.nx + pointVy * contact.ny;
          let normalForce = MOTO_PHYSICS.contactStiffness * depth - MOTO_PHYSICS.contactDamping * vn;
          if (normalForce <= 0) continue;
          normalForce = Math.min(normalForce, MOTO_PHYSICS.maxNormalForce);
          const vcx = pointVx - vn * contact.nx;
          const vcy = pointVy - vn * contact.ny;
          const tangentSpeed = vcx * contact.tx + vcy * contact.ty;
          let tangentForce = 0;

          if (contact.feature) {
            // Track segments: a baseline cruise keeps passive play moving
            // across kickers and arcs exactly like the classic rider — the
            // baseline also cancels the local uphill pull (capped at ~38° so
            // vertical and inverted loop faces still demand real momentum
            // and throttle). Without the compensation a cruise-speed rider
            // slumps on every ramp face, stalls on the crest and pits over
            // the far lip helmet-first.
            this.onFeature = true;
            if (controls.brake <= 0 && tangentSpeed < MOTO_PHYSICS.cruiseSpeed) {
              const slopeComp = -MOTO_PHYSICS.gravity
                * Math.max(-MOTO_PHYSICS.featureSlopeCompCap, Math.min(0, contact.ty)) * MOTO_PHYSICS.mass;
              // The baseline needs rolling speed: below ~120 px/s it fades
              // out, so a stalled bike cannot statically hold a steep face.
              // It slides back and takes a run-up instead — pumping a bowl
              // like a real half-pipe rather than parking on the wall.
              const driveScale = clamp(tangentSpeed / 140 + 0.15, 0.15, 1);
              tangentForce = (Math.min(MOTO_PHYSICS.featureCruise, (MOTO_PHYSICS.cruiseSpeed - tangentSpeed) * 0.9) + slopeComp) * driveScale;
            }
            tangentForce += controls.throttle * MOTO_PHYSICS.featureDrive * contact.traction;
            tangentForce -= Math.sign(tangentSpeed) * MOTO_PHYSICS.featureRolling;
            if (controls.brake > 0) tangentForce -= Math.sign(tangentSpeed) * controls.brake * MOTO_PHYSICS.featureBrake * contact.traction;
            const tractionLimit = MOTO_PHYSICS.tractionMu * contact.traction * normalForce;
            tangentForce = clamp(tangentForce, -tractionLimit, tractionLimit);
          } else if (!groundContact || contact.depth > groundContact.depth) {
            groundContact = contact;
          }
          // A load-bearing feature contact switches the bike into the
          // energy-honest mode. Cap grazes (depth ≤ 1.5 px, e.g. a wheel
          // brushing a kicker's entry point from the side) must NOT switch
          // modes — they would silently disable the ground drive and stall
          // the bike at the feature's lip.
          if (contact.feature && contact.depth > 1.5 && (!featureContact || contact.depth > featureContact.depth)) featureContact = contact;

          const wheelFx = normalForce * contact.nx + tangentForce * contact.tx;
          const wheelFy = normalForce * contact.ny + tangentForce * contact.ty;
          fx += wheelFx;
          fy += wheelFy;
          // Suspension blowoff: under a slam the fork's damping valve opens.
          // The chassis still receives the full deceleration (linear force is
          // untouched) but only a softened share of the rotational impulse,
          // so a hard touchdown on a curve pitches the bike instead of
          // flipping it helmet-first into the face it landed on. Cruising
          // loads sit below the threshold and keep their exact physics.
          const rotationalForce = normalForce <= MOTO_PHYSICS.blowoffForce
            ? normalForce
            : MOTO_PHYSICS.blowoffForce + (normalForce - MOTO_PHYSICS.blowoffForce) * MOTO_PHYSICS.blowoffShare;
          const share = rotationalForce / normalForce;
          torque += (rx * wheelFy - ry * wheelFx) * share;

          if (wheel === 0) { rearContact = true; rearDepthMax = Math.max(rearDepthMax, depth); }
          else { frontContact = true; frontDepthMax = Math.max(frontDepthMax, depth); }
          anyContact = true;
        }
      }

      // Head contact: the rider's helmet is a firm collision circle. In
      // normal play touching a surface with it is a crash (engine-side rule);
      // physically it also prevents the chassis from burying itself when a
      // protected tumble leaves the bike inverted — the helmet pushes back
      // and the flight stabiliser rights the chassis.
      {
        const cos = Math.cos(this.angle);
        const sin = Math.sin(this.angle);
        // The helmet sits along the chassis up axis (local −y), exactly like
        // the axles sit along local +y: (sin a, −cos a). The previous
        // (−sin a, −cos a) mirrored the helmet across the bike's vertical
        // axis whenever the chassis pitched — fine near level, but on a
        // loop's flanks the helmet landed on the wrong side of the bike,
        // poking out through the ribbon the rider was carving.
        const headX = this.x + MOTO_PHYSICS.headOffset * sin;
        const headY = this.y - MOTO_PHYSICS.headOffset * cos;
        const rx = headX - this.x;
        const ry = headY - this.y;
        const pointVx = this.vx - this.omega * ry;
        const pointVy = this.vy + this.omega * rx;
        this.hits.length = 0;
        surface.forEachContact(headX, headY, MOTO_PHYSICS.headRadius, (contact) => {
          if (contact.depth > 0) this.hits.push(contact);
        });
        for (const contact of this.hits) {
          // Track ribbons overhead: while no wheel is riding a feature, the
          // helmet may graze ribbon flanks it passes under — the loop's
          // entry flank at head height ahead of the notch, an arc haunch
          // above ground level, a kicker lip from behind. Those graze the
          // helmet without any wheel on the structure, so they are neither
          // crashes nor physical pushes. Once a wheel is on a feature the
          // helmet is firm against it (tumbles stay lethal).
          if (contact.feature && !featureContact) continue;
          if (contact.depth > 2) this.headHit = true;
          const vn = pointVx * contact.nx + pointVy * contact.ny;
          let normalForce = 900 * Math.min(contact.depth, 8) - 8 * vn;
          if (normalForce <= 0) continue;
          normalForce = Math.min(normalForce, 4200);
          const wheelFx = normalForce * contact.nx;
          const wheelFy = normalForce * contact.ny;
          fx += wheelFx;
          fy += wheelFy;
          torque += rx * wheelFy - ry * wheelFx;
        }
      }

      // Heightfield tangential model: the classic slope ODE replaces gravity's
      // pull along the tangent, keeping every validated obstacle passable.
      if (groundContact && !featureContact) {
        const ground = groundContact as WheelContact;
        const ice = onIceAt ? onIceAt(this.x) : ground.traction < 1;
        const tangentSpeed = this.vx * ground.tx + this.vy * ground.ty;
        const drive = groundDrive(tangentSpeed, Math.atan2(ground.ty, ground.tx), ice, difficulty, controls);
        const gravityTangent = MOTO_PHYSICS.gravity * ground.ty;
        let along = MOTO_PHYSICS.mass * (drive - gravityTangent);
        // Classic minimum-speed contract: the certified terrain ODE always
        // restored minSpeed for a rider who was not braking, and the moto
        // chassis honours the same floor. Below the floor the slope
        // resistance is suspended (the ODE's min-speed assist) and a
        // restoring push — gravity-cancelled like the drive above, and
        // compensated for the tangent projection so climbs hold too —
        // brings the horizontal speed back up.
        if (controls.brake <= 0 && this.vx < MOTO_PHYSICS.minSpeed) {
          const restore = MOTO_PHYSICS.basePush + difficulty * MOTO_PHYSICS.basePushPerDifficulty
            + (MOTO_PHYSICS.minSpeed - this.vx) * 8 + 24;
          along = Math.max(along, MOTO_PHYSICS.mass * (restore - gravityTangent) / Math.max(0.6, ground.tx));
        }
        fx += along * ground.tx;
        fy += along * ground.ty;
      }

      // Control torques.
      if (anyContact) {
        torque += controls.lean * MOTO_PHYSICS.leanTorqueGround;
        this.flipAssist = null;
        this.holdAirTime = 0;
        this.flipDone = false;
      } else {
        // Air control: the classic hold programs one assisted backflip (it
        // runs to completion exactly like the certified flip arcs), explicit
        // lean overrides it, and a released bike stabilises toward its flight
        // path through a spring/damper on the pitch.
        if (controls.flipHold && !this.flipDone) {
          this.holdAirTime += sub;
          if (!this.flipAssist && this.holdAirTime >= MOTO_PHYSICS.flipHoldSeconds && Math.abs(this.omega) < 3) {
            this.flipAssist = { baseAngle: this.angle, elapsed: 0 };
          }
        } else {
          this.holdAirTime = 0;
        }
        if (this.flipAssist) {
          this.flipAssist.elapsed += sub;
          // The program eases through one full rotation in flipSeconds, then
          // holds the final angle until the chassis has physically caught up
          // (a pure servo would always lag the program by its steady-state
          // error and land a fraction short of the full flip).
          const progress = flipProgress(Math.min(this.flipAssist.elapsed + MOTO_PHYSICS.flipLead, FLIP_SECONDS));
          const target = this.flipAssist.baseAngle - TAU * progress;
          const error = shortestAngle(target - this.angle);
          torque += (MOTO_PHYSICS.flipServoSpring * error - MOTO_PHYSICS.flipServoDamping * this.omega) * MOTO_PHYSICS.inertia;
          const converged = Math.abs(shortestAngle(this.flipAssist.baseAngle - TAU - this.angle)) < 0.12;
          if (this.flipAssist.elapsed >= FLIP_SECONDS && (converged || this.flipAssist.elapsed >= FLIP_SECONDS + 0.4)) {
            this.flipAssist = null;
            this.flipDone = true;
          }
        } else if (controls.lean !== 0 && !this.flipDone) {
          torque += controls.lean * MOTO_PHYSICS.leanTorqueAir;
        } else {
          const speed = Math.hypot(this.vx, this.vy);
          if (speed > 150) {
            // Follow the flight path, but never steer the nose more than
            // ~29° below level — off a lip the raw flight direction dives
            // and would drive the bike into the ground nose-first. A nearly
            // vertical hop simply holds level.
            const flight = Math.abs(this.vx) < 120 ? 0 : clamp(Math.atan2(this.vy, this.vx), -1.0, 0.5);
            const error = shortestAngle(flight - this.angle);
            torque += (MOTO_PHYSICS.alignSpring * error - MOTO_PHYSICS.alignDamping * this.omega) * MOTO_PHYSICS.inertia;
          } else {
            torque += -MOTO_PHYSICS.alignDamping * this.omega * MOTO_PHYSICS.inertia;
          }
        }
        if (controls.throttle > 0) fx += controls.throttle * MOTO_PHYSICS.airThrottleAccel * MOTO_PHYSICS.mass;
        if (controls.brake > 0) fx -= controls.brake * MOTO_PHYSICS.airBrakeAccel * MOTO_PHYSICS.mass;
      }

      // Speed caps: a hard ceiling keeps crest launches inside designed reach.
      if (this.vx > MOTO_PHYSICS.hardSpeedCap) fx -= (this.vx - MOTO_PHYSICS.hardSpeedCap) * MOTO_PHYSICS.capDrag * MOTO_PHYSICS.mass;

      this.vx += (fx / MOTO_PHYSICS.mass) * sub;
      this.vy += (fy / MOTO_PHYSICS.mass) * sub;
      this.omega = clamp(this.omega + (torque / MOTO_PHYSICS.inertia) * sub, -11, 11);
      this.x += this.vx * sub;
      this.y += this.vy * sub;
      // Position correction (suspension travel limit): the saturating spring
      // cannot arrest a very hard landing inside its travel — the chassis
      // would slide along inside the curve and the rider's head could sweep
      // the feature's lip corner. Past the limit the deepest wheel contact
      // is projected back out along its normal (standard game-physics
      // penetration resolution; forces and velocities are untouched below
      // the limit, so ordinary riding is bit-for-bit unchanged).
      if (deepContact) {
        for (let wheel = 0; wheel < 2; wheel += 1) {
          const offsetX = wheel === 0 ? -this.halfBase : this.halfBase;
          const wheelPos = this.wheelWorld(offsetX);
          this.hits.length = 0;
          surface.forEachContact(wheelPos.x, wheelPos.y, MOTO_PHYSICS.wheelRadius, (contact) => {
            if (contact.depth > 0) this.hits.push(contact);
          });
          let worst: WheelContact | null = null;
          for (const contact of this.hits) {
            if (!worst || contact.depth > worst.depth) worst = contact;
          }
          const limit = MOTO_PHYSICS.maxDepth + 2;
          if (worst && (worst as WheelContact).depth > limit) {
            const worstContact = worst as WheelContact;
            const push = worstContact.depth - limit;
            this.x += worstContact.nx * push;
            this.y += worstContact.ny * push;
            const vn = this.vx * worstContact.nx + this.vy * worstContact.ny;
            if (vn < 0) {
              this.vx -= vn * worstContact.nx;
              this.vy -= vn * worstContact.ny;
            }
          }
        }
      }

      const previousAngle = this.angle;
      this.angle += this.omega * sub;
      const physicalAngle = this.angle;
      // Classic ground-follow: with traction, on the heightfield and without
      // manual lean or violent spin, the chassis tracks the surface angle
      // within the frame — the certified ODE snapped rotation to the terrain
      // angle every grounded frame. Ice relaxes it (lean lags on ice), track
      // features keep their physical rotation (loops!), and a leaning or
      // tumbling rider keeps control. The snap itself is not spin.
      if (controls.lean === 0 && Math.abs(this.omega) < 3 && groundContact && !featureContact) {
        const ground = groundContact as WheelContact;
        const iceNow = onIceAt ? onIceAt(this.x) : ground.traction < 1;
        if (!iceNow) {
          this.angle = Math.atan2(ground.ty, ground.tx);
          this.omega = 0;
        }
      } else if (controls.lean === 0 && Math.abs(this.omega) < 3.5 && featureContact) {
        // Firm curve tracking: seated on a track segment (bowl walls, arc
        // crests, loop interiors) with the chassis already roughly aligned,
        // the rider carves the curve instead of tumbling off the rotational
        // impulse of the landing. Large mismatches stay physical — those
        // are crashes and botched launches, not tracking. Endpoint caps are
        // excluded: their tangent is the ribbon tip's, not a riding line.
        const contact = featureContact as WheelContact;
        const onCurve = contact.t === undefined || (contact.t > 0.05 && contact.t < 0.95);
        if (contact.depth > 2 && onCurve) {
          // Orient the target along the chassis' heading: the contact
          // tangent convention points toward +x, which on a loop's right
          // flank is the DESCENDING direction — the bike carving upward
          // would be told to point 180° the wrong way.
          let targetTx = contact.tx;
          let targetTy = contact.ty;
          const speed = Math.abs(this.vx) > Math.abs(this.vy) ? this.vx : this.vy;
          if ((this.vx !== 0 || this.vy !== 0) && this.vx * targetTx + this.vy * targetTy < 0) {
            targetTx = -targetTx;
            targetTy = -targetTy;
          } else if (this.vx === 0 && this.vy === 0 && speed < 0) {
            targetTx = -targetTx;
            targetTy = -targetTy;
          }
          const target = Math.atan2(targetTy, targetTx);
          if (Math.abs(shortestAngle(target - this.angle)) < 1.1) {
            this.angle = target;
            this.omega = 0;
            // Carve: seat the wheel at its normal ride depth so the chassis
            // tracks the curve positionally as well — the feature twin of
            // the heightfield ground pin. A wheel line only tangent to the
            // curve builds depth quadratically past the tangency (a loop
            // flank rises ~14 px within 40 px), which no suspension can
            // follow; carving is what keeps loops and bowls rideable while
            // separation (depth fading to zero) still falls off honestly
            // when momentum runs out.
            // The angle snap pivots the body, which can bury the other
            // wheel (still on the heightfield in a ground→curve handoff,
            // or deeper in the curve itself), so both wheels are re-probed
            // and the deepest contact seated at its normal ride depth —
            // twice, because the first seating can tilt the other wheel in.
            for (let probe = 0; probe < 2; probe += 1) {
              let worst: WheelContact | null = null;
              for (let wheel = 0; wheel < 2; wheel += 1) {
                const offsetX = wheel === 0 ? -this.halfBase : this.halfBase;
                const wheelPos = this.wheelWorld(offsetX);
                this.hits.length = 0;
                surface.forEachContact(wheelPos.x, wheelPos.y, MOTO_PHYSICS.wheelRadius, (probeContact) => {
                  if (probeContact.depth > 0) this.hits.push(probeContact);
                });
                for (const probed of this.hits) {
                  // Endpoint caps are ribbon tips, not riding surfaces —
                  // seating onto a cap normal ejects the chassis sideways
                  // out of the loop entry.
                  if (probed.feature && probed.t !== undefined && (probed.t <= 0.05 || probed.t >= 0.95)) continue;
                  if (!worst || probed.depth > (worst as WheelContact).depth) worst = probed;
                }
              }
              const seat = worst as WheelContact | null;
              if (seat && seat.depth > 4) {
                const push = seat.depth - 3;
                this.x += seat.nx * push;
                this.y += seat.ny * push;
                const vn = this.vx * seat.nx + this.vy * seat.ny;
                if (vn < 0) {
                  this.vx -= vn * seat.nx;
                  this.vy -= vn * seat.ny;
                }
              } else break;
            }
          }
        }
      }
      events.spinDelta += physicalAngle - previousAngle;

      const groundedNow = rearContact || frontContact;
      if (groundedNow) {
        if (airTimeAtStart > 0.16 && !landedThisStep) {
          landedThisStep = true;
          landingAngle = this.angle;
          landingContact = (groundContact as WheelContact | null) ?? (featureContact as WheelContact | null);
          landingImpact = Math.max(0, impactVy);
          // The spin rate at the instant of touchdown — the certified
          // landing rule judges the attitude the rider arrives with, not the
          // chassis response the suspension absorbs in the following frames.
          landingSpin = this.omega;
        }
        this.airTime = 0;
      } else {
        this.airTime += sub;
      }
      this.grounded = groundedNow;
      this.rearGrounded = rearContact;
      this.frontGrounded = frontContact;
    }

    // Smoothed suspension compression for the renderer.
    const follow = Math.min(1, delta * 18);
    this.rearCompression += (clamp(rearDepthMax / 9, 0, 1) - this.rearCompression) * follow;
    this.frontCompression += (clamp(frontDepthMax / 9, 0, 1) - this.frontCompression) * follow;

    if (landedThisStep && landingContact) {
      const contact = landingContact as WheelContact;
      let angleError = (landingAngle - Math.atan2(contact.ty, contact.tx)) % TAU;
      if (angleError > Math.PI) angleError -= TAU;
      if (angleError < -Math.PI) angleError += TAU;
      events.landed = { surfaceAngle: Math.atan2(contact.ty, contact.tx), angleError: Math.abs(angleError), impact: landingImpact, spin: landingSpin };
    }
    events.headHit = this.headHit;
    return events;
  }
}
