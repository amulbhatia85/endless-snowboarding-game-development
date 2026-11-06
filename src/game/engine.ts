import { ObstaclePlanner, OBSTACLE_PATTERNS, patternAvailability, patternRating, validPlacementMetadata, type PlacementMetadata, type PlacementRejection } from './obstaclePlanner';
import { OBSTACLE_REGISTRY, obstacleReady, swingingLogPose, iciclePose, branchPose, snowballPose, platformBob, type ObstacleId } from './obstacleRegistry';
import { flipProgress } from './riderPhysics';
import { BICYCLE_PHYSICS, TerrainWorld, type TerrainOrigin } from './terrain';
import { EnvironmentManager, decorationOverlapsGameplay, type EnvironmentView, type Palette } from './environment';
import type { EnvironmentTheme } from './levelManager';
import type { WeatherEffectConfig } from './weather';
import { createLevelRandom, LevelManager, previewLevelForObstacle } from './levelManager';
import { DifficultyManager, type DifficultyDirective } from './difficulty';

import { BIKES, RIDERS, TRAILS, MISSIONS, MISSION_BONUS, isUnlocked, requirementsMet, findCosmetic, type BikeEntry, type RiderEntry, type TrailEntry, type UnlockContext } from './progression';
import { Wallet, REWARD_CONFIG, type LevelRewardBreakdown } from './wallet';
import { RECOVERY_CONFIG } from './recovery';
import { readLifetime, getAchievements, readUnlockedAchievements } from './profile';

export type GameScreen = 'menu' | 'playing' | 'paused' | 'crashed' | 'gameover';
export type LevelPhase = 'riding' | 'approach' | 'entering' | 'celebrating' | 'exiting' | 'finished';
export type GraphicsQuality = 'auto' | 'high' | 'balanced';

export interface HudSnapshot {
  score: number;
  distance: number;
  speedKmh: number;
  coins: number;
  combo: number;
  elapsed: number;
  level?: {
    number: number;
    name: string;
    score: number;
    target: number;
    phase: LevelPhase;
    completed: number;
    coinsCollected: number;
    reward: LevelRewardBreakdown | null;
  };
  mission?: { label: string; progress: number; target: number; complete: boolean };
  powers: { kind: PowerKind; seconds?: number }[];
  /** Phase 7 — persistent glowstone balance (menus & completion screen). */
  wallet?: { balance: number };
}

export interface RunResult extends HudSnapshot {
  tricks: number;
  reason: string;
}

export interface EngineCallbacks {
  onStatus: (status: GameScreen) => void;
  onStat?: (label: string, value: string) => void;
  onHud: (snapshot: HudSnapshot) => void;
  onGameOver: (result: RunResult) => void;
  onCrash?: (result: RunResult) => void;
  onSound?: (event: SoundEvent) => void;
  onFrame?: (state: AudioFrameState) => void;
}

export type SoundEvent =
  | { type: 'jump' }
  | { type: 'ledge' }
  | { type: 'flipTick' }
  | { type: 'land'; force: number; clean: boolean }
  | { type: 'trick'; flips: number; combo: number }
  | { type: 'coin' }
  | { type: 'crash'; kind: 'rock' | 'tree' | 'landing' | 'fall' };

export interface AudioFrameState {
  status: GameScreen;
  speed: number;
  moving: boolean;
  grounded: boolean;
  spinning: boolean;
  slope: number;
  night: number;
  storm: number;
  /** Phase 9B — active environment theme, drives ambient audio flavour. */
  theme: EnvironmentTheme;
  /** Phase 9B — cosmetic wind strength 0..1 for ambience shaping. */
  wind: number;
}

export const POWERS = {
  magnet: { label: 'Magnet', icon: 'U', color: '#80ecff' },
  shield: { label: 'Shield', icon: '◇', color: '#a9f6b5' },
  double: { label: 'Double glowstones', icon: '2×', color: '#ffdc87' },
} as const;
type PowerKind = keyof typeof POWERS;
const POWER_ORDER: PowerKind[] = ['magnet', 'shield', 'double'];

type ObstacleKind = 'coin' | 'rock' | 'tree' | 'gap' | 'ramp' | 'log' | 'swinging-log'
  | 'root' | 'fence' | 'ice' | 'icicle' | 'snowball' | 'branch' | PowerKind;

interface Obstacle {
  kind: ObstacleKind;
  x: number;
  width?: number;
  bridged?: boolean;
  offset?: number;
  phase?: number;
  variant?: number;
  pulled?: { x: number; y: number };
  plan?: PlacementMetadata;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  color: string;
  wheelSnow?: boolean;
}

interface TrailPoint {
  x: number;
  y: number;
  age: number;
}

