/**
 * Phase 12 — parametric track segments.
 *
 * Every feature is built from exact mathematical curves: circular arcs and
 * cubic Béziers. The same curve objects drive rendering AND collision (the
 * wheel contact is the closest point on the curve, offset by the ribbon half
 * thickness), so the collision boundary follows the visible curve by
 * construction — there are no straight-line approximations anywhere.
 *
 * The planner introduces features progressively: curved kickers from level 1,
 * suspended arcs and ramp-gap combos from level 2, C-shaped bowls from
 * level 3 and full loops from level 5, with widening gaps and tighter
 * combinations after that.
 */

export interface P {
  x: number;
  y: number;
}

export type CurveShape =
  | { kind: 'arc'; cx: number; cy: number; r: number; a0: number; sweep: number }
  | { kind: 'bezier'; p0: P; p1: P; p2: P; p3: P };

export type TrackFeatureId = 'kicker' | 'gaprun' | 'suspended-arc' | 'c-bowl' | 'loop';

export interface TrackFeature {
  id: TrackFeatureId;
  /** World-space horizontal span (with a small margin for contacts). */
  x0: number;
  x1: number;
  curves: CurveShape[];
  /** Ribbon half thickness — the collision surface is the curve ± this. */
  halfThickness: number;
  /** Ground suppression span (the chasm under arcs, bowls and gap runs). */
  gap?: { x: number; width: number; bridged: boolean };
  /** Stilt pairs [top, ground] for suspended pieces. */
  supports?: [P, P][];
  /** Glowstones pinned to the riding line. */
  coins?: { x: number; y: number }[];
  /** One-line first-appearance introduction. */
  intro?: string;
  /** Entrance chevrons recommending speed (1..3). */
  speedHint?: number;
}

/** Marker on gap objects whose deck is drawn by a track feature. */
export const TRACK_GAP_MARKER = 'track';

export const FEATURE_UNLOCK: Record<TrackFeatureId, number> = {
  kicker: 1,
  gaprun: 2,
  'suspended-arc': 2,
  'c-bowl': 3,
  loop: 5,
};

/** Wheel radius + ribbon half thickness — the interior riding inset of loops. */
const LOOP_RIDING_INSET = 19;
/** Resting wheel-centre height above the ground (wheel radius − static sag). */
const LOOP_GROUND_CLEAR = 6.6;

export const FEATURE_INTRO: Record<TrackFeatureId, string> = {
  kicker: 'CURVED KICKER — RIDE THE ARC',
  gaprun: 'RAMP GAP — HOLD FOR SPEED',
  'suspended-arc': 'SUSPENDED ARC — STAY ON THE RIBBON',
  'c-bowl': 'THE BOWL — CARRY YOUR MOMENTUM',
  loop: 'THE LOOP — FULL SPEED OR FALL',
};

const TAU = Math.PI * 2;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function curvePoint(shape: CurveShape, t: number): P {
  if (shape.kind === 'arc') {
    const angle = shape.a0 + shape.sweep * t;
    return { x: shape.cx + shape.r * Math.cos(angle), y: shape.cy + shape.r * Math.sin(angle) };
  }
  const u = 1 - t;
  return {
    x: u * u * u * shape.p0.x + 3 * u * u * t * shape.p1.x + 3 * u * t * t * shape.p2.x + t * t * t * shape.p3.x,
    y: u * u * u * shape.p0.y + 3 * u * u * t * shape.p1.y + 3 * u * t * t * shape.p2.y + t * t * t * shape.p3.y,
  };
}

export function curveSpan(shape: CurveShape): { x0: number; x1: number } {
  if (shape.kind === 'arc') {
    const x0 = shape.cx - shape.r;
    const x1 = shape.cx + shape.r;
    return { x0: Math.min(x0, x1), x1: Math.max(x0, x1) };
  }
  const xs = [shape.p0.x, shape.p1.x, shape.p2.x, shape.p3.x];
  return { x0: Math.min(...xs), x1: Math.max(...xs) };
}

export interface ClosestResult {
  x: number;
  y: number;
  t: number;
  d2: number;
}

