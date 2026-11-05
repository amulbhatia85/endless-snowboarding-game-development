export interface LifetimeStats {
  runs: number;
  bestScore: number;
  bestDistance: number;
  bestCoins: number;
  bestTricks: number;
}

export interface AchievementView extends LifetimeStats {
  id: string;
  title: string;
  description: string;
  current: number;
  target: number;
  progress: number;
  unlocked: boolean;
  unit: string;
}

const LIFETIME_KEY = 'afterglow-lifetime-v1';
const UNLOCKED_KEY = 'afterglow-achievements-v1';

const EMPTY: LifetimeStats = { runs: 0, bestScore: 0, bestDistance: 0, bestCoins: 0, bestTricks: 0 };

interface ScoreLike {
  score: number;
  distance: number;
  coins: number;
  tricks: number;
}

const DEFINITIONS: Array<{
  id: string;
  title: string;
  description: string;
  metric: keyof LifetimeStats;
  target: number;
  unit: string;
}> = [
  { id: 'first-line', title: 'First Line', description: 'Complete your first descent.', metric: 'runs', target: 1, unit: 'run' },
  { id: 'quiet-mile', title: 'Quiet Mile', description: 'Travel 1,000 m in a single run.', metric: 'bestDistance', target: 1000, unit: 'm' },
  { id: 'glowkeeper', title: 'Glowkeeper', description: 'Collect 25 glowstones in one run.', metric: 'bestCoins', target: 25, unit: 'stones' },
  { id: 'aerialist', title: 'Aerialist', description: 'Land 5 backflips in one run.', metric: 'bestTricks', target: 5, unit: 'flips' },
  { id: 'high-country', title: 'High Country', description: 'Reach a score of 5,000.', metric: 'bestScore', target: 5000, unit: 'pts' },
  { id: 'long-night', title: 'Long Night', description: 'Travel 5,000 m in a single run.', metric: 'bestDistance', target: 5000, unit: 'm' },
  { id: 'afterglow-master', title: 'Afterglow Master', description: 'Reach a score of 15,000.', metric: 'bestScore', target: 15000, unit: 'pts' },
];

function mergeStats(base: LifetimeStats, scores: ScoreLike[]): LifetimeStats {
  return scores.reduce<LifetimeStats>((stats, score) => ({
    runs: Math.max(stats.runs, scores.length),
    bestScore: Math.max(stats.bestScore, score.score),
    bestDistance: Math.max(stats.bestDistance, score.distance),
    bestCoins: Math.max(stats.bestCoins, score.coins),
    bestTricks: Math.max(stats.bestTricks, score.tricks),
  }), { ...base });
}

export function readLifetime(scores: ScoreLike[]): LifetimeStats {
  try {
    const raw = localStorage.getItem(LIFETIME_KEY);
    const parsed = raw ? { ...EMPTY, ...JSON.parse(raw) } as LifetimeStats : { ...EMPTY };
    return mergeStats(parsed, scores);
  } catch {
    return mergeStats({ ...EMPTY }, scores);
  }
}

export function recordLifetimeRun(result: ScoreLike, scores: ScoreLike[]): LifetimeStats {
  const current = readLifetime(scores);
  const next: LifetimeStats = {
    runs: current.runs + 1,
    bestScore: Math.max(current.bestScore, result.score),
    bestDistance: Math.max(current.bestDistance, result.distance),
    bestCoins: Math.max(current.bestCoins, result.coins),
    bestTricks: Math.max(current.bestTricks, result.tricks),
  };
  try {
    localStorage.setItem(LIFETIME_KEY, JSON.stringify(next));
  } catch {
    // Achievement progress is optional if storage is unavailable.
  }
  return next;
}

export function getAchievements(stats: LifetimeStats): AchievementView[] {
  return DEFINITIONS.map((definition) => {
    const current = Math.min(stats[definition.metric], definition.target);
    return {
      ...stats,
      id: definition.id,
      title: definition.title,
      description: definition.description,
      current,
      target: definition.target,
      progress: definition.target === 0 ? 1 : current / definition.target,
      unlocked: stats[definition.metric] >= definition.target,
      unit: definition.unit,
    };
  });
}

export function readUnlockedAchievements(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(UNLOCKED_KEY) ?? '[]') as string[];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function persistUnlockedAchievements(ids: string[]): void {
  try {
    localStorage.setItem(UNLOCKED_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    // Non-fatal.
  }
}
