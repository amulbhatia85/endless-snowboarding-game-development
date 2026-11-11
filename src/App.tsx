import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { SnowGameEngine, type GameScreen, type GraphicsQuality, type HudSnapshot, type RunResult, type SoundEvent } from './game/engine';
import { EVENT_DEFINITIONS, type EventId } from './game/events';
import { AudioManager, type AudioSettings } from './game/audio';
import { AdService } from './game/ads';
import {
  BIKES, RIDERS, TRAILS, MISSION_BONUS,
  isUnlocked, requirementsMet, requirementText, resolveSelections,
  type CosmeticEntry, type UnlockContext,
} from './game/progression';
import {
  getAchievements,
  persistUnlockedAchievements,
  readLifetime,
  readUnlockedAchievements,
  recordLifetimeRun,
  type LifetimeStats,
} from './game/profile';

interface ScoreEntry {
  score: number;
  distance: number;
  coins: number;
  tricks: number;
  playedAt: string;
}

const IS_ANDROID = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const SCORE_KEY = 'afterglow-snow-scores-v1';
/** Phase 10D — release version shown in Settings (single source of truth). */
const APP_VERSION = '1.0.0';

const emptyHud: HudSnapshot = { score: 0, distance: 0, speedKmh: 0, coins: 0, combo: 0, elapsed: 0, powers: [] };

function readScores(): ScoreEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = window.localStorage.getItem(SCORE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value) as ScoreEntry[];
    return parsed
      .filter((entry) => Number.isFinite(entry.score) && Number.isFinite(entry.distance))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  } catch {
    return [];
  }
}

function formatNumber(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString('en-US');
}

type MenuView = 'home' | 'achievements' | 'leaderboard' | 'rewards' | 'settings' | 'how' | 'credits' | 'privacy';

interface PlayerPreferences {
  vibration: boolean;
  quality: GraphicsQuality;
  bike: string;
  rider: string;
  trail: string;
}

const PREFERENCES_KEY = 'afterglow-preferences-v1';

function readPreferences(): PlayerPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Partial<PlayerPreferences>;
    return {
      vibration: parsed.vibration !== false,
      bike: typeof parsed.bike === 'string' ? parsed.bike : BIKES[0].name,
      rider: typeof parsed.rider === 'string' ? parsed.rider : RIDERS[0].name,
      trail: typeof parsed.trail === 'string' ? parsed.trail : TRAILS[0].name,
      quality: parsed.quality === 'high' || parsed.quality === 'balanced' ? parsed.quality : 'auto',
    };
  } catch {
    return { vibration: true, quality: 'auto', bike: BIKES[0].name, rider: RIDERS[0].name, trail: TRAILS[0].name };
  }
}

