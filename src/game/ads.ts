import { Capacitor } from '@capacitor/core';
import {
  AdMob,
  AdmobConsentStatus,
  InterstitialAdPluginEvents,
  RewardAdPluginEvents,
} from '@capacitor-community/admob';

export type AdPlatform = 'android' | 'ios';

interface AdUnitIds {
  readonly appId: string;
  readonly interstitialId: string;
  readonly rewardedId: string;
}

/**
 * Google's ad units are platform-specific: an Android unit will not serve on
 * iOS and vice versa. Anything that is not explicitly iOS — including the web
 * preview, where ads are never requested — resolves to Android, the platform
 * the app ships on first.
 */
export function resolveAdPlatform(platform?: string | null): AdPlatform {
  return platform === 'ios' ? 'ios' : 'android';
}

/**
 * Central AdMob configuration.
 *
 * Development intentionally uses Google's official per-platform test IDs, so
 * test mode stays enabled for device and TestFlight testing. Before a store
 * release, set testMode to false and replace every production placeholder in
 * this one file, plus the native application IDs: the AndroidManifest
 * `com.google.android.gms.ads.APPLICATION_ID` meta-data and the iOS
 * Info.plist `GADApplicationIdentifier`.
 */
export const ADMOB_CONFIG = {
  testMode: true,
  test: {
    android: {
      appId: 'ca-app-pub-3940256099942544~3347511713',
      interstitialId: 'ca-app-pub-3940256099942544/1033173712',
      rewardedId: 'ca-app-pub-3940256099942544/5224354917',
    },
    ios: {
      appId: 'ca-app-pub-3940256099942544~1458002511',
      interstitialId: 'ca-app-pub-3940256099942544/4411468910',
      rewardedId: 'ca-app-pub-3940256099942544/1712485313',
    },
  },
  production: {
    android: {
      appId: 'YOUR_PRODUCTION_APP_ID',
      interstitialId: 'YOUR_PRODUCTION_INTERSTITIAL_ID',
      rewardedId: 'YOUR_PRODUCTION_REWARDED_ID',
    },
    ios: {
      appId: 'YOUR_PRODUCTION_APP_ID_IOS',
      interstitialId: 'YOUR_PRODUCTION_INTERSTITIAL_ID_IOS',
      rewardedId: 'YOUR_PRODUCTION_REWARDED_ID_IOS',
    },
  },
  interstitialEveryRuns: 3,
  minimumFullScreenIntervalMs: 90_000,
} as const;

const COMPLETED_RUNS_KEY = 'afterglow-completed-runs-v1';
const LAST_FULLSCREEN_KEY = 'afterglow-last-fullscreen-ad-v1';

type AdLifecycle = 'opened' | 'closed';

interface RewardSession {
  resolve: (earned: boolean) => void;
  earned: boolean;
  settled: boolean;
}

interface InterstitialSession {
  resolve: (shown: boolean) => void;
  shown: boolean;
  settled: boolean;
}

function readNumber(key: string): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Ads remain optional when storage is unavailable.
  }
}

export class AdService {
  private initialized = false;
  private initializing: Promise<boolean> | null = null;
  private listenersReady = false;
  private canRequestAds = false;
  private rewardedReady = false;
  private interstitialReady = false;
  private rewardedLoading = false;
  private interstitialLoading = false;
  private rewardSession: RewardSession | null = null;
  private interstitialSession: InterstitialSession | null = null;
  private lastRewardAt = 0;
  private lifecycleHandler: ((state: AdLifecycle) => void) | null = null;

  get isNative(): boolean {
    return Capacitor.isNativePlatform();
  }

  get platform(): AdPlatform {
    return resolveAdPlatform(Capacitor.getPlatform());
  }

  get activeIds(): AdUnitIds {
    const ids = ADMOB_CONFIG.testMode ? ADMOB_CONFIG.test : ADMOB_CONFIG.production;
    return ids[this.platform];
  }

  get rewardedAvailable(): boolean {
    return this.isNative && this.canRequestAds && this.rewardedReady && !this.rewardSession;
  }

  get completedRuns(): number {
    return readNumber(COMPLETED_RUNS_KEY);
  }

  setLifecycleHandler(handler: ((state: AdLifecycle) => void) | null): void {
    this.lifecycleHandler = handler;
  }

