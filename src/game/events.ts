// Phase 9D — deterministic special events.
//
// A special event is a bounded window of world distance in which the world
// leans into a moment: a golden sunset, a snowstorm rolling over the ridge, a
// calm scenic stretch, a dense glowstone trail. Events never add new
// mechanics — they reweight the existing weather, ambience, coin and obstacle
// pipelines inside a smooth envelope that fades in and out over ~450 px.
//
// Scheduling is fully deterministic: every window is derived from the level
// seed plus the level's start x, so save/reload and checkpoint revival
// reproduce the exact same schedule with no persisted event state. Events are
// purely positional — entering and leaving the window is the whole lifecycle,
// so cleanup is automatic on crash, revival, level transition or game over.

import { createLevelRandom, type EnvironmentTheme, type LevelConfiguration } from './levelManager';

export type EventId =
  | 'golden-hour'
  | 'snowstorm'
  | 'forest-wind'
  | 'mist-surge'
  | 'calm-journey'
  | 'coin-trail'
  | 'mountain-crossing'
  | 'rare-challenge'
  | 'falling-hazards';

/** Per-event influence on the world, before the envelope is applied. */
export interface EventEffects {
  /** Weather biases (0 = no change). Negative values calm the sky. */
  readonly snow: number;
  readonly fog: number;
  readonly wind: number;
  readonly warmLight: number;
  readonly shafts: number;
  readonly groundMist: number;
  readonly ambient: number;
  /** Recolours ambient particles toward drifting autumn leaves. */
  readonly leafTint: number;
  /** Hazard suppression 0..1 (calm journey: recovery chance → 1). */
  readonly calm: number;
  /** Coin arc density boost 0..1 (coin trail). */
  readonly coinTrail: number;
  /** Pattern intensity boost 0..1 (rare challenge). */
  readonly dangerBias: number;
  /** Recovery-need reduction 0..1 while the window runs (bridges/challenges). */
  readonly hazardFocus: number;
  /** Extra post-danger recovery padding 0..1. */
  readonly recoveryBoost: number;
  /** Pattern ids whose planner weight is boosted while the window runs. */
  readonly prefer: readonly string[];
}

export interface EventDefinition {
  readonly id: EventId;
  readonly label: string;
  readonly description: string;
  /** Themes the event may appear in; '*' = every theme. */
  readonly environments: readonly EnvironmentTheme[] | '*';
  readonly minLevel: number;
  /** Minimum difficulty progression (0..1) required for gameplay events. */
  readonly minProgression: number;
  /** Base selection weight (higher = more common). */
  readonly rarity: number;
  /** Minimum world distance (px) that must separate two of these windows. */
  readonly cooldown: number;
  /** Nominal window length in px. */
  readonly duration: number;
  /**
   * Celestial gate — evaluated live when the window is entered. Golden hour
   * only ignites when the sky is actually near sunrise or sunset; at night
   * (or any other phase) the window is skipped silently. The day/night clock
   * itself is never touched.
   */
  readonly celestial?: (phase: number, night: number) => boolean;
  readonly effects: EventEffects;
}

const NO_EFFECTS: EventEffects = {
  snow: 0, fog: 0, wind: 0, warmLight: 0, shafts: 0, groundMist: 0, ambient: 0, leafTint: 0,
  calm: 0, coinTrail: 0, dangerBias: 0, hazardFocus: 0, recoveryBoost: 0, prefer: [],
};

const effects = (partial: Partial<EventEffects>): EventEffects => ({ ...NO_EFFECTS, ...partial });

/** Dawn (0–0.12) and sunset (0.55–0.72) bands of the day cycle. */
const goldenBands = (phase: number, night: number): boolean =>
  night < 0.5 && (phase < 0.12 || (phase >= 0.55 && phase < 0.72));