export function curveClosest(shape: CurveShape, x: number, y: number): ClosestResult {
  if (shape.kind === 'arc') {
    const dx = x - shape.cx;
    const dy = y - shape.cy;
    const full = Math.abs(shape.sweep) >= TAU - 1e-6;
    let angle = Math.atan2(dy, dx);
    if (!full) {
      // Clamp the angle into the arc's sweep, honouring the sweep direction:
      // the along-arc offset is wrapped into (-π, π] first, then folded into
      // the sweep's sign so a probe inside a clockwise arc maps inside it
      // (the previous TAU-fold mapped it past the end and clamped it to the
      // start cap — the whole concave face of every negative-sweep arc
      // mis-reported its closest point).
      let offset = angle - shape.a0;
      while (offset > Math.PI) offset -= TAU;
      while (offset < -Math.PI) offset += TAU;
      if (shape.sweep >= 0) {
        if (offset < 0) offset += TAU;
        if (offset > shape.sweep) offset = offset > (shape.sweep + TAU) / 2 ? 0 : shape.sweep;
      } else {
        if (offset > 0) offset -= TAU;
        if (offset < shape.sweep) offset = offset < (shape.sweep - TAU) / 2 ? 0 : shape.sweep;
      }
      angle = shape.a0 + offset;
    }
    const point = { x: shape.cx + shape.r * Math.cos(angle), y: shape.cy + shape.r * Math.sin(angle) };
    const t = full ? 0 : clamp((angle - shape.a0) / (shape.sweep || 1), 0, 1);
    return { x: point.x, y: point.y, t, d2: (x - point.x) ** 2 + (y - point.y) ** 2 };
  }
  // Bézier: coarse cached samples + bisection refinement.
  const samples = bezierSamples(shape);
  let bestIndex = 0;
  let bestD2 = Infinity;
  for (let index = 0; index < samples.length; index += 2) {
    const d2 = (x - samples[index]) ** 2 + (y - samples[index + 1]) ** 2;
    if (d2 < bestD2) { bestD2 = d2; bestIndex = index; }
  }
  const count = samples.length / 2;
  let low = Math.max(0, (bestIndex / 2 - 1) / (count - 1));
  let high = Math.min(1, (bestIndex / 2 + 1) / (count - 1));
  let bestT = bestIndex / 2 / (count - 1);
  let bestPoint = curvePoint(shape, bestT);
  let bestDistance = (x - bestPoint.x) ** 2 + (y - bestPoint.y) ** 2;
  for (let pass = 0; pass < 9; pass += 1) {
    const mid = (low + high) / 2;
    const left = (low + mid) / 2;
    const right = (mid + high) / 2;
    const leftPoint = curvePoint(shape, left);
    const rightPoint = curvePoint(shape, right);
    const leftD2 = (x - leftPoint.x) ** 2 + (y - leftPoint.y) ** 2;
    const rightD2 = (x - rightPoint.x) ** 2 + (y - rightPoint.y) ** 2;
    if (leftD2 < rightD2) {
      high = mid;
      if (leftD2 < bestDistance) { bestT = left; bestPoint = leftPoint; bestDistance = leftD2; }
    } else {
      low = mid;
      if (rightD2 < bestDistance) { bestT = right; bestPoint = rightPoint; bestDistance = rightD2; }
    }
  }
  return { x: bestPoint.x, y: bestPoint.y, t: bestT, d2: bestDistance };
}

const sampleCache = new WeakMap<CurveShape, number[]>();

function bezierSamples(shape: CurveShape): number[] {
  const cached = sampleCache.get(shape);
  if (cached) return cached;
  const samples: number[] = [];
  const steps = 22;
  for (let index = 0; index <= steps; index += 1) {
    const point = curvePoint(shape, index / steps);
    samples.push(point.x, point.y);
  }
  sampleCache.set(shape, samples);
  return samples;
}

/** Appends the curve to the current path (caller owns stroke styles). */
export function traceCurve(context: CanvasRenderingContext2D, shape: CurveShape): void {
  if (shape.kind === 'arc') {
    context.moveTo(shape.cx + shape.r * Math.cos(shape.a0), shape.cy + shape.r * Math.sin(shape.a0));
    if (Math.abs(shape.sweep) >= TAU - 1e-6) {
      context.arc(shape.cx, shape.cy, shape.r, shape.a0, shape.a0 + TAU);
    } else {
      context.arc(shape.cx, shape.cy, shape.r, shape.a0, shape.a0 + shape.sweep, shape.sweep < 0);
    }
    return;
  }
  context.moveTo(shape.p0.x, shape.p0.y);
  context.bezierCurveTo(shape.p1.x, shape.p1.y, shape.p2.x, shape.p2.y, shape.p3.x, shape.p3.y);
}