interface ScorePopup {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

interface Rider {
  x: number;
  y: number;
  vy: number;
  speed: number;
  rotation: number;
  angularVelocity: number;
  totalSpin: number;
  flipElapsed?: number;
  grounded: boolean;
  airTime: number;
  fallingInto?: Obstacle;
}

interface RunState {
  rider: Rider;
  levelIndex: number;
  levelStartScore: number;
  levelStartX: number;
  levelPhase: LevelPhase;
  sceneTime: number;
  sceneStartSpeed: number;
  riderOpacity: number;
  winterMix: number;
  snowRate: number;
  houses: FinishHouse[];
  terrainOrigins?: TerrainOrigin[];
  hazardClearUntil?: number;
  objects: Obstacle[];
  particles: Particle[];
  trail: TrailPoint[];
  popups: ScorePopup[];
  nextCoinX: number;
  nextHazardX: number;
  nextBridgeX: number;
  nextPowerX: number;
  powerIndex: number;
  /** Phase 5 pacing memory: recently scheduled pattern ids (oldest first). */
  recentPatterns?: string[];
  magnetUntil: number;
  doubleUntil: number;
  shield: boolean;
  seed: number;
  distance: number;
  elapsed: number;
  mission: (typeof MISSIONS)[number];
  missionComplete: boolean;
  coins: number;
  tricks: number;
  bonus: number;
  combo: number;
  lastTrickAt: number;
  cameraX: number;
  cameraY: number;
  shake: number;
  trailTimer: number;
  wheelSnowCarry: number;
  hudTimer: number;
  nextStatAt: number;
  over: boolean;
  invulnerableUntil: number;
  crashReason: string;
  /** Phase 7 — wallet bookkeeping and per-level reward context. */
  coinsAtLevelStart: number;
  walletCommittedCoins: number;
  crashesThisLevel: number;
  flipsThisLevel: number;
  levelReward: LevelRewardBreakdown | null;
  /** Phase 8 — cosmetic crash tumble state; present only while over. */
  crashReaction?: { vx: number; vy: number; spin: number; elapsed: number };
}

// Phase 4: all visual theming (palettes, parallax, weather, decorations) now
// lives in EnvironmentManager; the engine only consumes its Palette output.

function isRunCheckpoint(value: unknown): value is RunState {
  if (!value || typeof value !== 'object') return false;
  const run = value as RunState;
  const finite = (number: unknown) => typeof number === 'number' && Number.isFinite(number);
  const nonnegative = (number: unknown) => finite(number) && (number as number) >= 0;
  const numberFields = ['levelIndex', 'levelStartScore', 'levelStartX', 'sceneTime', 'sceneStartSpeed', 'riderOpacity',
    'winterMix', 'snowRate', 'nextCoinX', 'nextHazardX', 'nextBridgeX', 'nextPowerX', 'powerIndex',
    'magnetUntil', 'doubleUntil', 'seed', 'distance', 'elapsed', 'coins', 'tricks', 'bonus', 'combo',
    'shake', 'trailTimer', 'wheelSnowCarry', 'hudTimer', 'nextStatAt', 'invulnerableUntil'] as const;
  if (!numberFields.every((key) => nonnegative(run[key])) || !finite(run.lastTrickAt)
    || !finite(run.cameraX) || !finite(run.cameraY) || !Number.isSafeInteger(run.levelIndex)
    || !Number.isSafeInteger(run.seed) || run.seed > 0xffffffff
    || run.levelPhase !== 'riding' || run.over !== false || run.riderOpacity !== 1
    || run.levelStartScore > Math.floor(run.distance / 10) + run.coins * 125 + run.bonus
    || run.levelStartX > run.distance || typeof run.shield !== 'boolean'
    || typeof run.missionComplete !== 'boolean' || typeof run.crashReason !== 'string') return false;
  const rider = run.rider;
  if (!rider || !['x', 'y', 'vy', 'speed', 'rotation', 'angularVelocity', 'totalSpin', 'airTime']
    .every((key) => finite(rider[key as keyof Rider])) || !rider.grounded || rider.fallingInto
    || rider.speed < 0 || rider.x !== run.distance || rider.x < 0) return false;
    if (!run.mission || !MISSIONS.some((mission) => mission.metric === run.mission.metric
      && mission.target === run.mission.target && mission.label === run.mission.label)) return false;
    // Phase 7 fields stay optional so pre-Phase-7 checkpoints remain valid;
    // when present they must be consistent with the run's coin counter.
    if (run.coinsAtLevelStart !== undefined && !(nonnegative(run.coinsAtLevelStart) && run.coinsAtLevelStart <= run.coins)) return false;
    if (run.walletCommittedCoins !== undefined && !(nonnegative(run.walletCommittedCoins) && run.walletCommittedCoins <= run.coins)) return false;
    if (run.crashesThisLevel !== undefined && !nonnegative(run.crashesThisLevel)) return false;
    if (run.flipsThisLevel !== undefined && !nonnegative(run.flipsThisLevel)) return false;
    if (run.levelReward !== undefined && run.levelReward !== null) {
      const reward = run.levelReward;
      if (!Number.isSafeInteger(reward.level) || reward.level < 1
        || ![reward.collected, reward.completion, reward.cleanRun, reward.flips, reward.milestone, reward.total]
          .every(nonnegative) || reward.total !== reward.collected + reward.completion + reward.cleanRun
          + reward.flips + reward.milestone) return false;
    }
    // Checkpoints are riding-only states; a crash tumble can never be saved.
    if (run.crashReaction !== undefined && run.crashReaction !== null) return false;
  const kinds: ObstacleKind[] = ['coin', 'rock', 'tree', 'gap', 'ramp', 'log', 'swinging-log',
    'root', 'fence', 'ice', 'icicle', 'snowball', 'branch', ...POWER_ORDER];
  if (!Array.isArray(run.objects) || run.objects.length > 2000 || !run.objects.every((object) =>
    object && kinds.includes(object.kind) && finite(object.x)
    && (object.width === undefined || (finite(object.width) && object.width > 0))
    && (object.offset === undefined || finite(object.offset))
    && (object.phase === undefined || finite(object.phase))
    && (object.variant === undefined || (finite(object.variant) && object.variant >= 0 && object.variant <= 1))
    && (object.bridged === undefined || typeof object.bridged === 'boolean')
    && (object.pulled === undefined || (finite(object.pulled.x) && finite(object.pulled.y)))
    && (object.plan === undefined || validPlacementMetadata(object.plan)))) return false;
  if (run.hazardClearUntil !== undefined && !nonnegative(run.hazardClearUntil)) return false;
  if (run.recentPatterns !== undefined && (!Array.isArray(run.recentPatterns) || run.recentPatterns.length > 16
    || !run.recentPatterns.every((id) => typeof id === 'string'
      && (id === 'recovery' || OBSTACLE_PATTERNS.some((pattern) => pattern.id === id))))) return false;
  if (run.terrainOrigins !== undefined && (!Array.isArray(run.terrainOrigins) || run.terrainOrigins.length === 0
    || !run.terrainOrigins.every((origin, index) => origin && Number.isSafeInteger(origin.level)
      && origin.level >= 1 && nonnegative(origin.x) && finite(origin.offset)
      && (index === 0 || (origin.x > run.terrainOrigins![index - 1].x && origin.level > run.terrainOrigins![index - 1].level)))
    || run.terrainOrigins[run.terrainOrigins.length - 1].level !== run.levelIndex + 1)) return false;
  if (!Array.isArray(run.houses) || !run.houses.every((house) => house && finite(house.x) && finite(house.groundY))) return false;
  return [run.particles, run.popups, run.trail].every((items) => Array.isArray(items) && items.length === 0);
}

interface FinishHouse {
  x: number;
  groundY: number;
}

const TAU = Math.PI * 2;
const BIKE_SCALE = 0.5;
const WHEEL_RADIUS = 12;
const WHEEL_Y = -8;
const REAR_AXLE = -25;
const FRONT_AXLE = 25;
const WHEEL_CONTACT_Y = 5;
const FLIP_HOLD_SECONDS = BICYCLE_PHYSICS.flipHoldSeconds;
const START_PAUSE = 1;
const START_ROLLOUT = 2.2;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Wrapped angle difference in (-π, π] — used by the ice slip lean. */
const shortAngleDelta = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

function hash(value: number): number {
  const n = Math.sin(value * 127.1 + 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

/** Hazards that demand a committed jump or sweep through the riding line;
 *  these are retired ahead of the rider during the safe final approach. */
function isDangerousObstacle(object: Obstacle): boolean {
  return (object.kind === 'gap' && !object.bridged) || object.kind === 'ramp' || object.kind === 'swinging-log'
    || object.kind === 'snowball' || object.kind === 'icicle' || object.kind === 'branch';
}

function colorMix(a: string, b: string, amount: number): string {
  const parse = (color: string) => {
    if (color.startsWith('#')) return [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
    return (color.match(/[\d.]+/g) ?? ['255', '255', '255']).slice(0, 3).map(Number);
  };
  const first = parse(a);
  const second = parse(b);
  const channels = first.map((value, index) => Math.round(lerp(value, second[index], amount)));
  return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
}

function alphaColor(color: string, alpha: number): string {
  const channels = color.match(/\d+/g)?.slice(0, 3) ?? ['255', '255', '255'];
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
}

export class SnowGameEngine {
  public status: GameScreen = 'menu';

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly callbacks: EngineCallbacks;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private frameHandle = 0;
  private lastFrame = 0;
  private clock = 0;
  private run: RunState | null = null;
  private held = false;
  private pressedAt = 0;
  private jumpQueued = false;
  private parked = false;
  private graphicsQuality: GraphicsQuality = 'auto';
  private bike: BikeEntry = BIKES[0];
  private character: RiderEntry = RIDERS[0];
  private trail: TrailEntry = TRAILS[0];
  /** Mission rotation slot. Seeded from the journey on the first run so
   *  identical saves get identical mission sequences (and therefore identical
   *  score-driven planning); cosmetics stay free to use Math.random. */
  private nextMission?: number;

  private missionSlotFor(levelSeed: number): number {
    this.nextMission ??= levelSeed % MISSIONS.length;
    return this.nextMission;
  }

  setRiderSetup(bike: BikeEntry, character: RiderEntry, trail: TrailEntry = TRAILS[0]): void {
    this.bike = bike;
    this.character = character;
    this.trail = trail;
  }

  private get lighterGraphics(): boolean {
    return this.graphicsQuality === 'balanced' || (this.android && this.graphicsQuality === 'auto');
  }

  readonly levels: LevelManager<RunState>;
  /** Phase 7 — persistent glowstone wallet (rewards, purchases, balance). */
  readonly wallet: Wallet;
  private checkpointElapsed = 0;
  private terrain?: TerrainWorld;
  private readonly obstaclePlanner = new ObstaclePlanner();
  private obstacleDebug = false;
  private obstacleRejections: PlacementRejection[] = [];
  /** Phase 9A dev preview: when set, generation collapses to this obstacle id. */
  private obstaclePreview?: string;

  // Phase 5 — intelligent difficulty & obstacle pacing. The manager emits a
  // pure, viewport-independent directive each planning pass; the planner (not
  // the engine) turns it into pattern choices. Rider speed limits, physics,
  // terrain shape and collisions are untouched by it.
  private readonly difficulty = new DifficultyManager();
  private lastDirective?: DifficultyDirective;
  private lastPlanInfo: { patternId: string; rating: number; spacing: number } | null = null;
  /** Fixed terrain-complexity sampling window: generation must not depend on
   *  the viewport, or wide and narrow screens would diverge (see tests). */
  private static readonly COMPLEXITY_WINDOW = 2000;

  // Phase 4 — dynamic environment & weather. Rendering of skies, parallax,
  // clouds, fog, weather and decorations is delegated to this manager; the
  // engine keeps terrain shape, obstacles, collisions and physics untouched.
  private readonly environment = new EnvironmentManager();
  private readonly environmentView: EnvironmentView = {
    width: 0, height: 0, cameraX: 0, cameraY: 0, clock: 0, phase: 0, riderX: 0,
    isMenu: false, lighter: false, groundAt: (x: number) => this.terrainAt(x),
  };
  private lastEnvironmentCameraX = 0;
  private readonly decorationReserved = (x: number, halfWidth: number): boolean => {
    const run = this.run;
    if (!run) return false;
    return decorationOverlapsGameplay(x, halfWidth, run.objects, run.houses);
  };

  setObstacleDebug(enabled: boolean): void {
    this.obstacleDebug = enabled;
    if (!enabled) this.obstacleRejections = [];
  }

  /**
   * Phase 9A audit tool (developer bar, `?dev=1`): restart the run with
   * generation collapsed to a single obstacle id. Every placement still runs
   * through the planner's validation pipeline, so previews show real, fair
   * placements — never hand-spawned objects. Pass null to resume normal mixes.
   */
  startObstaclePreview(id: string | null): boolean {
    if (id !== null && !obstacleReady(id)) return false;
    this.obstaclePreview = id ?? undefined;
    this.obstacleRejections = [];
    if (id === null) {
      this.start();
      return true;
    }
    // Preview needs a level whose environment actually permits the id; jump to
    // the first themed level that allows it (in-memory, like the level selector).
    const target = previewLevelForObstacle(id as ObstacleId);
    if (target !== this.levels.current.number) this.levels.enterPreview(target);
    this.start();
    return true;
  }

  /**
   * Phase 5A audit tool (developer level selector, `?dev=1`): restart the run
   * at an arbitrary level. The LevelManager swaps to in-memory storage, so
   * saved progression is never overwritten and nothing is permanently
   * unlocked. Environment, weather, terrain and decorations rebind through
   * the normal start() path.
   */
  startLevelPreview(level: number): boolean {
    if (!Number.isSafeInteger(level) || level < 1 || level > 9999) return false;
    this.obstacleRejections = [];
    this.levels.enterPreview(level);
    this.start();
    return true;
  }

  private readonly handleResize = () => {
    const bounds = this.canvas.getBoundingClientRect();
    this.width = Math.max(320, bounds.width || window.innerWidth);
    this.height = Math.max(320, bounds.height || window.innerHeight);
    const ratioCap = this.android && this.lighterGraphics
      ? Math.min(1, Math.sqrt(850_000 / (this.width * this.height)))
      : this.graphicsQuality === 'balanced' ? 1.35 : 2;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, ratioCap);
    this.canvas.width = Math.round(this.width * this.pixelRatio);
    this.canvas.height = Math.round(this.height * this.pixelRatio);
    this.context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);

    if (this.run) {
      this.run.cameraX = this.run.rider.x - this.width * this.riderScreenPosition(this.run);
      if (this.run.rider.grounded) {
        this.run.rider.y = this.rideHeight(this.run, this.run.rider.x) - 5;
      }
    }
  };

  constructor(canvas: HTMLCanvasElement, callbacks: EngineCallbacks, private readonly android = false) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D is not available in this browser.');

    this.canvas = canvas;
    this.context = context;
    this.callbacks = callbacks;
    const parameters = new URLSearchParams(window.location?.search ?? '');
    // ?debugObstacles=1 keeps the obstacle overlay; ?dev=1 (the developer
    // mode that also shows the level selector in the shell) enables it too.
    this.obstacleDebug = parameters.get('debugObstacles') === '1' || parameters.get('dev') === '1';
    // Local preview hook: ?level=N starts straight at that level (progress is
    // kept in memory only so real saves are never touched). ?dev=1 sandboxes
    // the entire developer session the same way — the level selector and any
    // play from a dev URL can never write to saved progression.
    const previewLevel = Number(parameters.get('level'));
    const preview = Number.isSafeInteger(previewLevel) && previewLevel >= 1 && previewLevel <= 9999;
    const sandbox = preview || parameters.get('dev') === '1';
    const previewStorage = sandbox
      ? (() => {
        const values = new Map<string, string>();
        return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
      })()
      : undefined;
    this.levels = new LevelManager<RunState>({
      validateCheckpoint: isRunCheckpoint,
      initialLevel: preview ? previewLevel : undefined,
      storage: previewStorage,
    });
    // Phase 7 — the wallet follows the same sandbox rules as the level
    // manager: dev/preview sessions get an in-memory balance so real saves
    // are never touched, and purchases there can never leak into progress.
    this.wallet = new Wallet({ storage: sandbox ? previewStorage : undefined });
    this.environment.setLevel(this.levels.current);
    const checkpoint = this.levels.checkpoint;
    if (checkpoint && checkpoint.levelIndex + 1 === this.levels.current.number
      && Math.floor(checkpoint.distance / 10) + checkpoint.coins * 125 + checkpoint.bonus === this.levels.savedRunScore
      && Math.min(this.levels.current.targetScore, this.levels.savedRunScore - checkpoint.levelStartScore) === this.levels.levelScore) {
      this.run = JSON.parse(JSON.stringify(checkpoint)) as RunState;
      this.parked = true;
      this.checkpointElapsed = this.run.elapsed;
      // Phase 7 fields default gracefully for pre-Phase-7 checkpoints.
      this.run.coinsAtLevelStart ??= 0;
      this.run.walletCommittedCoins ??= 0;
      this.run.crashesThisLevel ??= 0;
      this.run.flipsThisLevel ??= 0;
      this.run.levelReward ??= null;
    } else if (checkpoint) {
      this.levels.restartAttempt();
    }
    if (this.run) {
      const legacyTerrain = !this.run.terrainOrigins;
      this.run.terrainOrigins ??= [{ level: this.levels.current.number, x: this.run.levelStartX, offset: 0 }];
      this.terrain = this.createTerrain(this.run.terrainOrigins);
      // Older checkpoints retain their scores, but regenerate a safe corridor
      // rather than keeping hazards designed for the previous height function.
      if (legacyTerrain) {
        this.run.objects = [];
        this.run.nextCoinX = this.run.rider.x + 180;
        this.run.nextHazardX = this.run.rider.x + 650;
        this.run.nextPowerX = this.run.rider.x + 1100;
      }
    }
    this.handleResize();
    window.addEventListener('resize', this.handleResize);
    this.frameHandle = window.requestAnimationFrame(this.frame);
  }

  destroy(): void {
    this.saveStableCheckpoint();
    window.cancelAnimationFrame(this.frameHandle);
    window.removeEventListener('resize', this.handleResize);
  }

  start(): void {
    this.levels.restartAttempt();
    this.obstacleRejections = [];
    const level = this.levels.current;
    this.environment.setLevel(level);
    const x = 0;
    this.run = null;
    const origins = [{ level: level.number, x: 0, offset: 0 }];
    this.terrain = this.createTerrain(origins);
    const ground = this.terrainAt(x);
    this.run = {
      levelIndex: level.number - 1,
      levelStartScore: 0,
      levelStartX: 0,
      levelPhase: 'riding',
      sceneTime: 0,
      sceneStartSpeed: 0,
      riderOpacity: 1,
      winterMix: 0,
      snowRate: this.environment.snowIntensity,
      houses: [],
      terrainOrigins: origins,
      hazardClearUntil: 640,
      rider: {
        x,
        y: ground - 5,
        vy: 0,
        speed: 0,
        rotation: this.terrainAngle(x),
        angularVelocity: 0,
        totalSpin: 0,
        grounded: true,
        airTime: 0,
      },
      objects: [],
      particles: [],
      trail: [],
      popups: [],
      nextCoinX: 330,
      nextHazardX: 760,
      nextBridgeX: 760,
      nextPowerX: 760,
      powerIndex: 0,
      recentPatterns: [],
      magnetUntil: 0,
      doubleUntil: 0,
      shield: false,
      seed: level.seed,
      distance: 0,
      elapsed: 0,
      mission: MISSIONS[this.missionSlotFor(level.seed)],
      missionComplete: false,
      coins: 0,
      tricks: 0,
      bonus: 0,
      combo: 0,
      lastTrickAt: -100,
      cameraX: x - this.width * 0.62,
      cameraY: 0,
      shake: 0,
      trailTimer: 0,
      wheelSnowCarry: 0,
      hudTimer: 0,
      nextStatAt: 8 + Math.random() * 5,
      over: false,
      invulnerableUntil: 0,
      crashReason: '',
      coinsAtLevelStart: 0,
      walletCommittedCoins: 0,
      crashesThisLevel: 0,
      flipsThisLevel: 0,
      levelReward: null,
    };
    this.nextMission = (this.missionSlotFor(level.seed) + 1) % MISSIONS.length;
    this.parked = false;

    this.held = false;
    this.jumpQueued = false;
    this.status = 'playing';
    this.callbacks.onStatus(this.status);
    this.populateAhead(this.run);
    this.saveStableCheckpoint();
    this.callbacks.onHud(this.makeHud(this.run));
  }

  press(): void {
    if (this.status !== 'playing' || !this.run) return;
    // Phase 6: during the completion hold a press continues to the next
    // level early (a short grace keeps entry taps from skipping the screen).
    if (this.run.levelPhase === 'celebrating') {
      if (this.run.sceneTime >= 1.1) {
        this.run.sceneTime = Math.max(this.run.sceneTime, this.levels.current.transitions.end.completionSeconds);
      }
      return;
    }
    if (this.run.levelPhase !== 'riding') return;
    if (!this.held) {
      this.jumpQueued = true;
      this.pressedAt = this.clock;
    }
    this.held = true;
  }

  release(): void {
    this.held = false;
  }

  togglePause(): void {
    if (this.status === 'playing') {
      this.saveStableCheckpoint();
      this.held = false;
      this.jumpQueued = false;
      this.setStatus('paused');
    } else if (this.status === 'paused') {
      this.setStatus('playing');
    }
  }

  resume(): void {
    if (this.status === 'paused') this.setStatus('playing');
  }

  get hasParkedRun(): boolean {
    return this.parked && !!this.run && !this.run.over;
  }

  get reviveAvailable(): boolean {
    return this.status === 'crashed' && this.run?.over === true;
  }

  setGraphicsQuality(quality: GraphicsQuality): void {
    this.graphicsQuality = quality;
    this.handleResize();
  }

  suspendToMenu(): void {
    if ((this.status === 'playing' || this.status === 'paused') && this.run && !this.run.over) {
      this.held = false;
      this.jumpQueued = false;
      this.parked = true;
      this.saveStableCheckpoint();
      this.setStatus('menu');
    }
  }

  resumeParkedRun(): void {
    if (!this.hasParkedRun || !this.run) return;
    this.parked = false;
    this.lastFrame = 0;
    this.setStatus('playing');
    this.callbacks.onHud(this.makeHud(this.run));
  }

  returnToMenu(): void {
    if (this.run && !this.run.over) this.syncLevelScore(this.run);
    if (this.run) this.commitRunCoins(this.run); // abandoned runs keep their stones
    this.levels.restartAttempt();
    this.environment.setLevel(this.levels.current);
    this.held = false;
    this.jumpQueued = false;
    this.parked = false;
    this.run = null;
    this.terrain = undefined;
    this.setStatus('menu');
  }

  finalizeRun(): void {
    if (this.status !== 'crashed' || !this.run) return;
    const result = { ...this.makeHud(this.run), tricks: this.run.tricks, reason: this.run.crashReason };
    this.syncLevelScore(this.run);
    this.commitRunCoins(this.run); // Phase 7 — bank the glowstones that were collected
    this.levels.restartAttempt();
    this.setStatus('gameover');
    this.callbacks.onGameOver(result);
  }

  /**
   * Phase 7 — banks collected glowstones whenever a run ends or is abandoned.
   * Idempotent through the committed-coins watermark, so crashes, revives,
   * restarts and abandoned runs can never double-credit the wallet.
   */
  private commitRunCoins(run: RunState): void {
    const pending = run.coins - run.walletCommittedCoins;
    if (pending > 0) {
      this.wallet.deposit(pending);
      run.walletCommittedCoins = run.coins;
    }
  }

  /**
   * Phase 7 — settles glowstone earnings the moment a level's completion
   * condition is satisfied (target + safe house reached). Idempotent: an
   * interrupted-and-replayed level only earns its freshly collected stones,
   * never a second helping of one-time rewards.
   */
  private settleLevelRewards(run: RunState): void {
    const level = this.levels.current.number;
    const pending = Math.max(0, run.coins - run.walletCommittedCoins);
    const breakdown = this.wallet.grantLevelRewards({
      level,
      collected: pending,
      cleanRun: run.crashesThisLevel === 0,
      flips: run.flipsThisLevel,
    });
    if (!breakdown) {
      if (pending > 0) this.wallet.deposit(pending);
      run.levelReward = { level, collected: pending, completion: 0, cleanRun: 0, flips: 0, milestone: 0, total: pending };
    } else {
      run.levelReward = breakdown;
    }
    run.walletCommittedCoins = run.coins;
  }

  /**
   * Phase 6 developer tool (`?dev=1`): fast-forward the score to the level
   * target so the final approach can be tested without earning 50 000
   * points. The arrival itself then runs through the normal cinematic path.
   */
  devFinishLevel(): boolean {
    const run = this.run;
    if (this.status !== 'playing' || !run || run.over || run.levelPhase !== 'riding') return false;
    const earned = this.runScore(run) - run.levelStartScore;
    const target = this.levels.current.targetScore;
    if (earned < target) {
      run.bonus += target - earned + 250;
      this.syncLevelScore(run);
    }
    return true;
  }

  /**
   * Phase 9B developer tool (`?dev=1`): pin the weather to a preset so any
   * condition can be previewed in every environment regardless of level
   * config. `null` (or 'auto') restores the configured weather.
   */
  setWeatherPreview(preset: 'auto' | 'clear' | 'snow' | 'fog' | 'wind' | 'storm' | null): void {
    this.devStorm = preset === 'storm' ? 0.85 : 0;
    const presets: Record<string, readonly WeatherEffectConfig[]> = {
      clear: [],
      snow: [{ kind: 'snow', intensity: 0.8 }],
      fog: [{ kind: 'fog', intensity: 0.65 }],
      wind: [{ kind: 'wind', intensity: 0.65 }],
      storm: [{ kind: 'snow', intensity: 0.9 }, { kind: 'wind', intensity: 0.85 }, { kind: 'fog', intensity: 0.3 }],
    };
    this.environment.setWeatherPreview(preset && preset !== 'auto' ? presets[preset] : null);
  }

  /**
   * Phase 9B developer tool (`?dev=1`): freeze the day cycle at a fixed phase
   * so dawn / day / sunset / night lighting can be audited per environment.
   * `null` restores the continuous world+clock cycle.
   */
  setDayPhasePreview(phase: number | null): void {
    this.dayPhasePreview = phase === null ? undefined : ((phase % 1) + 1) % 1;
  }

  /** Phase 7 — wallet snapshot for the rewards UI and completion screen. */
  getWalletView(): { balance: number; lifetimeEarned: number; owned: readonly string[]; rewardedThrough: number } {
    return {
      balance: this.wallet.balance,
      lifetimeEarned: this.wallet.lifetimeEarned,
      owned: this.wallet.owned,
      rewardedThrough: this.wallet.rewardedThrough,
    };
  }

  /** Phase 7 — everything the unlock rules need, gathered in one place. */
  unlockContext(): UnlockContext {
    const stats = readLifetime([]);
    const unlocked = new Set([
      ...readUnlockedAchievements(),
      ...getAchievements(stats).filter((achievement) => achievement.unlocked).map((achievement) => achievement.id),
    ]);
    return {
      bestDistance: stats.bestDistance,
      bestTricks: stats.bestTricks,
      completedLevels: this.levels.completedThrough,
      owned: this.wallet.owned,
      achievements: [...unlocked],
    };
  }

  /**
   * Phase 7 — purchases a cosmetic with wallet glowstones. Locked items
   * (missing prerequisites) and unaffordable prices are rejected; a
   * successful purchase deducts exactly once and records ownership.
   */
  purchaseUnlockable(id: string): 'ok' | 'owned' | 'locked' | 'insufficient' | 'invalid' {
    const entry = findCosmetic(id);
    if (!entry) return 'invalid';
    const context = this.unlockContext();
    if (isUnlocked(entry, context)) return 'owned';
    if (!requirementsMet(entry, context)) return 'locked';
    return this.wallet.purchase(id, entry.cost ?? 0);
  }

  revive(): boolean {
    if (!this.reviveAvailable || !this.run) return false;
    const run = this.run;
    const rider = run.rider;
    let safeX = rider.x + 90;

    for (let candidate = rider.x + 45; candidate < rider.x + 760; candidate += 18) {
      const blocked = run.objects.some((object) =>
        (object.kind === 'rock' || object.kind === 'tree' || object.kind === 'log' || object.kind === 'swinging-log' || object.kind === 'ramp'
          || object.kind === 'root' || object.kind === 'fence' || object.kind === 'snowball' || object.kind === 'icicle' || object.kind === 'branch'
          || (object.kind === 'gap' && !object.bridged))
          && object.x + (object.kind === 'ramp' ? 100 : object.width ?? 35) >= candidate - 28
          && object.x < candidate + 135,
      );
      if (!blocked) {
        safeX = candidate;
        break;
      }
      safeX = candidate + 75;
    }
    while (this.gapAt(run, safeX)) safeX += 35;

    rider.x = safeX;
    rider.y = this.rideHeight(run, safeX) - 5;
    rider.vy = 0;
    rider.speed = Math.max(rider.speed, 300);
    rider.rotation = this.rideAngle(run, safeX);
    rider.angularVelocity = 0;
    rider.totalSpin = 0;
    rider.flipElapsed = undefined;
    rider.grounded = true;
    rider.airTime = 0;
    rider.fallingInto = undefined;
    run.distance = rider.x;
    run.over = false;
    run.crashReaction = undefined;
    run.invulnerableUntil = run.elapsed + RECOVERY_CONFIG.reviveInvulnerabilitySeconds;
    run.crashReason = '';
    // Phase 8 — restore camera tracking smoothly: apply part of the
    // correction now and let the regular smoothed follow finish the ease.
    const cameraTarget = rider.x - this.width * this.riderScreenPosition(run);
    run.cameraX = run.cameraX + (cameraTarget - run.cameraX) * RECOVERY_CONFIG.reviveCameraCatchUp;
    run.cameraY = 0;
    run.shake = Math.max(run.shake, 2.5);
    this.held = false;
    this.jumpQueued = false;
    this.lastFrame = 0;
    this.burst(run, rider.x, rider.y, 18, '#ffe3a9', 135, -95);
    this.popup(run, rider.x, rider.y - 62, 'ONE MORE CHANCE', '#ffe3a9');
    this.populateAhead(run);
    this.setStatus('playing');
    this.callbacks.onHud(this.makeHud(run));
    return true;
  }

  private readonly frame = (timestamp: number) => {
    const delta = this.lastFrame === 0 ? 0 : clamp((timestamp - this.lastFrame) / 1000, 0, 0.1);
    this.lastFrame = timestamp;

    if (this.status === 'playing' && this.run) {
      // Keep collision steps small even when Android delivers frames slowly.
      const steps = Math.max(1, Math.ceil(delta / 0.025));
      const stepTime = delta / steps;
      for (let i = 0; i < steps && this.status === 'playing'; i += 1) {
        this.clock += stepTime;
        this.step(stepTime);
      }
    } else {
      this.clock += delta;
      if (this.run && (this.status === 'gameover' || this.status === 'paused' || this.status === 'crashed')) {
        this.updateEffects(this.run, delta);
      }
    }

    const terrainCamera = this.run && this.status !== 'menu' ? this.run.cameraX : this.clock * 16 - this.width * 0.72;
    if (this.run?.terrainOrigins && this.run.terrainOrigins.length > 2) {
      const origins = this.run.terrainOrigins;
      while (origins.length > 2 && origins[1].x < terrainCamera - this.width * 2 - 640) origins.shift();
    }
    this.terrain?.maintain(terrainCamera, this.width);
    // Phase 9B — the day-cycle phase is computed once per frame and shared by
    // the environment update, the renderer and the audio state so the sun,
    // palettes, ambience and music never drift apart.
    const phase = this.currentDayPhase();
    this.lastNight = this.environment.palette(phase).night;
    // Environment and weather advance every frame (all statuses) so the menu
    // stays alive and level cross-fades run even while the world is parked.
    this.environment.update(delta, {
      cameraX: terrainCamera,
      cameraDx: terrainCamera - this.lastEnvironmentCameraX,
      width: this.width,
      height: this.height,
      storm: this.stormLevel(),
      lighter: this.lighterGraphics,
      groundAt: this.environmentView.groundAt,
      phase,
      night: this.lastNight,
    });
    this.lastEnvironmentCameraX = terrainCamera;
    this.draw();
    if (this.callbacks.onFrame) {
      const rider = this.run?.rider;
      this.callbacks.onFrame({
        status: this.status,
        speed: rider ? clamp((rider.speed - 205) / 270, 0, 1) : 0,
        moving: !!rider && rider.speed > 5 && (this.run?.riderOpacity ?? 1) > 0,
        grounded: rider ? rider.grounded : true,
        spinning: !!rider && !rider.grounded && rider.flipElapsed !== undefined && rider.totalSpin < TAU && this.status === 'playing',
        slope: rider && rider.grounded ? Math.sin(this.terrainAngle(rider.x)) : 0,
        night: this.lastNight,
        storm: this.stormLevel(),
        theme: this.environment.theme,
        wind: this.environment.windStrength,
      });
    }
    this.frameHandle = window.requestAnimationFrame(this.frame);
  };

  private lastNight = 0;
  /** Phase 9B dev previews — fixed day phase / storm strength (null = live). */
  private dayPhasePreview?: number;
  private devStorm = 0;

  private stormLevel(): number {
    if (this.devStorm > 0) return this.devStorm;
    return Math.pow(Math.max(0, Math.sin(this.clock * 0.12 - 0.8)), 5);
  }

  /**
   * The continuous day-cycle phase. Timing and behaviour are unchanged from
   * earlier phases: world distance plus wall clock wrap over one full day.
   * The only override is the developer day-phase preview (`?dev=1`).
   */
  private currentDayPhase(): number {
    if (this.dayPhasePreview !== undefined) return this.dayPhasePreview;
    const worldX = this.status === 'menu' || !this.run ? this.clock * 16 : this.run.rider.x;
    return (0.62 + (worldX + this.clock * 18) / 25500) % 1;
  }

  private emit(event: SoundEvent): void {
    this.callbacks.onSound?.(event);
  }

  private setStatus(status: GameScreen): void {
    this.status = status;
    this.callbacks.onStatus(status);
  }

  private terrainAt(x: number): number {
    const base = this.baseTerrainAt(x);
    for (const house of this.run?.houses ?? []) {
      const distance = Math.abs(x - house.x);
      // Phase 6: a wider, C1-continuous blend gives the arrival a naturally
      // smooth runway into the house's flat ground.
      if (distance >= 380) continue;
      const t = clamp((distance - 95) / 285, 0, 1);
      return lerp(house.groundY, base, t * t * (3 - 2 * t));
    }
    return base;
  }

  private createTerrain(origins: TerrainOrigin[]): TerrainWorld {
    return new TerrainWorld(origins, (level) => this.levels.getLevel(level));
  }

  private baseTerrainAt(x: number): number {
    this.terrain ??= this.createTerrain([{ level: this.levels.current.number, x: 0, offset: 0 }]);
    return this.height * 0.605 + this.terrain.heightAt(x);
  }

  private terrainAngle(x: number): number {
    return Math.atan2(this.terrainAt(x + 8) - this.terrainAt(x - 8), 16);
  }

  private gapAt(run: RunState, x: number, includeBridges = false): Obstacle | undefined {
    return run.objects.find((object) => object.kind === 'gap' && (includeBridges || !object.bridged)
      && x >= object.x && x <= object.x + (object.width ?? 0));
  }

  private bridgeAt(run: RunState, x: number): Obstacle | undefined {
    const gap = this.gapAt(run, x, true);
    return gap?.bridged ? gap : undefined;
  }

  /** Phase 9A — the ice patch covering x, if any (reduced-traction ground). */
  private iceAt(run: RunState, x: number): Obstacle | undefined {
    return run.objects.find((object) => object.kind === 'ice' && x >= object.x && x <= object.x + (object.width ?? 0));
  }

  private bridgeDeck(bridge: Obstacle, x: number): number {
    const width = bridge.width ?? 1;
    const t = (x - bridge.x) / width;
    return lerp(this.terrainAt(bridge.x), this.terrainAt(bridge.x + width), t);
  }

  /** Phase 9A — moving platforms add a deterministic vertical bob to the deck. */
  private platformDeckOffset(run: RunState, bridge: Obstacle): number {
    return bridge.plan?.obstacleId === 'moving-platform' ? platformBob(run.elapsed, bridge.phase ?? 0) : 0;
  }

  private rideHeight(run: RunState, x: number): number {
    const bridge = this.bridgeAt(run, x);
    return bridge ? this.bridgeDeck(bridge, x) + this.platformDeckOffset(run, bridge) : this.terrainAt(x);
  }

  private rideAngle(run: RunState, x: number): number {
    return Math.atan2(this.rideHeight(run, x + 8) - this.rideHeight(run, x - 8), 16);
  }

  private nextRandom(run: RunState): number {
    run.seed = (run.seed * 1664525 + 1013904223) >>> 0;
    return run.seed / 4294967296;
  }

  private populateAhead(run: RunState): void {
    if (run.levelPhase !== 'riding') return;
    const ahead = run.rider.x + this.width * 1.7 + 520;

    // Phase 5 pacing directive: depends only on the level, scored progress and
    // the terrain in a fixed window ahead — never on the viewport — so obstacle
    // generation stays identical across screen sizes.
    const level = this.levels.current;
    const progress = clamp((this.runScore(run) - run.levelStartScore) / level.targetScore, 0, 1);
    const terrainComplexity = this.terrain
      ? this.terrain.complexity(run.rider.x, run.rider.x + SnowGameEngine.COMPLEXITY_WINDOW)
      : 0;
    const directive = this.difficulty.directive({ level, progress, terrainComplexity });
    this.lastDirective = directive;
    if (directive.safeApproach) {
      // Final approach (45 k → house): retire dangerous hazards the rider has
      // not yet seen (beyond the right screen edge) and let the planner below
      // schedule only mild ones. Visible obstacles are never yanked away.
      run.objects = run.objects.filter((object) =>
        !isDangerousObstacle(object) || object.x <= run.rider.x + this.width);
    }

    while (run.nextCoinX < ahead) {
      const start = run.nextCoinX;
      const random = createLevelRandom(this.levels.current.seed ^ Math.floor(start) ^ 0x51c01);
      const count = 3 + Math.floor(random() * 3);
      for (let index = 0; index < count; index += 1) {
        const curve = count < 2 ? 0 : Math.sin((index / (count - 1)) * Math.PI);
        const coinX = start + index * 38;
        // Phase 7 — never drop a glowstone inside a hazard's collision space;
        // arcs simply skip those spots (still reachable by normal riding and
        // small jumps, never inside rocks, trees or logs).
        if (!this.coinBlocked(run, coinX)) {
          run.objects.push({
            kind: 'coin',
            x: coinX,
            offset: 38 + curve * 24,
            phase: random() * TAU,
          });
        }
      }
      run.nextCoinX += 310 + random() * 260;
    }

    while (run.nextHazardX < ahead) {
      if (run.nextHazardX < (run.hazardClearUntil ?? 0)) {
        run.nextHazardX = run.hazardClearUntil!;
        continue;
      }
      if (run.nextHazardX >= run.nextPowerX) {
        run.objects.push({ kind: POWER_ORDER[run.powerIndex % POWER_ORDER.length], x: run.nextHazardX - 245 });
        run.powerIndex += 1;
        run.nextPowerX = run.nextHazardX + 1500 + hash(run.nextHazardX) * 800;
      }
      const difficulty = clamp((run.rider.x - run.levelStartX) / 26000, 0, 1);
      // Dev-only obstacle preview: the whole level collapses to the selected
      // obstacle id, but every placement still runs the full planner pipeline
      // (validation, conflicts, spacing) so previews are always fair.
      const previewLevel = this.obstaclePreview && obstacleReady(this.obstaclePreview)
        ? { ...this.levels.current, number: 99, allowedObstacles: [this.obstaclePreview as ObstacleId] }
        : this.levels.current;
      const plan = this.obstaclePlanner.plan({
        level: previewLevel,
        candidateX: run.nextHazardX,
        riderX: run.rider.x,
        riderSpeed: run.rider.speed,
        riderAcceleration: Math.tan(run.rider.rotation) * 230 + 8 + difficulty * 9,
        surface: (x) => this.terrainAt(x),
        clearUntil: run.hazardClearUntil ?? 640,
        bridgeAllowedAfter: run.nextBridgeX,
        rampAllowedAfter: run.levelIndex === 0 ? 30_000 : run.levelStartX + 4000,
        reserved: [
          { start: run.levelStartX - 120, end: run.levelStartX + 640 },
          ...run.houses.map(house => ({ start: house.x - 300, end: house.x + 300 })),
        ],
        nearby: run.objects.filter(object => ['rock', 'log', 'tree', 'gap', 'ramp', 'swinging-log', 'root', 'fence', 'ice', 'icicle', 'snowball', 'branch'].includes(object.kind)),
        directive,
        recentPatterns: run.recentPatterns,
      });
      run.objects.push(...plan.obstacles);
      // Phase 7 — coins that now sit inside a newly placed hazard's collision
      // space are removed so no glowstone is ever unreachable or dangerous.
      run.objects = run.objects.filter((object) =>
        object.kind !== 'coin' || !this.coinBlocked(run, object.x));
      run.hazardClearUntil = Math.max(run.hazardClearUntil ?? 0, plan.clearUntil);
      for (const obstacle of plan.obstacles) {
        if (obstacle.bridged) run.nextBridgeX = obstacle.x + (obstacle.width ?? 0) + 4500;
      }
      if (plan.obstacles.length) {
        run.recentPatterns = [...(run.recentPatterns ?? []), plan.patternId]
          .slice(-directive.recentPatternMemory);
        this.lastPlanInfo = {
          patternId: plan.patternId,
          rating: patternRating(plan.patternId) ?? 0,
          spacing: plan.obstacles[0].plan.spacing,
        };
      }
      if (this.obstacleDebug) this.obstacleRejections = [...this.obstacleRejections, ...plan.rejected].slice(-24);
      run.nextHazardX = plan.nextX;
    }

    run.objects = run.objects.filter((object) => object.x + (object.width ?? 50) > run.rider.x - this.width * 0.9);
  }

  private rampAt(run: RunState, x: number): Obstacle | undefined {
    return run.objects.find((object) => object.kind === 'ramp' && x >= object.x && x < object.x + 100);
  }

  /**
   * Phase 7 — true when a glowstone at x would sit inside a hazard: within a
   * collision obstacle's radius plus padding, or over an unbridged gap's span.
   * Ramps and bridges are safe to ride, so coins above them stay.
   */
  private coinBlocked(run: RunState, x: number): boolean {
    return run.objects.some((object) => {
      if (object.kind === 'gap') {
        return !object.bridged && x > object.x - 30 && x < object.x + (object.width ?? 60) + 30;
      }
      if (object.kind !== 'rock' && object.kind !== 'tree' && object.kind !== 'log' && object.kind !== 'swinging-log'
        && object.kind !== 'root' && object.kind !== 'fence' && object.kind !== 'snowball') {
        if (object.kind !== 'icicle' && object.kind !== 'branch') return false;
        // Falling hazards sweep a narrow drop zone.
        return Math.abs(object.x - x) <= 50;
      }
      const radius = OBSTACLE_REGISTRY[object.kind].collision?.radius ?? 20;
      return Math.abs(object.x - x) <= radius + 34;
    });
  }

  private rampSurface(ramp: Obstacle, x: number): number {
    return lerp(this.terrainAt(ramp.x), this.terrainAt(ramp.x + 100) - 38, (x - ramp.x) / 100);
  }

  private rampAngle(ramp: Obstacle): number {
    return Math.atan2(this.rampSurface(ramp, ramp.x + 100) - this.rampSurface(ramp, ramp.x), 100);
  }

  private jump(run: RunState): void {
    const rider = run.rider;
    rider.grounded = false;
    rider.vy = -(BICYCLE_PHYSICS.jumpVelocity + Math.min(BICYCLE_PHYSICS.maxJumpBoost, rider.speed * BICYCLE_PHYSICS.jumpSpeedFactor));
    rider.airTime = 0;
    rider.totalSpin = 0;
    rider.flipElapsed = undefined;
    rider.angularVelocity = 0;
    run.shake = Math.max(run.shake, 1.6);
    this.burst(run, rider.x - 8, rider.y + 2, 9, this.environment.burstColors.soft, 95, -65);
    this.emit({ type: 'jump' });
  }

  private flipHoldTime(rider: Rider): number {
    return this.held ? Math.min(rider.airTime, this.clock - this.pressedAt) : 0;
  }

  private riderScreenPosition(run: RunState): number {
    const t = clamp((run.elapsed - START_PAUSE) / START_ROLLOUT, 0, 1);
    return lerp(0.62, 0.28, t * t * (3 - 2 * t));
  }

  private step(delta: number): void {
    const run = this.run;
    if (!run || run.over) return;

    const rider = run.rider;
    run.elapsed += delta;
    if (run.levelPhase !== 'riding') {
      this.stepLevelScene(run, delta);
      return;
    }
    run.distance = rider.x;
    if (run.elapsed < START_PAUSE) {
      this.jumpQueued = false;
      return;
    }

    const queued = this.jumpQueued;
    this.jumpQueued = false;
    if (queued && rider.grounded) this.jump(run);

    const previousX = rider.x;
    const previousY = rider.y;
    let moved = false;
    if (rider.grounded) {
      const previousRamp = this.rampAt(run, rider.x);
      const slope = Math.tan(rider.rotation);
      const difficulty = clamp(rider.x / 26000, 0, 1);
      const rollout = (run.elapsed - START_PAUSE) / START_ROLLOUT;
      // Phase 9A — ice patches cut traction: slope input on the speed is
      // amplified and the lean follows the terrain with a visible slip lag.
      // The physics stays fully deterministic and controllable — ice patches
      // are only validated onto gentle, step-free terrain.
      const onIce = !!this.iceAt(run, rider.x);
      if (rollout < 1) {
        rider.speed = 250 * rollout * rollout * (3 - 2 * rollout);
      } else {
        rider.speed += (slope * 230 * (onIce ? 1.35 : 1) + 8 + difficulty * 9) * delta;
        rider.speed = clamp(rider.speed, BICYCLE_PHYSICS.minSpeed, BICYCLE_PHYSICS.maxSpeed);
      }
      rider.x += rider.speed * delta;
      moved = true;

      const ramp = this.rampAt(run, rider.x);
      const gap = this.gapAt(run, rider.x);
      if (previousRamp && !ramp) {
        rider.y = this.rampSurface(previousRamp, previousRamp.x + 100) - 5;
        this.jump(run);
      } else if (ramp) {
        rider.y = this.rampSurface(ramp, rider.x) - 5;
        rider.rotation = this.rampAngle(ramp);
      } else if (gap) {
        rider.fallingInto = gap;
        rider.grounded = false;
        rider.vy = 0;
        rider.airTime = 0;
        rider.totalSpin = 0;
        rider.flipElapsed = undefined;
        this.emit({ type: 'ledge' });
      } else {
        rider.y = this.rideHeight(run, rider.x) - 5;
        const targetAngle = this.rideAngle(run, rider.x);
        rider.rotation = onIce
          ? rider.rotation + shortAngleDelta(targetAngle - rider.rotation) * (1 - Math.exp(-4.5 * delta))
          : targetAngle;
      }
    }

    if (!rider.grounded) {
      if (!moved) rider.x += rider.speed * delta;
      rider.speed = clamp(rider.speed + delta * BICYCLE_PHYSICS.airborneAcceleration, BICYCLE_PHYSICS.minSpeed, BICYCLE_PHYSICS.maxSpeed);
      rider.airTime += delta;
      rider.vy += BICYCLE_PHYSICS.gravity * delta;
      rider.y += rider.vy * delta;
      const previousGap = this.gapAt(run, previousX);
      if (!rider.fallingInto && previousGap) {
        const farEdge = previousGap.x + (previousGap.width ?? 0);
        if (rider.x > farEdge) {
          const crossing = (farEdge - previousX) / (rider.x - previousX);
          const lipY = this.terrainAt(farEdge) - 5;
          if (lerp(previousY, rider.y, crossing) > lipY) rider.fallingInto = previousGap;
        }
      }

      if (rider.fallingInto) {
        const farEdge = rider.fallingInto.x + (rider.fallingInto.width ?? 0);
        rider.x = Math.min(rider.x, farEdge - 8);
      }
      const ramp = this.rampAt(run, rider.x);
      const surfaceAngle = ramp ? this.rampAngle(ramp) : this.rideAngle(run, rider.x);

      if (rider.flipElapsed === undefined && this.flipHoldTime(rider) >= FLIP_HOLD_SECONDS) {
        rider.flipElapsed = 0;
      }

      const previousSpin = rider.totalSpin;
      if (rider.flipElapsed !== undefined && previousSpin < TAU) {
        rider.flipElapsed += delta;
        rider.totalSpin = TAU * flipProgress(rider.flipElapsed);
        if (Math.floor(rider.totalSpin / Math.PI) > Math.floor(previousSpin / Math.PI)) {
          this.emit({ type: 'flipTick' });
        }
      }

      const spinStep = rider.totalSpin - previousSpin;
      rider.angularVelocity = delta > 0 ? -spinStep / delta : 0;
      const neutralAngle = rider.rotation + previousSpin;
      const correction = 1 - Math.exp(-7.5 * delta);
      rider.rotation = neutralAngle + this.shortestAngle(surfaceAngle - neutralAngle) * correction - rider.totalSpin;

      const groundY = (ramp ? this.rampSurface(ramp, rider.x) : this.rideHeight(run, rider.x)) - 5;
      if (!rider.fallingInto && !this.gapAt(run, rider.x) && rider.vy > 0 && rider.y >= groundY) {
        this.land(run, groundY, surfaceAngle);
      }
    }

    if (run.over) return;

    run.distance = rider.x;
    this.collectPickups(run, delta);
    if (!run.missionComplete && this.missionProgress(run) >= run.mission.target) {
      run.missionComplete = true;
      run.bonus += MISSION_BONUS;
      this.popup(run, rider.x, rider.y - 60, `MISSION COMPLETE  +${MISSION_BONUS}`, '#ffdfa6');
    }
    this.syncLevelScore(run);
    if (rider.grounded && !rider.fallingInto && this.levels.targetReached) {
      this.beginLevelArrival(run);
      return;
    }
    if (this.checkCollision(run)) return;

    if (rider.y > this.height + 115) {
      this.emit({ type: 'crash', kind: 'fall' });
      this.finishRun(run, rider.fallingInto ? 'You fell into a chasm.' : 'A little too much open air.');
      return;
    }

    run.cameraX += (rider.x - this.width * this.riderScreenPosition(run) - run.cameraX) * (1 - Math.exp(-4.2 * delta));
    const cameraTargetY = clamp((this.height * 0.62 - rider.y) * 0.12, -22, 28);
    run.cameraY += (cameraTargetY - run.cameraY) * (1 - Math.exp(-2.8 * delta));
    this.addTrail(run, delta);
    this.emitWheelSnow(run, delta);
    this.updateEffects(run, delta);
    this.populateAhead(run);

    if (run.elapsed >= run.nextStatAt) {
      run.nextStatAt = run.elapsed + 9 + Math.random() * 6;
      const stats = [
        ['SCORE', this.runScore(run).toLocaleString('en-US')],
        ['DISTANCE', `${Math.floor(run.distance / 10).toLocaleString('en-US')} m`],
        ['GLOWSTONES', run.coins.toLocaleString('en-US')],
        ['SPEED', `${Math.round(rider.speed * 0.36)} km/h`],
      ];
      const [label, value] = stats[Math.floor(Math.random() * stats.length)];
      this.callbacks.onStat?.(label, value);
    }

    if (run.elapsed - this.checkpointElapsed >= 3) this.saveStableCheckpoint();
    run.hudTimer += delta;
    if (run.hudTimer >= (this.android ? 0.2 : 0.12)) {
      run.hudTimer = 0;
      this.callbacks.onHud(this.makeHud(run));
    }
  }

  private beginLevelArrival(run: RunState): void {
    // Phase 6: spawn the house beyond the right edge of the visible screen
    // (rider sits ≥ 0.28 widths from the left, so ≥ 1.05 widths is always
    // off-screen) — it scrolls into view naturally, never pops in.
    const x = run.rider.x + Math.max(760, this.width * 1.05);
    const house = { x, groundY: this.baseTerrainAt(x) };
    run.houses = run.houses.filter((existing) => existing.x > run.rider.x - this.width * 2 - 300);
    run.houses.push(house);
    run.levelPhase = 'approach';
    run.sceneTime = 0;
    run.sceneStartSpeed = Math.max(205, run.rider.speed);
    run.objects = run.objects.filter((object) => object.x + (object.width ?? 50) < run.rider.x - 60);
    run.popups = [];
    run.combo = 0;
    run.shake = 0;
    this.held = false;
    this.jumpQueued = false;
    this.callbacks.onHud(this.makeHud(run));
  }

  private stepLevelScene(run: RunState, delta: number): void {
    const rider = run.rider;
    const house = run.houses[run.houses.length - 1];
    const doorX = house.x + 24;
    run.sceneTime += delta;
    this.held = false;
    this.jumpQueued = false;
    rider.grounded = true;
    rider.vy = 0;
    rider.angularVelocity = 0;
    rider.totalSpin = 0;
    rider.flipElapsed = undefined;
    rider.fallingInto = undefined;
    // Keep earned powers from expiring while controls are unavailable.
    if (run.magnetUntil > run.elapsed - delta) run.magnetUntil += delta;
    if (run.doubleUntil > run.elapsed - delta) run.doubleUntil += delta;

    if (run.levelPhase === 'approach') {
      const remaining = doorX - 18 - rider.x;
      const targetSpeed = Math.min(run.sceneStartSpeed, 35 + Math.max(0, remaining) * 0.72);
      rider.speed = lerp(rider.speed, targetSpeed, 1 - Math.exp(-3 * delta));
      rider.x = Math.min(doorX - 18, rider.x + rider.speed * delta);
      if (rider.x >= doorX - 18) {
        run.levelPhase = 'entering';
        run.sceneTime = 0;
      }
    } else if (run.levelPhase === 'entering') {
      const t = clamp(run.sceneTime / this.levels.current.transitions.end.entrySeconds, 0, 1);
      const eased = t * t * (3 - 2 * t);
      rider.x = doorX - 18 + eased * 23;
      rider.speed = 23 * 6 * t * (1 - t) / this.levels.current.transitions.end.entrySeconds;
      run.riderOpacity = 1 - eased;
      if (t === 1) {
        run.riderOpacity = 0;
        rider.speed = 0;
        this.syncLevelScore(run);
        this.levels.markSafeHouseReached();
        // Phase 7 — the completion condition is satisfied here: settle the
        // one-time rewards and bank the level's collected glowstones before
        // the completion card is shown.
        this.settleLevelRewards(run);
        run.levelPhase = 'celebrating';
        run.sceneTime = 0;
        // Cross-fade the whole environment while the rider is inside the
        // safe house, finishing as they ride out into the new level.
        const upcoming = this.levels.getLevel(this.levels.current.number + 1);
        this.environment.transitionTo(
          upcoming,
          this.levels.current.transitions.end.completionSeconds + upcoming.transitions.start.seconds,
          rider.x,
        );
        this.callbacks.onHud(this.makeHud(run));
      }
    } else if (run.levelPhase === 'celebrating') {
      rider.speed = 0;
      if (run.sceneTime >= this.levels.current.transitions.end.completionSeconds) {
        this.syncLevelScore(run);
        const nextLevel = this.levels.advanceAfterTransition();
        run.levelIndex = nextLevel.number - 1;
        run.levelStartScore = this.runScore(run);
        run.levelStartX = rider.x;
        // Phase 7 — the new level starts with a clean reward slate.
        run.coinsAtLevelStart = run.coins;
        run.crashesThisLevel = 0;
        run.flipsThisLevel = 0;
        run.levelReward = null;
        run.terrainOrigins ??= [];
        run.terrainOrigins.push({ level: nextLevel.number, x: rider.x, offset: house.groundY - this.height * 0.605 });
        this.terrain = this.createTerrain(run.terrainOrigins);
        run.hazardClearUntil = rider.x + 640;
        run.levelPhase = 'exiting';
        run.sceneTime = 0;
        run.riderOpacity = 0;
        run.winterMix = 0;
        run.snowRate = this.environment.snowIntensity;
        run.seed = nextLevel.seed;
        run.nextStatAt = run.elapsed + 9;
        // Fresh pacing memory for the new level's obstacle variety.
        run.recentPatterns = [];
        this.lastPlanInfo = null;
        this.callbacks.onHud(this.makeHud(run));
      }
    } else if (run.levelPhase === 'exiting') {
      const t = clamp(run.sceneTime / this.levels.current.transitions.start.seconds, 0, 1);
      rider.speed = 220 * t * t * (3 - 2 * t);
      rider.x += rider.speed * delta;
      run.riderOpacity = clamp(run.sceneTime / 0.85, 0, 1);
      if (t === 1) {
        run.levelPhase = 'riding';
        run.distance = rider.x;
        run.levelStartScore = this.runScore(run);
        run.riderOpacity = 1;
        run.nextCoinX = rider.x + 180;
        run.nextHazardX = rider.x + 650;
        run.nextPowerX = rider.x + 1100;
        run.snowRate = this.environment.snowIntensity;
        this.populateAhead(run);
      }
    }

    rider.y = this.terrainAt(rider.x) - 5;
    rider.rotation = this.terrainAngle(rider.x);
    run.distance = rider.x;
    this.syncLevelScore(run);
    if (run.levelPhase === 'riding') this.saveStableCheckpoint();
    // Pan toward the doorway and retain room ahead as the rider emerges.
    const framing = run.levelPhase === 'exiting' ? 0.38 : 0.5;
    const targetX = run.levelPhase === 'celebrating' ? doorX : rider.x;
    run.cameraX = lerp(run.cameraX, targetX - this.width * framing, 1 - Math.exp(-1.8 * delta));
    run.cameraY = lerp(run.cameraY, 0, 1 - Math.exp(-2 * delta));
    if (rider.speed > 20) {
      this.addTrail(run, delta);
      this.emitWheelSnow(run, delta);
    }
    this.updateEffects(run, delta);
    run.hudTimer += delta;
    if (run.hudTimer >= 0.12) {
      run.hudTimer = 0;
      this.callbacks.onHud(this.makeHud(run));
    }
  }

  private land(run: RunState, groundY: number, angle: number): void {
    const rider = run.rider;
    const angleError = Math.abs(this.shortestAngle(rider.rotation - angle));
    const flips = Math.floor(rider.totalSpin / TAU);

    if (angleError > BICYCLE_PHYSICS.landingAngleLimit || Math.abs(rider.angularVelocity) > BICYCLE_PHYSICS.landingSpinLimit) {
      rider.y = groundY;
      run.shake = 12;
      this.burst(run, rider.x, groundY, 26, this.environment.burstColors.heavy, 200, -125);
      this.emit({ type: 'crash', kind: 'landing' });
      this.finishRun(run, 'The landing got away from you.');
      return;
    }

    this.emit({ type: 'land', force: clamp(rider.vy / 950, 0, 1), clean: angleError < 0.35 });

    rider.grounded = true;
    rider.vy = 0;
    rider.y = groundY;
    rider.rotation = angle;
    rider.angularVelocity = 0;
    run.shake = Math.max(run.shake, angleError > 0.55 ? 4.2 : 2.4);
    this.burst(run, rider.x, groundY + 2, angleError > 0.55 ? 16 : 10, this.environment.burstColors.soft, 135, -90);

    if (flips > 0) {
      if (run.elapsed - run.lastTrickAt < 5.5) run.combo += 1;
      else run.combo = 1;
      run.lastTrickAt = run.elapsed;
      run.tricks += flips;
      run.flipsThisLevel += flips;
      const base = 250 * flips + Math.max(0, flips - 1) * 130;
      const multiplier = 1 + Math.min(run.combo - 1, 3) * 0.5;
      const cleanBonus = angleError < 0.48 ? 100 : 0;
      const points = Math.round(base * multiplier) + cleanBonus;
      run.bonus += points;
      const trickLabel = flips === 1 ? 'BACKFLIP' : `${flips}x BACKFLIP`;
      const comboLabel = run.combo > 1 ? `  /  COMBO x${run.combo}` : '';
      this.popup(run, rider.x, groundY - 68, `${trickLabel}  +${points}${comboLabel}`, '#ffe3a9');
      this.emit({ type: 'trick', flips, combo: run.combo });
    } else if (angleError < 0.35) {
      this.popup(run, rider.x, groundY - 56, 'SMOOTH LANDING  +40', '#e8f8fc');
      run.bonus += 40;
    }
  }

  private collectPickups(run: RunState, delta: number): void {
    const rider = run.rider;
    const riderCoreY = rider.y - 21;
    run.objects = run.objects.filter((object) => {
      const isCoin = object.kind === 'coin';
      const power = POWER_ORDER.find((kind) => kind === object.kind);
      if (!isCoin && !power) return true;

      const x = object.pulled?.x ?? object.x;
      const y = object.pulled?.y ?? this.terrainAt(object.x) - (object.offset ?? 25);
      const dx = rider.x - x;
      const dy = riderCoreY - y;
      const distance = Math.hypot(dx, dy);
      const attracting = isCoin && (object.pulled || (run.elapsed < run.magnetUntil && distance < 185));
      const travel = (rider.speed + 240) * delta;
      if (!(Math.abs(dx) < 24 && Math.abs(dy) < 31) && !(attracting && distance <= travel)) {
        if (attracting) object.pulled = { x: x + dx * travel / distance, y: y + dy * travel / distance };
        return true;
      }

      if (power) {
        // Phase 7 — ability durations live in the reward configuration.
        if (power === 'magnet') run.magnetUntil = run.elapsed + REWARD_CONFIG.abilities.magnetSeconds;
        if (power === 'double') run.doubleUntil = run.elapsed + REWARD_CONFIG.abilities.doubleSeconds;
        if (power === 'shield') run.shield = true;
        this.burst(run, x, y, 15, POWERS[power].color, 110, -45);
        this.popup(run, x, y - 16, POWERS[power].label.toUpperCase(), POWERS[power].color);
      } else {
        const amount = run.elapsed < run.doubleUntil ? 2 : 1;
        run.coins += amount;
        run.bonus += 125 * amount;
        run.shake = Math.max(run.shake, 1.3);
        this.burst(run, x, y, 9, '#ffd98b', 115, -40);
        this.popup(run, x, y - 12, amount === 2 ? '2× GLOWSTONES' : '+125', '#ffe0a2');
      }
      this.emit({ type: 'coin' });
      return false;
    });
  }

  private checkCollision(run: RunState): boolean {
    if (run.elapsed < run.invulnerableUntil) return false;
    const rider = run.rider;
    for (const object of run.objects) {
      // Phase 9A — rolling hazard: pose-driven position, resting on the
      // terrain wherever the patrol has carried it.
      if (object.kind === 'snowball') {
        const { radius, height } = OBSTACLE_REGISTRY.snowball.collision!;
        const slope = (this.terrainAt(object.x + 40) - this.terrainAt(object.x - 40)) / 80;
        const pose = snowballPose(object.x, slope, run.elapsed, object.phase ?? 0);
        if (Math.abs(rider.x - pose.x) > radius + BICYCLE_PHYSICS.collisionPadding) continue;
        const obstacleTop = this.terrainAt(pose.x) - height;
        if (rider.y + BICYCLE_PHYSICS.collisionBottom > obstacleTop + BICYCLE_PHYSICS.collisionInset) {
          return this.crashInto(run, object, 'A rolling snowball swept you up.');
        }
        continue;
      }
      // Phase 9A — overhead falling hazards: only the falling phase collides;
      // hanging, warning and landed states are safe to pass.
      if (object.kind === 'icicle' || object.kind === 'branch') {
        const groundY = this.terrainAt(object.x);
        const pose = object.kind === 'icicle'
          ? iciclePose(groundY, run.elapsed, object.phase ?? 0)
          : branchPose(groundY, run.elapsed, object.phase ?? 0);
        if (pose.state !== 'falling') continue;
        const { radius } = OBSTACLE_REGISTRY[object.kind].collision!;
        if (Math.abs(rider.x - object.x) > radius + BICYCLE_PHYSICS.collisionPadding) continue;
        // The leading edge must reach the rider's body envelope.
        const tip = object.kind === 'icicle' ? pose.y : pose.y + 12;
        if (tip > rider.y - 36 && tip < rider.y + 8) {
          return this.crashInto(run, object, object.kind === 'icicle' ? 'An icicle dropped onto your line.' : 'A falling branch caught you.');
        }
        continue;
      }
      if (object.kind !== 'rock' && object.kind !== 'tree' && object.kind !== 'log' && object.kind !== 'swinging-log'
        && object.kind !== 'root' && object.kind !== 'fence') continue;
      const { radius, height } = OBSTACLE_REGISTRY[object.kind].collision!;
      const groundY = this.terrainAt(object.x);
      const moving = object.kind === 'swinging-log' ? swingingLogPose(object.x, groundY, run.elapsed, object.phase) : undefined;
      const collisionX = moving?.x ?? object.x;
      if (Math.abs(rider.x - collisionX) > radius + BICYCLE_PHYSICS.collisionPadding) continue;
      const obstacleTop = moving ? moving.y - height / 2 : groundY - height;
      const riderBottom = rider.y + BICYCLE_PHYSICS.collisionBottom;
      const belowMovingLog = moving && rider.y - 30 >= moving.y + height / 2;
      if (!belowMovingLog && riderBottom > obstacleTop + BICYCLE_PHYSICS.collisionInset) {
        const reason = object.kind === 'swinging-log' ? 'A swinging log caught your line.'
          : object.kind === 'log' ? 'A fallen log caught your wheel.'
          : object.kind === 'tree' ? 'A tree crossed your line.'
          : object.kind === 'root' ? 'A tree root caught your wheel.'
          : object.kind === 'fence' ? 'A fence stopped you cold.'
          : 'A rock crossed your line.';
        return this.crashInto(run, object, reason);
      }
    }
    return false;
  }

  /** Shared shield/crash epilogue for every colliding hazard. */
  private crashInto(run: RunState, object: Obstacle, reason: string): boolean {
    const rider = run.rider;
    if (run.shield) {
      run.shield = false;
      run.invulnerableUntil = run.elapsed + 0.65;
      this.burst(run, rider.x, rider.y - 16, 18, POWERS.shield.color, 130, -55);
      this.popup(run, rider.x, rider.y - 52, 'SHIELD USED', POWERS.shield.color);
      return false;
    }
    run.shake = 13;
    this.burst(run, rider.x, rider.y, 28, '#f0f8fa', 205, -135);
    this.emit({ type: 'crash', kind: object.kind === 'tree' || object.kind === 'root' || object.kind === 'branch' ? 'tree' : 'rock' });
    this.finishRun(run, reason);
    return true;
  }

  private finishRun(run: RunState, reason: string): void {
    if (run.over) return;
    run.over = true;
    run.crashReason = reason;
    run.crashesThisLevel += 1;
    run.distance = run.rider.x;
    // Phase 8 — a brief, purely cosmetic tumble: the rider pops over the
    // bars, slides and spins to a stop. The camera stays put, the score is
    // already frozen, and no further collision logic runs while over.
    run.crashReaction = {
      vx: clamp(run.rider.speed * RECOVERY_CONFIG.crashTumbleSlideFactor, 0, 260),
      vy: run.rider.grounded ? RECOVERY_CONFIG.crashTumblePopVelocity : Math.min(run.rider.vy, 0),
      spin: RECOVERY_CONFIG.crashTumbleSpin,
      elapsed: 0,
    };
    this.syncLevelScore(run);
    this.held = false;
    this.jumpQueued = false;
    this.status = 'crashed';
    this.callbacks.onStatus(this.status);
    this.callbacks.onCrash?.({ ...this.makeHud(run), tricks: run.tricks, reason });
  }

  private missionProgress(run: RunState): number {
    return run.mission.metric === 'distance' ? Math.floor(run.distance / 10) : run[run.mission.metric];
  }

  private syncLevelScore(run: RunState): void {
    this.levels.updateScore(Math.max(0, this.runScore(run) - run.levelStartScore), this.runScore(run));
  }

  private saveStableCheckpoint(): void {
    const run = this.run;
    if (!run || run.over || run.levelPhase !== 'riding' || !run.rider.grounded || run.rider.fallingInto
      || this.gapAt(run, run.rider.x) || this.rampAt(run, run.rider.x)) return;
    const danger = run.objects.some((object) =>
      (object.plan && run.rider.x >= object.plan.warningStart && run.rider.x <= object.plan.clearUntil)
      || (['rock', 'tree', 'log', 'swinging-log', 'root', 'fence', 'snowball', 'icicle', 'branch'].includes(object.kind) && Math.abs(object.x - run.rider.x) < 80));
    if (danger) return;
    this.syncLevelScore(run);
    const checkpoint = { ...run, particles: [], trail: [], popups: [] };
    this.levels.saveCheckpoint(checkpoint);
    this.checkpointElapsed = run.elapsed;
  }

  private runScore(run: RunState): number {
    return Math.max(0, Math.floor(run.distance / 10)) + run.coins * 125 + run.bonus;
  }

  private makeHud(run: RunState): HudSnapshot {
    const powers: HudSnapshot['powers'] = [];
    if (run.magnetUntil > run.elapsed) powers.push({ kind: 'magnet', seconds: Math.ceil(run.magnetUntil - run.elapsed) });
    if (run.shield) powers.push({ kind: 'shield' });
    if (run.doubleUntil > run.elapsed) powers.push({ kind: 'double', seconds: Math.ceil(run.doubleUntil - run.elapsed) });
    return {
      powers,
      wallet: { balance: this.wallet.balance },
      level: {
        number: run.levelIndex + 1,
        name: this.levels.current.name,
        score: this.levels.levelScore,
        target: this.levels.current.targetScore,
        phase: run.levelPhase,
        completed: this.levels.completedThrough + (this.levels.safeHouseReached ? 1 : 0),
        coinsCollected: Math.max(0, run.coins - run.coinsAtLevelStart),
        reward: run.levelReward,
      },
      mission: {
        label: run.mission.label,
        progress: Math.min(run.mission.target, this.missionProgress(run)),
        target: run.mission.target,
        complete: run.missionComplete,
      },
      score: this.runScore(run),
      distance: Math.max(0, Math.floor(run.distance / 10)),
      speedKmh: Math.round(run.rider.speed * 0.36),
      coins: run.coins,
      combo: run.combo,
      elapsed: run.elapsed,
    };
  }

  private addTrail(run: RunState, delta: number): void {
    run.trailTimer += delta;
    if (run.trailTimer >= 0.035) {
      run.trailTimer = 0;
      run.trail.push({ x: run.rider.x - 18, y: run.rider.y + 4, age: 0 });
      if (run.trail.length > 22) run.trail.shift();
    }
  }

  private emitWheelSnow(run: RunState, delta: number): void {
    const rider = run.rider;
    if (!rider.grounded || rider.speed < 25 || (this.rampAt(run, rider.x) || this.bridgeAt(run, rider.x))) {
      run.wheelSnowCarry = 0;
      return;
    }

    const speed = clamp((rider.speed - 205) / 270, 0, 1);
    const quality = this.lighterGraphics ? 0.7 : 1;
    const spray = this.environment.groundSpray;
    run.wheelSnowCarry += lerp(13, 39, speed) * quality * spray.rate * delta;
    const bursts = Math.floor(run.wheelSnowCarry);
    run.wheelSnowCarry -= bursts;
    const cos = Math.cos(rider.rotation);
    const sin = Math.sin(rider.rotation);

    for (let index = 0; index < bursts; index += 1) {
      for (const axle of [REAR_AXLE, FRONT_AXLE]) {
        // Snow leaves the lower rear quadrant along the tire's tangent.
        const angle = 0.2 + Math.random() * 0.5;
        const localX = (axle - WHEEL_RADIUS * Math.sin(angle)) * BIKE_SCALE;
        const localY = WHEEL_CONTACT_Y - WHEEL_RADIUS * (1 - Math.cos(angle)) * BIKE_SCALE;
        const force = rider.speed * lerp(0.24, 0.48, Math.random()) * (axle === REAR_AXLE ? 1 : 0.72);
        const backward = -Math.cos(angle) * force;
        const upward = -Math.sin(angle) * force;
        const life = 0.36 + Math.random() * 0.28;
        run.particles.push({
          x: rider.x + localX * cos - localY * sin,
          y: rider.y + localX * sin + localY * cos - 1,
          vx: backward * cos - upward * sin,
          vy: backward * sin + upward * cos,
          size: (1.1 + Math.random() * (1.1 + speed)) * spray.size,
          life,
          maxLife: life,
          color: spray.color,
          wheelSnow: true,
        });
      }
    }
  }

  private updateEffects(run: RunState, delta: number): void {
    // Phase 8 — the crash tumble plays out while the crashed scene is on
    // screen (the frame loop keeps calling this for paused/crashed/gameover).
    const reaction = run.crashReaction;
    if (run.over && reaction && reaction.elapsed < RECOVERY_CONFIG.crashTumbleSeconds) {
      reaction.elapsed += delta;
      const rider = run.rider;
      rider.x += reaction.vx * delta;
      reaction.vx *= Math.exp(-RECOVERY_CONFIG.crashTumbleSlideDecay * delta);
      reaction.vy += 1_500 * delta;
      rider.y += reaction.vy * delta;
      rider.rotation += reaction.spin * delta;
      reaction.spin *= Math.exp(-RECOVERY_CONFIG.crashTumbleSpinDecay * delta);
      // Stop the slide against a solid obstacle; settle on the surface
      // unless the rider is inside a gap (they keep falling, as they should).
      const blocked = run.objects.some((object) =>
        (object.kind === 'rock' || object.kind === 'tree' || object.kind === 'log' || object.kind === 'swinging-log')
        && object.x > rider.x - 10 && object.x - rider.x < 24);
      if (blocked) reaction.vx = 0;
      if (!this.gapAt(run, rider.x) && !rider.fallingInto) {
        const groundY = this.rideHeight(run, rider.x) - 5;
        if (rider.y > groundY) {
          rider.y = groundY;
          reaction.vy = 0;
          reaction.vx *= 0.55;
          reaction.spin *= 0.45;
        }
      }
    }
    run.particles = run.particles.filter((particle) => {
      particle.life -= delta;
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      particle.vy += 250 * delta;
      if (particle.wheelSnow && particle.vy > 0 && particle.y >= this.terrainAt(particle.x) && !this.gapAt(run, particle.x)) {
        return false;
      }
      return particle.life > 0;
    });
    run.trail.forEach((point) => { point.age += delta; });
    run.trail = run.trail.filter((point) => point.age < 0.48);
    run.popups.forEach((popup) => { popup.life -= delta; popup.y -= 19 * delta; });
    run.popups = run.popups.filter((popup) => popup.life > 0);
    run.shake *= Math.exp(-7.5 * delta);
  }

  private burst(run: RunState, x: number, y: number, amount: number, color: string, force: number, lift: number): void {
    for (let index = 0; index < amount; index += 1) {
      const angle = this.nextRandom(run) * TAU;
      const velocity = force * (0.25 + this.nextRandom(run) * 0.75);
      run.particles.push({
        x,
        y,
        vx: Math.cos(angle) * velocity - 45,
        vy: Math.sin(angle) * velocity * 0.52 + lift,
        size: 1.5 + this.nextRandom(run) * 3.2,
        life: 0.38 + this.nextRandom(run) * 0.55,
        maxLife: 0.9,
        color,
      });
    }
  }

  private popup(run: RunState, x: number, y: number, text: string, color: string): void {
    run.popups.push({ x, y, text, color, life: 1.35, maxLife: 1.35 });
  }

  private shortestAngle(angle: number): number {
    let result = angle;
    while (result > Math.PI) result -= TAU;
    while (result < -Math.PI) result += TAU;
    return result;
  }

  private draw(): void {
    const context = this.context;
    const width = this.width;
    const height = this.height;
    const run = this.run;
    const isMenu = this.status === 'menu' || !run;
    const menuX = this.clock * 16;
    const cameraX = isMenu ? menuX - width * 0.72 : run.cameraX;
    const worldX = isMenu ? menuX : run.rider.x;
    const cycle = this.currentDayPhase();
    const palette = this.environment.palette(cycle);
    this.lastNight = palette.night;

    // A single reusable view object keeps per-frame allocations out of render.
    const view = this.environmentView;
    view.width = width;
    view.height = height;
    view.cameraX = cameraX;
    view.cameraY = isMenu ? 0 : run.cameraY;
    view.clock = this.clock;
    view.phase = cycle;
    view.riderX = worldX;
    view.isMenu = isMenu;
    view.lighter = this.lighterGraphics;

    context.clearRect(0, 0, width, height);
    this.environment.drawSky(context, view, palette);

    const rider = isMenu
      ? { x: menuX, y: this.terrainAt(menuX) - 5, rotation: this.terrainAngle(menuX), grounded: true }
      : run.rider;
    const shakeX = run && (this.status === 'playing' || this.status === 'gameover' || this.status === 'crashed')
      ? Math.sin(this.clock * 78) * run.shake
      : 0;
    const cameraY = view.cameraY;

    context.save();
    context.translate(shakeX, cameraY);
    this.environment.drawBackground(context, view, palette);
    if (!isMenu) {
      this.drawStartWindmill(context, cameraX, run.elapsed);
      for (const house of run.houses) this.drawFinishHouse(context, house, cameraX, run);
    }
    this.drawTerrain(context, width, height, cameraX, palette, run);
    // Phase 9B — environment-specific crest detail rides the collision surface.
    this.environment.drawGroundDetail(context, view, palette);
    this.environment.drawDecorations(context, view, this.decorationReserved, palette);
    if (run && !isMenu) this.drawTrail(context, run, cameraX, palette);
    if (run && !isMenu) this.drawObjects(context, run, cameraX, palette);
    if (run && !isMenu) this.drawParticles(context, run, cameraX);
    const airTime = isMenu ? 0 : run.rider.airTime;
    context.save();
    context.globalAlpha = isMenu ? 1 : run.riderOpacity;
    this.drawRider(context, rider.x - cameraX, rider.y, rider.rotation, rider.grounded, isMenu, rider.x, airTime);
    context.restore();
    if (run && !isMenu) this.drawPopups(context, run, cameraX);
    if (run && !isMenu && this.obstacleDebug) this.drawObstacleDebug(context, run, cameraX);
    this.environment.drawAmbient(context, view);
    // Phase 9B — sparse foreground silhouettes pass in front of the gameplay.
    this.environment.drawForeground(context, view, palette);
    context.restore();
    // Screen-space weather stays outside the camera shake.
    this.environment.drawWeather(context, view, palette);
    if (run && !isMenu && this.status === 'playing' && run.levelPhase === 'riding') this.drawObstacleWarning(context, run);
  }

  private drawObstacleWarning(context: CanvasRenderingContext2D, run: RunState): void {
    const upcoming = run.objects.find(object => object.plan && !object.bridged
      && object.x > run.rider.x && run.rider.x >= object.plan.warningStart
      && (OBSTACLE_REGISTRY[object.plan.obstacleId].requiresWarning || object.x - run.cameraX > this.width - 25));
    if (!upcoming) return;
    context.save();
    context.fillStyle = '#f4d5a0';
    context.strokeStyle = '#263b50';
    context.lineWidth = 2;
    context.font = '600 10px system-ui';
    context.textAlign = 'right';
    const label = `› ${(upcoming.plan?.obstacleId ?? upcoming.kind).replace(/-/g, ' ').toUpperCase()} AHEAD`;
    const x = this.width - 18;
    const y = this.height * 0.4;
    context.strokeText(label, x, y);
    context.fillText(label, x, y);
    context.restore();
  }

  private drawObstacleDebug(context: CanvasRenderingContext2D, run: RunState, cameraX: number): void {
    context.save();
    context.lineWidth = 1;
    context.font = '10px monospace';
    context.textAlign = 'left';
    this.drawDifficultyDebug(context, run);
    for (const object of run.objects) {
      if (!['rock', 'tree', 'log', 'gap', 'ramp', 'swinging-log', 'root', 'fence', 'ice', 'icicle', 'snowball', 'branch'].includes(object.kind)) continue;
      const x = object.x - cameraX;
      if (x < -200 || x > this.width + 200) continue;
      const ground = this.terrainAt(object.x);
      const collision = object.kind === 'rock' || object.kind === 'log' || object.kind === 'tree' || object.kind === 'swinging-log'
        || object.kind === 'root' || object.kind === 'fence' || object.kind === 'snowball' || object.kind === 'icicle' || object.kind === 'branch'
        ? OBSTACLE_REGISTRY[object.kind].collision : undefined;
      context.strokeStyle = object.bridged ? '#74f0b7' : '#ff8c99';
      if (collision) {
        const radius = collision.radius + BICYCLE_PHYSICS.collisionPadding;
        if (object.kind === 'swinging-log') {
          const pose = swingingLogPose(object.x, ground, run.elapsed, object.phase);
          context.strokeRect(pose.x - cameraX - radius, pose.y - collision.height / 2, radius * 2, collision.height);
        } else if (object.kind === 'snowball') {
          const slope = (this.terrainAt(object.x + 40) - this.terrainAt(object.x - 40)) / 80;
          const pose = snowballPose(object.x, slope, run.elapsed, object.phase ?? 0);
          context.strokeRect(pose.x - cameraX - radius, this.terrainAt(pose.x) - collision.height, radius * 2, collision.height);
        } else if (object.kind === 'icicle' || object.kind === 'branch') {
          const pose = object.kind === 'icicle'
            ? iciclePose(ground, run.elapsed, object.phase ?? 0)
            : branchPose(ground, run.elapsed, object.phase ?? 0);
          if (pose.state === 'falling') context.strokeRect(x - radius, pose.y, radius * 2, collision.height);
        } else {
          context.strokeRect(x - radius, ground - collision.height + BICYCLE_PHYSICS.collisionInset, radius * 2, collision.height + 7);
        }
      } else {
        context.strokeRect(x, ground - (object.kind === 'ramp' ? 38 : 0), object.width ?? 100, object.kind === 'gap' ? 85 : 38);
      }
      const plan = object.plan;
      if (!plan) continue;
      context.fillStyle = '#c8eeff';
      context.fillText(`${plan.patternId} · spacing ${Math.round(plan.spacing)}px`, x - 20, ground - 90);
      for (const [region, color, offset] of [[plan.takeoff, '#ffc96b', 15], [plan.landing, '#74efb5', 27]] as const) {
        context.strokeStyle = color;
        context.beginPath();
        context.moveTo(region.start - cameraX, this.terrainAt(region.start) - offset);
        context.lineTo(region.end - cameraX, this.terrainAt(region.end) - offset);
        context.stroke();
      }
    }
    context.fillStyle = '#ffb0b0';
    let row = 0;
    const baseline = 16 + this.difficultyDebugRowCount * 13 + 10;
    for (const rejected of this.obstacleRejections.slice(-4)) {
      context.fillText(`REJECT ${rejected.patternId} @${Math.round(rejected.x)}: ${rejected.reason}`, 12, baseline + row++ * 14);
    }
    context.restore();
  }

  private difficultyDebugRowCount = 1;

  /**
   * Phase 5A diagnostics: level & environment, difficulty, pacing zone, wave,
   * active pattern, next obstacle, active weather, current terrain chunk and
   * the obstacle types eligible for generation in this level.
   */
  private drawDifficultyDebug(context: CanvasRenderingContext2D, run: RunState): void {
    const directive = this.lastDirective;
    const level = this.levels.current;
    const rows: string[] = [
      `LVL ${run.levelIndex + 1} · ${level.environment.toUpperCase()} · ${level.name}`,
    ];
    if (directive) {
      const wave = directive.wave;
      const recovery = directive.nextRecoveryPoints === null
        ? 'SAFE APPROACH'
        : directive.nextRecoveryPoints === 0 ? 'RECOVERY ACTIVE'
        : `recovery in ~${(directive.nextRecoveryPoints / 1000).toFixed(1)}k pts`;
      rows.push(
        `DIFF ${directive.intensity.toFixed(2)} (lvl ${directive.levelIntensity.toFixed(2)} · zone ${directive.zone.multiplier.toFixed(2)} · wave ${wave.tension.toFixed(2)} · terr ${(1 - 0.3 * directive.terrainComplexity).toFixed(2)})`,
        `ZONE ${directive.zone.label} (${(directive.zone.fromPoints / 1000).toFixed(0)}k–${(directive.zone.toPoints / 1000).toFixed(0)}k pts)`,
        `WAVE ${wave.index + 1}/${wave.count} · ${recovery}`,
        `PATTERN ${this.lastPlanInfo ? `${this.lastPlanInfo.patternId} · rating ${this.lastPlanInfo.rating.toFixed(2)} · spacing ${Math.round(this.lastPlanInfo.spacing)}px` : '—'}`,
      );
    } else {
      rows.push('DIFF — (no planning pass yet)');
    }
    const upcoming = run.objects.find((object) => object.plan && object.x > run.rider.x);
    rows.push(`NEXT ${upcoming ? `${upcoming.kind} @+${Math.round(upcoming.x - run.rider.x)}px (${upcoming.plan!.patternId})` : '—'}`);
    const weather = this.environment.weatherEffects().map((effect) => `${effect.kind} ${effect.intensity.toFixed(2)}`).join(' · ');
    rows.push(`WEATHER ${weather || 'clear'}`);
    const chunk = this.terrain?.describe(run.rider.x);
    rows.push(`TERRAIN ${chunk ? `L${chunk.level} chunk ${chunk.index} · ${chunk.pattern} · complexity ${directive ? directive.terrainComplexity.toFixed(2) : '—'}` : '—'} · jump reach ${directive ? `${directive.riderEnvelope.minJumpDistance}–${directive.riderEnvelope.maxJumpDistance}px` : '—'}`);
    const active = level.allowedObstacles.filter((id) => obstacleReady(id));
    const pending = level.allowedObstacles.filter((id) => !obstacleReady(id));
    const availablePatterns = patternAvailability(level).filter((pattern) => pattern.available).length;
    rows.push(`OBSTACLES ${active.join(',')}${pending.length ? ` (+${pending.join(',')} pending)` : ''} · patterns ${availablePatterns}/${OBSTACLE_PATTERNS.length}`);
    this.difficultyDebugRowCount = rows.length;
    context.fillStyle = '#b8e6ff';
    rows.forEach((text, index) => context.fillText(text, 12, 16 + index * 13));
  }

  private drawStartWindmill(context: CanvasRenderingContext2D, cameraX: number, elapsed: number): void {
    const millX = -78;
    const x = millX - cameraX;
    if (x < -160 || x > this.width + 160) return;

    context.save();
    context.translate(x, this.terrainAt(millX) + 5);
    const scale = clamp(this.height / 300, 0.95, 1.55);
    context.scale(scale, scale);
    context.lineJoin = 'round';

    // The warm plaster tower widens toward its stone foundation.
    context.fillStyle = '#b6a095';
    context.beginPath();
    context.ellipse(0, -4, 43, 10, 0, 0, TAU);
    context.fill();
    context.fillStyle = '#ebd1ae';
    context.beginPath();
    context.moveTo(-36, -5);
    context.lineTo(-26, -104);
    context.lineTo(26, -104);
    context.lineTo(36, -5);
    context.quadraticCurveTo(0, 4, -36, -5);
    context.fill();
    context.fillStyle = '#c1a48d';
    context.beginPath();
    context.moveTo(13, -103);
    context.lineTo(26, -104);
    context.lineTo(36, -5);
    context.lineTo(23, -3);
    context.closePath();
    context.fill();

    context.fillStyle = '#9c554d';
    context.beginPath();
    context.moveTo(-33, -99);
    context.lineTo(-22, -117);
    context.quadraticCurveTo(0, -149, 22, -117);
    context.lineTo(34, -99);
    context.closePath();
    context.fill();
    context.strokeStyle = '#edf3ef';
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(-30, -102);
    context.lineTo(-22, -117);
    context.quadraticCurveTo(0, -149, 22, -117);
    context.lineTo(30, -103);
    context.stroke();

    context.fillStyle = '#675147';
    for (let beam = -21; beam <= 21; beam += 7) context.fillRect(beam, -96, 3, 5);
    context.beginPath();
    context.arc(0, -62, 5.5, 0, TAU);
    context.fill();
    context.beginPath();
    context.moveTo(-6, -4);
    context.lineTo(-6, -32);
    context.quadraticCurveTo(0, -45, 6, -32);
    context.lineTo(6, -4);
    context.fill();

    context.save();
    context.translate(0, -108);
    context.rotate(0.46 + this.clock * 0.24);
    for (let blade = 0; blade < 4; blade += 1) {
      context.rotate(Math.PI / 2);
      context.fillStyle = '#f0d8bb';
      context.strokeStyle = '#8d6855';
      context.lineWidth = 2.6;
      context.beginPath();
      context.moveTo(18, -5);
      context.lineTo(78, -9);
      context.lineTo(78, 10);
      context.lineTo(18, 8);
      context.closePath();
      context.fill();
      context.stroke();
      context.beginPath();
      context.moveTo(0, 0);
      context.lineTo(78, 0);
      for (let rib = 28; rib < 78; rib += 10) {
        context.moveTo(rib, -7);
        context.lineTo(rib, 8);
      }
      context.stroke();
    }
    context.fillStyle = '#694c3f';
    context.beginPath();
    context.arc(0, 0, 6, 0, TAU);
    context.fill();
    context.restore();

    if (elapsed < 2.7) {
      context.strokeStyle = '#493d39';
      context.lineWidth = 1.6;
      context.lineCap = 'round';
      for (let bird = 0; bird < 5; bird += 1) {
        const flight = Math.max(0, elapsed - (0.2 + bird * 0.095));
        const direction = bird % 2 === 0 ? -1 : 1;
        const birdX = -17 + bird * 8 + direction * flight * (27 + bird * 7);
        const birdY = -123 - (2 - Math.abs(2 - bird)) * 5 - flight * (28 + bird * 5);
        const wing = flight > 0 ? Math.sin(flight * 23 + bird) * 4 : 1;
        context.beginPath();
        context.moveTo(birdX - 4, birdY - wing);
        context.quadraticCurveTo(birdX - 2, birdY - wing - 2, birdX, birdY);
        context.quadraticCurveTo(birdX + 2, birdY - wing - 2, birdX + 4, birdY - wing);
        context.stroke();
      }
    }
    context.restore();
  }

  /**
   * Phase 6 cinematic: the active house's door openness, 0 (closed) .. 1
   * (open). Derived purely from the scene state so it stays deterministic:
   * it opens as the rider closes in, shuts behind them after entry, reopens
   * for the exit and closes once the rider has ridden clear.
   */
  private houseDoorOpenness(run: RunState, house: FinishHouse): number {
    if (run.houses[run.houses.length - 1] !== house) return 0;
    const ease = (t: number) => t * t * (3 - 2 * t);
    const doorX = house.x + 24;
    switch (run.levelPhase) {
      case 'approach': {
        const remaining = doorX - 18 - run.rider.x;
        return ease(clamp((240 - remaining) / 240, 0, 1));
      }
      case 'entering':
        return 1;
      case 'celebrating':
        return 1 - ease(clamp((run.sceneTime - 0.55) / 0.6, 0, 1));
      case 'exiting': {
        const gone = run.rider.x - doorX;
        return gone < 70 ? 1 : 1 - ease(clamp((gone - 70) / 160, 0, 1));
      }
      default:
        return 0;
    }
  }

  private drawFinishHouse(context: CanvasRenderingContext2D, house: FinishHouse, cameraX: number, run: RunState): void {
    const x = house.x - cameraX;
    if (x < -170 || x > this.width + 170) return;
    const door = this.houseDoorOpenness(run, house);
    const theme = this.levels.current.environment;
    const night = this.lastNight;
    // Warm light reads stronger after dusk and while the door is open.
    const warm = clamp(0.45 + 0.55 * night + 0.2 * door, 0, 1);
    const flicker = 0.88 + 0.12 * Math.sin(this.clock * 2.1 + house.x * 0.13);
    context.save();
    context.translate(x, house.groundY + 4);

    // Ambient light spilling from the house onto the surroundings.
    const halo = context.createRadialGradient(18, -30, 10, 18, -30, theme === 'misty-mountains' ? 150 : 120);
    halo.addColorStop(0, `rgba(255, 205, 130, ${0.2 * warm * flicker})`);
    halo.addColorStop(1, 'rgba(255, 205, 130, 0)');
    context.fillStyle = halo;
    context.fillRect(-140, -150, 320, 160);

    // Subtle chimney smoke — lazier and softer in the mist.
    const smokeAlpha = theme === 'misty-mountains' ? 0.17 : 0.25;
    for (let i = 0; i < 5; i += 1) {
      const t = (this.clock * 0.17 + i / 5) % 1;
      context.fillStyle = `rgba(224,236,244,${smokeAlpha * Math.sin(t * Math.PI)})`;
      context.beginPath();
      context.ellipse(-24 + t * 28, -128 - t * 42, 3 + t * 10, 3 + t * 6, 0.2, 0, TAU);
      context.fill();
    }
    context.fillStyle = '#88746d';
    context.fillRect(-31, -132, 14, 38);
    context.fillStyle = '#e4c6a5';
    context.fillRect(-58, -84, 116, 90);
    context.fillStyle = '#b08a6c';
    for (let y = -72; y < 5; y += 12) context.fillRect(-58, y, 116, 1);
    context.fillRect(-58, -84, 5, 90);
    context.fillRect(53, -84, 5, 90);

    context.fillStyle = '#675e67';
    context.beginPath();
    context.moveTo(-72, -80);
    context.lineTo(-2, -134);
    context.lineTo(72, -80);
    context.closePath();
    context.fill();
    context.strokeStyle = '#edf3ef';
    context.lineWidth = 6;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(-71, -83);
    context.lineTo(-2, -135);
    context.lineTo(71, -83);
    context.stroke();

    // Environment-specific dressing: snow accumulation in the mountains.
    if (theme === 'snowy-mountains') {
      context.strokeStyle = '#f6fafd';
      context.lineWidth = 9;
      context.beginPath();
      context.moveTo(-70, -87);
      context.lineTo(-2, -139);
      context.lineTo(70, -87);
      context.stroke();
      context.fillStyle = '#e8f3f8';
      for (let i = -3; i <= 3; i += 1) {
        const length = 5 + ((i * 73 + 19) % 5);
        context.beginPath();
        context.moveTo(i * 18 - 2.5, -85);
        context.lineTo(i * 18 + 2.5, -85);
        context.lineTo(i * 18, -85 + length);
        context.closePath();
        context.fill();
      }
      context.fillStyle = '#f2f8fc';
      context.beginPath();
      context.ellipse(0, 4, 80, 12, 0, 0, TAU);
      context.fill();
      context.beginPath();
      context.ellipse(-36, 7, 34, 8, 0, 0, TAU);
      context.fill();
    }

    // A small round attic window in the gable, lit from within.
    const atticGlow = context.createRadialGradient(-2, -102, 2, -2, -102, 22);
    atticGlow.addColorStop(0, `rgba(255, 214, 140, ${0.3 * warm * flicker})`);
    atticGlow.addColorStop(1, 'rgba(255, 214, 140, 0)');
    context.fillStyle = atticGlow;
    context.fillRect(-24, -124, 44, 44);
    context.fillStyle = `rgba(255, 216, 148, ${0.55 + 0.4 * warm})`;
    context.beginPath();
    context.arc(-2, -102, 6, 0, TAU);
    context.fill();
    context.strokeStyle = '#9b775b';
    context.lineWidth = 2;
    context.stroke();

    // The cross-framed window with a warm, gently flickering glow.
    const windowGlow = context.createRadialGradient(-27, -47, 4, -27, -47, 48);
    windowGlow.addColorStop(0, `rgba(255, 214, 140, ${0.38 * warm * flicker})`);
    windowGlow.addColorStop(1, 'rgba(255, 214, 140, 0)');
    context.fillStyle = windowGlow;
    context.fillRect(-72, -88, 90, 82);
    context.fillStyle = '#755b4d';
    context.fillRect(-43, -63, 32, 32);
    context.fillStyle = `rgba(255, 223, 164, ${clamp(0.7 + 0.3 * warm, 0, 1)})`;
    context.fillRect(-40, -60, 26, 26);
    context.strokeStyle = '#9b775b';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(-27, -60);
    context.lineTo(-27, -34);
    context.moveTo(-40, -47);
    context.lineTo(-14, -47);
    context.stroke();
    context.fillStyle = '#e8edf0';
    context.fillRect(-45, -32, 36, 4);

    // A lantern by the door for the darker trails.
    if (theme === 'moonlit-forest' || theme === 'misty-mountains') {
      context.fillStyle = '#4a3f35';
      context.fillRect(58, -46, 3.5, 50);
      context.fillRect(51, -46, 16, 3);
      const lampX = 59;
      const lampY = -53;
      const lampHalo = context.createRadialGradient(lampX, lampY, 2, lampX, lampY, theme === 'misty-mountains' ? 62 : 42);
      lampHalo.addColorStop(0, `rgba(255, 206, 130, ${0.45 * warm})`);
      lampHalo.addColorStop(1, 'rgba(255, 206, 130, 0)');
      context.fillStyle = lampHalo;
      context.fillRect(lampX - 64, lampY - 64, 128, 128);
      context.fillStyle = '#2f2a24';
      context.fillRect(lampX - 4.5, lampY - 6, 9, 12);
      context.fillStyle = `rgba(255, 214, 140, ${0.75 + 0.25 * Math.sin(this.clock * 3.7 + 1)})`;
      context.fillRect(lampX - 2.5, lampY - 4, 5, 8);
    }

    // The doorway: frame, warm interior revealed as the door swings open.
    context.fillStyle = '#765a49';
    context.fillRect(3, -54, 42, 60);
    context.fillStyle = '#2b2320';
    context.fillRect(7, -50, 34, 56);
    if (door > 0) {
      const interior = context.createLinearGradient(7, 0, 41, 0);
      interior.addColorStop(0, `rgba(255, 190, 110, ${0.55 * door * warm})`);
      interior.addColorStop(1, `rgba(255, 214, 150, ${0.38 * door * warm})`);
      context.fillStyle = interior;
      context.fillRect(7, -50, 34, 56);
    }
    // Door panel, hinged on the left, swinging inward as it opens.
    context.save();
    context.translate(7, 0);
    context.scale(Math.max(0.14, Math.cos(door * 1.25)), 1);
    context.fillStyle = '#8a6a4f';
    context.fillRect(0, -50, 34, 56);
    context.fillStyle = '#7a5c43';
    context.fillRect(3, -46, 28, 22);
    context.fillRect(3, -20, 28, 22);
    context.fillStyle = '#ffd98b';
    context.beginPath();
    context.arc(29, -22, 2.2, 0, TAU);
    context.fill();
    context.restore();
    context.fillStyle = '#f8d297';
    context.fillRect(8, -49, 3, 52);
    context.fillStyle = '#ffdda0';
    context.fillRect(47, -50, 5, 9);
    context.restore();
  }

  private drawTerrain(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    cameraX: number,
    palette: Palette,
    run: RunState | null,
  ): void {
    const step = this.lighterGraphics ? 12 : 9;
    let segment: Array<{ x: number; y: number }> = [];
    const fill = () => {
      if (segment.length < 2) {
        segment = [];
        return;
      }

      const ground = context.createLinearGradient(0, height * 0.54, 0, height);
      ground.addColorStop(0, palette.snow);
      ground.addColorStop(0.55, colorMix(palette.snow, palette.snowShade, 0.44));
      ground.addColorStop(1, palette.snowShade);
      context.beginPath();
      context.moveTo(segment[0].x, segment[0].y);
      for (const point of segment) context.lineTo(point.x, point.y);
      context.lineTo(segment[segment.length - 1].x, height + 40);
      context.lineTo(segment[0].x, height + 40);
      context.closePath();
      context.fillStyle = ground;
      context.fill();

      context.beginPath();
      context.moveTo(segment[0].x, segment[0].y);
      for (const point of segment) context.lineTo(point.x, point.y);
      context.strokeStyle = alphaColor(colorMix(palette.snow, '#ffffff', 0.5), 0.9);
      context.lineWidth = 2.4;
      context.lineJoin = 'round';
      context.stroke();

      context.beginPath();
      context.moveTo(segment[0].x, segment[0].y + 8);
      for (const point of segment) context.lineTo(point.x, point.y + 8);
      context.strokeStyle = `rgba(118,152,177,${0.16 + palette.night * 0.07})`;
      context.lineWidth = 1;
      context.stroke();
      segment = [];
    };

    for (let screenX = -18; screenX <= width + 18; screenX += step) {
      const worldX = cameraX + screenX;
      const inGap = run ? this.gapAt(run, worldX, true) : undefined;
      if (inGap) {
        fill();
      } else {
        segment.push({ x: screenX, y: this.terrainAt(worldX) });
      }
    }
    fill();

    if (run) {
      for (const gap of run.objects) {
        if (gap.kind !== 'gap') continue;
        const startX = gap.x - cameraX;
        const endX = startX + (gap.width ?? 0);
        if (endX < -30 || startX > width + 30) continue;
        const leftY = this.terrainAt(gap.x);
        const rightY = this.terrainAt(gap.x + (gap.width ?? 0));
        const gorge = context.createLinearGradient(0, Math.min(leftY, rightY), 0, height);
        gorge.addColorStop(0, 'rgba(35,54,74,0.84)');
        gorge.addColorStop(1, 'rgba(13,30,47,0.96)');
        context.beginPath();
        context.moveTo(startX, leftY);
        context.lineTo(startX + 8, leftY + 26);
        context.lineTo(endX - 8, rightY + 26);
        context.lineTo(endX, rightY);
        context.lineTo(endX, height + 40);
        context.lineTo(startX, height + 40);
        context.closePath();
        context.fillStyle = gorge;
        context.fill();

        context.strokeStyle = 'rgba(255,255,255,0.72)';
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(startX, leftY);
        context.lineTo(startX + 8, leftY + 26);
        context.moveTo(endX, rightY);
        context.lineTo(endX - 8, rightY + 26);
        context.stroke();
      }
    }
  }

  private drawObjects(context: CanvasRenderingContext2D, run: RunState, cameraX: number, palette: Palette): void {
    for (const object of run.objects) {
      const x = (object.pulled?.x ?? object.x) - cameraX;
      if (x + (object.width ?? 0) < -100 || x > this.width + 100) continue;
      const groundY = this.terrainAt(object.x);

      if (object.kind === 'coin') {
        const y = object.pulled?.y ?? groundY - (object.offset ?? 42);
        const spin = 0.28 + Math.abs(Math.sin(this.clock * 4.1 + (object.phase ?? 0))) * 0.72;
        context.save();
        context.translate(x, y);
        context.scale(spin, 1);
        if (!this.lighterGraphics) {
          const halo = context.createRadialGradient(0, 0, 1, 0, 0, 22);
          halo.addColorStop(0, 'rgba(255,221,154,0.33)');
          halo.addColorStop(1, 'rgba(255,221,154,0)');
          context.fillStyle = halo;
          context.beginPath();
          context.arc(0, 0, 22, 0, TAU);
          context.fill();
        }
        context.strokeStyle = '#ffda91';
        context.lineWidth = 2.2;
        context.beginPath();
        context.arc(0, 0, 8.5, 0, TAU);
        context.stroke();
        context.strokeStyle = 'rgba(255,255,255,0.86)';
        context.lineWidth = 1;
        context.beginPath();
        context.arc(0, 0, 4.2, -1.1, 1.1);
        context.stroke();
        context.restore();
        continue;
      }

      const power = POWER_ORDER.find((kind) => kind === object.kind);
      if (power) this.drawPower(context, x, groundY - 25, power);
      if (object.bridged && object.plan?.obstacleId === 'moving-platform') {
        this.drawMovingPlatform(context, object, x, run);
      } else if (object.bridged) {
        this.drawBridge(context, object, x);
      }
      if (object.kind === 'gap' && !object.bridged) this.drawGapVariant(context, object, x);
      if (object.kind === 'ramp') this.drawRamp(context, object, x);
      if (object.kind === 'rock') this.drawRock(context, x, groundY, palette);
      if (object.kind === 'tree') this.drawPine(context, x, groundY, palette);
      if (object.kind === 'log') this.drawSnowyLog(context, x, groundY, palette);
      if (object.kind === 'root') this.drawRoot(context, x, groundY, palette, object.variant ?? 0.5);
      if (object.kind === 'fence') this.drawFence(context, x, groundY, palette, object.variant ?? 0.5);
      if (object.kind === 'ice') this.drawIcePatch(context, object, cameraX);
      if (object.kind === 'icicle') this.drawIcicle(context, object, cameraX, run);
      if (object.kind === 'snowball') this.drawSnowball(context, object, cameraX, run);
      if (object.kind === 'branch') this.drawBranch(context, object, cameraX, run);
      if (object.kind === 'swinging-log') {
        const pose = swingingLogPose(object.x, groundY, run.elapsed, object.phase);
        context.save();
        context.strokeStyle = '#8e7966';
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(x - 52, groundY);
        context.lineTo(x - 52, groundY - 122);
        context.lineTo(x + 4, groundY - 122);
        context.stroke();
        context.strokeStyle = '#c9b28f';
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(x, groundY - 122);
        context.lineTo(pose.x - cameraX, pose.y);
        context.stroke();
        context.translate(pose.x - cameraX, pose.y);
        context.rotate(pose.angle);
        this.drawSnowyLog(context, 0, 11, palette);
        context.restore();
      }
    }
  }

  private drawSnowyLog(context: CanvasRenderingContext2D, x: number, y: number, palette: Palette): void {
    context.save();
    context.translate(x, y);
    context.fillStyle = '#80634f';
    context.fillRect(-25, -22, 47, 21);
    context.strokeStyle = '#563f36';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(-23, -12);
    context.lineTo(18, -12);
    context.moveTo(-15, -5);
    context.lineTo(15, -5);
    context.stroke();
    context.fillStyle = '#c39a72';
    context.beginPath();
    context.ellipse(22, -11, 6, 11, 0, 0, TAU);
    context.fill();
    context.strokeStyle = '#89674d';
    context.lineWidth = 1;
    context.beginPath();
    context.ellipse(22, -11, 3, 6, 0, 0, TAU);
    context.stroke();
    context.strokeStyle = palette.snow;
    context.lineWidth = 5;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(-24, -23);
    context.quadraticCurveTo(-5, -26, 20, -23);
    context.stroke();
    context.restore();
  }

  private drawPower(context: CanvasRenderingContext2D, x: number, y: number, kind: PowerKind): void {
    const { color, icon } = POWERS[kind];
    context.save();
    context.fillStyle = '#142839';
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.shadowColor = color;
    context.shadowBlur = this.lighterGraphics ? 0 : 13;
    context.beginPath();
    context.arc(x, y, 14, 0, TAU);
    context.fill();
    context.stroke();
    context.shadowBlur = 0;
    context.fillStyle = color;
    context.font = 'bold 14px system-ui';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(icon, x, y);
    context.restore();
  }

  private drawBridge(context: CanvasRenderingContext2D, bridge: Obstacle, x: number): void {
    const width = bridge.width ?? 1;
    const deckY = (t: number) => this.bridgeDeck(bridge, bridge.x + width * t);
    const plankCount = Math.ceil(width / 9);
    context.save();
    context.lineCap = 'round';

    // Timber ends, suspension ropes and their vertical ties sit behind the deck.
    for (const end of [0, 1]) {
      const y = deckY(end);
      context.fillStyle = '#523b32';
      context.fillRect(x + width * end - 3, y - 30, 6, 39);
      context.fillStyle = '#edf5f7';
      context.fillRect(x + width * end - 4, y - 32, 8, 3);
    }

    const ropeY = (t: number) => deckY(t) - 29 + 14 * Math.sin(Math.PI * t);
    context.strokeStyle = '#d1aa76';
    context.lineWidth = 2.3;
    context.beginPath();
    context.moveTo(x, ropeY(0));
    for (let i = 1; i <= plankCount; i += 1) {
      const t = i / plankCount;
      context.lineTo(x + width * t, ropeY(t));
    }
    context.stroke();

    for (let i = 1; i < plankCount; i += 2) {
      const t = i / plankCount;
      const tieX = x + width * t;
      context.strokeStyle = '#a7845e';
      context.lineWidth = 1.2;
      context.beginPath();
      context.moveTo(tieX, ropeY(t));
      context.lineTo(tieX, deckY(t) + 5);
      context.stroke();
    }

    for (let i = 0; i < plankCount; i += 1) {
      const left = i / plankCount;
      const right = (i + 1) / plankCount;
      const leftY = deckY(left);
      const rightY = deckY(right);
      context.fillStyle = i % 2 ? '#a36d45' : '#bf8957';
      context.beginPath();
      context.moveTo(x + width * left, leftY);
      context.lineTo(x + width * right + 0.5, rightY);
      context.lineTo(x + width * right + 0.5, rightY + 8);
      context.lineTo(x + width * left, leftY + 8);
      context.closePath();
      context.fill();
      context.strokeStyle = '#ebc494';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x + width * left + 1, leftY + 1);
      context.lineTo(x + width * right - 1, rightY + 1);
      context.stroke();
    }

    for (const end of [0, 1]) {
      const lanternX = x + width * end;
      const y = deckY(end) - 22;
      context.fillStyle = '#ffe2a6';
      context.shadowColor = '#ffb866';
      context.shadowBlur = this.lighterGraphics ? 0 : 12;
      context.fillRect(lanternX - 3, y, 6, 8);
    }
    context.shadowBlur = 0;

    const flagColors = ['#d98468', '#f3cb87', '#87bdc5'];
    const wind = 0.45 + this.stormLevel() * 0.35 + Math.sin(this.clock * 1.7) * 0.2;
    for (let index = 0; index < flagColors.length; index += 1) {
      const t = (index + 1) / 4;
      const poleX = x + width * t;
      const y = deckY(t);
      const flagY = y - 48;
      const reach = 14 + wind * 13;
      const ripple = Math.sin(this.clock * (7 + 5 * wind) - index * 0.85) * (3 + wind * 4);

      context.fillStyle = '#74523e';
      context.fillRect(poleX - 1.5, flagY - 3, 3, 54);
      context.fillStyle = flagColors[index];
      context.beginPath();
      context.moveTo(poleX, flagY);
      context.bezierCurveTo(poleX + reach * 0.35, flagY - 4, poleX + reach * 0.65, flagY + ripple, poleX + reach, flagY + 4 + ripple);
      context.quadraticCurveTo(poleX + reach * 0.48, flagY + 9, poleX, flagY + 13);
      context.closePath();
      context.fill();
    }
    context.restore();
  }

