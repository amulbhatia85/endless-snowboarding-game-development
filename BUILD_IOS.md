# Building the Afterglow iOS App

The iOS project lives in `ios/` (Capacitor v8, Swift Package Manager — no
CocoaPods needed). It wraps the same web build as the Android app: the game
itself is the `dist/` bundle, copied into `ios/App/App/public/`.

> **This project was generated and synced on Linux.** Apple requires a Mac
> with Xcode to compile, sign and run iOS apps, so the actual build has not
> been executed or verified in this environment. Everything below is ready —
> the remaining steps are Mac-only.

## Already configured

| Setting | Value |
| --- | --- |
| Bundle identifier | `com.afterglow.snowboard` (same as Android) |
| App name | Afterglow |
| Orientation | Landscape left / right only (matches Android; iPad requires fullscreen) |
| Launch screen | Brand background `#102032` with the generated splash art |
| App icon + splash | Generated from `assets/icon.png` via `@capacitor/assets` |
| AdMob | Google's official **iOS test** App ID in `Info.plist` (`GADApplicationIdentifier`), `initializeForTesting: true` in `src/game/ads.ts`, ATT usage string present |
| Plugins | `@capacitor-community/admob`, `@capacitor/app`, `@capacitor/haptics` (SPM packages) |
| Deployment target | iOS 15.0 |
| Encryption export | `ITSAppUsesNonExemptEncryption = false` (App Store declaration) |

## Requirements

- A Mac with **Xcode 16.3+** (free Apple ID is enough for the Simulator and
  personal device builds; a paid Apple Developer membership is required for
  TestFlight / App Store)
- Node.js (to rebuild the web bundle)

## Build steps

```bash
npm install
npm run build          # build the web game into dist/
npx cap sync ios       # copy dist/ into the iOS project + update plugins
npx cap open ios       # opens App.xcodeproj in Xcode
```

First Xcode open resolves the SPM packages over the network (Capacitor +
the three plugins).

Option A: Xcode
1. Select the **App** scheme and an iPhone/iPad Simulator or your device.
2. Press **Cmd+R** to run.
3. For a store build: set your signing team under *Signing & Capabilities*,
   then **Product > Archive** and upload via Organizer.

Option B: command line

```bash
cd ios/App
xcodebuild -workspace App.xcodeproj -scheme App -sdk iphonesimulator build
# device/archive builds need a development team:
xcodebuild -project App.xcodeproj -scheme App -destination 'generic/platform=iOS' archive
```

After changing the game code, run `npm run build && npx cap sync ios` again.

## Before an App Store release

1. Replace the AdMob **test** ids:
   - `ios/App/App/Info.plist` → `GADApplicationIdentifier` (your iOS app id)
   - `src/game/ads.ts` → `ADMO_CONFIG.production` ad-unit ids, and set
     `testMode: false`
   - Add `SKAdNetworkItems` to `Info.plist` (Google's SKAdNetwork id
     `cskgmvz9sc.skadnetwork` plus your other networks).
2. Choose a release bundle-id signing team; the bundle id
   `com.afterglow.snowboard` must be registered to your Apple Developer
   account.
3. App Privacy / Data Safety forms in App Store Connect (ads + tracking).
4. If the game targets children, set the AdMob child-directed treatment and
   the Families policy forms.

## Notes

- Audio unlocks on the first tap (WebKit requires a user gesture) — verify
  sound on a real device at least once.
- The engine's lighter-graphics auto-degradation currently keys off the
  Android flag only; iOS devices run the full-quality web path. If low-end
  iPhones struggle, pass the same flag the Android shell uses.