export const EVENT_DEFINITIONS: readonly EventDefinition[] = [
  {
    id: 'golden-hour',
    label: 'Golden Hour',
    description: 'The sun dips low and floods the valley with warm light.',
    environments: '*',
    minLevel: 3,
    minProgression: 0,
    rarity: 1.1,
    cooldown: 26000,
    duration: 5200,
    celestial: goldenBands,
    effects: effects({ warmLight: 0.55, shafts: 0.3, ambient: 0.2, fog: -0.15 }),
  },
  {
    id: 'snowstorm',
    label: 'Snowstorm',
    description: 'A storm rolls over the ridge — heavy snow and biting wind.',
    environments: ['snowy-mountains'],
    minLevel: 5,
    minProgression: 0,
    rarity: 0.9,
    cooldown: 30000,
    duration: 4600,
    effects: effects({ snow: 0.38, wind: 0.32, fog: 0.14, groundMist: 0.15 }),
  },
  {
    id: 'forest-wind',
    label: 'Forest Wind',
    description: 'A gusty breeze sets the trees swaying and carries the leaves.',
    environments: ['moonlit-forest', 'countryside'],
    minLevel: 4,
    minProgression: 0,
    rarity: 1.0,
    cooldown: 24000,
    duration: 5000,
    effects: effects({ wind: 0.34, leafTint: 0.8, ambient: 0.35, shafts: 0.18 }),
  },
  {
    id: 'mist-surge',
    label: 'Mist Surge',
    description: 'Thick mist pools over the pass while the path stays clear.',
    environments: ['misty-mountains'],
    minLevel: 4,
    minProgression: 0,
    rarity: 1.0,
    cooldown: 26000,
    duration: 4800,
    effects: effects({ fog: 0.3, groundMist: 0.35, ambient: 0.15 }),
  },
  {
    id: 'calm-journey',
    label: 'Calm Journey',
    description: 'A quiet scenic stretch — the mountain lets you breathe.',
    environments: '*',
    minLevel: 2,
    minProgression: 0,
    rarity: 1.2,
    cooldown: 22000,
    duration: 6200,
    effects: effects({ calm: 1, ambient: 0.25, fog: -0.12, wind: -0.1, shafts: 0.12 }),
  },
  {
    id: 'coin-trail',
    label: 'Glowstone Trail',
    description: 'A long ribbon of glowstones winds down the slope.',
    environments: '*',
    minLevel: 2,
    minProgression: 0,
    rarity: 1.15,
    cooldown: 24000,
    duration: 4200,
    effects: effects({ coinTrail: 1, ambient: 0.15 }),
  },
  {
    id: 'mountain-crossing',
    label: 'Mountain Crossing',
    description: 'The route threads a chain of bridges across the deep gaps.',
    environments: ['snowy-mountains', 'misty-mountains', 'countryside'],
    minLevel: 6,
    minProgression: 0.45,
    rarity: 0.8,
    cooldown: 34000,
    duration: 5600,
    effects: effects({ hazardFocus: 0.85, prefer: ['rope-bridge', 'broken-bridge', 'moving-platform'], wind: 0.12 }),
  },
  {
    id: 'rare-challenge',
    label: 'Rare Challenge',
    description: 'A gauntlet of the mountain\u2019s hardest lines — with room to recover.',
    environments: '*',
    minLevel: 8,
    minProgression: 0.55,
    rarity: 0.55,
    cooldown: 40000,
    // Phase 11 — widened so the gauntlet fits at least two hot lines after
    // the base pacing widened (lookahead alone consumes ~2 kpx of a window).
    duration: 6200,
    effects: effects({ dangerBias: 0.5, hazardFocus: 0.6, recoveryBoost: 1, prefer: ['cliff-jump', 'ramp-gap', 'warned-swinging-log'] }),
  },
  {
    id: 'falling-hazards',
    label: 'Falling Hazards',
    description: 'Icicles and loose branches come loose above the trail.',
    environments: ['snowy-mountains', 'moonlit-forest'],
    minLevel: 7,
    minProgression: 0.5,
    rarity: 0.7,
    cooldown: 32000,
    duration: 4000,
    effects: effects({ prefer: ['icicle-drop', 'falling-branch'], hazardFocus: 0.4, wind: 0.14 }),
  },
];