  private drawRamp(context: CanvasRenderingContext2D, ramp: Obstacle, x: number): void {
    const startY = this.rampSurface(ramp, ramp.x);
    const endY = this.rampSurface(ramp, ramp.x + 100);
    context.save();
    context.lineCap = 'round';

    context.strokeStyle = '#58433a';
    context.lineWidth = 5;
    for (const offset of [42, 70, 96]) {
      context.beginPath();
      context.moveTo(x + offset, this.rampSurface(ramp, ramp.x + offset));
      context.lineTo(x + offset, this.terrainAt(ramp.x + offset));
      context.stroke();
    }

    context.lineWidth = 9;
    context.beginPath();
    context.moveTo(x, startY);
    context.lineTo(x + 100, endY);
    context.stroke();
    context.strokeStyle = '#bb8758';
    context.lineWidth = 5;
    context.stroke();

    const leftTop = startY - 85;
    const rightTop = endY - 85;
    context.strokeStyle = '#775840';
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(x + 7, startY);
    context.lineTo(x + 7, leftTop);
    context.moveTo(x + 96, endY);
    context.lineTo(x + 96, rightTop);
    context.stroke();

    const ropeY = (t: number) => lerp(leftTop, rightTop, t) + 48 * t * (1 - t);
    context.strokeStyle = '#dbc7a6';
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(x + 7, leftTop);
    context.quadraticCurveTo(x + 51.5, (leftTop + rightTop) / 2 + 24, x + 96, rightTop);
    context.stroke();

    const flagColors = ['#d66f58', '#eac27d', '#77a6a9'];
    for (let index = 0; index < 6; index += 1) {
      const t = 0.12 + index * 0.14;
      const flagX = x + 7 + 89 * t;
      const flutter = Math.sin(this.clock * 5 + index) * 3;
      context.fillStyle = flagColors[index % flagColors.length];
      context.beginPath();
      context.moveTo(flagX, ropeY(t));
      context.lineTo(flagX + 9, ropeY(t + 9 / 89));
      context.lineTo(flagX + 4 + flutter, ropeY(t) + 12);
      context.closePath();
      context.fill();
    }
    context.restore();
  }

