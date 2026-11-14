# Building Anne's Folio

All platforms share one web build (`npm run build` → `dist/`). Each platform wraps it:

| Platform | Wrapper | Command | Builds on |
|---|---|---|---|
| Web / PWA | none | `npm run build` | anything with Node 22 |
| Android | Capacitor + `QuillNativePlugin.java` | `npm run android:build` | Linux, macOS, Windows, or Android itself (Termux) |
| Windows, macOS, Linux, Raspberry Pi OS | Electron (`electron/`) | `npm run desktop:dist` | the target OS (macOS builds need a Mac) |
| iOS / iPadOS | Capacitor (`ios/`) | `npm run ios:sync`, then Xcode | macOS with Xcode |

**Releases:** run the **Release** workflow (Actions tab ▸ Release ▸ Run workflow) or push a tag `v<version>`. GitHub Actions builds every platform and publishes them as one release (`.github/workflows/release.yml`). A tag typed into a manual run must be `v<version in package.json>`, optionally with a `-suffix`, and must not exist yet. A tagged or manual release needs the Android release keystore secret ([ANDROID.md](ANDROID.md#signing)); without it the Android build fails and the release is published without the APK.

## Checks

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest unit tests
npm run build        # production web build
npm run e2e          # browser smoke test against the build (Playwright Chromium)
```

CI runs these four before building any platform: on every push in the Android workflow, and in the first job of the Release workflow, which every release job waits for. `npm test` also includes the tests of the desktop shell (`electron/main.cjs` against a stand-in for Electron) and of the workflow files.

## Prerequisites

- Node.js 22 or later (`node -v`; `package.json` declares it), then `npm ci` in the repository.
- Android: JDK 21 and the Android SDK (platform 36, build-tools 36.0.0).
- iOS: Xcode 16 or later.

## Web

```bash
npm ci
npm run build        # dist/ (first writes public/third-party-notices.txt and copies the pdf.js, OCR and ONNX Runtime files into public/)
npx vite preview     # http://localhost:4173
```

The copied files (`public/pdfjs/`, `public/tesseract/`, `public/ort/`) are git-ignored and come from `node_modules` (`scripts/copy-pdfjs.mjs`, which stops with an error when a source is missing). `public/ort/` holds ONNX Runtime for the on-device AI model, about 37 MB: the app loads no program code from a CDN, so this ships with every build.

## Desktop (Windows, macOS, Linux, Raspberry Pi OS)

```bash
npm run desktop        # build and run the desktop app
npm run desktop:dist   # build installers for this OS into release/
```

`desktop:dist` builds what the current OS can make:
- Windows: one NSIS installer per architecture (x64, arm64) and the portable `.exe`.
- macOS: a universal `.dmg` and `.zip`.
- Linux: an AppImage and a `.deb` for x64, arm64 and armv7l (Raspberry Pi OS 32-bit).

For one target only:

```bash
npm run build && node scripts/prepare-desktop.mjs
npx electron-builder --config electron-builder.config.cjs --linux deb --arm64
```

Before packaging, CI checks the staged app in `build/desktop-app/` with `node --check` on the Electron scripts.

The desktop app uses Electron 43, which runs on macOS 12 or later, Windows 10 or later, and Linux on x64, arm64 and 32-bit ARM (armv7l). Electron 44 no longer supports macOS 12 and publishes no 32-bit ARM (armv7l) builds, so moving to it means dropping the Raspberry Pi OS 32-bit package; Electron 43 itself is supported until January 2027. The packaged app has Electron's "run as Node" switches turned off (`electronFuses` in `electron-builder.config.cjs`).

## Android on a computer

```bash
npm run android:build    # build, cap sync, gradlew assembleRelease (also from the Windows command prompt)
```

The APK is in `android/app/build/outputs/apk/release/`. Without a release keystore it is signed with the debug key; [ANDROID.md](ANDROID.md) covers signing for Google Play.

## Android on the device (Termux)

You can build the APK on a 64-bit ARM phone or tablet with 4 GB of RAM or more, using [Termux](https://termux.dev) from F-Droid or GitHub (the Play Store version is outdated). The script installs Node.js, OpenJDK 21, the Android SDK command-line tools and Termux's ARM build of `aapt2`. It then clones the repository and builds the APK. The first run downloads about 2.5 GB and takes 20–40 minutes.

```bash
pkg install -y curl
termux-setup-storage        # optional: lets the script copy the APK to Downloads
curl -fsSLO https://raw.githubusercontent.com/socrtwo/annes-folio/main/scripts/termux-build.sh
bash termux-build.sh
```

Options (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `QL_BRANCH` | `main` | Branch to build |
| `QL_DIR` | `~/QuillFolio` | Checkout folder |
| `ANDROID_HOME` | `~/android-sdk` | SDK folder |
| `QL_HEAP` | `1536m` | Gradle heap; lower it (`1024m`) if the build is killed for memory |

`bash termux-build.sh --web` builds only the web app, without the SDK.

The manual steps the script performs, if you prefer to run them yourself:

```bash
pkg update -y && pkg install -y git nodejs-lts openjdk-21 aapt aapt2 unzip wget zip
git clone --depth 1 https://github.com/socrtwo/annes-folio ~/QuillFolio && cd ~/QuillFolio
ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npm run build
mkdir -p ~/android-sdk/cmdline-tools && cd ~/android-sdk/cmdline-tools
wget https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
unzip commandlinetools-linux-*_latest.zip && mv cmdline-tools latest && cd ~/QuillFolio
export ANDROID_HOME=~/android-sdk JAVA_HOME=$PREFIX/lib/jvm/java-21-openjdk
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-36" "build-tools;36.0.0"
npx cap sync android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cd android && ./gradlew --no-daemon -Dorg.gradle.jvmargs=-Xmx1536m \
  -Pandroid.aapt2FromMavenOverride=$PREFIX/bin/aapt2 assembleRelease
```

The APK is then in `android/app/build/outputs/apk/release/`.

Why the extra steps: Google's SDK ships `aapt2` only for x86-64 desktops, so the build uses Termux's ARM `aapt2` through `android.aapt2FromMavenOverride`. Electron and Playwright are skipped because they are for desktop builds and browser tests. If Gradle fails on an `aapt2` version mismatch after a Termux update, run `pkg upgrade aapt2` (or `pkg upgrade aapt`) and try again.

**Untested:** the Termux route has not been run on a physical device by the project; CI builds the APK on Linux. Please report problems in the issue tracker.

## iOS

```bash
npm run ios:sync                      # web build + copy into ios/App/App/public
open ios/App/App.xcodeproj            # in Xcode: Signing & Capabilities ▸ Team, then Run
```

CI builds an unsigned `.ipa` with:

```bash
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -sdk iphoneos \
  CODE_SIGNING_ALLOWED=NO build
```

## Icons

`npm run icons` regenerates every icon from the sources `resources/icon.svg`, `resources/icon-foreground.svg` and `resources/icon-background.txt` (the Anne's Office suite icon family): `scripts/gen-android-icons.mjs` writes the Android launcher icons, `resources/icon-square.svg` and `public/favicon.svg`, and `scripts/gen-platform-icons.mjs` the desktop, iOS and web-app PNGs. Rendering uses Playwright's Chromium.

## Command reference

`npm run catalog` regenerates [COMMANDS.md](COMMANDS.md) from the command registry.

## Spelling dictionary catalog

`node scripts/gen-dictionary-catalog.mjs` refreshes `src/proof/dictionary-catalog.json` from the npm registry. For each language it records the version, license, checksums, and the measured load time and memory.