export const EVENT_IDS: readonly EventId[] = EVENT_DEFINITIONS.map((definition) => definition.id);

export function eventDefinition(id: EventId): EventDefinition {
  const definition = EVENT_DEFINITIONS.find((candidate) => candidate.id === id);
  if (!definition) throw new RangeError(`Unknown event id: ${id}`);
  return definition;
}

export function eventLabel(id: EventId): string {
  return eventDefinition(id).label;
}

/** A scheduled event window in world space. */
export interface EventWindow {
  readonly index: number;
  readonly eventId: EventId;
  readonly startX: number;
  readonly endX: number;
}

/** The currently running event (or the last evaluated state). */
export interface ActiveEvent {
  readonly eventId: EventId;
  readonly label: string;
  /** Smooth 0..1 envelope — ramps over ~450 px in and out of the window. */
  readonly intensity: number;
  readonly remainingPx: number;
}

export interface EventGate {
  /** Events only run while the rider is actually riding the level. */
  readonly riding: boolean;
  /** The final house approach suspends every event. */
  readonly safeApproach: boolean;
  /** No activation until the rider passes this x (revival grace). */
  readonly reviveGraceX: number;
  /** Live day-cycle phase and night factor (celestial gates). */
  readonly phase: number;
  readonly night: number;
}

export interface EventScheduleReport {
  readonly windows: readonly EventWindow[];
  readonly active: ActiveEvent | null;
  readonly forced: EventId | null;
  readonly suppressed: boolean;
}

const ENVELOPE_RAMP = 450;
const MIN_LEVEL_GAP = 3600;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smoothstep = (t: number) => t * t * (3 - 2 * t);

function eligibleIn(definition: EventDefinition, level: LevelConfiguration): boolean {
  if (level.number < definition.minLevel) return false;
  if (level.difficulty.progression < definition.minProgression) return false;
  return definition.environments === '*' || definition.environments.includes(level.environment);
}

/**
 * Deterministic, positional event scheduler. One instance lives on the
 * engine; `bind` is called with the current level and its start x (both are
 * part of the run state, so restored checkpoints rebuild the same schedule).
 */
export class EventManager {
  private windows: EventWindow[] = [];
  private boundLevel: LevelConfiguration | null = null;
  private boundStartX = Number.NaN;
  private active: ActiveEvent | null = null;
  private forced: EventId | null = null;
  private suppressed = false;
  /** Set by revive(): no new activation before this x. */
  private reviveGraceX = 0;

  /** Rebuilds the schedule when the level or its start x changed. Idempotent. */
  bind(level: LevelConfiguration, levelStartX: number, riderX = levelStartX): void {
    if (this.boundLevel === level && this.boundStartX === levelStartX) return;
    this.boundLevel = level;
    this.boundStartX = levelStartX;
    this.windows = buildSchedule(level, levelStartX);
    // A dev forced selection survives rebinds (level advances, restores) so
    // the preview keeps playing the chosen event.
    if (this.forced) this.applyForced(riderX);
    this.active = null;
    this.reviveGraceX = 0;
  }

  /**
   * Advances the active-event state to world position `x`. Pure with respect
   * to the schedule: the envelope is a function of x alone (plus the live
   * gate), so rewinding (crash + revival) simply replays it.
   */
  update(x: number, gate: EventGate): ActiveEvent | null {
    this.active = this.evaluate(x, gate);
    return this.active;
  }

  get current(): ActiveEvent | null {
    return this.active;
  }

  /** Envelope at x when the gate allows the event; 0 otherwise. */
  intensityAt(x: number, gate: EventGate): number {
    return this.evaluate(x, gate)?.intensity ?? 0;
  }