  private drawRock(context: CanvasRenderingContext2D, x: number, groundY: number, palette: Palette): void {
    context.save();
    context.translate(x, groundY);
    context.fillStyle = 'rgba(30,55,72,0.14)';
    context.beginPath();
    context.ellipse(0, -1, 19, 4, 0, 0, TAU);
    context.fill();
    const stone = context.createLinearGradient(-8, -27, 10, 0);
    stone.addColorStop(0, colorMix(palette.snowShade, '#f3f6f5', 0.32));
    stone.addColorStop(1, '#728b9d');
    context.fillStyle = stone;
    context.beginPath();
    context.moveTo(-15, -3);
    context.lineTo(-12, -17);
    context.lineTo(-3, -25);
    context.lineTo(8, -21);
    context.lineTo(16, -9);
    context.lineTo(13, -2);
    context.quadraticCurveTo(0, 2, -15, -3);
    context.closePath();
    context.fill();
    context.strokeStyle = 'rgba(255,255,255,0.8)';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(-10, -17);
    context.lineTo(-3, -23);
    context.lineTo(3, -20);
    context.stroke();
    context.restore();
  }

  private drawPine(context: CanvasRenderingContext2D, x: number, groundY: number, palette: Palette): void {
    context.save();
    context.translate(x, groundY);
    context.fillStyle = 'rgba(24,48,67,0.14)';
    context.beginPath();
    context.ellipse(0, -1, 19, 4, 0, 0, TAU);
    context.fill();
    context.fillStyle = '#526d7c';
    context.fillRect(-2.2, -25, 4.4, 25);
    const tiers = [
      { y: -19, w: 24, h: 30 },
      { y: -38, w: 19, h: 28 },
      { y: -54, w: 14, h: 23 },
    ];
    for (const tier of tiers) {
      context.beginPath();
      context.moveTo(0, tier.y - tier.h);
      context.lineTo(tier.w, tier.y + 4);
      context.lineTo(-tier.w, tier.y + 4);
      context.closePath();
      context.fillStyle = '#315663';
      context.fill();
      context.beginPath();
      context.moveTo(0, tier.y - tier.h);
      context.lineTo(tier.w * 0.68, tier.y - 3);
      context.quadraticCurveTo(0, tier.y + 3, -tier.w * 0.7, tier.y - 2);
      context.closePath();
      context.fillStyle = colorMix(palette.snow, '#66889a', 0.42);
      context.fill();
    }
    context.restore();
  }

