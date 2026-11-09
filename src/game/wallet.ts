import type { ProgressStorage } from './levelManager';

/**
 * Phase 7 — the glowstone wallet. A persistent coin balance kept strictly
 * separate from the 50 000-point level score, plus the configurable level
 * completion rewards and validated cosmetic purchases.
 *
 * Every mutating call is a single synchronous check-then-persist transaction:
 * grants are idempotent (keyed by level number), purchases can never drive
 * the balance negative, and a corrupt or missing save degrades to an empty
 * wallet without touching any other saved progress.
 */

export interface RewardConfiguration {
  /** Base glowstones for completing any level. */
  levelCompletion: number;
  /** Extra glowstones when the level attempt had no crashes. */
  cleanRunBonus: number;
  /** Glowstones per backflip landed during the level. */
  coinsPerFlip: number;
  /** Maximum flip reward per level (caps long trick chains). */
  flipRewardCap: number;
  /** Bonus glowstones for special level numbers. */
  milestones: Record<number, number>;
  /** Temporary ability tuning (durations in seconds, shield in uses). */
  abilities: { magnetSeconds: number; doubleSeconds: number; shieldUses: number };
}

export const REWARD_CONFIG: RewardConfiguration = {
  levelCompletion: 100,
  cleanRunBonus: 50,
  coinsPerFlip: 5,
  flipRewardCap: 25,
  milestones: { 5: 200, 10: 400, 25: 1000 },
  abilities: { magnetSeconds: 10, doubleSeconds: 12, shieldUses: 1 },
};

/** What the completion screen shows; also the grant ledger entry. */
export interface LevelRewardBreakdown {
  level: number;
  collected: number;
  completion: number;
  cleanRun: number;
  flips: number;
  milestone: number;
  total: number;
}

export type PurchaseOutcome = 'ok' | 'owned' | 'insufficient' | 'invalid';

export interface WalletSave {
  version: 1;
  coins: number;
  lifetimeEarned: number;
  /** Highest level number whose completion rewards have been claimed. */
  rewardedThrough: number;
  owned: readonly string[];
}

const WALLET_KEY = 'afterglow-wallet-v1';
const EMPTY: WalletSave = { version: 1, coins: 0, lifetimeEarned: 0, rewardedThrough: 0, owned: [] };

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function memoryStorage(): ProgressStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

function detectStorage(): ProgressStorage | undefined {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      return { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => { localStorage.setItem(key, value); } };
    }
  } catch {
    // Storage can be unavailable (private mode); the wallet simply won't persist.
  }
  return undefined;
}

function parseSave(raw: string | null): WalletSave {
  if (!raw) return { ...EMPTY, owned: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<WalletSave>;
    if (parsed.version !== 1 || !count(parsed.coins) || !count(parsed.lifetimeEarned)
      || !count(parsed.rewardedThrough) || !Array.isArray(parsed.owned)
      || parsed.lifetimeEarned < parsed.coins
      || !parsed.owned.every((id) => typeof id === 'string')) {
      return { ...EMPTY, owned: [] };
    }
    return {
      version: 1,
      coins: parsed.coins,
      lifetimeEarned: parsed.lifetimeEarned,
      rewardedThrough: parsed.rewardedThrough,
      owned: [...new Set(parsed.owned as string[])],
    };
  } catch {
    return { ...EMPTY, owned: [] };
  }
}

export class Wallet {
  private save: WalletSave;
  private storage?: ProgressStorage;
  storageAvailable = true;

  constructor(options: { storage?: ProgressStorage } = {}) {
    this.storage = options.storage ?? detectStorage();
    if (!this.storage) this.storageAvailable = false;
    this.save = parseSave(this.storage?.getItem(WALLET_KEY) ?? null);
  }

  get balance(): number { return this.save.coins; }
  get lifetimeEarned(): number { return this.save.lifetimeEarned; }
  get rewardedThrough(): number { return this.save.rewardedThrough; }
  get owned(): readonly string[] { return this.save.owned; }

  private persist(): void {
    try {
      this.storage?.setItem(WALLET_KEY, JSON.stringify(this.save));
    } catch {
      this.storageAvailable = false;
    }
  }

  /** Banks ordinary collected glowstones. Non-positive amounts are ignored. */
  deposit(amount: number): number {
    if (!count(amount) || amount === 0) return this.save.coins;
    this.save.coins += amount;
    this.save.lifetimeEarned += amount;
    this.persist();
    return this.save.coins;
  }

  /**
   * Grants the one-time completion rewards for a level. Returns null (and
   * changes nothing) when the level was already rewarded — replays only earn
   * ordinary collected glowstones, never repeated milestone rewards.
   */
  grantLevelRewards(request: {
    level: number;
    collected: number;
    cleanRun: boolean;
    flips: number;
  }): LevelRewardBreakdown | null {
    const { level } = request;
    if (!count(level) || level < 1 || level <= this.save.rewardedThrough) return null;
    const collected = count(request.collected) ? request.collected : 0;
    const flips = count(request.flips) ? request.flips : 0;
    const parts = {
      collected,
      completion: REWARD_CONFIG.levelCompletion,
      cleanRun: request.cleanRun ? REWARD_CONFIG.cleanRunBonus : 0,
      flips: Math.min(REWARD_CONFIG.coinsPerFlip * flips, REWARD_CONFIG.flipRewardCap),
      milestone: REWARD_CONFIG.milestones[level] ?? 0,
    };
    const breakdown: LevelRewardBreakdown = {
      level,
      ...parts,
      total: parts.collected + parts.completion + parts.cleanRun + parts.flips + parts.milestone,
    };
    this.save.coins += breakdown.total;
    this.save.lifetimeEarned += breakdown.total;
    this.save.rewardedThrough = level;
    this.persist();
    return breakdown;
  }

  /** Deducts the price and records ownership. The balance can never go negative. */
  purchase(id: string, cost: number): PurchaseOutcome {
    if (typeof id !== 'string' || id.length === 0 || !count(cost) || cost <= 0) return 'invalid';
    if (this.save.owned.includes(id)) return 'owned';
    if (this.save.coins < cost) return 'insufficient';
    this.save.coins -= cost;
    this.save.owned = [...this.save.owned, id];
    this.persist();
    return 'ok';
  }

  /** Developer sandboxes (`?dev=1`, `?level=N`): never touch the saved wallet. */
  enterPreview(): void {
    this.storage = memoryStorage();
    this.storageAvailable = true;
    this.save = { ...EMPTY, owned: [] };
  }
}
