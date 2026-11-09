export interface BikeEntry {
  id: string;
  name: string;
  color: string;
  /** Stat auto-unlock: best single-run distance in metres. */
  meters?: number;
  /** Coin price for purchasable cosmetics. */
  cost?: number;
  /** Completed levels required before the purchase unlocks. */
  requiresLevels?: number;
}

export interface RiderEntry {
  id: string;
  name: string;
  coat: string;
  sleeve: string;
  scarf: string;
  cap: string;
  /** Stat auto-unlock: best single-run landed backflips. */
  flips?: number;
  cost?: number;
  requiresLevels?: number;
}

export interface TrailEntry {
  id: string;
  name: string;
  /** null = the environment's palette glow (the classic look). */
  color: string | null;
  cost?: number;
  requiresLevels?: number;
  requiresAchievement?: string;
}

export const BIKES: readonly BikeEntry[] = [
  { id: 'bike-amber', name: 'Amber', color: '#efae5d', meters: 0 },
  { id: 'bike-glacier', name: 'Glacier', color: '#77d8f0', meters: 250 },
  { id: 'bike-ember', name: 'Ember', color: '#ff7863', meters: 750 },
  { id: 'bike-midnight', name: 'Midnight', color: '#8f9fd4', cost: 400 },
  { id: 'bike-aurora', name: 'Aurora', color: '#a5f3d0', cost: 900, requiresLevels: 5 },
];

export const RIDERS: readonly RiderEntry[] = [
  { id: 'rider-scout', name: 'Scout', coat: '#ad4c49', sleeve: '#d57661', scarf: '#efae5d', cap: '#273b55', flips: 0 },
  { id: 'rider-piper', name: 'Piper', coat: '#246f66', sleeve: '#55ae91', scarf: '#f5d384', cap: '#55395d', flips: 1 },
  { id: 'rider-nova', name: 'Nova', coat: '#514588', sleeve: '#8d76ca', scarf: '#ff9eb7', cap: '#203349', flips: 3 },
  { id: 'rider-willow', name: 'Willow', coat: '#3f6d4f', sleeve: '#7fae7a', scarf: '#ead9a0', cap: '#2c3a33', cost: 250 },
  { id: 'rider-ash', name: 'Ash', coat: '#5a4a6e', sleeve: '#8d7ba6', scarf: '#d9c8ef', cap: '#2f2a3c', cost: 600, requiresLevels: 3 },
];

export const TRAILS: readonly TrailEntry[] = [
  { id: 'trail-classic', name: 'Classic', color: null },
  { id: 'trail-ember', name: 'Ember', color: '#ffb36b', cost: 250 },
  { id: 'trail-frost', name: 'Frost', color: '#a8e8ff', cost: 250 },
  { id: 'trail-gilded', name: 'Gilded', color: '#ffd76b', cost: 500, requiresAchievement: 'glowkeeper' },
];

export const MISSIONS = [
  { label: 'Ride 150 metres', metric: 'distance', target: 150 },
  { label: 'Collect 8 glowstones', metric: 'coins', target: 8 },
  { label: 'Land a backflip', metric: 'tricks', target: 1 },
] as const;
export const MISSION_BONUS = 500;

export type CosmeticEntry = BikeEntry | RiderEntry | TrailEntry;

/** Everything the unlock rules need to know about the player. */
export interface UnlockContext {
  bestDistance: number;
  bestTricks: number;
  completedLevels: number;
  owned: readonly string[];
  achievements: readonly string[];
}

function statTarget(entry: CosmeticEntry): { metric: 'bestDistance' | 'bestTricks'; target: number } | undefined {
  if ('meters' in entry && entry.meters !== undefined) return { metric: 'bestDistance', target: entry.meters };
  if ('flips' in entry && entry.flips !== undefined) return { metric: 'bestTricks', target: entry.flips };
  return undefined;
}

/** Unlocked = stat threshold met, free, or already purchased. */
export function isUnlocked(entry: CosmeticEntry, context: UnlockContext): boolean {
  const stat = statTarget(entry);
  if (stat) return stat.metric === 'bestDistance' ? context.bestDistance >= stat.target : context.bestTricks >= stat.target;
  if (entry.cost === undefined || entry.cost === 0) return true;
  return context.owned.includes(entry.id);
}

/** Purchase prerequisites (level completions, achievements) — price excluded. */
export function requirementsMet(entry: CosmeticEntry, context: UnlockContext): boolean {
  if (statTarget(entry)) return false; // stat unlocks are earned by riding, never bought
  if ('requiresLevels' in entry && entry.requiresLevels !== undefined && context.completedLevels < entry.requiresLevels) return false;
  if ('requiresAchievement' in entry && entry.requiresAchievement !== undefined
    && !context.achievements.includes(entry.requiresAchievement)) return false;
  return true;
}

const ACHIEVEMENT_TITLES: Record<string, string> = {
  'first-line': 'First Line',
  'quiet-mile': 'Quiet Mile',
  glowkeeper: 'Glowkeeper',
  aerialist: 'Aerialist',
  'high-country': 'High Country',
  'long-night': 'Long Night',
  'afterglow-master': 'Afterglow Master',
};

/** Human-readable unlock requirement, shown on locked cards. */
export function requirementText(entry: CosmeticEntry): string {
  const stat = statTarget(entry);
  if (stat?.metric === 'bestDistance' && stat.target > 0) return `${stat.target} m in one run`;
  if (stat?.metric === 'bestTricks' && stat.target > 0) return `${stat.target} flips in one run`;
  const parts: string[] = [];
  if ('requiresAchievement' in entry && entry.requiresAchievement !== undefined) {
    parts.push(`${ACHIEVEMENT_TITLES[entry.requiresAchievement] ?? 'Special'} achievement`);
  }
  if ('requiresLevels' in entry && entry.requiresLevels !== undefined) parts.push(`${entry.requiresLevels} levels completed`);
  if (entry.cost !== undefined && entry.cost > 0) parts.push(`${entry.cost} glowstones`);
  return parts.length ? parts.join(' · ') : 'Unlocked';
}

export function findCosmetic(id: string): CosmeticEntry | undefined {
  return [...BIKES, ...RIDERS, ...TRAILS].find((entry) => entry.id === id);
}

/**
 * Resolves the selected skins, falling back to the defaults whenever the
 * preference points at a locked item. Locked items can never be equipped.
 */
export function resolveSelections(
  preferences: { bike: string; rider: string; trail: string },
  context: UnlockContext,
): { bike: BikeEntry; rider: RiderEntry; trail: TrailEntry } {
  const bike = BIKES.find((item) => item.name === preferences.bike && isUnlocked(item, context)) ?? BIKES[0];
  const rider = RIDERS.find((item) => item.name === preferences.rider && isUnlocked(item, context)) ?? RIDERS[0];
  const trail = TRAILS.find((item) => item.name === preferences.trail && isUnlocked(item, context)) ?? TRAILS[0];
  return { bike, rider, trail };
}