  /** Phase 9A — gnarled tree root: a low ground protrusion for controlled hops. */
  private drawRoot(context: CanvasRenderingContext2D, x: number, groundY: number, palette: Palette, variant: number): void {
    const half = 15 + variant * 10;
    const hump = 9 + (1 - variant) * 4;
    context.save();
    context.translate(x, groundY);
    context.fillStyle = 'rgba(30,55,72,0.14)';
    context.beginPath();
    context.ellipse(0, -1, half + 5, 4, 0, 0, TAU);
    context.fill();
    context.fillStyle = '#6b4f3d';
    context.beginPath();
    context.moveTo(-half, 1);
    context.bezierCurveTo(-half * 0.55, -hump * 2.1, -half * 0.15, -hump * 2.2, 0, -hump);
    context.bezierCurveTo(half * 0.4, -hump * 2.2, half * 0.75, -hump * 1.5, half, 1);
    context.closePath();
    context.fill();
    // Knobby ridges follow the crest so the shape reads as buried root, not rock.
    context.strokeStyle = '#8a6a50';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(-half * 0.5, -hump * 0.8);
    context.quadraticCurveTo(0, -hump * 1.5, half * 0.45, -hump * 0.75);
    context.stroke();
    context.strokeStyle = colorMix(palette.snow, '#93a7b5', 0.5);
    context.lineWidth = 1.6;
    context.beginPath();
    context.moveTo(-half * 0.42, -hump * 1.05);
    context.quadraticCurveTo(0, -hump * 1.85, half * 0.38, -hump * 1.0);
    context.stroke();
    context.restore();
  }