  /** Live weather/ambience bias (pre-multiplied by the envelope). */
  environmentBias(x: number, gate: EventGate): EventEnvironmentBias | null {
    const active = this.evaluate(x, gate);
    return active ? biasFor(active) : null;
  }

  /** Bias of the event evaluated by the last update() call. */
  bias(): EventEnvironmentBias | null {
    return this.active ? biasFor(this.active) : null;
  }

  /** Coin-trail envelope at a spawn position (0..1). */
  coinTrailAt(x: number): number {
    const window = this.windowAt(x);
    if (!window) return 0;
    return envelope(x, window) * eventDefinition(window.eventId).effects.coinTrail;
  }

  /**
   * Gameplay adjustments for a planning position: envelope-scaled effects the
   * engine folds into the pacing directive and the planner hint.
   */
  gameplayAt(x: number): EventGameplay {
    const window = this.windowAt(x);
    if (!window) return EMPTY_GAMEPLAY;
    const t = envelope(x, window);
    const e = eventDefinition(window.eventId).effects;
    return {
      eventId: window.eventId,
      intensity: t,
      calm: e.calm * t,
      dangerBias: e.dangerBias * t,
      hazardFocus: e.hazardFocus * t,
      recoveryBoost: e.recoveryBoost * t,
      prefer: t > 0.35 ? e.prefer : [],
    };
  }

  /** Dev/reporting view of the schedule. */
  report(): EventScheduleReport {
    return { windows: this.windows, active: this.active, forced: this.forced, suppressed: this.suppressed };
  }

  /** Dev tool (`?dev=1`): force the next window to a given event id. */
  forceNext(id: EventId, riderX: number): void {
    this.suppressed = false;
    this.forced = id;
    // Not bound yet (before the first frame): the pending id is applied when
    // the engine binds the level.
    if (!this.boundLevel || !Number.isFinite(this.boundStartX)) return;
    this.applyForced(riderX);
  }

  /** Overrides the next window ahead of `riderX`, appending one if needed. */
  private applyForced(riderX: number): void {
    if (!this.forced) return;
    const upcoming = this.windows.find((window) => window.endX > riderX - 100);
    if (upcoming) {
      const forced = this.forced;
      // Phase 11 — the forced definition's own duration applies, so a
      // previewed event behaves like its organically scheduled self instead
      // of inheriting whichever window happened to sit ahead of the rider.
      const definition = eventDefinition(forced);
      this.windows = this.windows.map((window) =>
        window === upcoming
          ? { ...window, eventId: forced, endX: window.startX + definition.duration }
          : window);
      return;
    }
    // Schedule is exhausted (or fully behind the rider): append one window so
    // the preview always has something to show. Dev-only state — 'auto'
    // rebuilds the deterministic schedule from the bound level.
    const definition = eventDefinition(this.forced);
    const startX = Math.max(riderX + 700, this.boundStartX + 900);
    this.windows = [...this.windows, {
      index: this.windows.length,
      eventId: this.forced,
      startX,
      endX: startX + definition.duration,
    }];
  }

  /** Dev tool: 'none' suspends every event; 'auto' restores determinism. */
  setPreview(mode: 'auto' | 'none'): void {
    if (mode === 'none') {
      this.suppressed = true;
      this.forced = null;
      this.active = null;
      return;
    }
    this.suppressed = false;
    this.forced = null;
    // Rebind from the deterministic inputs to drop any dev-appended window.
    if (this.boundLevel && Number.isFinite(this.boundStartX)) {
      this.windows = buildSchedule(this.boundLevel, this.boundStartX);
    }
  }

  /** Called by the engine on revival — delays the next activation. */
  reviveFrom(x: number): void {
    this.reviveGraceX = x + 1500;
  }

  private windowAt(x: number): EventWindow | undefined {
    return this.windows.find((window) => x >= window.startX - 60 && x <= window.endX + 60);
  }