function StudioMark({ compact = false }: { compact?: boolean }) {
  return (
    <svg className={compact ? 'studio-mark compact' : 'studio-mark'} viewBox="0 0 96 96" aria-hidden="true">
      <circle cx="48" cy="48" r="43" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
      <circle cx="48" cy="48" r="35" fill="none" stroke="currentColor" strokeWidth="0.8" opacity="0.28" />
      <path d="M18 67 39 35l9 13 7-10 23 29H18Z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="m31 67 12-17 7 9 5-7 11 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" opacity="0.78" />
      <path d="M39 35v10l5-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="66" cy="27" r="3" fill="currentColor" />
      <path d="M20 76h56" stroke="currentColor" strokeWidth="1" opacity="0.45" />
    </svg>
  );
}

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
      <path d="M4 30.5 16.1 12l5.1 7.2 4.2-6.1L36 30.5H4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m12.1 30.5 7.1-10.1 6 8.1 3.2-4.4 5.1 6.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.1 12v5.4l3.2-1.9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg viewBox="0 0 24 18" aria-hidden="true">
      <rect x="0.9" y="0.9" width="22.2" height="16.2" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9.6 5.4v7.2l6.3-3.6z" fill="currentColor" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 10h12m-5-5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PauseIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 5.5v9M13 5.5v9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m7.5 5.8 7 4.2-7 4.2V5.8Z" fill="currentColor" />
    </svg>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 7.5h3l4-3.2v11.4l-4-3.2h-3z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      {muted ? (
        <path d="m13.5 7.5 4 5m0-5-4 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : (
        <path d="M13.5 7.2a4 4 0 0 1 0 5.6M15.6 5.2a7 7 0 0 1 0 9.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      )}
    </svg>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

const MILESTONES = [500, 1000, 2500, 5000, 10000, 20000];

// Phase 5A audit tool: `?dev=1` reveals the developer level selector (levels
// 1–4, in-memory only — saved progression is never touched) and the engine's
// diagnostics overlay. Purely a testing aid; invisible in normal play.
// Phase 10D: developer URL parameters are only honoured in development
// builds — the production bundle ignores them entirely.
const DEV_MODE = import.meta.env.DEV
  && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('dev') === '1';
const DEV_LEVELS: { level: number; label: string }[] = [
  { level: 1, label: 'Green Hills' },
  { level: 2, label: 'Snowy Mountains' },
  { level: 3, label: 'Misty Mountains' },
  { level: 4, label: 'Moonlit Forest' },
];
// Phase 9B audit tools: pin the weather and freeze the day cycle so every
// condition can be previewed in each of the four environments.
const DEV_WEATHER: { id: string; label: string }[] = [
  { id: 'auto', label: 'Weather…' },
  { id: 'clear', label: 'Clear' },
  { id: 'snow', label: 'Snow' },
  { id: 'fog', label: 'Fog' },
  { id: 'wind', label: 'Wind' },
  { id: 'storm', label: 'Storm' },
];
const DEV_PHASES: { id: string; label: string }[] = [
  { id: 'auto', label: 'Time…' },
  { id: '0.06', label: 'Dawn' },
  { id: '0.4', label: 'Day' },
  { id: '0.66', label: 'Sunset' },
  { id: '0.9', label: 'Night' },
];
// Phase 9D audit tool: force/inspect special events (in-memory only).
const DEV_EVENTS: { id: string; label: string }[] = [
  { id: 'auto', label: 'Event…' },
  { id: 'none', label: 'No events' },
  ...EVENT_DEFINITIONS.map((definition) => ({ id: definition.id, label: definition.label })),
];
// Phase 9A audit tool: per-obstacle preview ids (validated placements only).
const DEV_OBSTACLES: { id: string; label: string }[] = [
  { id: 'rock', label: 'Rock' },
  { id: 'log', label: 'Log' },
  { id: 'tree', label: 'Tree' },
  { id: 'root', label: 'Root' },
  { id: 'fence', label: 'Fence' },
  { id: 'gap', label: 'Gap' },
  { id: 'cliff', label: 'Cliff' },
  { id: 'bridge', label: 'Rope bridge' },
  { id: 'broken-bridge', label: 'Broken bridge' },
  { id: 'moving-platform', label: 'Moving platform' },
  { id: 'ramp', label: 'Ramp' },
  { id: 'ice', label: 'Ice patch' },
  { id: 'icicle', label: 'Icicle' },
  { id: 'snowball', label: 'Snowball' },
  { id: 'swinging-log', label: 'Swinging log' },
  { id: 'branch', label: 'Falling branch' },
  { id: 'gorge', label: 'Deep valley gorge' },
  { id: 'ice-boulder', label: 'Giant ice boulder' },
];

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<SnowGameEngine | null>(null);
  const appActiveRef = useRef(true);
  const pendingReviveRef = useRef<SnowGameEngine | null>(null);
  const resumeRewardedRideRef = useRef<() => void>(() => {});
  const [audio] = useState(() => new AudioManager(IS_ANDROID));
  const [ads] = useState(() => new AdService());
  const [screen, setScreen] = useState<GameScreen>('menu');
  const [hud, setHud] = useState<HudSnapshot>(emptyHud);
  const [scores, setScores] = useState<ScoreEntry[]>(readScores);
  const [result, setResult] = useState<(RunResult & { newRecord: boolean }) | null>(null);
  const [crashResult, setCrashResult] = useState<RunResult | null>(null);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(() => ({ ...audio.settings }));
  const [preferences, setPreferences] = useState<PlayerPreferences>(readPreferences);
  const [lifetime, setLifetime] = useState<LifetimeStats>(() => readLifetime(readScores()));
  const [showSettings, setShowSettings] = useState(false);
  const [menuView, setMenuView] = useState<MenuView>('home');
  // Phase 7 — wallet mirror for the rewards UI (refreshed on surface changes).
  const [walletView, setWalletView] = useState(() => engineRef.current?.getWalletView()
    ?? { balance: 0, lifetimeEarned: 0, owned: [] as readonly string[], rewardedThrough: 0 });
  const [splashDone, setSplashDone] = useState(false);
  const [hasParkedRun, setHasParkedRun] = useState(false);
  const [obstaclePreview, setObstaclePreview] = useState('');
  const [weatherPreview, setWeatherPreview] = useState('auto');
  const [dayPreview, setDayPreview] = useState('auto');
  const [eventPreview, setEventPreview] = useState('auto');
  const [levelJump, setLevelJump] = useState('');
  const [levelInfoOpen, setLevelInfoOpen] = useState(false);
  const [rewardedReady, setRewardedReady] = useState(false);
  const [adBusy, setAdBusy] = useState(false);
  const [adNotice, setAdNotice] = useState('');
  const [floatingStat, setFloatingStat] = useState<{ id: number; label: string; value: string } | null>(null);
  const [toast, setToast] = useState<{ id: number; title: string; label: string } | null>(null);


  // Per-run tracking for mid-run achievements
  const runRef = useRef({ best: 0, recordAnnounced: false, milestone: 0, comboFive: false });
  const prevStatus = useRef<GameScreen>('menu');
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const menuViewRef = useRef(menuView);
  menuViewRef.current = menuView;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const splashDoneRef = useRef(splashDone);
  splashDoneRef.current = splashDone;
  const introPlayedRef = useRef(false);
  const resumingParkedRef = useRef(false);
  const lastHapticRef = useRef(0);
  const resultsActionRef = useRef<(action: 'restart' | 'menu') => Promise<void>>(async () => {});
  const backActionRef = useRef<() => void>(() => {});

  const vibrate = (kind: 'coin' | 'soft' | 'medium' | 'crash' | 'success') => {
    if (!preferencesRef.current.vibration) return;
    const now = Date.now();
    if (kind === 'coin' && now - lastHapticRef.current < 110) return;
    lastHapticRef.current = now;
    if (Capacitor.isNativePlatform()) {
      if (kind === 'crash') void Haptics.notification({ type: NotificationType.Warning }).catch(() => {});
      else if (kind === 'success') void Haptics.notification({ type: NotificationType.Success }).catch(() => {});
      else void Haptics.impact({ style: kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light }).catch(() => {});
    } else if (navigator.vibrate) {
      navigator.vibrate(kind === 'crash' ? [30, 40, 30] : kind === 'coin' ? 8 : 16);
    }
  };

  resumeRewardedRideRef.current = () => {
    const engine = pendingReviveRef.current;
    if (!engine || document.hidden || !appActiveRef.current) return;
    pendingReviveRef.current = null;
    if (engineRef.current !== engine || !engine.revive()) return;
    setCrashResult(null);
    setRewardedReady(false);
    vibrate('success');
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const showToast = (title: string, label: string) => {
      setToast({ id: Date.now(), title, label });
      audio.achievement();
    };

    const engine = new SnowGameEngine(canvas, {
      onStatus: (status) => {
        const previous = prevStatus.current;
        prevStatus.current = status;
        setScreen(status);
        if (status !== 'playing') setFloatingStat(null);
        if (status === 'playing' && previous === 'paused') audio.resumeGame();
        else if (status === 'playing' && previous === 'crashed') audio.reviveCue();
        else if (status === 'playing' && resumingParkedRef.current) {
          resumingParkedRef.current = false;
          audio.startMusicResume();
        } else if (status === 'playing') {
          runRef.current = { best: readScores()[0]?.score ?? 0, recordAnnounced: false, milestone: 0, comboFive: false };
          audio.startRun();
        } else if (status === 'paused') audio.pauseGame();
        else if (status === 'menu') audio.menuMusic();
      },
      onStat: (label, value) => setFloatingStat({ id: Date.now(), label, value }),
      onHud: (snapshot) => {
        setHud(snapshot);
        if (snapshot.level?.phase !== 'riding') setFloatingStat(null);
        const run = runRef.current;
        if (!run.recordAnnounced && run.best > 0 && snapshot.score > run.best) {
          run.recordAnnounced = true;
          setToast({ id: Date.now(), title: 'New personal best', label: 'BEYOND YOUR BEST LINE' });
          audio.highScore();
        }
        const next = MILESTONES[run.milestone];
        if (next && snapshot.distance >= next) {
          run.milestone += 1;
          showToast(`${next.toLocaleString('en-US')} meters`, 'DISTANCE MILESTONE');
        }
      },
      onSound: (event: SoundEvent) => {
        audio.handle(event);
        if (event.type === 'coin') vibrate('coin');
        else if (event.type === 'crash') vibrate('crash');
        else if (event.type === 'trick') vibrate('medium');
        else if (event.type === 'land' && event.force > 0.62) vibrate('soft');
        const run = runRef.current;
        if (event.type === 'trick') {
          if (event.combo >= 5 && !run.comboFive) {
            run.comboFive = true;
            window.setTimeout(() => showToast('Flow state', 'FIVE-TRICK COMBO'), 500);
          }
        }
      },
      onFrame: (state) => audio.update(state),
      onCrash: (runResult) => {
        setCrashResult(runResult);
        setResult(null);
        setAdNotice('');
        audio.crashCue();
        void ads.initialize()
          .then(() => ads.prepareRewarded())
          .then(() => setRewardedReady(ads.rewardedAvailable));
      },
      onGameOver: (runResult) => {
        const previous = readScores();
        const newRecord = runResult.score > (previous[0]?.score ?? 0);
        const entry: ScoreEntry = {
          score: runResult.score,
          distance: runResult.distance,
          coins: runResult.coins,
          tricks: runResult.tricks,
          playedAt: new Date().toISOString(),
        };
        const nextScores = [...previous, entry].sort((a, b) => b.score - a.score).slice(0, 5);
        try {
          window.localStorage.setItem(SCORE_KEY, JSON.stringify(nextScores));
        } catch {
          // The current run remains playable if storage is unavailable.
        }
        setScores(nextScores);
        setResult({ ...runResult, newRecord });
        setCrashResult(null);
        ads.recordCompletedRun();

        const previouslyUnlocked = readUnlockedAchievements();
        const nextLifetime = recordLifetimeRun(runResult, previous);
        const achievements = getAchievements(nextLifetime);
        persistUnlockedAchievements(achievements.filter((item) => item.unlocked).map((item) => item.id));
        setLifetime(nextLifetime);
        const newlyUnlocked = achievements.find((item) => item.unlocked && !previouslyUnlocked.includes(item.id));
        if (newlyUnlocked && previous.length > 0) {
          window.setTimeout(() => {
            setToast({ id: Date.now(), title: newlyUnlocked.title, label: 'ACHIEVEMENT UNLOCKED' });
            audio.achievement();
          }, 900);
        }
        if (newRecord && previous.length > 0 && !runRef.current.recordAnnounced) audio.recordCue();
        void ads.prepareInterstitial();
      },
    }, IS_ANDROID, import.meta.env.DEV);

    engineRef.current = engine;
    setHasParkedRun(engine.hasParkedRun);
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [audio, ads]);

  // Phase 10B — the level-completion cue now arrives as a 'complete' sound
  // event emitted by the engine the moment the rider settles inside the safe
  // house (see onSound → audio.handle), replacing the generic achievement
  // chime that used to fire here off the HUD phase.

  // Studio splash timing. The game world is already rendering behind it, so
  // this also acts as the asset warm-up window without blocking first paint.
  useEffect(() => {
    const id = window.setTimeout(() => setSplashDone(true), 4000);
    return () => window.clearTimeout(id);
  }, []);

  // Best-effort studio sting. Browsers may keep Web Audio suspended until the
  // first gesture; in that case the sting plays on that first interaction.
  useEffect(() => {
    const id = window.setTimeout(() => {
      audio.unlock();
      if (audio.ready && !introPlayedRef.current) {
        introPlayedRef.current = true;
        audio.studioIntro();
      }
    }, 420);
    return () => window.clearTimeout(id);
  }, [audio]);

  useEffect(() => {
    if (splashDone) audio.menuMusic();
  }, [audio, splashDone]);

  // Autoplay unlock on first gesture + tab visibility handling
  useEffect(() => {
    const unlock = () => {
      audio.unlock();
      if (!introPlayedRef.current && audio.ready) {
        introPlayedRef.current = true;
        audio.studioIntro();
      }
      if (splashDoneRef.current) void ads.initialize();
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (engineRef.current?.status === 'playing') engineRef.current.togglePause();
        audio.suspend();
      } else {
        audio.resumeContext();
        resumeRewardedRideRef.current();
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('touchstart', unlock, true);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      window.removeEventListener('touchstart', unlock, true);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [audio, ads]);

  // Native ads: initialize after the splash, preload quietly, and silence the
  // game while a full-screen ad is visible.
  useEffect(() => {
    ads.setLifecycleHandler((state) => {
      audio.setAdSuspended(state === 'opened');
    });
    if (splashDone) void ads.initialize();
    return () => ads.setLifecycleHandler(null);
  }, [ads, audio, splashDone]);

  useEffect(() => {
    engineRef.current?.setGraphicsQuality(preferences.quality);
  }, [preferences.quality]);

  useEffect(() => {
    // Phase 7 — resolve the equipped skins, falling back to the defaults when
    // the preference points at a locked item (locked cosmetics never equip).
    const engine = engineRef.current;
    if (!engine) return;
    const context: UnlockContext = engine.unlockContext();
    const { bike, rider, trail } = resolveSelections(preferences, {
      ...context,
      bestDistance: lifetime.bestDistance,
      bestTricks: lifetime.bestTricks,
      achievements: [
        ...context.achievements,
        ...getAchievements(lifetime).filter((achievement) => achievement.unlocked).map((achievement) => achievement.id),
      ],
    });
    engine.setRiderSetup(bike, rider, trail);
  }, [preferences, lifetime, walletView.owned]);

  // Android hardware back button + native foreground/background handling.
  useEffect(() => {
    let removed = false;
    let backHandle: { remove: () => Promise<void> } | undefined;
    let stateHandle: { remove: () => Promise<void> } | undefined;

    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('backButton', () => backActionRef.current())
        .then((handle) => { if (removed) void handle.remove(); else backHandle = handle; })
        .catch(() => {});
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        appActiveRef.current = isActive;
        if (!isActive) {
          if (engineRef.current?.status === 'playing') engineRef.current.togglePause();
          audio.suspend();
        } else {
          audio.resumeContext();
          resumeRewardedRideRef.current();
        }
      }).then((handle) => { if (removed) void handle.remove(); else stateHandle = handle; }).catch(() => {});
    }

    return () => {
      removed = true;
      void backHandle?.remove();
      void stateHandle?.remove();
    };
  }, [audio]);

  // Keep checking briefly for a rewarded ad while the revive offer is open.
  useEffect(() => {
    if (screen !== 'crashed' || rewardedReady) return;
    const id = window.setInterval(() => {
      void ads.prepareRewarded().then(() => setRewardedReady(ads.rewardedAvailable));
    }, 900);
    return () => window.clearInterval(id);
  }, [ads, screen, rewardedReady]);

  useEffect(() => {
    if (!floatingStat) return;
    const id = window.setTimeout(() => setFloatingStat(null), 2800);
    return () => window.clearTimeout(id);
  }, [floatingStat]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Credits roll — a slow, smooth upward scroll that pauses the moment the
  // player holds or scrolls manually, resuming after a quiet beat. Honors
  // reduced-motion (no auto-scroll; the viewport still scrolls by hand).
  useEffect(() => {
    if (menuView !== 'credits') return;
    const el = creditsRef.current;
    if (!el) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let held = false;
    let lastTouch = performance.now();
    let last = performance.now();
    // Fractional scrollTop assignments round to whole pixels (and below half a
    // pixel round to zero), so the roll keeps its own float position and only
    // writes whole-pixel steps — otherwise 26px/s never accumulates.
    let pos = el.scrollTop;
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const idle = now - lastTouch > 2200;
      const max = el.scrollHeight - el.clientHeight;
      if (!held && idle && el.scrollTop < max - 0.5) {
        pos = Math.min(max, Math.max(pos, el.scrollTop) + 26 * dt);
        const whole = Math.round(pos);
        if (whole > el.scrollTop) el.scrollTop = whole;
      } else {
        pos = el.scrollTop;
      }
      raf = requestAnimationFrame(step);
    };
    const mark = () => { lastTouch = performance.now(); };
    const hold = () => { held = true; mark(); };
    const release = () => { held = false; mark(); };
    el.addEventListener('pointerdown', hold);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('wheel', mark, { passive: true });
    el.addEventListener('touchmove', mark, { passive: true });
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointerdown', hold);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('pointercancel', release);
      el.removeEventListener('wheel', mark);
      el.removeEventListener('touchmove', mark);
    };
  }, [menuView]);

  // Attract-scene corridor: measure the open band the menu leaves in the
  // idle rider's column (30% of the width) — the largest gap between the
  // visible menu blocks — and hand it to the engine so the rider always
  // coasts where the UI leaves room, on every device and orientation.
  useEffect(() => {
    if (screen !== 'menu') return;
    const measure = () => {
      requestAnimationFrame(() => {
        const engine = engineRef.current;
        if (!engine) return;
        const columnLeft = window.innerWidth * 0.30 - 15;
        const columnRight = window.innerWidth * 0.30 + 15;
        const blockers: DOMRect[] = [];
        const push = (el: Element | null) => {
          if (!el) return;
          const rect = el.getBoundingClientRect();
          if (rect.width > 2 && rect.height > 2) blockers.push(rect);
        };
        push(document.querySelector('.topbar'));
        document.querySelectorAll('.intro-copy > *').forEach((el) => push(el));
        push(document.querySelector('.main-menu-nav'));
        push(document.querySelector('.menu-mini-row'));
        const hits = blockers
          .filter((rect) => rect.left < columnRight && rect.right > columnLeft)
          .sort((a, b) => a.top - b.top);
        let top = 0;
        let bottom = window.innerHeight;
        let best = -1;
        let previousBottom = 0;
        for (const rect of hits) {
          if (rect.top - previousBottom > best) {
            best = rect.top - previousBottom;
            top = previousBottom;
            bottom = rect.top;
          }
          previousBottom = Math.max(previousBottom, rect.bottom);
        }
        if (window.innerHeight - previousBottom > best) {
          top = previousBottom;
          bottom = window.innerHeight;
        }
        engine.setAttractBand(top, bottom);
      });
    };
    measure();
    const retry = window.setTimeout(measure, 700); // once fonts have settled
    window.addEventListener('resize', measure);
    return () => {
      window.clearTimeout(retry);
      window.removeEventListener('resize', measure);
    };
  }, [screen]);

  const creditsRef = useRef<HTMLDivElement>(null);
  const toggleMuteRef = useRef<() => void>(() => {});
  const toggleMute = () => {
    const muted = !audio.settings.muted;
    if (muted) {
      audio.toggleCue(false);
      audio.setMuted(true);
    } else {
      audio.setMuted(false);
      audio.toggleCue(true);
    }
    setAudioSettings({ ...audio.settings });
  };
  toggleMuteRef.current = toggleMute;

  const changeVolume = (bus: 'music' | 'sfx' | 'ambient', value: number) => {
    audio.setVolume(bus, value);
    setAudioSettings({ ...audio.settings });
    if (bus === 'sfx') audio.click();
  };

  const updatePreferences = (patch: Partial<PlayerPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
      } catch {
        // Preferences simply will not persist if storage is unavailable.
      }
      return next;
    });
  };

  // Phase 7 — keep the wallet mirror fresh whenever the player surfaces change.
  useEffect(() => {
    setWalletView(engineRef.current?.getWalletView()
      ?? { balance: 0, lifetimeEarned: 0, owned: [] as readonly string[], rewardedThrough: 0 });
  }, [screen, menuView, hud.level?.phase]);

  /** Phase 7 — buys a cosmetic through the engine (single writer for the wallet). */
  const buyCosmetic = (entry: CosmeticEntry): 'ok' | 'owned' | 'locked' | 'insufficient' | 'invalid' => {
    const engine = engineRef.current;
    if (!engine) return 'invalid';
    const outcome = engine.purchaseUnlockable(entry.id);
    if (outcome === 'ok') {
      setWalletView(engine.getWalletView());
      audio.achievement();
    } else {
      audio.click();
    }
    return outcome;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine) return;
      if ((event.target as HTMLElement)?.tagName === 'INPUT' && event.code !== 'Escape') return;

      if (event.code === 'KeyM') {
        toggleMuteRef.current();
        return;
      }

      if (event.code === 'Escape') {
        event.preventDefault();
        if (menuViewRef.current !== 'home') setMenuView('home');
        else engine.togglePause();
        return;
      }

      if (menuViewRef.current !== 'home' && engine.status === 'menu') return;

      const jumpKey = event.code === 'Space' || event.code === 'ArrowUp' || event.code === 'KeyW';
      if (jumpKey) {
        event.preventDefault();
        if (event.repeat) return;
        if (engine.status === 'gameover') {
          void resultsActionRef.current('restart');
        } else if (engine.status === 'menu') {
          setResult(null);
          engine.start();
        } else if (engine.status === 'paused') {
          engine.resume();
        } else {
          engine.press();
        }
      } else if (event.code === 'Enter' && engine.status === 'gameover') {
        event.preventDefault();
        void resultsActionRef.current('restart');
      } else if (event.code === 'Enter' && engine.status === 'menu') {
        event.preventDefault();
        setResult(null);
        engine.start();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.code === 'ArrowUp' || event.code === 'KeyW') {
        engineRef.current?.release();
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType !== 'touch') return;
      setShowSettings(false);
      if (engineRef.current?.status === 'playing') {
        event.preventDefault();
        engineRef.current.press();
      }
    };

    const handlePointerUp = () => engineRef.current?.release();

    canvas.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    // Phase 10C — long-press on touch devices must not raise the browser
    // context menu over the play surface (jump-and-hold is a core control).
    const handleContextMenu = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener('contextmenu', handleContextMenu);

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      canvas.removeEventListener('contextmenu', handleContextMenu);
    };
  }, []);

  const beginRun = () => {
    setResult(null);
    setCrashResult(null);
    setShowSettings(false);
    setMenuView('home');
    setHasParkedRun(false);
    engineRef.current?.start();
  };

  const jumpToLevel = (level: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    audio.click();
    setResult(null);
    setCrashResult(null);
    setShowSettings(false);
    setMenuView('home');
    setHasParkedRun(false);
    engine.startLevelPreview(level);
  };

  // Phase 6 dev tool: jump straight to the cinematic final approach.
  const finishLevelForTest = () => {
    const engine = engineRef.current;
    if (!engine) return;
    audio.click();
    engine.devFinishLevel();
  };

  // Phase 9A dev tool: preview a single obstacle type end to end. Generation
  // collapses to the chosen id but keeps running through the planner's full
  // validation pipeline; empty selection restores the normal mix.
  const previewObstacle = (id: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    audio.click();
    setObstaclePreview(id);
    setResult(null);
    setCrashResult(null);
    setShowSettings(false);
    setMenuView('home');
    setHasParkedRun(false);
    if (!engine.startObstaclePreview(id || null)) setObstaclePreview('');
  };

  // Phase 9B dev tools: pin the weather and freeze the time of day. Both are
  // purely cosmetic overrides — generation, physics and progression are
  // untouched, and 'auto' restores the live configuration.
  const previewWeather = (id: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    audio.click();
    setWeatherPreview(id);
    engine.setWeatherPreview(id as 'auto' | 'clear' | 'snow' | 'fog' | 'wind' | 'storm');
  };

  const previewDayPhase = (id: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    audio.click();
    setDayPreview(id);
    engine.setDayPhasePreview(id === 'auto' ? null : Number(id));
  };

  // Phase 9D dev tool: force the next special event, suspend all events, or
  // restore the deterministic schedule. In-memory only — generation seed,
  // saved progression and rewards are untouched.
  const previewEvent = (id: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    audio.click();
    setEventPreview(id);
    engine.setEventPreview(id as 'auto' | 'none' | EventId);
  };

  // Phase 9C dev tool: jump to any generated level number (in-memory preview —
  // saved progression is untouched), reproducing its exact deterministic
  // configuration.
  const jumpToAnyLevel = () => {
    const parsed = Number.parseInt(levelJump, 10);
    if (!Number.isInteger(parsed) || parsed < 1) return;
    jumpToLevel(parsed);
  };

  const togglePause = () => engineRef.current?.togglePause();

  const continueParkedRun = () => {
    const engine = engineRef.current;
    if (!engine?.hasParkedRun) return;
    audio.click();
    resumingParkedRef.current = true;
    setMenuView('home');
    setHasParkedRun(false);
    engine.resumeParkedRun();
  };

  const returnToMainMenu = (parkRun = false) => {
    audio.click();
    setResult(null);
    setCrashResult(null);
    setShowSettings(false);
    setMenuView('home');
    if (parkRun) {
      engineRef.current?.suspendToMenu();
      setHasParkedRun(!!engineRef.current?.hasParkedRun);
    } else {
      engineRef.current?.returnToMenu();
      setHasParkedRun(false);
    }
    audio.menuMusic();
  };

  const endRun = () => {
    audio.click();
    engineRef.current?.finalizeRun();
  };

  /**
   * Phase 8 — RESTART on the crash screen. The crashed run is finalized
   * exactly once first (coins banked, run recorded, achievements settled),
   * any due interstitial plays, then the current level restarts from its
   * beginning with a clean attempt. Completed levels, unlocks and the coin
   * balance are untouched by design.
   */
  const restartFromCrash = async () => {
    if (adBusy) return;
    audio.click();
    setAdBusy(true);
    try {
      engineRef.current?.finalizeRun();
      await ads.showInterstitialIfDue();
    } finally {
      audio.setAdSuspended(false);
      setAdBusy(false);
    }
    beginRun();
  };

  const watchRewardedRevive = async () => {
    const engine = engineRef.current;
    if (!engine?.reviveAvailable || adBusy || pendingReviveRef.current) return;
    if (!ads.rewardedAvailable) {
      setAdNotice('No rewarded ad is ready yet. You can end the run normally.');
      void ads.prepareRewarded().then(() => setRewardedReady(ads.rewardedAvailable));
      return;
    }

    setAdBusy(true);
    setAdNotice('');
    let earned = false;
    try {
      earned = await ads.showRewarded();
    } finally {
      audio.setAdSuspended(false);
      setRewardedReady(ads.rewardedAvailable);
      setAdBusy(false);
    }

    if (earned) {
      pendingReviveRef.current = engine;
      resumeRewardedRideRef.current();
    } else {
      setAdNotice('The reward was not completed, so the run was not revived.');
    }
  };

  resultsActionRef.current = async (action) => {
    if (adBusy) return;
    setAdBusy(true);
    try {
      await ads.showInterstitialIfDue();
    } finally {
      audio.setAdSuspended(false);
      setAdBusy(false);
    }
    if (action === 'restart') beginRun();
    else returnToMainMenu(false);
  };

  const achievements = getAchievements(lifetime);

  // Playtest fix — the completion card's fade animation must span exactly the
  // engine's celebration hold. They once drifted apart (a 3.1s CSS fade over a
  // longer hold made the card invisible while the phase still ran), so the
  // duration is now read from the engine's own level configuration.
  const completionHoldSeconds = engineRef.current?.levels.current.transitions.end.completionSeconds ?? 10;

  const scoreTable = (
    <div className="score-table-wrap">
      <table className="score-table">
        <thead>
          <tr><th>#</th><th>RIDE</th><th>DISTANCE</th><th>DATE</th></tr>
        </thead>
        <tbody>
          {scores.length > 0 ? scores.map((entry, index) => (
            <tr key={`${entry.playedAt}-${index}`} className={index === 0 && result?.newRecord ? 'record-row' : ''}>
              <td className="rank-cell">0{index + 1}</td>
              <td className="table-score">{formatNumber(entry.score)}</td>
              <td>{formatNumber(entry.distance)} m</td>
              <td>{formatDate(entry.playedAt)}</td>
            </tr>
          )) : (
            <tr><td colSpan={4} className="empty-table">Your first line is waiting.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const volumeControls = (
    <>
      <div className="sound-panel-head settings-audio-head">
        <span>AUDIO</span>
        <button className={`mute-toggle ${audioSettings.muted ? '' : 'on'}`} onClick={toggleMute} aria-pressed={!audioSettings.muted}>
          <span className="mute-knob" />
          <em>{audioSettings.muted ? 'MUTED' : 'ON'}</em>
        </button>
      </div>
      {([['music', 'Music'], ['sfx', 'Effects'], ['ambient', 'Ambience']] as const).map(([bus, label]) => (
        <label key={bus} className={`volume-row ${audioSettings.muted ? 'dim' : ''}`}>
          <span>{label}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={audioSettings[bus]}
            onChange={(e) => changeVolume(bus, Number(e.target.value))}
            style={{ ['--fill' as string]: `${audioSettings[bus] * 100}%` }}
          />
          <b>{Math.round(audioSettings[bus] * 100)}</b>
        </label>
      ))}
    </>
  );

  backActionRef.current = () => {
    if (menuViewRef.current !== 'home') {
      setMenuView('home');
      return;
    }
    if (showSettings) {
      setShowSettings(false);
      return;
    }
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.status === 'playing') engine.togglePause();
    else if (engine.status === 'paused') returnToMainMenu(true);
    else if (engine.status === 'crashed') engine.finalizeRun();
    else if (engine.status === 'gameover') void resultsActionRef.current('menu');
    else if (Capacitor.isNativePlatform()) void CapacitorApp.exitApp().catch(() => {});
  };

  return (
    <main className={`game-app screen-${screen}${IS_ANDROID ? ' android-app' : ''}`}>
      <canvas ref={canvasRef} className="game-canvas" aria-label="Afterglow endless snowboarding game" />
      <div className="scene-vignette" aria-hidden="true" />

      {DEV_MODE && (
        <div className="dev-level-bar" aria-label="Developer level selector (does not affect saved progress)">
          <span className="dev-level-tag">DEV</span>
          {DEV_LEVELS.map(({ level, label }) => (
            <button
              key={level}
              type="button"
              className={`dev-level-button${hud.level?.number === level ? ' active' : ''}`}
              onClick={() => jumpToLevel(level)}
            >
              <em>{level}</em> {label}
            </button>
          ))}
          <button type="button" className="dev-level-button dev-finish" onClick={finishLevelForTest}>
            ⏭ Finish level
          </button>
          <select
            className="dev-level-button dev-obstacle-select"
            aria-label="Developer obstacle preview (validated single-obstacle generation)"
            value={obstaclePreview}
            onChange={(event) => previewObstacle(event.target.value)}
          >
            <option value="">Obstacle mix…</option>
            {DEV_OBSTACLES.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
          <select
            className="dev-level-button dev-obstacle-select"
            aria-label="Developer weather preview (cosmetic override)"
            value={weatherPreview}
            onChange={(event) => previewWeather(event.target.value)}
          >
            {DEV_WEATHER.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
          <select
            className="dev-level-button dev-obstacle-select"
            aria-label="Developer time-of-day preview (freezes the day cycle)"
            value={dayPreview}
            onChange={(event) => previewDayPhase(event.target.value)}
          >
            {DEV_PHASES.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
          <select
            className="dev-level-button dev-obstacle-select"
            aria-label="Developer special-event preview (forces the next event window)"
            value={eventPreview}
            onChange={(event) => previewEvent(event.target.value)}
          >
            {DEV_EVENTS.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
          <input
            className="dev-level-button dev-level-number"
            aria-label="Developer level number (deterministic preview of any generated level)"
            placeholder="Level #"
            inputMode="numeric"
            value={levelJump}
            onChange={(event) => setLevelJump(event.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(event) => { if (event.key === 'Enter') jumpToAnyLevel(); }}
          />
          <button type="button" className="dev-level-button" onClick={jumpToAnyLevel}>
            ↪ Go
          </button>
          <button type="button" className="dev-level-button" onClick={() => setLevelInfoOpen((open) => !open)}>
            ℹ Level
          </button>
        </div>
      )}

      {DEV_MODE && levelInfoOpen && (
        <pre className="dev-level-info" aria-label="Generated level recipe (deterministic reproduction data)">
          {engineRef.current?.devLevelReport() ?? ''}
        </pre>
      )}

      {!splashDone && (
        <section className="studio-splash" aria-label="Shadows Game Studio" onClick={() => setSplashDone(true)}>
          <div className="splash-particles" aria-hidden="true">
            {Array.from({ length: 18 }, (_, index) => <span key={index} style={{ ['--i' as string]: index }} />)}
          </div>
          <div className="splash-logo-wrap">
            <div className="splash-wordmark">
              <span>SHADOWS</span>
              <strong>GAME STUDIO</strong>
            </div>
          </div>
          <span className="splash-skip">TAP TO CONTINUE</span>
        </section>
      )}

      <header className="topbar">
        <div className="brand-lockup" aria-label="Afterglow">
          <BrandMark />
          <div className="brand-type">
            <span className="brand-name">AFTERGLOW</span>
            <span className="brand-subtitle">SHADOWS GAME STUDIO</span>
          </div>
        </div>

        <div className="header-actions">
          {(screen === 'playing' || screen === 'paused') && (
            <button className="icon-button pause-button" onClick={() => { audio.click(); togglePause(); }} aria-label={screen === 'paused' ? 'Resume game' : 'Pause game'}>
              <PauseIcon playing={screen === 'playing'} />
            </button>
          )}
          <div className="sound-control">
            <button
              className={`icon-button ${audioSettings.muted ? 'is-muted' : ''}`}
              onClick={() => { audio.unlock(); audio.click(); setShowSettings((v) => !v); }}
              aria-label="Sound settings"
              aria-expanded={showSettings}
            >
              <SpeakerIcon muted={audioSettings.muted} />
            </button>
            {showSettings && (
              <div className="sound-panel" role="dialog" aria-label="Sound settings">
                {volumeControls}
                <button className="panel-link" onClick={() => { audio.click(); setShowSettings(false); setMenuView('settings'); }}>
                  Open full settings
                </button>
                <p className="sound-hint"><kbd>M</kbd> TOGGLE MUTE</p>
              </div>
            )}
          </div>
        </div>
      </header>

      {toast && (
        <div key={toast.id} className="achievement-toast" role="status">
          <span className="toast-star" aria-hidden="true">✦</span>
          <div>
            <span className="toast-label">{toast.label}</span>
            <strong>{toast.title}</strong>
          </div>
        </div>
      )}

      {(screen === 'playing' || screen === 'paused' || screen === 'crashed') && (!hud.level || hud.level.phase === 'riding') && (
        <section className="hud" aria-label="Run statistics" aria-live="polite">
          {hud.mission && (
            <div className="run-mission" aria-label="Run mission">
              <strong>{hud.mission.complete ? 'Mission complete' : hud.mission.label}</strong>
              <span>{hud.mission.complete ? `+${MISSION_BONUS}` : `${hud.mission.progress}/${hud.mission.target}`}</span>
            </div>
          )}
          {hud.combo > 1 && <span className="combo-indicator">COMBO x{hud.combo}</span>}
        </section>
      )}

      {screen === 'playing' && (!hud.level || hud.level.phase === 'riding') && (
        <div className="live-distance" aria-label="Distance traveled">
          <span>{hud.level ? `LEVEL ${hud.level.number} · DISTANCE` : 'DISTANCE'}</span>
          <span className="distance-value">{formatNumber(hud.distance)}<small> m</small></span>
        </div>
      )}

      {screen === 'playing' && hud.level && hud.level.phase !== 'riding' && (
        <div className="level-cinematic" aria-live="polite">
          {hud.level.phase === 'celebrating' && (
            <div
              key={hud.level.number}
              className="level-completion"
              style={{ animationDuration: `${completionHoldSeconds}s` }}
            >
              <span className="level-completion-rule" />
              <p>50,000 POINTS · A JOURNEY WELL RIDDEN</p>
              <h2>LEVEL {hud.level.number} COMPLETED</h2>
              <div className="level-completion-stats" aria-label="Run so far">
                <span><b>{formatNumber(hud.score)}</b> SCORE</span>
                <span><b>{formatNumber(hud.distance)}</b> METERS</span>
                <span><b>{formatNumber(hud.coins)}</b> GLOWSTONES</span>
              </div>
              {hud.level.reward && (
                <div className="level-rewards" aria-label="Glowstones earned this level">
                  <span className="reward-line">{hud.level.reward.collected} GLOWSTONES COLLECTED</span>
                  <span className="reward-line">COMPLETION +{hud.level.reward.completion}</span>
                  {hud.level.reward.cleanRun > 0 && <span className="reward-line">CLEAN RUN +{hud.level.reward.cleanRun}</span>}
                  {hud.level.reward.flips > 0 && <span className="reward-line">BACKFLIPS +{hud.level.reward.flips}</span>}
                  {hud.level.reward.milestone > 0 && <span className="reward-line">LEVEL MILESTONE +{hud.level.reward.milestone}</span>}
                  <span className="reward-line reward-total">TOTAL +{hud.level.reward.total}</span>
                </div>
              )}
              <span className="level-continue-hint">TAP TO CONTINUE</span>
              <span className="level-completion-rule" />
            </div>
          )}
          {hud.level.phase === 'exiting' && (
            <div className="level-introduction">
              <p>LEVEL {hud.level.number}</p>
              <h2>{hud.level.name}</h2>
              <span>A new trail · 50,000 points to earn</span>
            </div>
          )}
        </div>
      )}

      {screen === 'playing' && floatingStat && (!hud.level || hud.level.phase === 'riding') && (
        <div key={floatingStat.id} className="floating-stat" role="status">
          <span>{floatingStat.label}</span>
          <strong>{floatingStat.value}</strong>
        </div>
      )}

      {screen === 'menu' && menuView === 'home' && (
        <section className="intro-screen" aria-labelledby="game-title">
          <div className="intro-copy">
            <div className="eyebrow"><span className="eyebrow-dot" />THE MOUNTAIN IS YOURS</div>
            <h1 id="game-title">AFTERGLOW</h1>
            <p className="intro-description">FIND YOUR RHYTHM BETWEEN EARTH AND SKY.</p>
            <p className="control-copy">
              <span className="keycap">SPACE</span> OR TAP TO JUMP <i /> HOLD FOR ONE BACKFLIP
            </p>
            <div className="menu-studio-line">
              <StudioMark compact />
              <span>SHADOWS GAME STUDIO</span>
            </div>
          </div>

          <nav className="main-menu-nav" aria-label="Main menu">
            <button className="menu-button menu-play" onClick={() => { audio.click(); beginRun(); }}>
              <span><strong>Play</strong><small>Start a new descent</small></span><span className="button-arrow"><ArrowIcon /></span>
            </button>
            {hasParkedRun && (
              <button className="menu-button continue-button" onClick={() => { audio.click(); continueParkedRun(); }}>
                <span><strong>Continue</strong><small>Resume your parked run</small></span><span className="button-arrow"><ArrowIcon /></span>
              </button>
            )}
            <button className="menu-button" onClick={() => { audio.click(); setMenuView('achievements'); }}>
              <span><strong>Achievements</strong><small>{achievements.filter((item) => item.unlocked).length} of {achievements.length} unlocked</small></span><span className="button-arrow"><ArrowIcon /></span>
            </button>
            <button className="menu-button" onClick={() => { audio.click(); setMenuView('rewards'); }}>
              <span><strong>Rewards</strong><small><span className="menu-gem" aria-hidden="true">◆</span> {formatNumber(walletView.balance)} glowstones · riders, bikes & trails</small></span><span className="button-arrow"><ArrowIcon /></span>
            </button>
            <button className="menu-button" onClick={() => { audio.click(); setMenuView('leaderboard'); }}>
              <span><strong>Leaderboard</strong><small>Your best local rides</small></span><span className="button-arrow"><ArrowIcon /></span>
            </button>
            <button className="menu-button" onClick={() => { audio.click(); setMenuView('how'); }}>
              <span><strong>How to Play</strong><small>Controls, tricks and scoring</small></span><span className="button-arrow"><ArrowIcon /></span>
            </button>
            <div className="menu-mini-row">
              <button onClick={() => { audio.click(); setMenuView('settings'); }}>Settings</button>
              <span />
              <button onClick={() => { audio.click(); setMenuView('credits'); }}>Credits</button>
            </div>
          </nav>
        </section>
      )}

      {menuView !== 'home' && (screen === 'menu' || screen === 'paused') && (
        <section className="menu-page" aria-labelledby="menu-page-title">
          <button className="back-button" onClick={() => { audio.click(); setMenuView('home'); }} aria-label="Back">
            <span className="back-arrow">‹</span> Back
          </button>
          <div className="menu-page-card">

            {menuView === 'achievements' && (
              <>
                <div className="eyebrow"><span className="eyebrow-dot" />YOUR JOURNEY</div>
                <h2 id="menu-page-title">Achievements</h2>
                <p className="page-intro">Quiet milestones from the mountain.</p>
                <div className="achievement-list">
                  {achievements.map((item) => (
                    <article key={item.id} className={`achievement-card ${item.unlocked ? 'unlocked' : ''}`}>
                      <span className="achievement-medal">{item.unlocked ? '✦' : '·'}</span>
                      <div>
                        <strong>{item.title}</strong>
                        <p>{item.description}</p>
                        <div className="progress-track"><span style={{ width: `${Math.round(item.progress * 100)}%` }} /></div>
                      </div>
                      <b>{formatNumber(item.current)} / {formatNumber(item.target)} {item.unit}</b>
                    </article>
                  ))}
                </div>
              </>
            )}

            {menuView === 'leaderboard' && (
              <>
                <div className="eyebrow"><span className="eyebrow-dot" />LOCAL LEGENDS</div>
                <h2 id="menu-page-title">Leaderboard</h2>
                <p className="page-intro">Your five finest lines, saved on this device.</p>
                <div className="leaderboard page-leaderboard">
                  <div className="leaderboard-heading"><span>YOUR BEST RIDES</span><span>LOCAL / TOP 5</span></div>
                  {scoreTable}
                </div>
                <div className="lifetime-strip">
                  <span><b>{formatNumber(lifetime.runs)}</b> RUNS</span>
                  <span><b>{formatNumber(lifetime.bestDistance)}</b> BEST M</span>
                  <span><b>{formatNumber(lifetime.bestTricks)}</b> BEST FLIPS</span>
                </div>
              </>
            )}

            {menuView === 'rewards' && (
              <>
                <div className="eyebrow"><span className="eyebrow-dot" />EARN & EQUIP</div>
                <h2 id="menu-page-title">Rewards</h2>
                <p className="page-intro">Glowstones gathered on the trail fund riders, bicycles and trails.</p>
                <div className="wallet-balance" role="status" aria-label="Glowstone balance">
                  <span className="wallet-gem" aria-hidden="true">◆</span>
                  <strong>{formatNumber(walletView.balance)}</strong>
                  <small>GLOWSTONES</small>
                </div>
                {([
                  { title: 'Characters', hint: 'Ride farther and land flips — or spend glowstones', items: RIDERS as readonly CosmeticEntry[], selected: preferences.rider, apply: (name: string) => updatePreferences({ rider: name }) },
                  { title: 'Bicycles', hint: 'Cosmetic only — every frame rides the same', items: BIKES as readonly CosmeticEntry[], selected: preferences.bike, apply: (name: string) => updatePreferences({ bike: name }) },
                  { title: 'Trails', hint: 'A touch of colour behind the wheel', items: TRAILS as readonly CosmeticEntry[], selected: preferences.trail, apply: (name: string) => updatePreferences({ trail: name }) },
                ]).map((section) => {
                  const context: UnlockContext = {
                    bestDistance: lifetime.bestDistance,
                    bestTricks: lifetime.bestTricks,
                    completedLevels: engineRef.current?.levels.completedThrough ?? 0,
                    owned: walletView.owned,
                    achievements: getAchievements(lifetime).filter((achievement) => achievement.unlocked).map((achievement) => achievement.id),
                  };
                  return (
                    <section className="rewards-section" key={section.title} aria-label={section.title}>
                      <header>
                        <h3>{section.title}</h3>
                        <p>{section.hint}</p>
                      </header>
                      <div className="reward-grid">
                        {section.items.map((entry) => {
                          const unlocked = isUnlocked(entry, context);
                          const equipped = section.selected === entry.name && unlocked;
                          const purchasable = !unlocked && requirementsMet(entry, context);
                          return (
                            <article key={entry.id} className={`reward-card${equipped ? ' selected' : ''}${unlocked ? '' : ' locked'}`}>
                              <div className="reward-swatch" aria-hidden="true">
                                {'coat' in entry ? (
                                  <>
                                    <span style={{ background: entry.coat }} /><span style={{ background: entry.sleeve }} /><span style={{ background: entry.scarf }} /><span style={{ background: entry.cap }} />
                                  </>
                                ) : (
                                  <span style={{ background: entry.color ?? 'linear-gradient(120deg, #ffe9b8, #a8e8ff)', width: '100%' }} />
                                )}
                              </div>
                              <strong>{entry.name}</strong>
                              {equipped ? (
                                <span className="reward-state equipped">EQUIPPED</span>
                              ) : unlocked ? (
                                <button type="button" className="reward-action" onClick={() => { audio.click(); section.apply(entry.name); }}>
                                  Equip
                                </button>
                              ) : purchasable ? (
                                <button type="button" className="reward-action buy" onClick={() => buyCosmetic(entry)}>
                                  Buy · {entry.cost} ◆
                                </button>
                              ) : (
                                <span className="reward-state">{requirementText(entry)}</span>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </>
            )}

            {menuView === 'settings' && (
              <>
                <div className="eyebrow"><span className="eyebrow-dot" />MAKE IT YOURS</div>
                <h2 id="menu-page-title">Settings</h2>
                <p className="page-intro">Preferences are saved on this device.</p>
                <div className="settings-section">{volumeControls}</div>
                <div className="settings-section preference-rows">
                  <div className="preference-row">
                    <span><strong>Vibration</strong><small>Coins, landings and crashes</small></span>
                    <button className={`mute-toggle ${preferences.vibration ? 'on' : ''}`} onClick={() => { audio.click(); updatePreferences({ vibration: !preferences.vibration }); vibrate('soft'); }} aria-pressed={preferences.vibration}>
                      <span className="mute-knob" /><em>{preferences.vibration ? 'ON' : 'OFF'}</em>
                    </button>
                  </div>
                  <div className="preference-row quality-row">
                    <span><strong>Graphics quality</strong><small>Resolution and snowfall density</small></span>
                    <div className="segmented-control" role="group" aria-label="Graphics quality">
                      {(['auto', 'high', 'balanced'] as GraphicsQuality[]).map((quality) => (
                        <button key={quality} className={preferences.quality === quality ? 'active' : ''} onClick={() => { audio.click(); updatePreferences({ quality }); }}>
                          {quality === 'balanced' ? 'Saver' : quality}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="settings-section preference-rows">
                  <div className="preference-row">
                    <span><strong>Rider, bicycle & trail</strong><small>Equip what you've earned or purchased</small></span>
                    <button type="button" className="reward-link" onClick={() => { audio.click(); setMenuView('rewards'); }}>
                      {preferences.rider} · {preferences.bike} · {preferences.trail} <span>›</span>
                    </button>
                  </div>
                </div>
                <div className="settings-links">
                  <button onClick={() => { audio.click(); setMenuView('privacy'); }}>Privacy Policy <span>›</span></button>
                  <button onClick={() => { audio.click(); setMenuView('credits'); }}>Credits <span>›</span></button>
                  {ads.isNative && (
                    <button onClick={() => { audio.click(); void ads.showPrivacyOptions(); }}>Ad privacy choices <span>›</span></button>
                  )}
                </div>
                <p className="settings-version">Afterglow v{APP_VERSION} · Shadows Game Studio · Offline play supported</p>
              </>
            )}

            {menuView === 'how' && (
              <>
                <div className="eyebrow"><span className="eyebrow-dot" />RIDE WELL</div>
                <h2 id="menu-page-title">How to Play</h2>
                <p className="page-intro">One button. A whole mountain of timing.</p>
                <div className="how-grid">
                  <article><span>01</span><strong>Jump</strong><p>Tap the screen, click, or press Space while riding to leave the snow. Short taps hop; timing carries you over hazards.</p></article>
                  <article><span>02</span><strong>Hold for a backflip</strong><p>Press and hold to start one backflip. The rider levels out after a full rotation — release early for a half turn if the landing calls for it.</p></article>
                  <article><span>03</span><strong>Land clean</strong><p>Match the slope when you touch down. Landing at a bad angle ends the run — just like hitting an obstacle.</p></article>
                  <article><span>04</span><strong>Read the mountain</strong><p>Rocks, fallen logs, swinging logs and gaps line the trail. Jump the low ones, steer your flight past the rest.</p></article>
                  <article><span>05</span><strong>Glowstones & powers</strong><p>Golden glowstones build your score and wallet. Magnet pulls them in, Shield saves one crash, Double shines your points for a while.</p></article>
                  <article><span>06</span><strong>Ride to the safe house</strong><p>Each level asks for 50,000 points. Reach the target and a warm safe house completes the level — then a new trail begins.</p></article>
                </div>
                <div className="how-controls"><span className="keycap">TAP</span> Jump / hold to flip <i /> <span className="keycap">SPACE</span> Jump <i /> <span className="keycap">ESC</span> Pause <i /> <span className="keycap">M</span> Mute</div>
              </>
            )}

            {menuView === 'credits' && (
              <div className="credits-viewport" ref={creditsRef}>
                <div className="credits-page">
                  <StudioMark />
                  <div className="eyebrow centered"><span className="eyebrow-dot" />SHADOWS GAME STUDIO</div>
                  <h2 id="menu-page-title">Afterglow</h2>
                  <p className="page-intro">An original endless snowboarding journey.</p>
                  <dl className="credits-list">
                    <div><dt>Game design & development</dt><dd>Shadows Game Studio</dd></div>
                    <div><dt>Music & sound</dt><dd>Original generative score, performed live by the game</dd></div>
                    <div><dt>Art direction</dt><dd>Shadows Game Studio</dd></div>
                    <div><dt>Technology</dt><dd>Canvas, Web Audio, React and Capacitor</dd></div>
                  </dl>
                  <p className="credits-thanks">Thank you for riding with us.</p>
                </div>
              </div>
            )}

            {menuView === 'privacy' && (
              <>
                <div className="eyebrow"><span className="eyebrow-dot" />YOUR PRIVACY</div>
                <h2 id="menu-page-title">Privacy Policy</h2>
                <div className="privacy-copy">
                  <p><strong>Offline first.</strong> Afterglow can be played without an account or internet connection. Scores, achievements and preferences stay in local storage on your device.</p>
                  <p><strong>Advertising.</strong> The Android build uses Google AdMob with Google's official test IDs during development. AdMob and Google's User Messaging Platform may process device and consent information to request, personalize and measure ads, subject to your consent choices.</p>
                  <p><strong>Your choices.</strong> Use “Ad privacy choices” in Settings on Android when available, or your device advertising settings, to review or change ad personalization.</p>
                  <p><strong>Contact.</strong> Shadows Game Studio. Replace this prototype contact line with the studio's public support email before store release.</p>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {screen === 'playing' && hud.elapsed < 8 && (!hud.level || hud.level.phase === 'riding') && (
        <div className="play-hint" aria-hidden="true">
              TAP TO JUMP <span>/</span> HOLD FOR ONE BACKFLIP
        </div>
      )}

      {screen === 'crashed' && crashResult && (
        <section className="state-overlay crash-overlay" aria-labelledby="crash-title">
          <div className="state-content crash-content">
            <div className="eyebrow"><span className="eyebrow-dot" />THE MOUNTAIN PAUSES</div>
            <div className="crash-head">
              <div className="crash-copy">
                <h2 id="crash-title">Keep going?</h2>
                <p className="result-reason">{crashResult.reason}</p>
                {crashResult.level && (
                  <p className="crash-level">LEVEL {crashResult.level.number} · {crashResult.level.name.toUpperCase()}</p>
                )}
              </div>
              <div className="crash-stats">
                <span><b>{formatNumber(crashResult.score)}</b> SCORE</span>
                <span><b>{formatNumber(crashResult.distance)}</b> METERS</span>
                <span><b>{formatNumber(crashResult.coins)}</b> GLOWSTONES</span>
                <span><b>{formatNumber(crashResult.speedKmh)}</b> KM/H</span>
              </div>
            </div>
            {/* Playtest fix — redesigned crash card: gold video CTA on the
                left, Restart Level / End Run grouped right, one line; the ad
                note moves to a tiny footnote below the actions. */}
            <div className={rewardedReady ? 'crash-secondary' : 'crash-secondary no-revive'}>
              {rewardedReady && (
                <button className="revive-video" onClick={() => { audio.click(); watchRewardedRevive(); }} disabled={adBusy} aria-label="Watch a video to revive this run">
                  <VideoIcon />
                  <small>{adBusy ? 'OPENING…' : 'WATCH AD'}</small>
                </button>
              )}
              <div className="crash-secondary-group">
                <button className="end-run-button" onClick={() => { audio.click(); restartFromCrash(); }} disabled={adBusy}>Restart Level</button>
                <button className="end-run-button" onClick={() => { audio.click(); endRun(); }} disabled={adBusy}>End Run</button>
              </div>
            </div>
            {(adNotice || !rewardedReady) && (
              <p className="crash-footnote">
                {adNotice || (ads.isNative ? 'Preparing a rewarded ad...' : 'Rewarded ads are available in the Android app.')}
              </p>
            )}
          </div>
        </section>
      )}

      {screen === 'paused' && (
        <section className="state-overlay" aria-labelledby="pause-title">
          <div className="state-content pause-content">
            <div className="eyebrow"><span className="eyebrow-dot" />TAKE YOUR TIME</div>
            <h2 id="pause-title">Catch your breath.</h2>
            <p>The mountain will be right where you left it.</p>
            <div className="pause-actions">
              <button className="primary-button" onClick={() => { audio.click(); engineRef.current?.resume(); }}>
                <span>Resume Game</span><span className="button-arrow"><ArrowIcon /></span>
              </button>
              <div className="pause-secondary">
                <button className="text-button" onClick={() => { audio.click(); beginRun(); }}>Restart Run</button>
                <button className="text-button" onClick={() => { audio.click(); setMenuView('settings'); }}>Settings</button>
                <button className="text-button" onClick={() => { audio.click(); returnToMainMenu(true); }}>Main Menu</button>
              </div>
            </div>
            <span className="escape-note"><kbd>ESC</kbd> TO RESUME</span>
          </div>
        </section>
      )}

      {screen === 'gameover' && result && (
        <section className="state-overlay results-overlay" aria-labelledby="result-title">
          <div className="state-content results-content">
            <div className="eyebrow"><span className="eyebrow-dot" />THE END OF THIS LINE</div>
            <h2 id="result-title">Every run leaves a trace.</h2>
            <p className="result-reason">{result.reason}</p>
            {result.level && result.level.completed > 0 && (
              <p>{result.level.completed} {result.level.completed === 1 ? 'level' : 'levels'} completed</p>
            )}
            {result.mission && (
              <p>{result.mission.label} · {result.mission.complete
                ? `Completed (+${MISSION_BONUS} points)`
                : `${result.mission.progress}/${result.mission.target}`}</p>
            )}

            <div className="result-score-line">
              <div className="final-score">
                <span className="hud-label">FINAL SCORE</span>
                <strong>{formatNumber(result.score)}</strong>
                {result.newRecord && <em>NEW PERSONAL BEST</em>}
              </div>
              <div className="result-details">
                <span><b>{formatNumber(result.distance)}</b> METERS</span>
                <span><b>{formatNumber(result.coins)}</b> GLOWSTONES</span>
                <span><b>{formatNumber(result.tricks)}</b> FLIPS</span>
                <span><b>{formatNumber(result.speedKmh)}</b> KM/H</span>
              </div>
            </div>

            <div className="leaderboard">
              <div className="leaderboard-heading">
                <span>YOUR BEST RIDES</span>
                <span>LOCAL / TOP 5</span>
              </div>
              {scoreTable}
            </div>

            <div className="button-row result-actions">
              <button className="primary-button" onClick={() => { audio.click(); void resultsActionRef.current('restart'); }} disabled={adBusy}>
                <span>{adBusy ? 'Please wait...' : 'Ride again'}</span><span className="button-arrow"><ArrowIcon /></span>
              </button>
              <button className="text-button" onClick={() => { audio.click(); void resultsActionRef.current('menu'); }} disabled={adBusy}>Main Menu</button>
              <span className="instant-restart"><kbd>SPACE</kbd> INSTANT RESTART</span>
            </div>
          </div>
        </section>
      )}

      {screen === 'menu' && menuView === 'home' && (
        <div className="bottom-mark" aria-hidden="true">
          <span className="bottom-line" />
          A QUIETER KIND OF WILD
        </div>
      )}
    </main>
  );
}