  /** Phase 9A — wooden fence section: a taller static jump with clean clearance. */
  private drawFence(context: CanvasRenderingContext2D, x: number, groundY: number, palette: Palette, variant: number): void {
    const rails = variant < 0.5 ? 2 : 3;
    const height = 44;
    const half = 20;
    context.save();
    context.translate(x, groundY);
    context.fillStyle = 'rgba(30,55,72,0.14)';
    context.beginPath();
    context.ellipse(0, -1, half + 7, 4, 0, 0, TAU);
    context.fill();
    // Rails first (behind the posts), slightly weathered wood.
    for (let index = 0; index < rails; index += 1) {
      const y = -height + 8 + index * ((height - 14) / Math.max(1, rails - 1));
      context.fillStyle = index % 2 === 0 ? '#8e7966' : '#9c8874';
      context.fillRect(-half, y - 3, half * 2, 5.5);
      context.fillStyle = 'rgba(255,255,255,0.22)';
      context.fillRect(-half, y - 3, half * 2, 1.4);
    }
    // Posts with snow caps in cold palettes.
    for (const side of [-half, half - 3]) {
      context.fillStyle = '#7c6753';
      context.fillRect(side, -height - 4, 5, height + 5);
      context.fillStyle = 'rgba(255,255,255,0.18)';
      context.fillRect(side, -height - 4, 1.6, height + 5);
      context.fillStyle = colorMix(palette.snow, '#aab8c6', 0.35);
      context.fillRect(side - 1, -height - 7, 7, 3.4);
    }
    context.restore();
  }

