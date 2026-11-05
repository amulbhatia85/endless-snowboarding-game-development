import type { ObstacleId } from './obstacleRegistry';

export const LEVEL_TARGET_SCORE = 50_000;
export type EnvironmentTheme = 'countryside' | 'snowy-mountains' | 'misty-mountains' | 'moonlit-forest';
export type ObstacleCategory = ObstacleId;

export interface LevelConfiguration {
  number: number;
  name: string;
  seed: number;
  targetScore: number;
  environment: EnvironmentTheme;
  difficulty: { tier: number; progression: number };
  terrain: { heightScale: number; variationSeed: number };
  allowedObstacles: readonly ObstacleCategory[];
  weather: { kind: 'clear' | 'snow' | 'mist' | 'night'; intensity: number; speed: number };
  transitions: {
    start: { kind: 'house-exit'; seconds: number };
    end: { kind: 'safe-house'; entrySeconds: number; completionSeconds: number };
  };
}

const THEMES: readonly EnvironmentTheme[] = ['countryside', 'snowy-mountains', 'misty-mountains', 'moonlit-forest'];
const THEME_CONFIG = {
  countryside: { name: 'Green Hills', obstacles: ['rock', 'log', 'tree', 'fence', 'ramp', 'gap', 'bridge'], weather: 'clear', intensity: 0, speed: 1 },
  'snowy-mountains': { name: 'Snowfall Adventure', obstacles: ['rock', 'log', 'ice', 'icicle', 'snowball', 'gap', 'ramp', 'bridge'], weather: 'snow', intensity: 0.5, speed: 0.38 },
  'misty-mountains': { name: 'Misty Mountains', obstacles: ['rock', 'gap', 'cliff', 'bridge', 'broken-bridge', 'ramp', 'log', 'moving-platform'], weather: 'mist', intensity: 0.4, speed: 0.4 },
  'moonlit-forest': { name: 'Moonlit Forest', obstacles: ['tree', 'rock', 'root', 'branch', 'log', 'swinging-log', 'gap'], weather: 'night', intensity: 0.35, speed: 0.5 },
} as const;

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

export function generateLevel(number: number, journeySeed: number): LevelConfiguration {
  if (!positiveInteger(number)) throw new RangeError('Level number must be a positive safe integer.');
  const seed = mixSeed(journeySeed, number);
  const environment = number <= THEMES.length ? THEMES[number - 1] : THEMES[seed % THEMES.length];
  const theme = THEME_CONFIG[environment];
  const progression = Math.min(1, Math.log2(number) / 8);
  return {
    number,
    name: theme.name,
    seed,
    targetScore: LEVEL_TARGET_SCORE,
    environment,
    difficulty: { tier: number, progression },
    terrain: { heightScale: 1 + progression * 0.3, variationSeed: mixSeed(seed, 1) },
    allowedObstacles: [...theme.obstacles],
    weather: { kind: theme.weather, intensity: theme.intensity, speed: theme.speed },
    transitions: {
      start: { kind: 'house-exit', seconds: 2.4 },
      end: { kind: 'safe-house', entrySeconds: 1.5, completionSeconds: 3.1 },
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
  private readonly storage: ProgressStorage | undefined;
  private readonly validateCheckpoint: (value: unknown) => value is T;
  storageAvailable = true;

  constructor(options: {
    storage?: ProgressStorage;
    seed?: number;
    validateCheckpoint?: (value: unknown) => value is T;
  } = {}) {
    this.storage = options.storage ?? browserStorage();
    this.validateCheckpoint = options.validateCheckpoint ?? ((_value: unknown): _value is T => false);
    const seed = options.seed ?? Math.floor(Math.random() * 0x100000000);
    this.progress = {
      version: 1, journeySeed: seed >>> 0, currentLevel: 1, unlockedThrough: 1,
      completedThrough: 0, levelScore: 0, runScore: 0, lifetimeScore: 0, checkpoint: null,
    };
    this.restore();
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
