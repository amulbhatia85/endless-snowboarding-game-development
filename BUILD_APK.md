# Building the Afterglow APK

> **CI rebuilds this for you.** `.github/workflows/build-android.yml` builds
> the debug APK on a GitHub-hosted Linux runner whenever the game code or the
> Android project changes, verifies it bundles the current `dist/index.html`
> byte-for-byte, and commits it back to the branch as `Afterglow.apk` (also
> uploaded as a run artifact). The manual steps below remain valid for local
> builds.

Requirements: Node.js, JDK 21, Android Studio (includes the Android SDK).

```bash
npm install
npm run build          # build the web game into dist/
npx cap sync android   # copy dist/ into the Android project
```

Option A: Android Studio
```bash
npx cap open android
```
Then use **Build > Build Bundle(s) / APK(s) > Build APK(s)**.

Option B: Command line
```bash
cd android
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
```
The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

To publish on Google Play, build a signed release with
**Build > Generate Signed Bundle / APK** in Android Studio.

After changing the game code, run `npm run build && npx cap sync android` again.