export interface SegmentContact {
  x: number;
  y: number;
  nx: number;
  ny: number;
  depth: number;
  tx: number;
  ty: number;
  /** Parametric position along the curve (0 and 1 are the endpoint caps). */
  t: number;
}

/** Closest contacts of a circle against every curve of a feature. */
export function featureContacts(feature: TrackFeature, x: number, y: number, r: number, visit: (contact: SegmentContact) => void): void {
  const reach = r + feature.halfThickness;
  for (const shape of feature.curves) {
    const closest = curveClosest(shape, x, y);
    const distance = Math.sqrt(closest.d2);
    // Endpoint caps: the rounded tip of a ribbon. Full reach here makes the
    // tip a solid wall for anyone approaching along the surface (the classic
    // entry-cap trap — the closest point is the endpoint and its radial
    // normal points backward). The cap only engages close to the tip, so the
    // adjoining curve surface (or a buried tail) catches approaching riders
    // with a proper surface normal first.
    const capped = closest.t <= 0 || closest.t >= 1;
    const effective = capped ? reach * 0.4 : reach;
    if (distance >= effective || distance < 1e-6) continue;
    const nx = (x - closest.x) / distance;
    const ny = (y - closest.y) / distance;
    let tx = -ny;
    let ty = nx;
    if (tx < 0) { tx = -tx; ty = -ty; }
    visit({ x: closest.x, y: closest.y, nx, ny, depth: reach - distance, tx, ty, t: closest.t });
  }
}