  /** Phase 9A — slippery ice patch: a sheen slab hugging the terrain surface. */
  private drawIcePatch(context: CanvasRenderingContext2D, object: Obstacle, cameraX: number): void {
    const width = object.width ?? 180;
    const startX = object.x - cameraX;
    if (startX + width < -60 || startX > this.width + 60) return;
    context.save();
    context.beginPath();
    context.moveTo(startX, this.terrainAt(object.x));
    for (let step = 24; step < width; step += 24) {
      context.lineTo(startX + step, this.terrainAt(object.x + step));
    }
    context.lineTo(startX + width, this.terrainAt(object.x + width));
    context.lineTo(startX + width, this.terrainAt(object.x + width) + 9);
    context.lineTo(startX, this.terrainAt(object.x) + 9);
    context.closePath();
    const sheen = context.createLinearGradient(startX, 0, startX + width, 0);
    sheen.addColorStop(0, 'rgba(191,230,245,0.18)');
    sheen.addColorStop(0.5, 'rgba(214,240,250,0.55)');
    sheen.addColorStop(1, 'rgba(191,230,245,0.18)');
    context.fillStyle = sheen;
    context.fill();
    context.strokeStyle = 'rgba(240,250,255,0.65)';
    context.lineWidth = 1.4;
    context.stroke();
    // Deterministic glints crawl along the patch so it reads as live ice.
    const phase = (object.phase ?? 0) + this.clock * 0.35;
    for (let index = 0; index < 3; index += 1) {
      const t = (phase + index * 0.33) % 1;
      const glintX = startX + t * width;
      context.strokeStyle = 'rgba(255,255,255,0.8)';
      context.lineWidth = 1.2;
      context.beginPath();
      context.moveTo(glintX - 5, this.terrainAt(object.x + t * width) - 3);
      context.lineTo(glintX + 4, this.terrainAt(object.x + t * width) - 8);
      context.stroke();
    }
    context.restore();
  }

  /** Phase 9A — hanging icicle with shake warning, fall and shatter phases. */
  private drawIcicle(context: CanvasRenderingContext2D, object: Obstacle, cameraX: number, run: RunState): void {
    const x = object.x - cameraX;
    const groundY = this.terrainAt(object.x);
    const pose = iciclePose(groundY, run.elapsed, object.phase ?? 0);
    context.save();
    if (pose.state === 'shattered') {
      const cycle = (((run.elapsed + (object.phase ?? 0)) % 4.2) + 4.2) % 4.2;
      const fade = clamp(1 - (cycle - 2.95) / 1.25, 0, 1);
      context.globalAlpha = fade;
      context.fillStyle = '#cfe6f2';
      for (const [offset, size] of [[-11, 4], [-2, 6], [9, 3.5]] as const) {
        context.beginPath();
        context.moveTo(x + offset - size, groundY - 1);
        context.lineTo(x + offset, groundY - 1 - size * 1.6);
        context.lineTo(x + offset + size, groundY - 1);
        context.closePath();
        context.fill();
      }
      context.restore();
      return;
    }
    const shake = pose.state === 'shaking' ? Math.sin(run.elapsed * 42) * 2.2 : 0;
    context.translate(x + shake, 0);
    // Frozen cornice the icicle hangs from.
    context.fillStyle = '#5d6b77';
    context.beginPath();
    context.moveTo(-24, pose.y - 34);
    context.lineTo(24, pose.y - 34);
    context.lineTo(15, pose.y - 25);
    context.lineTo(-16, pose.y - 25);
    context.closePath();
    context.fill();
    context.fillStyle = colorMix('#e8f2f8', '#ffffff', 0.4);
    context.fillRect(-24, pose.y - 36, 48, 3);
    // The icicle itself — bright tip, cool body.
    const body = context.createLinearGradient(0, pose.y - 26, 0, pose.y);
    body.addColorStop(0, '#a8cfe2');
    body.addColorStop(1, '#eef8fd');
    context.fillStyle = body;
    context.beginPath();
    context.moveTo(-7, pose.y - 26);
    context.lineTo(7, pose.y - 26);
    context.lineTo(0, pose.y);
    context.closePath();
    context.fill();
    context.strokeStyle = 'rgba(255,255,255,0.9)';
    context.lineWidth = 1.1;
    context.beginPath();
    context.moveTo(-2, pose.y - 24);
    context.lineTo(-0.5, pose.y - 5);
    context.stroke();
    // Warning drips telegraph the drop.
    if (pose.state === 'shaking') {
      context.fillStyle = 'rgba(214,240,250,0.85)';
      for (const [offset, drop] of [[-4, 3], [3, 7]] as const) {
        context.beginPath();
        context.arc(offset, pose.y + drop + Math.sin(run.elapsed * 20 + offset) * 1.5, 1.4, 0, TAU);
        context.fill();
      }
    }
    if (pose.state === 'falling') {
      context.strokeStyle = 'rgba(238,248,253,0.5)';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(0, pose.y - 30);
      context.lineTo(0, pose.y - 8);
      context.stroke();
    }
    context.restore();
  }

  /** Phase 9A — rolling snowball with terrain-following patrol and rolling marks. */
  private drawSnowball(context: CanvasRenderingContext2D, object: Obstacle, cameraX: number, run: RunState): void {
    const slope = (this.terrainAt(object.x + 40) - this.terrainAt(object.x - 40)) / 80;
    const pose = snowballPose(object.x, slope, run.elapsed, object.phase ?? 0);
    const radius = OBSTACLE_REGISTRY.snowball.collision!.radius;
    const ballX = pose.x - cameraX;
    const groundY = this.terrainAt(pose.x);
    const ballY = groundY - radius;
    context.save();
    // Deterministic motion ghosts trail the sweep direction.
    for (const [lag, alpha] of [[0.16, 0.16], [0.32, 0.08]] as const) {
      const ghost = snowballPose(object.x, slope, run.elapsed - lag, object.phase ?? 0);
      context.globalAlpha = alpha;
      context.fillStyle = '#dce9f2';
      context.beginPath();
      context.arc(ghost.x - cameraX, this.terrainAt(ghost.x) - radius, radius * 0.9, 0, TAU);
      context.fill();
    }
    context.globalAlpha = 1;
    // Contact shadow.
    context.fillStyle = 'rgba(30,55,72,0.18)';
    context.beginPath();
    context.ellipse(ballX, groundY + 1, radius * 0.95, 4, 0, 0, TAU);
    context.fill();
    // Ball body with a cool snow gradient.
    const ball = context.createRadialGradient(ballX - radius * 0.35, ballY - radius * 0.4, radius * 0.2, ballX, ballY, radius);
    ball.addColorStop(0, '#fdfeff');
    ball.addColorStop(1, '#c4d6e4');
    context.fillStyle = ball;
    context.beginPath();
    context.arc(ballX, ballY, radius, 0, TAU);
    context.fill();
    // Rolling marks rotate with the sweep so the motion reads as rolling.
    context.save();
    context.translate(ballX, ballY);
    context.rotate(pose.rotation);
    context.strokeStyle = 'rgba(140,168,190,0.55)';
    context.lineWidth = 1.6;
    for (const [dx, dy] of [[0, -radius * 0.55], [-radius * 0.5, radius * 0.3], [radius * 0.5, radius * 0.3]] as const) {
      context.beginPath();
      context.arc(dx, dy, radius * 0.22, 0, Math.PI * 1.2);
      context.stroke();
    }
    context.restore();
    // Snow spray kicks up along the ground contact when the ball moves fast.
    const speed = Math.abs(Math.cos(run.elapsed * 0.85 + (object.phase ?? 0)));
    if (speed > 0.55) {
      context.fillStyle = 'rgba(240,248,255,0.7)';
      const direction = Math.sign(Math.cos(run.elapsed * 0.85 + (object.phase ?? 0))) || 1;
      for (const [offset, lift] of [[radius * 0.8, 3], [radius * 1.25, 6]] as const) {
        context.beginPath();
        context.arc(ballX - direction * offset, groundY - lift, 1.6, 0, TAU);
        context.fill();
      }
    }
    context.restore();
  }

