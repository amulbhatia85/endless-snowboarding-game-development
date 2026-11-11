import type { ObstacleId } from './obstacleRegistry';

export const LEVEL_TARGET_SCORE = 50_000;
export type EnvironmentTheme = 'countryside' | 'snowy-mountains' | 'misty-mountains' | 'moonlit-forest' | 'jungle';
export type ObstacleCategory = ObstacleId;

/**
 * Phase 9C — per-level terrain identity. A profile biases the procedural
 * terrain generator statistically (range, bump, recovery rate, valley shape);
 * it never relaxes the slope cap or the physics validation, so every profile
 * stays physically achievable by construction.
 */
export type LevelProfileId =
  | 'classic'
  | 'flowing-hills'
  | 'mountain-descent'
  | 'gradual-climb'
  | 'rolling-valleys'
  | 'technical-slopes'
  | 'controlled-flats'
  | 'mixed-terrain';

export interface TerrainBias {
  /** Multiplier on the environment's anchor range (0.55..1.25). */
  rangeScale: number;
  /** Multiplier on the bump amplitude (0.3..1.3). */
  bumpScale: number;
  /** Multiplier on the recovery-chunk probability (0.55..1.45). */
  recoveryScale: number;
  /** Shifts the valley ↔ rolling ↔ ramp split (−0.12..0.12). */
  valleyBias: number;
}

export interface LevelProfile {
  id: LevelProfileId;
  /** Human-readable identity used in the HUD and dev diagnostics. */
  label: string;
  terrain: TerrainBias;
}

const NEUTRAL_BIAS: TerrainBias = { rangeScale: 1, bumpScale: 1, recoveryScale: 1, valleyBias: 0 };

/** The seven generated identities (levels ≥ 5). `classic` is the neutral prefix profile. */
const PROFILE_BIASES: Record<Exclude<LevelProfileId, 'classic'>, TerrainBias> = {
  'flowing-hills': { rangeScale: 0.9, bumpScale: 0.85, recoveryScale: 1.25, valleyBias: 0.04 },
  'mountain-descent': { rangeScale: 1.55, bumpScale: 0.55, recoveryScale: 0.55, valleyBias: 0.12 },
  'gradual-climb': { rangeScale: 0.95, bumpScale: 0.6, recoveryScale: 1.3, valleyBias: 0.06 },
  'rolling-valleys': { rangeScale: 1.05, bumpScale: 1.1, recoveryScale: 0.95, valleyBias: 0.12 },
  'technical-slopes': { rangeScale: 1.1, bumpScale: 1.3, recoveryScale: 0.6, valleyBias: -0.1 },
  'controlled-flats': { rangeScale: 0.55, bumpScale: 0.35, recoveryScale: 1.45, valleyBias: 0.02 },
  'mixed-terrain': { rangeScale: 1, bumpScale: 1, recoveryScale: 1, valleyBias: 0 },
};

const PROFILE_LABELS: Record<LevelProfileId, string> = {
  classic: 'Classic',
  'flowing-hills': 'Flowing Hills',
  'mountain-descent': 'Mountain Descent',
  'gradual-climb': 'Gradual Climb',
  'rolling-valleys': 'Rolling Valleys',
  'technical-slopes': 'Technical Slopes',
  'controlled-flats': 'Controlled Flats',
  'mixed-terrain': 'Mixed Terrain',
};

/**
 * Environment-appropriate terrain patterns: each theme prefers a different
 * profile mix (a weight of 0 means the combination is never generated).
 */
const THEME_PROFILE_WEIGHTS: Record<EnvironmentTheme, Partial<Record<Exclude<LevelProfileId, 'classic'>, number>>> = {
  countryside: { 'flowing-hills': 5, 'rolling-valleys': 4, 'gradual-climb': 3, 'controlled-flats': 2, 'mixed-terrain': 3, 'mountain-descent': 1, 'technical-slopes': 0 },
  'snowy-mountains': { 'mountain-descent': 5, 'technical-slopes': 4, 'flowing-hills': 2, 'mixed-terrain': 3, 'rolling-valleys': 2, 'gradual-climb': 0, 'controlled-flats': 0 },
  'misty-mountains': { 'mountain-descent': 4, 'gradual-climb': 3, 'technical-slopes': 3, 'rolling-valleys': 3, 'mixed-terrain': 2, 'flowing-hills': 0, 'controlled-flats': 1 },
  'moonlit-forest': { 'flowing-hills': 4, 'technical-slopes': 3, 'rolling-valleys': 3, 'controlled-flats': 2, 'mixed-terrain': 3, 'mountain-descent': 0, 'gradual-climb': 2 },
  jungle: { 'flowing-hills': 4, 'rolling-valleys': 4, 'mixed-terrain': 3, 'gradual-climb': 2, 'technical-slopes': 2, 'controlled-flats': 1, 'mountain-descent': 0 },
};