/** True when a point sits within `clearance` above any curve of the feature. */
export function nearFeatureLine(feature: TrackFeature, x: number, y: number, clearance: number): boolean {
  if (x < feature.x0 - 60 || x > feature.x1 + 60) return false;
  for (const shape of feature.curves) {
    const closest = curveClosest(shape, x, y);
    const distance = Math.sqrt(closest.d2);
    if (distance <= clearance) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Feature builders
// ---------------------------------------------------------------------------

export interface TrackPlanInput {
  level: number;
  startX: number;
  groundAt: (x: number) => number;
  random: () => number;
  lastId?: TrackFeatureId | null;
  busy: (from: number, to: number) => boolean;
}

export interface TrackPlanResult {
  feature: TrackFeature;
  endX: number;
  clearAfter: number;
}

function slopeOver(groundAt: (x: number) => number, from: number, to: number): number {
  let max = 0;
  for (let x = from; x <= to; x += 40) {
    const slope = Math.abs((groundAt(x + 40) - groundAt(x)) / 40);
    if (slope > max) max = slope;
  }
  return max;
}

/**
 * A buried lead-in tail that precedes a curve entry. Without it the curve's
 * start cap is a wall for a wheel approaching at ground level (the closest
 * point is the endpoint, whose normal points backwards); with it, the cap
 * sits deep under the snow and the transition reads as a gentle pre-ramp.
 */
const lerpAt = (a: number, b: number, t: number) => a + (b - a) * t;

function entryTail(x: number, groundAt: (x: number) => number, length = 26, depth = 16): CurveShape {
  const start = { x: x - length, y: groundAt(x - length) + depth };
  const end = { x, y: groundAt(x) };
  return {
    kind: 'bezier',
    p0: start,
    p1: { x: lerpAt(start.x, end.x, 0.34), y: lerpAt(start.y, end.y, 0.34) },
    p2: { x: lerpAt(start.x, end.x, 0.67), y: lerpAt(start.y, end.y, 0.67) },
    p3: end,
  };
}

/** A buried run-out tail after a curve's ground-level exit (rollback safety). */
function exitTail(x: number, groundAt: (x: number) => number, length = 26, depth = 16): CurveShape {
  const start = { x, y: groundAt(x) };
  const end = { x: x + length, y: groundAt(x + length) + depth };
  return {
    kind: 'bezier',
    p0: start,
    p1: { x: lerpAt(start.x, end.x, 0.34), y: lerpAt(start.y, end.y, 0.34) },
    p2: { x: lerpAt(start.x, end.x, 0.67), y: lerpAt(start.y, end.y, 0.67) },
    p3: end,
  };
}

function buildKicker(x0: number, groundAt: (x: number) => number, random: () => number, level: number): { feature: TrackFeature; endX: number } | null {
  const width = 104 + random() * 46;
  const height = 30 + random() * 16 + Math.min(16, level * 1.4);
  const g0 = groundAt(x0);
  const exitSlope = clamp(height / width * 1.35, 0.34, 0.72);
  const lipX = x0 + width;
  const curve: CurveShape = {
    kind: 'bezier',
    p0: { x: x0, y: g0 },
    p1: { x: x0 + width * 0.34, y: g0 - height * 0.06 },
    p2: { x: lipX - width * 0.24, y: g0 - height + width * 0.24 * exitSlope },
    p3: { x: lipX, y: g0 - height },
  };
  const coins: P[] = [];
  for (let index = 0; index <= 3; index += 1) {
    const point = curvePoint(curve, 0.2 + index * 0.2);
    coins.push({ x: point.x, y: point.y - 30 });
  }
  return {
    feature: {
      id: 'kicker',
      x0: x0 - 26,
      x1: lipX,
      curves: [entryTail(x0, groundAt), curve],
      halfThickness: 9,
      coins,
      speedHint: 0,
    },
    endX: lipX,
  };
}

function buildGaprun(x0: number, groundAt: (x: number) => number, random: () => number, level: number): { feature: TrackFeature; endX: number } | null {
  const kicker = buildKicker(x0, groundAt, random, level);
  if (!kicker) return null;
  const lipX = kicker.endX;
  const gapWidth = clamp(168 + level * 11 + random() * 52, 168, 372);
  const catchHeight = 16 + random() * 22;
  const landingWidth = 150 + random() * 60;
  const landX = lipX + gapWidth;
  const gEnd = groundAt(landX + landingWidth);
  const landing: CurveShape = {
    kind: 'bezier',
    p0: { x: landX, y: gEnd - catchHeight },
    p1: { x: landX + landingWidth * 0.3, y: gEnd - catchHeight * 1.12 },
    p2: { x: landX + landingWidth * 0.72, y: gEnd - catchHeight * 0.05 },
    p3: { x: landX + landingWidth, y: gEnd },
  };
  const kickerCurve = kicker.feature.curves[1];
  const lipY = kickerCurve.kind === 'bezier' ? kickerCurve.p3.y : groundAt(lipX);
  const coins: P[] = [];
  for (let index = 0; index < 4; index += 1) {
    const f = (index + 0.5) / 4;
    coins.push({ x: lipX + gapWidth * f, y: Math.min(lipY, gEnd - catchHeight) - 26 - Math.sin(f * Math.PI) * 22 });
  }
  for (let index = 0; index <= 2; index += 1) {
    const point = curvePoint(landing, 0.25 + index * 0.25);
    coins.push({ x: point.x, y: point.y - 28 });
  }
  const feature: TrackFeature = {
    id: 'gaprun',
    x0,
    x1: landX + landingWidth,
    // The takeoff is the full kicker (entry tail + main curve) — without the
    // main curve the run starts from flat ground and no certified takeoff
    // exists. The landing follows, and the ground suppression spans the
    // whole landing: the curve's underside must never meet the heightfield
    // (a bike that arrives under the leading edge would be crushed between
    // the two surfaces — arriving low is a fall into the chasm instead,
    // which the landing's catch height is tuned to prevent for certified
    // takeoffs).
    curves: [kicker.feature.curves[0], kicker.feature.curves[1], landing],
    halfThickness: 9,
    gap: { x: lipX - 4, width: gapWidth + 4 + landingWidth, bridged: false },
    coins,
    speedHint: gapWidth > 300 ? 3 : gapWidth > 230 ? 2 : 1,
  };
  if (catchHeight > 24) {
    feature.supports = [
      [{ x: landX + landingWidth * 0.3, y: gEnd - catchHeight }, { x: landX + landingWidth * 0.3, y: groundAt(landX + landingWidth * 0.3) }],
      [{ x: landX + landingWidth * 0.62, y: gEnd - catchHeight * 0.6 }, { x: landX + landingWidth * 0.62, y: groundAt(landX + landingWidth * 0.62) }],
    ];
  }
  return { feature, endX: landX + landingWidth };
}

function buildSuspendedArc(x0: number, groundAt: (x: number) => number, random: () => number, level: number): { feature: TrackFeature; endX: number } | null {
  const span = clamp(216 + random() * 88 + level * 6, 216, 330);
  const rise = clamp(34 + random() * 30 + level * 3, 34, 86);
  const g0 = groundAt(x0);
  const g1 = groundAt(x0 + span);
  if (Math.abs(g1 - g0) > 46) return null;
  const entrySlope = clamp(rise / span * 0.9, 0.12, 0.26);
  const curve: CurveShape = {
    kind: 'bezier',
    p0: { x: x0, y: g0 },
    p1: { x: x0 + span * 0.42, y: g0 - entrySlope * span * 0.42 },
    p2: { x: x0 + span * 0.58, y: g1 - entrySlope * span * 0.42 },
    p3: { x: x0 + span, y: g1 },
  };
  const coins: P[] = [];
  for (let index = 0; index <= 4; index += 1) {
    const point = curvePoint(curve, index / 4);
    coins.push({ x: point.x, y: point.y - 30 });
  }
  const supports: [P, P][] = [];
  for (const f of [0.3, 0.5, 0.7]) {
    const point = curvePoint(curve, f);
    supports.push([point, { x: point.x, y: groundAt(point.x) }]);
  }
  return {
    feature: {
      id: 'suspended-arc',
      x0: x0 - 26,
      x1: x0 + span + 26,
      curves: [entryTail(x0, groundAt), curve, exitTail(x0 + span, groundAt)],
      halfThickness: 9,
      gap: { x: x0 + 8, width: span - 16, bridged: true },
      supports,
      coins,
      speedHint: 0,
    },
    endX: x0 + span,
  };
}

function buildBowl(x0: number, groundAt: (x: number) => number, random: () => number, level: number): { feature: TrackFeature; endX: number } | null {
  const radius = clamp(74 + random() * 26 + Math.min(22, level * 1.6), 74, 116);
  const rim = (24 + random() * 9) * Math.PI / 180;
  const span = 2 * radius * Math.cos(rim);
  const gMid = groundAt(x0 + span / 2);
  const cy = gMid - radius * Math.sin(rim);
  const cx = x0 + radius * Math.cos(rim);
  const curve: CurveShape = { kind: 'arc', cx, cy, r: radius, a0: Math.PI - rim, sweep: -(Math.PI - 2 * rim) };
  const coins: P[] = [];
  for (let index = 0; index <= 4; index += 1) {
    const angle = Math.PI - rim - (Math.PI - 2 * rim) * (index / 4);
    coins.push({ x: cx + (radius - 26) * Math.cos(angle), y: cy + (radius - 26) * Math.sin(angle) });
  }
  return {
    feature: {
      id: 'c-bowl',
      x0: x0 - 26,
      x1: x0 + span + 26,
      curves: [entryTail(x0, groundAt), curve, exitTail(x0 + span, groundAt)],
      halfThickness: 9,
      gap: { x: x0 + 6, width: span - 12, bridged: false },
      coins,
      speedHint: 0,
    },
    endX: x0 + span,
  };
}

function buildLoop(x0: number, groundAt: (x: number) => number, random: () => number, level: number): { feature: TrackFeature; endX: number } | null {
  const radius = clamp(60 + random() * 12 + Math.min(8, (level - 5) * 1.2), 60, 80);
  const cx = x0 + radius + 30;
  const gMid = groundAt(cx);
  // The interior riding line (wheel centres at radius minus 19 from the
  // centre, where 19 = wheel radius + ribbon half thickness) takes over
  // from the entry dip's floor, so the loop reads as one continuous ribbon.
  const cy = gMid - radius + LOOP_RIDING_INSET - LOOP_GROUND_CLEAR;
  // Entry: a concave dip from the ground into the loop's interior. The bike
  // rides the dip's inner face and arrives at the flank already pitched and
  // tracking with its momentum intact — a bare tangent circle demands a
  // ~60° pitch change within a couple of frames and grinds the speed out
  // against the flank. The dip passes through the circle's open bottom
  // segment, so ribbon and dip never overlap.
  const joinAngle = (42 * Math.PI) / 180;
  const join = { x: cx + radius * Math.cos(joinAngle), y: cy + radius * Math.sin(joinAngle) };
  const exitAngle = (110 * Math.PI) / 180;
  const dipStartX = cx - radius - 30;
  const dipStart = { x: dipStartX, y: groundAt(dipStartX) };
  const dipFloor = Math.max(dipStart.y, gMid) + 14 + random() * 8;
  const dip: CurveShape = {
    kind: 'bezier',
    p0: dipStart,
    p1: { x: dipStart.x + (join.x - dipStart.x) * 0.32, y: dipFloor },
    p2: { x: join.x - Math.sin(joinAngle) * 46, y: join.y + Math.cos(joinAngle) * 46 },
    p3: join,
  };
  // The loop proper: from the join, up the right flank, over the top, down
  // the left side, ending just past the bottom-left where the interior line
  // hands the bike back to the heightfield (a short drop, no ribbon plane
  // to cross). The bottom segment stays open for the dip.
  const curve: CurveShape = { kind: 'arc', cx, cy, r: radius, a0: joinAngle, sweep: exitAngle - TAU - joinAngle };
  const coins: P[] = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = joinAngle - (curve.sweep * (index + 0.5)) / 9;
    coins.push({ x: cx + (radius - 30) * Math.cos(angle), y: cy + (radius - 30) * Math.sin(angle) });
  }
  const supports: [P, P][] = [];
  for (const angle of [Math.PI * 1.22, Math.PI * 0.78]) {
    const top = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
    supports.push([top, { x: top.x, y: groundAt(top.x) }]);
  }
  // The bike rejoins the heightfield shortly after the arc's exit end.
  const exitGroundX = cx - radius * Math.cos(exitAngle) + 34;
  return {
    feature: {
      id: 'loop',
      x0,
      x1: exitGroundX + 30,
      curves: [dip, curve],
      halfThickness: 9,
      supports,
      coins,
      gap: { x: dipStart.x + 8, width: exitGroundX - dipStart.x - 16, bridged: false },
      speedHint: 3,
    },
    endX: exitGroundX + 30,
  };
}

const CLEAR_AFTER: Record<TrackFeatureId, number> = {
  kicker: 300,
  gaprun: 460,
  'suspended-arc': 400,
  'c-bowl': 480,
  loop: 560,
};

function featureWeights(level: number): Record<TrackFeatureId, number> {
  const weights: Record<TrackFeatureId, number> = { kicker: 6, gaprun: 0, 'suspended-arc': 0, 'c-bowl': 0, loop: 0 };
  if (level >= 2) { weights.gaprun = 5; weights['suspended-arc'] = 4; }
  if (level >= 3) weights['c-bowl'] = 5;
  if (level >= 4) { weights.gaprun = 6; weights['suspended-arc'] = 4; }
  if (level >= 5) weights.loop = 5;
  if (level >= 7) { weights.kicker = 4; weights['c-bowl'] = 6; }
  return weights;
}

function pickFeatureId(level: number, random: () => number, lastId: TrackFeatureId | null | undefined): TrackFeatureId {
  const weights = featureWeights(level);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const ids = Object.keys(weights) as TrackFeatureId[];
    const total = ids.reduce((sum, id) => sum + weights[id], 0);
    let roll = random() * total;
    let chosen: TrackFeatureId = ids[0];
    for (const id of ids) {
      roll -= weights[id];
      if (roll <= 0) { chosen = id; break; }
    }
    if (FEATURE_UNLOCK[chosen] > level) continue;
    if (chosen === lastId && attempt < 3) continue;
    return chosen;
  }
  return 'kicker';
}