  async initialize(): Promise<boolean> {
    if (!this.isNative) return false;
    if (this.initialized) return this.canRequestAds;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      try {
        await AdMob.initialize({ initializeForTesting: ADMOB_CONFIG.testMode });
        await this.registerListeners();

        let consent = await AdMob.requestConsentInfo();
        if (consent.isConsentFormAvailable && consent.status === AdmobConsentStatus.REQUIRED) {
          consent = await AdMob.showConsentForm();
        }
        this.canRequestAds = consent.canRequestAds;
        this.initialized = true;

        if (this.canRequestAds) {
          void this.prepareRewarded();
          void this.prepareInterstitial();
        }
        return this.canRequestAds;
      } catch {
        this.canRequestAds = false;
        this.initialized = false;
        return false;
      } finally {
        this.initializing = null;
      }
    })();

    return this.initializing;
  }

  private async registerListeners(): Promise<void> {
    if (this.listenersReady) return;
    this.listenersReady = true;

    await AdMob.addListener(RewardAdPluginEvents.Loaded, () => {
      this.rewardedReady = true;
      this.rewardedLoading = false;
    });
    await AdMob.addListener(RewardAdPluginEvents.FailedToLoad, () => {
      this.rewardedReady = false;
      this.rewardedLoading = false;
    });
    await AdMob.addListener(RewardAdPluginEvents.Showed, () => {
      this.markFullScreenShown();
      this.lifecycleHandler?.('opened');
    });
    await AdMob.addListener(RewardAdPluginEvents.Rewarded, () => {
      if (this.rewardSession) this.rewardSession.earned = true;
      this.lastRewardAt = Date.now();
    });
    await AdMob.addListener(RewardAdPluginEvents.Dismissed, () => {
      this.rewardedReady = false;
      this.settleReward(this.rewardSession?.earned ?? false);
      this.lifecycleHandler?.('closed');
      void this.prepareRewarded();
    });
    await AdMob.addListener(RewardAdPluginEvents.FailedToShow, () => {
      this.rewardedReady = false;
      this.settleReward(false);
      this.lifecycleHandler?.('closed');
    });

    await AdMob.addListener(InterstitialAdPluginEvents.Loaded, () => {
      this.interstitialReady = true;
      this.interstitialLoading = false;
    });
    await AdMob.addListener(InterstitialAdPluginEvents.FailedToLoad, () => {
      this.interstitialReady = false;
      this.interstitialLoading = false;
    });
    await AdMob.addListener(InterstitialAdPluginEvents.Showed, () => {
      if (this.interstitialSession) this.interstitialSession.shown = true;
      this.markFullScreenShown();
      this.lifecycleHandler?.('opened');
    });
    await AdMob.addListener(InterstitialAdPluginEvents.Dismissed, () => {
      this.interstitialReady = false;
      this.settleInterstitial(this.interstitialSession?.shown ?? false);
      this.lifecycleHandler?.('closed');
      void this.prepareInterstitial();
    });
    await AdMob.addListener(InterstitialAdPluginEvents.FailedToShow, () => {
      this.interstitialReady = false;
      this.settleInterstitial(false);
      this.lifecycleHandler?.('closed');
    });
  }

  async prepareRewarded(): Promise<boolean> {
    if (!this.isNative || !this.canRequestAds || this.rewardedReady || this.rewardedLoading) {
      return this.rewardedReady;
    }
    this.rewardedLoading = true;
    try {
      await AdMob.prepareRewardVideoAd({
        adId: this.activeIds.rewardedId,
        isTesting: ADMOB_CONFIG.testMode,
        immersiveMode: true,
      });
      this.rewardedReady = true;
      return true;
    } catch {
      this.rewardedReady = false;
      return false;
    } finally {
      this.rewardedLoading = false;
    }
  }

  async prepareInterstitial(): Promise<boolean> {
    if (!this.isNative || !this.canRequestAds || this.interstitialReady || this.interstitialLoading) {
      return this.interstitialReady;
    }
    this.interstitialLoading = true;
    try {
      await AdMob.prepareInterstitial({
        adId: this.activeIds.interstitialId,
        isTesting: ADMOB_CONFIG.testMode,
        immersiveMode: true,
      });
      this.interstitialReady = true;
      return true;
    } catch {
      this.interstitialReady = false;
      return false;
    } finally {
      this.interstitialLoading = false;
    }
  }

  /**
   * Resolves true only after the SDK reward event has been received and the
   * ad has been dismissed. Opening or merely closing the ad never revives.
   */
  async showRewarded(): Promise<boolean> {
    if (!this.rewardedAvailable || this.rewardSession) return false;

    const result = new Promise<boolean>((resolve) => {
      this.rewardSession = { resolve, earned: false, settled: false };
    });

    try {
      await AdMob.showRewardVideoAd();
    } catch {
      this.settleReward(false);
      this.lifecycleHandler?.('closed');
    }
    return result;
  }

  recordCompletedRun(): number {
    const next = this.completedRuns + 1;
    writeNumber(COMPLETED_RUNS_KEY, next);
    return next;
  }

  interstitialDue(): boolean {
    const runs = this.completedRuns;
    return runs > 0 && runs % ADMOB_CONFIG.interstitialEveryRuns === 0;
  }

  async showInterstitialIfDue(): Promise<boolean> {
    if (!this.isNative || !this.interstitialDue() || this.rewardSession || this.interstitialSession) return false;
    if (Date.now() - this.lastRewardAt < ADMOB_CONFIG.minimumFullScreenIntervalMs) return false;
    if (Date.now() - readNumber(LAST_FULLSCREEN_KEY) < ADMOB_CONFIG.minimumFullScreenIntervalMs) return false;

    if (!this.interstitialReady) {
      void this.prepareInterstitial();
      return false;
    }

    const result = new Promise<boolean>((resolve) => {
      this.interstitialSession = { resolve, shown: false, settled: false };
    });
    try {
      await AdMob.showInterstitial();
    } catch {
      this.settleInterstitial(false);
      this.lifecycleHandler?.('closed');
    }
    return result;
  }

  async showPrivacyOptions(): Promise<boolean> {
    if (!this.isNative) return false;
    try {
      await this.initialize();
      await AdMob.showPrivacyOptionsForm();
      return true;
    } catch {
      return false;
    }
  }

  private markFullScreenShown(): void {
    writeNumber(LAST_FULLSCREEN_KEY, Date.now());
  }

  private settleReward(earned: boolean): void {
    const session = this.rewardSession;
    if (!session || session.settled) return;
    session.settled = true;
    this.rewardSession = null;
    session.resolve(earned && session.earned);
  }

  private settleInterstitial(shown: boolean): void {
    const session = this.interstitialSession;
    if (!session || session.settled) return;
    session.settled = true;
    this.interstitialSession = null;
    session.resolve(shown && session.shown);
  }
}