/** Identity flavour words for generated level names (levels ≥ 5). */
const PROFILE_FLAVORS: Record<Exclude<LevelProfileId, 'classic'>, readonly string[]> = {
  'flowing-hills': ['Whispering', 'Drifting', 'Sunlit', 'Wandering'],
  'mountain-descent': ['Plunging', 'Thundering', 'Cascade', 'Eagle'],
  'gradual-climb': ['Rising', 'Aspen', 'Meadow', 'Lantern'],
  'rolling-valleys': ['Emerald', 'Mossy', 'Riverbend', 'Clover'],
  'technical-slopes': ['Jagged', 'Falcon', 'Razorline', 'Cobalt'],
  'controlled-flats': ['Stillwater', 'Moonlit', 'Quiet', 'Glassy'],
  'mixed-terrain': ['Shifting', 'Kaleido', 'Borderland', 'Crosswind'],
};

const THEME_NOUNS: Record<EnvironmentTheme, string> = {
  countryside: 'Valley',
  'snowy-mountains': 'Peaks',
  'misty-mountains': 'Range',
  'moonlit-forest': 'Forest',
  jungle: 'Jungle',
};

export interface LevelConfiguration {
  number: number;
  name: string;
  seed: number;
  targetScore: number;
  environment: EnvironmentTheme;
  difficulty: { tier: number; progression: number };
  terrain: { heightScale: number; variationSeed: number };
  /**
   * Phase 9C — the level's identity. Levels 1–4 keep the classic neutral
   * profile; generated levels carry one of the seven biases above.
   */
  profile: LevelProfile;
  allowedObstacles: readonly ObstacleCategory[];
  /**
   * Phase 9C — dominant obstacle families for this level (a seeded subset of
   * `allowedObstacles`). The planner boosts these patterns; nothing is
   * removed, so availability and validation semantics are unchanged.
   */
  obstacleFocus: readonly ObstacleCategory[];
  weather: { kind: 'clear' | 'snow' | 'mist' | 'night'; intensity: number; speed: number };
  transitions: {
    start: { kind: 'house-exit'; seconds: number };
    end: { kind: 'safe-house'; entrySeconds: number; completionSeconds: number };
  };
}

const THEMES: readonly EnvironmentTheme[] = ['countryside', 'snowy-mountains', 'misty-mountains', 'moonlit-forest', 'jungle'];
const THEME_CONFIG = {
  countryside: { name: 'Green Hills', obstacles: ['rock', 'log', 'tree', 'root', 'fence', 'ramp', 'gap', 'bridge'], weather: 'clear', intensity: 0, speed: 1 },
  'snowy-mountains': { name: 'Snowfall Adventure', obstacles: ['rock', 'log', 'ice', 'icicle', 'snowball', 'gap', 'ramp', 'bridge', 'gorge', 'ice-boulder'], weather: 'snow', intensity: 0.5, speed: 0.38 },
  'misty-mountains': { name: 'Misty Mountains', obstacles: ['rock', 'gap', 'cliff', 'bridge', 'broken-bridge', 'ramp', 'log', 'moving-platform', 'gorge'], weather: 'mist', intensity: 0.4, speed: 0.4 },
  'moonlit-forest': { name: 'Moonlit Forest', obstacles: ['tree', 'rock', 'root', 'branch', 'log', 'swinging-log', 'gap'], weather: 'night', intensity: 0.35, speed: 0.5 },
  // Phase 11 — the fifth environment: a dense canopy world of vines, ruin
  // stones and river crossings. Owns the timed-hazard families early
  // (falling branches from L3, swinging vines from L4) plus moving
  // platforms; mechanically it reuses fully validated obstacle kinds.
  jungle: { name: 'Jungle Canopy', obstacles: ['tree', 'rock', 'root', 'log', 'branch', 'swinging-log', 'gap', 'ramp', 'bridge', 'moving-platform'], weather: 'mist', intensity: 0.45, speed: 0.42 },
} as const;

