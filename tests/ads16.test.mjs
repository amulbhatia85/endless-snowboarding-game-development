import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 16 — per-platform AdMob test configuration.
//
// Google's test ad units are NOT interchangeable between Android and iOS: an
// Android unit requested on iOS fails to load. Test mode stays enabled for
// device and TestFlight testing, but each platform must get its own official
// unit IDs.

const { ADMOB_CONFIG, resolveAdPlatform } = await import(moduleUrl('src/game/ads.ts'));

// Google's official demo/test units (developers.google.com/admob/{android,ios}/test-ads).
const ANDROID_TEST = {
  appId: 'ca-app-pub-3940256099942544~3347511713',
  interstitialId: 'ca-app-pub-3940256099942544/1033173712',
  rewardedId: 'ca-app-pub-3940256099942544/5224354917',
};

const IOS_TEST = {
  appId: 'ca-app-pub-3940256099942544~1458002511',
  interstitialId: 'ca-app-pub-3940256099942544/4411468910',
  rewardedId: 'ca-app-pub-3940256099942544/1712485313',
};

test('test ads stay enabled for device and TestFlight testing', () => {
  assert.equal(ADMOB_CONFIG.testMode, true);
});

test('each platform carries its own official test units', () => {
  assert.deepEqual(ADMOB_CONFIG.test.android, ANDROID_TEST);
  assert.deepEqual(ADMOB_CONFIG.test.ios, IOS_TEST);
});

test('Android and iOS never share an ad-unit id', () => {
  // The regression: a single flat id set shipped Android units to iOS.
  assert.notEqual(
    ADMOB_CONFIG.test.android.interstitialId,
    ADMOB_CONFIG.test.ios.interstitialId,
  );
  assert.notEqual(
    ADMOB_CONFIG.test.android.rewardedId,
    ADMOB_CONFIG.test.ios.rewardedId,
  );
  assert.notEqual(ADMOB_CONFIG.test.android.appId, ADMOB_CONFIG.test.ios.appId);
});

test('platform resolution maps native platforms and defaults to Android', () => {
  assert.equal(resolveAdPlatform('ios'), 'ios');
  assert.equal(resolveAdPlatform('android'), 'android');
  // Web preview never requests ads; it must still resolve to a real id set
  // rather than dereferencing undefined.
  assert.equal(resolveAdPlatform('web'), 'android');
  assert.equal(resolveAdPlatform(undefined), 'android');
  assert.equal(resolveAdPlatform(null), 'android');
});

test('every configured id set is complete and non-production', () => {
  for (const platform of ['android', 'ios']) {
    const ids = ADMOB_CONFIG.test[platform];
    for (const key of ['appId', 'interstitialId', 'rewardedId']) {
      assert.match(ids[key], /^ca-app-pub-3940256099942544[~/]\d+$/, `${platform}.${key}`);
      assert.ok(!ids[key].includes('YOUR_PRODUCTION'), `${platform}.${key} must not be a production placeholder`);
    }
  }
});

test('ad-unit ids stay distinct within a platform', () => {
  for (const platform of ['android', 'ios']) {
    const ids = ADMOB_CONFIG.test[platform];
    assert.notEqual(ids.interstitialId, ids.rewardedId, `${platform} units must differ`);
  }
});
