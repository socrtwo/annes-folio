#!/data/data/com.termux/files/usr/bin/bash
# Build the Anne's Folio Android APK on an Android device with Termux (https://termux.dev, the
# F-Droid or GitHub build; the Play Store build is outdated).
#
#   curl -fsSLO https://raw.githubusercontent.com/socrtwo/annes-folio/main/scripts/termux-build.sh
#   bash termux-build.sh            # first run installs everything (about 2.5 GB, 20-40 minutes)
#   bash termux-build.sh --web      # only the web build (dist/), no Android SDK needed
#
# Environment overrides: QL_DIR (checkout, default ~/QuillFolio), QL_BRANCH (default main),
# ANDROID_HOME (default ~/android-sdk), QL_HEAP (Gradle heap, default 1536m).
#
# Google's Android SDK has no ARM build of aapt2, so the build uses Termux's own aapt2 via
# android.aapt2FromMavenOverride. Needs a 64-bit ARM device with about 4 GB of RAM.
set -euo pipefail

QL_DIR="${QL_DIR:-$HOME/QuillFolio}"
QL_BRANCH="${QL_BRANCH:-main}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
QL_HEAP="${QL_HEAP:-1536m}"
CMDLINE_TOOLS_ZIP="commandlinetools-linux-13114758_latest.zip"
WEB_ONLY=0
[[ "${1:-}" == "--web" ]] && WEB_ONLY=1

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

say "Installing Termux packages"
pkg update -y
pkg install -y git nodejs-lts unzip wget zip
if [[ $WEB_ONLY == 0 ]]; then
  pkg install -y openjdk-21 aapt aapt2 || pkg install -y openjdk-21 aapt
fi

say "Getting the source ($QL_BRANCH)"
if [[ -d "$QL_DIR/.git" ]]; then
  git -C "$QL_DIR" fetch --depth 1 origin "$QL_BRANCH"
  git -C "$QL_DIR" checkout -q FETCH_HEAD
else
  git clone --depth 1 --branch "$QL_BRANCH" https://github.com/socrtwo/annes-folio "$QL_DIR"
fi
cd "$QL_DIR"

say "Installing JavaScript dependencies"
# The desktop (Electron) and browser-test packages are not needed here.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm ci --no-audit --no-fund

say "Building the web app"
npm run build
if [[ $WEB_ONLY == 1 ]]; then
  say "Done: web build in $QL_DIR/dist (serve it with: npx vite preview --host)"
  exit 0
fi

if [[ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]]; then
  say "Installing the Android SDK command-line tools"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  wget -q --show-progress -O "$TMPDIR/cmdline-tools.zip" "https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest" "$ANDROID_HOME/cmdline-tools/cmdline-tools"
  unzip -q "$TMPDIR/cmdline-tools.zip" -d "$ANDROID_HOME/cmdline-tools"
  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -f "$TMPDIR/cmdline-tools.zip"
fi
export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-$PREFIX/lib/jvm/java-21-openjdk}"

say "Installing SDK platform 36 and build tools"
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses > /dev/null || true
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" "platforms;android-36" "build-tools;36.0.0"

say "Preparing the Android project"
npx cap sync android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

say "Building the APK (Gradle downloads itself the first time)"
cd android
chmod +x gradlew
./gradlew --no-daemon \
  -Dorg.gradle.jvmargs="-Xmx$QL_HEAP -Dfile.encoding=UTF-8" \
  -Pandroid.aapt2FromMavenOverride="$PREFIX/bin/aapt2" \
  assembleRelease

VERSION=$(node -p "require('../package.json').version")
APK=$(ls app/build/outputs/apk/release/*.apk | head -n 1)
OUT="$QL_DIR/QuillFolio-$VERSION.apk"
cp "$APK" "$OUT"
if [[ -d "$HOME/storage/downloads" ]]; then
  cp "$OUT" "$HOME/storage/downloads/"
  say "Done: $OUT (also copied to Downloads). Open it with a file manager to install."
else
  say "Done: $OUT. Run termux-setup-storage once to let the script copy it to Downloads."
fi