/**
 * Phase 9A audit tool: the first themed level (1–4) whose environment permits
 * this obstacle id — drives the developer obstacle preview so every id is
 * shown in a level that can actually generate it.
 */
export function previewLevelForObstacle(id: ObstacleId): number {
  const index = THEMES.findIndex(theme => (THEME_CONFIG[theme].obstacles as readonly string[]).includes(id));
  return index === -1 ? 1 : index + 1;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function points(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Integer mixing keeps generation independent of gameplay and cosmetic randomness.
function mixSeed(seed: number, level: number): number {
  let value = (seed ^ (level >>> 0) ^ Math.imul(Math.floor(level / 0x100000000), 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

/** Deterministic 0..1 draw for (journey seed, salt, level). */
function roll(journeySeed: number, salt: number, level: number): number {
  return mixSeed(journeySeed ^ salt, level) / 4294967296;
}

// ───────────────────────── Phase 9C: level identity chain ─────────────────────────
//
// Every level ≥ 5 gets an environment and a terrain profile from a seeded
// chain that consults the two previous levels: consecutive levels never share
// an environment, two-level ping-pong is impossible, and terrain profiles
// never repeat back to back. The chain is pure (reproducible from the saved
// journey seed alone), computed iteratively — so any level number can be
// reproduced without recursion — and cached with a hard cap.

interface LevelIdentity {
  environment: EnvironmentTheme;
  profile: Exclude<LevelProfileId, 'classic'>;
}

const PREFIX_IDENTITIES: readonly LevelIdentity[] = [
  { environment: 'countryside', profile: 'flowing-hills' },
  { environment: 'snowy-mountains', profile: 'mountain-descent' },
  { environment: 'misty-mountains', profile: 'rolling-valleys' },
  { environment: 'moonlit-forest', profile: 'flowing-hills' },
];

const identityChains = new Map<number, { start: number; entries: Map<number, LevelIdentity> }>();
/** Contiguous tail kept per journey seed — advancing a journey stays O(1). */
const IDENTITY_CHAIN_TAIL = 512;
const GENERATED_PROFILES = Object.keys(PROFILE_BIASES) as readonly (Exclude<LevelProfileId, 'classic'>)[];

function weightedProfile(environment: EnvironmentTheme, draw: number, exclude?: LevelProfileId): Exclude<LevelProfileId, 'classic'> {
  const weights = THEME_PROFILE_WEIGHTS[environment];
  const entries = GENERATED_PROFILES.filter(id => weights[id] && id !== exclude);
  if (!entries.length) return GENERATED_PROFILES.find(id => weights[id]) ?? 'mixed-terrain';
  const total = entries.reduce((sum, id) => sum + (weights[id] ?? 0), 0);
  let pick = draw * total;
  for (const id of entries) {
    pick -= weights[id] ?? 0;
    if (pick < 0) return id;
  }
  return entries[entries.length - 1];
}

function identityStep(journeySeed: number, level: number, previous: LevelIdentity, before: LevelIdentity): LevelIdentity {
  // Environment: a seeded pick that differs from both previous levels — no
  // immediate repeats, no two-level ping-pong, and no fixed predictable cycle.
  const allowed = THEMES.filter(theme => theme !== previous.environment);
  const envDraw = roll(journeySeed, 0x51ed270b, level);
  let environment = allowed[Math.min(allowed.length - 1, Math.floor(envDraw * allowed.length))];
  if (environment === before.environment) {
    // Deterministic reshuffle to another allowed theme (never the previous one).
    const offset = 1 + Math.floor(envDraw * 2);
    environment = allowed[(allowed.indexOf(before.environment) + offset) % allowed.length];
  }
  // Profile: theme-appropriate weighted pick, never the previous level's.
  const profile = weightedProfile(environment, roll(journeySeed, 0x9a1c33f7, level), previous.profile);
  return { environment, profile };
}

function identityAt(journeySeed: number, level: number): LevelIdentity {
  if (level <= PREFIX_IDENTITIES.length) return PREFIX_IDENTITIES[level - 1];
  let chain = identityChains.get(journeySeed);
  if (!chain) {
    chain = { start: PREFIX_IDENTITIES.length + 1, entries: new Map() };
    identityChains.set(journeySeed, chain);
  }
  const cached = chain.entries.get(level);
  if (cached) return cached;
  let before = PREFIX_IDENTITIES[PREFIX_IDENTITIES.length - 2];
  let previous = PREFIX_IDENTITIES[PREFIX_IDENTITIES.length - 1];
  let start = PREFIX_IDENTITIES.length + 1;
  const newest = chain.start + chain.entries.size - 1;
  if (chain.entries.size >= 2 && level > newest) {
    // Resume the contiguous tail: sequential advancement is O(1).
    const tail = chain.entries.get(newest);
    const tailBefore = chain.entries.get(newest - 1);
    if (tail && tailBefore) {
      previous = tail;
      before = tailBefore;
      start = newest + 1;
    }
  } else if (chain.entries.size && level <= newest) {
    // Gap inside the tail cannot happen (contiguous), but stay safe: reset.
    chain.start = PREFIX_IDENTITIES.length + 1;
    chain.entries.clear();
  } else if (chain.entries.size && level < chain.start) {
    // Descending far below the cached tail: recompute from the prefix.
    chain.start = PREFIX_IDENTITIES.length + 1;
    chain.entries.clear();
  }
  let identity = previous;
  for (let number = start; number <= level; number += 1) {
    identity = identityStep(journeySeed, number, previous, before);
    before = previous;
    previous = identity;
    chain.entries.set(number, identity);
    if (chain.entries.size > IDENTITY_CHAIN_TAIL) {
      chain.entries.delete(chain.start);
      chain.start += 1;
    }
  }
  return identity;
}

/** Seeded dominant-family subset of the theme's obstacles (levels ≥ 5). */
function focusFor(journeySeed: number, level: number, obstacles: readonly ObstacleCategory[]): ObstacleCategory[] {
  const base = (n: number) => {
    const size = 2 + Math.floor(roll(journeySeed, 0x2f6b8e1, n) * 3); // 2..4 families
    const pool = [...obstacles];
    const picked: ObstacleCategory[] = [];
    for (let index = 0; index < size && pool.length; index += 1) {
      const draw = roll(journeySeed, 0x6d91c4 + index * 0x9e37, n);
      picked.push(pool.splice(Math.floor(draw * pool.length), 1)[0]);
    }
    return picked;
  };
  const current = base(level);
  const previous = base(level - 1);
  const overlap = previous.filter(id => current.includes(id)).length;
  if (overlap >= Math.ceil(current.length / 2) && current.length > 1) {
    // Deterministic nudge away from the previous level's raw emphasis.
    const unused = obstacles.filter(id => !current.includes(id));
    if (unused.length) {
      const swapIndex = current.findIndex(id => previous.includes(id));
      current[swapIndex === -1 ? 0 : swapIndex] = unused[Math.floor(roll(journeySeed, 0x17c3fe, level) * unused.length)];
    }
  }
  return current;
}

export function generateLevel(number: number, journeySeed: number): LevelConfiguration {
  if (!positiveInteger(number)) throw new RangeError('Level number must be a positive safe integer.');
  const seed = mixSeed(journeySeed, number);
  const identity = identityAt(journeySeed, number);
  const environment = identity.environment;
  const theme = THEME_CONFIG[environment];
  const progression = Math.min(1, Math.log2(number) / 8);
  const generated = number > PREFIX_IDENTITIES.length;
  const profileId: LevelProfileId = generated ? identity.profile : 'classic';
  const profile: LevelProfile = { id: profileId, label: PROFILE_LABELS[profileId], terrain: generated ? PROFILE_BIASES[identity.profile] : NEUTRAL_BIAS };

  return {
    number,
    name: generated
      ? `${PROFILE_FLAVORS[identity.profile][Math.floor(roll(journeySeed, 0x5f3a9d, number) * PROFILE_FLAVORS[identity.profile].length)]} ${THEME_NOUNS[environment]}`
      : theme.name,
    seed,
    targetScore: LEVEL_TARGET_SCORE,
    environment,
    difficulty: { tier: number, progression },
    terrain: { heightScale: 1 + progression * 0.3, variationSeed: mixSeed(seed, 1) },
    profile,
    allowedObstacles: [...theme.obstacles],
    obstacleFocus: generated ? focusFor(journeySeed, number, theme.obstacles) : [],
    weather: generated && theme.weather !== 'clear'
      ? {
        kind: theme.weather,
        intensity: Math.min(0.95, theme.intensity * (0.55 + roll(journeySeed, 0x77aa11, number) * 0.9)),
        speed: Math.max(0.2, theme.speed * (0.8 + roll(journeySeed, 0x3cc927, number) * 0.45)),
      }
      : { kind: theme.weather, intensity: theme.intensity, speed: theme.speed },
    transitions: {
      start: { kind: 'house-exit', seconds: 2.4 },
      // Playtest fix — the completion card used to auto-advance after 3.1s,
      // which came and went before the reward lines and stats could be read.
      // It now holds for a generous read; a press after the engine's 1.1s
      // grace still continues early (see SnowGameEngine.press). The card's
      // CSS fade reads this exact value (App.tsx), so they cannot drift.
      end: { kind: 'safe-house', entrySeconds: 1.5, completionSeconds: 10 },
    },
  };
}

export function createLevelRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface ProgressSave<T> {
  version: 1;
  journeySeed: number;
  currentLevel: number;
  unlockedThrough: number;
  completedThrough: number;
  levelScore: number;
  runScore: number;
  lifetimeScore: number;
  checkpoint: T | null;
}

export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LEVEL_SAVE_KEY = 'afterglow-level-progress-v1';

function browserStorage(): ProgressStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export class LevelManager<T = never> {
  private progress: ProgressSave<T>;
  private safeHouseLevel: number | null = null;
  private configuration: LevelConfiguration;
  private storage: ProgressStorage | undefined;
  private readonly validateCheckpoint: (value: unknown) => value is T;
  storageAvailable = true;

  constructor(options: {
    storage?: ProgressStorage;
    seed?: number;
    validateCheckpoint?: (value: unknown) => value is T;
    /** Forces the starting level (local preview via ?level=N and tests). */
    initialLevel?: number;
  } = {}) {
    this.storage = options.storage ?? browserStorage();
    this.validateCheckpoint = options.validateCheckpoint ?? ((_value: unknown): _value is T => false);
    const seed = options.seed ?? Math.floor(Math.random() * 0x100000000);
    this.progress = {
      version: 1, journeySeed: seed >>> 0, currentLevel: 1, unlockedThrough: 1,
      completedThrough: 0, levelScore: 0, runScore: 0, lifetimeScore: 0, checkpoint: null,
    };
    this.restore();
    if (options.initialLevel !== undefined) {
      if (!positiveInteger(options.initialLevel)) throw new RangeError('initialLevel must be a positive safe integer.');
      this.progress.currentLevel = options.initialLevel;
      this.progress.unlockedThrough = Math.max(this.progress.unlockedThrough, options.initialLevel);
      this.progress.completedThrough = options.initialLevel - 1;
      this.progress.levelScore = 0;
      this.progress.runScore = 0;
      this.progress.checkpoint = null;
      this.persist();
    }
    this.configuration = generateLevel(this.progress.currentLevel, this.progress.journeySeed);
  }

  get current(): LevelConfiguration { return this.configuration; }
  get levelScore(): number { return this.progress.levelScore; }
  get lifetimeScore(): number { return this.progress.lifetimeScore; }
  get completedThrough(): number { return this.progress.completedThrough; }
  get unlockedThrough(): number { return this.progress.unlockedThrough; }
  get checkpoint(): T | null { return this.progress.checkpoint; }
  get savedRunScore(): number { return this.progress.runScore; }
  get targetReached(): boolean { return this.levelScore >= LEVEL_TARGET_SCORE; }
  get safeHouseReached(): boolean { return this.safeHouseLevel === this.current.number; }

  getLevel(number: number): LevelConfiguration {
    return generateLevel(number, this.progress.journeySeed);
  }

  updateScore(levelScore: number, runScore: number): void {
    if (!points(levelScore) || !points(runScore) || runScore < this.progress.runScore || levelScore > runScore) {
      throw new RangeError('Score updates must be nonnegative and cumulative within an attempt.');
    }
    const earned = runScore - this.progress.runScore;
    this.progress.lifetimeScore = Math.min(Number.MAX_SAFE_INTEGER, this.progress.lifetimeScore + earned);
    this.progress.runScore = runScore;
    this.progress.levelScore = Math.min(levelScore, LEVEL_TARGET_SCORE);
  }

  markSafeHouseReached(): boolean {
    if (!this.targetReached) return false;
    if (this.safeHouseReached) return false; // idempotent: no duplicate completion
    this.safeHouseLevel = this.current.number;
    return true;
  }

  advanceAfterTransition(): LevelConfiguration {
    if (!this.targetReached || !this.safeHouseReached) {
      throw new Error('The target, safe house and completion transition must precede advancement.');
    }
    const next = this.current.number + 1;
    if (!positiveInteger(next)) throw new RangeError('Level number exceeds the supported integer range.');
    this.progress.currentLevel = next;
    this.configuration = generateLevel(next, this.progress.journeySeed);
    this.progress.completedThrough = next - 1;
    this.progress.unlockedThrough = Math.max(this.progress.unlockedThrough, next);
    this.progress.levelScore = 0;
    this.progress.checkpoint = null;
    this.safeHouseLevel = null;
    this.persist();
    return this.current;
  }

  saveCheckpoint(checkpoint: T): boolean {
    if (this.safeHouseReached || !this.validateCheckpoint(checkpoint)) return false;
    this.progress.checkpoint = JSON.parse(JSON.stringify(checkpoint)) as T;
    return this.persist();
  }

  restartAttempt(): void {
    this.progress.levelScore = 0;
    this.progress.runScore = 0;
    this.progress.checkpoint = null;
    this.safeHouseLevel = null;
    this.persist();
  }

  /**
   * Phase 5A audit tool (developer level selector, `?dev=1`): jump to an
   * arbitrary level using the same journey seed, entirely in memory. All
   * subsequent persistence goes to a throwaway store, so real saved
   * progression — scores, unlocks, checkpoints — is never overwritten and no
   * level is permanently unlocked.
   */
  enterPreview(level: number): LevelConfiguration {
    if (!positiveInteger(level)) throw new RangeError('Preview level must be a positive safe integer.');
    const values = new Map<string, string>();
    this.storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
    this.progress = {
      version: 1,
      journeySeed: this.progress.journeySeed,
      currentLevel: level,
      unlockedThrough: Math.max(this.progress.unlockedThrough, level),
      completedThrough: level - 1,
      levelScore: 0,
      runScore: 0,
      lifetimeScore: this.progress.lifetimeScore,
      checkpoint: null,
    };
    this.safeHouseLevel = null;
    this.configuration = generateLevel(level, this.progress.journeySeed);
    this.persist();
    return this.configuration;
  }

  private persist(): boolean {
    try {
      if (!this.storage) { this.storageAvailable = false; return false; }
      this.storage.setItem(LEVEL_SAVE_KEY, JSON.stringify(this.progress));
      this.storageAvailable = true;
      return true;
    } catch {
      this.storageAvailable = false;
      return false;
    }
  }

  private restore(): void {
    try {
      const raw = this.storage?.getItem(LEVEL_SAVE_KEY);
      if (!raw) return;
      const data: unknown = JSON.parse(raw);
      if (!data || typeof data !== 'object') return;
      const saved = data as Record<string, unknown>;
      if (saved.version !== 1 || !points(saved.journeySeed) || saved.journeySeed > 0xffffffff
        || !positiveInteger(saved.currentLevel) || !positiveInteger(saved.unlockedThrough)
        || !points(saved.completedThrough) || saved.completedThrough !== saved.currentLevel - 1
        || saved.unlockedThrough < saved.currentLevel || !points(saved.levelScore)
        || saved.levelScore > LEVEL_TARGET_SCORE || !points(saved.runScore)
        || saved.levelScore > saved.runScore || !points(saved.lifetimeScore)
        || saved.runScore > saved.lifetimeScore) return;
      const checkpoint = saved.checkpoint === null || !this.validateCheckpoint(saved.checkpoint) ? null : saved.checkpoint;
      this.progress = {
        version: 1, journeySeed: saved.journeySeed, currentLevel: saved.currentLevel,
        unlockedThrough: saved.unlockedThrough, completedThrough: saved.completedThrough,
        levelScore: checkpoint === null ? 0 : saved.levelScore,
        runScore: checkpoint === null ? 0 : saved.runScore,
        lifetimeScore: saved.lifetimeScore, checkpoint,
      };
    } catch {
      // Invalid or unavailable saves fall back to a playable fresh journey.
      this.storageAvailable = false;
    }
  }
}