  private evaluate(x: number, gate: EventGate): ActiveEvent | null {
    if (this.suppressed) return null;
    if (!gate.riding || gate.safeApproach) return null;
    if (x < Math.max(gate.reviveGraceX, this.reviveGraceX)) return null;
    const window = this.windowAt(x);
    if (!window) return null;
    const definition = eventDefinition(window.eventId);
    if (definition.celestial && !definition.celestial(gate.phase, gate.night)) return null;
    return {
      eventId: window.eventId,
      label: definition.label,
      intensity: envelope(x, window),
      remainingPx: Math.max(0, window.endX - x),
    };
  }
}

function envelope(x: number, window: EventWindow): number {
  const rampIn = clamp01((x - window.startX) / ENVELOPE_RAMP);
  const rampOut = clamp01((window.endX - x) / ENVELOPE_RAMP);
  return Math.min(smoothstep(rampIn), smoothstep(rampOut));
}

function biasFor(active: ActiveEvent): EventEnvironmentBias {
  const e = eventDefinition(active.eventId).effects;
  const t = active.intensity;
  return {
    snow: e.snow * t,
    fog: e.fog * t,
    wind: e.wind * t,
    warmLight: e.warmLight * t,
    shafts: e.shafts * t,
    groundMist: e.groundMist * t,
    ambient: e.ambient * t,
    leafTint: e.leafTint * t,
  };
}

/** Weather/ambience bias handed to EnvironmentManager.update each frame. */
export interface EventEnvironmentBias {
  readonly snow: number;
  readonly fog: number;
  readonly wind: number;
  readonly warmLight: number;
  readonly shafts: number;
  readonly groundMist: number;
  readonly ambient: number;
  readonly leafTint: number;
}

/** Envelope-scaled gameplay adjustments for planning positions. */
export interface EventGameplay {
  readonly eventId: EventId | null;
  readonly intensity: number;
  readonly calm: number;
  readonly dangerBias: number;
  readonly hazardFocus: number;
  readonly recoveryBoost: number;
  readonly prefer: readonly string[];
}

const EMPTY_GAMEPLAY: EventGameplay = {
  eventId: null, intensity: 0, calm: 0, dangerBias: 0, hazardFocus: 0, recoveryBoost: 0, prefer: [],
};

/**
 * Builds the deterministic window list for one level: 1–3 windows, drawn
 * from the eligible definitions by rarity weight, never repeating the
 * previous event, always separated by the definition cooldown plus a base
 * gap so events stay occasional and never overlap.
 */
function buildSchedule(level: LevelConfiguration, levelStartX: number): EventWindow[] {
  const eligible = EVENT_DEFINITIONS.filter((definition) => eligibleIn(definition, level));
  if (!eligible.length) return [];
  const random = createLevelRandom(level.seed ^ 0x9e7e47);
  const count = 1 + Math.floor(random() * 3);
  const windows: EventWindow[] = [];
  let x = levelStartX + 4800 + random() * 5200;
  let previousId: EventId | null = null;
  for (let index = 0; index < count; index += 1) {
    const pool = eligible.filter((definition) => definition.id !== previousId);
    if (!pool.length) break;
    const total = pool.reduce((sum, definition) => sum + definition.rarity, 0);
    let pick = random() * total;
    let chosen = pool[pool.length - 1];
    for (const definition of pool) {
      if (pick < definition.rarity) {
        chosen = definition;
        break;
      }
      pick -= definition.rarity;
    }
    const end = x + chosen.duration * (0.85 + random() * 0.3);
    windows.push({ index, eventId: chosen.id, startX: x, endX: end });
    previousId = chosen.id;
    x = end + Math.max(chosen.cooldown, MIN_LEVEL_GAP) * (0.7 + random() * 0.6);
  }
  return windows;
}

/** Deterministic schedule for (level, startX) — test/dev entry point. */
export function scheduleForLevel(level: LevelConfiguration, levelStartX: number): EventWindow[] {
  return buildSchedule(level, levelStartX);
}