/** Plans one feature at startX; returns null when the terrain does not suit it. */
export function planTrackFeature(input: TrackPlanInput): TrackPlanResult | null {
  const { level, startX, groundAt, random, busy } = input;
  const id = pickFeatureId(level, random, input.lastId);
  let built: { feature: TrackFeature; endX: number } | null = null;
  if (id === 'kicker') built = buildKicker(startX, groundAt, random, level);
  else if (id === 'gaprun') built = buildGaprun(startX, groundAt, random, level);
  else if (id === 'suspended-arc') built = buildSuspendedArc(startX, groundAt, random, level);
  else if (id === 'c-bowl') built = buildBowl(startX, groundAt, random, level);
  else built = buildLoop(startX, groundAt, random, level);
  if (!built) return null;

  const feature = built.feature;
  const approach = id === 'loop' ? 340 : id === 'c-bowl' ? 260 : 200;
  const runout = CLEAR_AFTER[id];
  if (slopeOver(groundAt, startX - approach, feature.x1 + 120) > (id === 'loop' ? 0.11 : 0.15)) return null;
  if (busy(startX - approach, feature.x1 + runout)) return null;
  feature.intro = FEATURE_INTRO[id];
  return { feature, endX: built.endX, clearAfter: runout };
}

/** Spacing (px of clear ground) between consecutive features. */
export function featureSpacing(level: number, random: () => number): number {
  const base = Math.max(1050, 1750 - level * 55);
  return base + random() * 850;
}