  /** Phase 9A — falling branch with leaf-drift warning cue (moonlit forests). */
  private drawBranch(context: CanvasRenderingContext2D, object: Obstacle, cameraX: number, run: RunState): void {
    const x = object.x - cameraX;
    const groundY = this.terrainAt(object.x);
    const pose = branchPose(groundY, run.elapsed, object.phase ?? 0);
    context.save();
    if (pose.state === 'landed') {
      const cycle = (((run.elapsed + (object.phase ?? 0)) % 5) + 5) % 5;
      context.globalAlpha = clamp(1 - (cycle - 3.9) / 1.1, 0, 1);
    }
    const shake = pose.state === 'shaking' ? Math.sin(run.elapsed * 34) * 1.8 : 0;
    context.translate(x + shake, pose.y);
    if (pose.state === 'hanging' || pose.state === 'shaking') {
      // Canopy silhouette the branch detaches from.
      context.fillStyle = 'rgba(38,56,47,0.9)';
      context.beginPath();
      context.ellipse(6, -26, 34, 13, 0.1, 0, TAU);
      context.fill();
      context.fillStyle = 'rgba(52,74,62,0.75)';
      context.beginPath();
      context.ellipse(-14, -20, 22, 9, -0.08, 0, TAU);
      context.fill();
    }
    context.rotate(pose.angle);
    // Woody limb.
    context.strokeStyle = '#6f5a44';
    context.lineWidth = 4.5;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(-26, 0);
    context.quadraticCurveTo(0, -3, 26, 1);
    context.stroke();
    // Twigs and leaf clumps.
    context.lineWidth = 2.2;
    context.beginPath();
    context.moveTo(-8, -1);
    context.lineTo(-14, -9);
    context.moveTo(10, 0);
    context.lineTo(16, -8);
    context.stroke();
    context.fillStyle = '#41584a';
    for (const [dx, dy, r] of [[-15, -11, 5.5], [2, -4, 6.5], [19, -10, 5]] as const) {
      context.beginPath();
      context.arc(dx, dy, r, 0, TAU);
      context.fill();
    }
    context.restore();
    // Warning cue: leaves drift loose from the canopy before the drop.
    if (pose.state === 'shaking') {
      context.save();
      context.fillStyle = 'rgba(112,138,116,0.85)';
      for (const [offset, lag] of [[-14, 0], [4, 0.4], [16, 0.8]] as const) {
        const drift = ((run.elapsed * 1.4 + lag) % 1);
        context.beginPath();
        context.ellipse(x + offset + Math.sin(run.elapsed * 3 + lag * 5) * 4,
          groundY - 96 + drift * 34, 3, 1.6, drift * 2, 0, TAU);
        context.fill();
      }
      context.restore();
    }
  }

  /** Phase 9A — bobbing platform bridging its gap with an underglow. */
  private drawMovingPlatform(context: CanvasRenderingContext2D, platform: Obstacle, x: number, run: RunState): void {
    const width = platform.width ?? 1;
    const bob = platformBob(run.elapsed, platform.phase ?? 0);
    const deckY = (t: number) => this.bridgeDeck(platform, platform.x + width * t) + bob;
    context.save();
    // Underglow marks the platform as the safe line over the gorge.
    const glow = context.createLinearGradient(0, deckY(0.5) + 6, 0, deckY(0.5) + 44);
    glow.addColorStop(0, 'rgba(111,227,255,0.30)');
    glow.addColorStop(1, 'rgba(111,227,255,0)');
    context.fillStyle = glow;
    context.fillRect(x - 4, deckY(0.5) + 6, width + 8, 40);
    // Stone slab deck.
    context.beginPath();
    context.moveTo(x, deckY(0));
    for (let t = 0.25; t <= 1; t += 0.25) context.lineTo(x + width * t, deckY(t));
    context.lineTo(x + width, deckY(1) + 9);
    for (let t = 0.75; t >= 0; t -= 0.25) context.lineTo(x + width * t, deckY(t) + 9);
    context.closePath();
    const slab = context.createLinearGradient(0, deckY(0), 0, deckY(0) + 9);
    slab.addColorStop(0, '#b7c4d1');
    slab.addColorStop(1, '#6f7f8f');
    context.fillStyle = slab;
    context.fill();
    context.strokeStyle = 'rgba(238,246,252,0.8)';
    context.lineWidth = 1.6;
    context.beginPath();
    context.moveTo(x, deckY(0));
    context.lineTo(x + width, deckY(1));
    context.stroke();
    // Side skirt + rune lights that pulse with the bob.
    context.fillStyle = '#55636f';
    context.fillRect(x + 4, deckY(0.5) + 9, width - 8, 4);
    const pulse = 0.5 + bob / 10;
    context.fillStyle = `rgba(111,227,255,${0.5 + pulse * 0.4})`;
    for (const t of [0.22, 0.5, 0.78]) {
      context.beginPath();
      context.arc(x + width * t, deckY(t) + 3.5, 1.8, 0, TAU);
      context.fill();
    }
    // End rails.
    context.strokeStyle = '#8d9aa8';
    context.lineWidth = 2.4;
    for (const end of [0, 1]) {
      context.beginPath();
      context.moveTo(x + width * end, deckY(end));
      context.lineTo(x + width * end, deckY(end) - 10);
      context.stroke();
    }
    context.restore();
  }

  /** Phase 9A — cliff and broken-bridge dressing over the standard gorge. */
  private drawGapVariant(context: CanvasRenderingContext2D, object: Obstacle, x: number): void {
    const width = object.width ?? 0;
    const leftY = this.terrainAt(object.x);
    const rightY = this.terrainAt(object.x + width);
    context.save();
    if (object.plan?.obstacleId === 'cliff') {
      // Sheer strata bands carve the gorge walls into a rock cliff face.
      context.strokeStyle = 'rgba(255,255,255,0.16)';
      context.lineWidth = 2;
      for (let index = 0; index < 3; index += 1) {
        const y = 10 + index * 13;
        context.beginPath();
        context.moveTo(x + 8, leftY + y);
        context.lineTo(x + 8 + 16 + index * 7, leftY + y - 3);
        context.moveTo(x + width - 8, rightY + y);
        context.lineTo(x + width - 8 - 14 - index * 6, rightY + y - 3);
        context.stroke();
      }
      // Hard rim highlights on both lips.
      context.strokeStyle = 'rgba(255,255,255,0.75)';
      context.lineWidth = 2.6;
      context.beginPath();
      context.moveTo(x - 14, leftY + 1);
      context.lineTo(x, leftY - 3);
      context.moveTo(x + width, rightY - 3);
      context.lineTo(x + width + 14, rightY + 1);
      context.stroke();
    } else if (object.plan?.obstacleId === 'broken-bridge') {
      // Frayed plank stubs on both lips — the bridge that used to be here.
      context.lineCap = 'butt';
      for (const [edge, edgeY, direction] of [[0, leftY, 1], [width, rightY, -1]] as const) {
        for (const [lift, reach] of [[-4, 26], [-12, 18]] as const) {
          context.fillStyle = '#8e7966';
          context.fillRect(x + edge + (direction === 1 ? 0 : -reach), edgeY + lift - 2.5, reach, 5);
          context.fillStyle = 'rgba(255,255,255,0.2)';
          context.fillRect(x + edge + (direction === 1 ? 0 : -reach), edgeY + lift - 2.5, reach, 1.3);
        }
        // Broken post stump with a frayed rope end.
        context.fillStyle = '#7c6753';
        context.fillRect(x + edge - 2.5 + direction * 8, edgeY - 22, 5, 22);
        context.strokeStyle = '#a7845e';
        context.lineWidth = 1.8;
        context.beginPath();
        context.moveTo(x + edge + direction * 8, edgeY - 18);
        context.quadraticCurveTo(x + edge + direction * 22, edgeY - 26, x + edge + direction * 30, edgeY - 14);
        context.stroke();
      }
    }
    context.restore();
  }

  private drawTrail(context: CanvasRenderingContext2D, run: RunState, cameraX: number, palette: Palette): void {
    if (run.trail.length < 2) return;
    context.save();
    context.lineCap = 'round';
    // Phase 7 — cosmetic trail colour overrides the palette glow (physics,
    // width and fade are untouched; purely visual).
    const groundColor = this.trail.color ?? palette.glow;
    for (let index = 1; index < run.trail.length; index += 1) {
      const previous = run.trail[index - 1];
      const current = run.trail[index];
      const alpha = clamp(1 - current.age / 0.48, 0, 1) * 0.36;
      if (alpha <= 0) continue;
      context.globalAlpha = alpha;
      context.strokeStyle = current.y < this.terrainAt(current.x) - 30 ? '#ffffff' : groundColor;
      context.lineWidth = 1 + alpha * 3;
      context.beginPath();
      context.moveTo(previous.x - cameraX, previous.y);
      context.lineTo(current.x - cameraX, current.y);
      context.stroke();
    }
    context.restore();
  }

  private drawParticles(context: CanvasRenderingContext2D, run: RunState, cameraX: number): void {
    for (const particle of run.particles) {
      const alpha = clamp(particle.life / particle.maxLife, 0, 1);
      context.globalAlpha = alpha;
      context.fillStyle = particle.color;
      context.beginPath();
      context.arc(particle.x - cameraX, particle.y, particle.size * (0.45 + alpha * 0.55), 0, TAU);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  private drawPopups(context: CanvasRenderingContext2D, run: RunState, cameraX: number): void {
    context.save();
    context.textAlign = 'center';
    context.font = '700 12px ui-sans-serif, system-ui, sans-serif';
    for (const popup of run.popups) {
      context.globalAlpha = clamp(popup.life / popup.maxLife, 0, 1);
      context.fillStyle = popup.color;
      context.shadowColor = 'rgba(20,37,51,0.5)';
      context.shadowBlur = this.lighterGraphics ? 0 : 8;
      context.fillText(popup.text, popup.x - cameraX, popup.y);
    }
    context.restore();
  }

  private drawRider(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    rotation: number,
    grounded: boolean,
    idle: boolean,
    distance: number,
    airTime: number,
  ): void {
    const run = idle ? null : this.run;
    const pulse = 0.25 + 0.75 * (1 - Math.cos(this.clock * Math.PI)) / 2;
    const magnet = run ? clamp((run.magnetUntil - run.elapsed) / 2, 0, 1) : 0;
    const double = run ? clamp((run.doubleUntil - run.elapsed) / 2, 0, 1) : 0;
    const shield = run?.shield ? 1 : 0;
    const protection = run ? clamp((run.invulnerableUntil - run.elapsed) / 1.5, 0, 1) : 0;
    const strength = Math.max(magnet, double, shield, protection) * pulse;
    context.save();
    context.translate(x, y);

    if (grounded) {
      context.fillStyle = 'rgba(26,48,65,0.18)';
      context.beginPath();
      context.ellipse(0, 7, 21, 2, 0, 0, TAU);
      context.fill();
    }

    context.rotate(rotation);
    context.translate(0, WHEEL_CONTACT_Y);
    context.scale(BIKE_SCALE, BIKE_SCALE);
    context.translate(0, -WHEEL_CONTACT_Y);
    context.lineCap = 'round';
    context.lineJoin = 'round';

    const wheelAngle = (distance / 6.5) % TAU;

    for (const axle of [REAR_AXLE, FRONT_AXLE]) {
      context.save();
      context.translate(axle, WHEEL_Y);
      context.rotate(wheelAngle);
      context.fillStyle = '#40566e';
      context.strokeStyle = '#17283f';
      context.lineWidth = 3;
      context.beginPath();
      context.arc(0, 0, WHEEL_RADIUS, 0, TAU);
      context.fill();
      context.stroke();

      context.strokeStyle = '#c6d7df';
      context.lineWidth = 1.8;
      context.beginPath();
      for (let spoke = 0; spoke < 3; spoke += 1) {
        const angle = spoke * TAU / 3;
        context.moveTo(0, 0);
        context.lineTo(Math.cos(angle) * 10, Math.sin(angle) * 10);
      }
      context.stroke();
      context.strokeStyle = '#f0c896';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(0, 0, 10, 0, 0.9);
      context.stroke();
      context.restore();
    }

    context.strokeStyle = this.bike.color;
    context.lineWidth = 3.5;
    context.beginPath();
    context.moveTo(REAR_AXLE, WHEEL_Y);
    context.lineTo(-8, -28);
    context.lineTo(17, -24);
    context.lineTo(1, -10);
    context.closePath();
    context.moveTo(-8, -28);
    context.lineTo(1, -10);
    context.moveTo(FRONT_AXLE, WHEEL_Y);
    context.lineTo(14, -33);
    context.lineTo(21, -34);
    context.stroke();

    if (strength > 0) this.drawRiderOutline(context, grounded, idle, airTime, strength);
    this.drawRiderBody(context, grounded, idle, airTime);
    context.restore();
  }

  private riderOutline?: {
    mask: HTMLCanvasElement;
    glow: HTMLCanvasElement;
    maskContext: CanvasRenderingContext2D;
    glowContext: CanvasRenderingContext2D;
  };

  private drawRiderOutline(context: CanvasRenderingContext2D, grounded: boolean, idle: boolean, airTime: number, strength: number): void {
    if (!this.riderOutline) {
      const mask = document.createElement('canvas');
      const glow = document.createElement('canvas');
      mask.width = glow.width = 192;
      mask.height = glow.height = 192;
      const maskContext = mask.getContext('2d');
      const glowContext = glow.getContext('2d');
      if (!maskContext || !glowContext) return;
      this.riderOutline = { mask, glow, maskContext, glowContext };
    }

    const { mask, glow, maskContext, glowContext } = this.riderOutline;
    maskContext.clearRect(0, 0, 192, 192);
    maskContext.save();
    maskContext.translate(96, 140);
    maskContext.lineCap = 'round';
    maskContext.lineJoin = 'round';
    this.drawRiderBody(maskContext, grounded, idle, airTime);
    maskContext.restore();

    glowContext.clearRect(0, 0, 192, 192);
    glowContext.save();
    // Cast just the combined body's shadow, then subtract every body pixel.
    glowContext.shadowColor = '#ffffff';
    glowContext.shadowBlur = 10;
    glowContext.shadowOffsetX = 192;
    glowContext.drawImage(mask, -192, 0);
    glowContext.drawImage(mask, -192, 0);
    // A tighter rim keeps the soft glow readable against bright snow.
    glowContext.shadowBlur = 3;
    glowContext.drawImage(mask, -192, 0);
    glowContext.drawImage(mask, -192, 0);
    glowContext.restore();
    glowContext.save();
    glowContext.globalCompositeOperation = 'destination-out';
    glowContext.drawImage(mask, 0, 0);
    glowContext.restore();

    context.save();
    context.globalAlpha *= strength * 0.9;
    context.drawImage(glow, -96, -140);
    context.restore();
  }

  private drawRiderBody(context: CanvasRenderingContext2D, grounded: boolean, idle: boolean, airTime: number): void {
    const tuckProgress = grounded ? 0 : clamp(airTime / 0.18, 0, 1);
    const tuck = 5 * tuckProgress * tuckProgress * (3 - 2 * tuckProgress);
    const shoulderX = 5 + tuck;
    const shoulderY = -43 + tuck;
    const flutter = Math.sin(this.clock * (idle ? 5 : 13)) * 4;
    const scarfEnd = idle ? -32 : -44;

    // Keep the scarf behind the rider so the silhouette reads through a flip.
    context.fillStyle = this.character.scarf;
    context.beginPath();
    context.moveTo(shoulderX, shoulderY - 2);
    context.bezierCurveTo(-13, shoulderY - 4, -25, shoulderY - 9, scarfEnd, shoulderY - 4 + flutter);
    context.lineTo(scarfEnd + 4, shoulderY + 3 + flutter);
    context.bezierCurveTo(-25, shoulderY - 2, -12, shoulderY + 5, shoulderX, shoulderY + 3);
    context.closePath();
    context.fill();

    context.strokeStyle = '#25344e';
    context.lineWidth = 6;
    context.beginPath();
    context.moveTo(-7, -27 + tuck);
    context.lineTo(8, -22);
    context.lineTo(1, -10);
    context.stroke();
    context.strokeStyle = '#17283f';
    context.lineWidth = 3.5;
    context.beginPath();
    context.moveTo(-2, -10);
    context.lineTo(5, -10);
    context.moveTo(-13, -28);
    context.lineTo(-4, -28);
    context.stroke();

    // The coat, cap, scarf and limbs form one body silhouette.
    context.fillStyle = this.character.coat;
    context.beginPath();
    context.moveTo(-11, -27 + tuck);
    context.quadraticCurveTo(-9, shoulderY + 3, shoulderX - 3, shoulderY - 2);
    context.quadraticCurveTo(shoulderX + 8, shoulderY - 4, shoulderX + 8, shoulderY + 5);
    context.lineTo(5, -27 + tuck);
    context.quadraticCurveTo(-3, -24 + tuck, -11, -27 + tuck);
    context.fill();
    context.strokeStyle = this.character.sleeve;
    context.lineWidth = 5;
    context.beginPath();
    context.moveTo(shoulderX + 2, shoulderY + 4);
    context.lineTo(13 + 4 * tuckProgress, shoulderY + 12);
    context.lineTo(21, -34);
    context.stroke();

    context.fillStyle = '#e8b58a';
    context.beginPath();
    context.ellipse(shoulderX + 6, shoulderY - 7, 7, 8, -0.2, 0, TAU);
    context.fill();
    context.fillStyle = this.character.cap;
    context.beginPath();
    context.moveTo(shoulderX - 3, shoulderY - 9);
    context.bezierCurveTo(shoulderX - 5, shoulderY - 24, shoulderX + 13, shoulderY - 24, shoulderX + 15, shoulderY - 11);
    context.closePath();
    context.fill();
    context.strokeStyle = '#54718d';
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(shoulderX - 3, shoulderY - 9);
    context.lineTo(shoulderX + 15, shoulderY - 11);
    context.stroke();
    context.fillStyle = '#f0c896';
    context.beginPath();
    context.arc(shoulderX + 4, shoulderY - 21, 3, 0, TAU);
    context.fill();

    context.strokeStyle = this.character.scarf;
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(shoulderX - 2, shoulderY - 2);
    context.quadraticCurveTo(shoulderX + 4, shoulderY + 2, shoulderX + 10, shoulderY - 1);
    context.stroke();
  }

}
