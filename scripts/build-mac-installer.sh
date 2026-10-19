#!/bin/bash
set -euo pipefail

NODE_VERSION=22.22.3
ARCH=darwin-arm64
APP_NAME="产品素材工作台"
SKIP_NPM_CI=0
ALLOW_ADHOC=0
MAC_SIGNING_IDENTITY="${CREATIVE_STUDIO_MAC_SIGNING_IDENTITY:--}"
MAC_NOTARY_PROFILE="${CREATIVE_STUDIO_MAC_NOTARY_PROFILE:-}"

for arg in "$@"; do
  case "$arg" in
    --skip-npm-ci) SKIP_NPM_CI=1 ;;
    --allow-adhoc) ALLOW_ADHOC=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
DIST_ROOT="dist/macos"
APP="$DIST_ROOT/$APP_NAME.app"
PAYLOAD="$APP/Contents/Resources/app"
STANDALONE_PAYLOAD="$PAYLOAD/.next/standalone"
ELECTRON_APP="$ROOT/node_modules/electron/dist/Electron.app"
CACHE_DIR=".cache/macos-installer"
NODE_NAME="node-v$NODE_VERSION-$ARCH"
NODE_TARBALL="$CACHE_DIR/$NODE_NAME.tar.gz"
NODE_EXTRACTED="$CACHE_DIR/$NODE_NAME"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/$NODE_NAME.tar.gz"
DMG_STAGE="$DIST_ROOT/dmg"
DMG_PATH="$DIST_ROOT/$APP_NAME-$VERSION.dmg"
DMG_RW_PATH="$DIST_ROOT/$APP_NAME-$VERSION.rw.dmg"

if [ "$ALLOW_ADHOC" -eq 0 ] && { [ "$MAC_SIGNING_IDENTITY" = "-" ] || [ -z "$MAC_NOTARY_PROFILE" ]; }; then
  echo "Release packaging requires a Developer ID signing identity and notarization keychain profile." >&2
  echo "Set CREATIVE_STUDIO_MAC_SIGNING_IDENTITY and CREATIVE_STUDIO_MAC_NOTARY_PROFILE, or pass --allow-adhoc for a local-only build." >&2
  exit 1
fi
if [ "$MAC_SIGNING_IDENTITY" = "-" ] && [ -n "$MAC_NOTARY_PROFILE" ]; then
  echo "CREATIVE_STUDIO_MAC_NOTARY_PROFILE requires a real Developer ID signing identity." >&2
  exit 1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    echo "Install Xcode Command Line Tools with: xcode-select --install" >&2
    exit 1
  fi
}

copy_dir_contents() {
  local source="$1"
  local dest="$2"
  if [ ! -d "$source" ]; then
    echo "Missing required directory: $source" >&2
    exit 1
  fi
  mkdir -p "$dest"
  cp -R "$source"/. "$dest"/
}

remove_payload_path() {
  local relative="$1"
  local target="$PAYLOAD/$relative"
  if [ ! -e "$target" ]; then
    return 0
  fi
  case "$(cd "$(dirname "$target")" 2>/dev/null && pwd -P)/$(basename "$target")" in
    "$(cd "$PAYLOAD" && pwd -P)"/*) rm -rf "$target" ;;
    *) echo "Refusing to prune outside installer payload: $target" >&2; exit 1 ;;
  esac
}

binary_has_arch() {
  local binary="$1"
  local expected_arch="$2"
  local arch
  for arch in $(lipo -archs "$binary" 2>/dev/null); do
    if [ "$arch" = "$expected_arch" ]; then
      return 0
    fi
  done
  return 1
}

echo "Preflight..."
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
HOST_PLATFORM="$(node -p "process.platform")"
HOST_ARCH="$(node -p "process.arch")"
if [ "$NODE_MAJOR" != "22" ]; then
  echo "Creative Studio macOS packaging requires Node 22.x on the build host." >&2
  echo "The bundled runtime is Node $NODE_VERSION; mismatched native module ABI can crash better-sqlite3 or sharp." >&2
  exit 1
fi
if [ "$HOST_PLATFORM" != "darwin" ]; then
  echo "Creative Studio macOS packaging must run on macOS; detected $HOST_PLATFORM." >&2
  exit 1
fi
if [ "$HOST_ARCH" != "arm64" ]; then
  echo "Creative Studio macOS packaging requires an arm64 Node build host; detected $HOST_ARCH." >&2
  echo "Do not package under Rosetta because native modules would not match the bundled arm64 runtime." >&2
  exit 1
fi

for command in iconutil codesign hdiutil sips curl tar npm node lipo osascript SetFile; do
  require_command "$command"
done

if [ "$SKIP_NPM_CI" -eq 1 ]; then
  echo "Skipping npm ci because --skip-npm-ci was provided."
else
  echo "Installing npm dependencies..."
  npm ci
  if [ ! -d "$ELECTRON_APP" ]; then
    echo "Electron runtime was not installed by npm ci; running Electron installer..."
    if ! node "$ROOT/node_modules/electron/install.js"; then
      echo "Electron runtime installer failed." >&2
      exit 1
    fi
  fi
fi

if [ ! -d "$ELECTRON_APP" ]; then
  echo "Missing Electron runtime: $ELECTRON_APP" >&2
  echo "Run npm ci and the Electron installer before building the macOS installer." >&2
  exit 1
fi

rm -rf .next/dev

echo "Building Next.js standalone app..."
npm run build

echo "Building Electron main/preload payload..."
npm run build:desktop

echo "Refreshing app icons..."
npm run icons

mkdir -p "$CACHE_DIR" "$DIST_ROOT"
if [ ! -f "$NODE_TARBALL" ]; then
  echo "Downloading private Node.js runtime: $NODE_URL"
  curl -fL "$NODE_URL" -o "$NODE_TARBALL"
fi

if [ ! -d "$NODE_EXTRACTED" ]; then
  echo "Extracting Node.js runtime..."
  tar -xzf "$NODE_TARBALL" -C "$CACHE_DIR"
fi

echo "Building .app skeleton..."
rm -rf "$APP"
mkdir -p "$DIST_ROOT"
copy_dir_contents "$ELECTRON_APP" "$APP"
if [ ! -x "$APP/Contents/MacOS/Electron" ]; then
  echo "Electron.app is missing its main executable: $APP/Contents/MacOS/Electron" >&2
  exit 1
fi
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/CreativeStudio"
rm -f "$APP/Contents/Resources/default_app.asar"
if ! binary_has_arch "$APP/Contents/MacOS/CreativeStudio" arm64; then
  echo "Electron executable is not arm64: $APP/Contents/MacOS/CreativeStudio" >&2
  exit 1
fi
mkdir -p "$PAYLOAD"
sed "s/__VERSION__/$VERSION/g" installer/macos/Info.plist >"$APP/Contents/Info.plist"
printf 'APPL????' >"$APP/Contents/PkgInfo"

echo "Assembling installer payload..."
copy_dir_contents ".next/standalone" "$STANDALONE_PAYLOAD"
mkdir -p "$PAYLOAD/.next"
copy_dir_contents ".next/static" "$PAYLOAD/.next/static"
copy_dir_contents "public" "$PAYLOAD/public"
copy_dir_contents "$NODE_EXTRACTED" "$PAYLOAD/runtime"
copy_dir_contents "dist-desktop" "$PAYLOAD/dist-desktop"
node -e "const fs=require('node:fs'); const target=process.argv[1]; const version=process.argv[2]; fs.writeFileSync(target, JSON.stringify({name:'creative-studio',version,private:true,main:'dist-desktop/main.js'}, null, 2)+'\\n')" \
  "$PAYLOAD/package.json" "$VERSION"

echo "Pruning local-only and development paths..."
# Kept in sync with the Windows installer's prune list. Next's output tracing
# can copy the whole project root into .next/standalone, so every entry has to
# be pruned at both levels — pruning only the payload root used to leave build
# caches and dev configs behind inside the standalone directory.
PRUNE_RELATIVE_PATHS=(
  data
  storage
  outputs
  installer
  docs
  scripts
  desktop
  .git
  .claude
  .venv-litellm
  python-runtime
  config.yaml
  litellm-config.yaml
  requirements-litellm.txt
  .next/cache
  .next/dev
  node_modules/.cache
  tsconfig.tsbuildinfo
  package-lock.json
  eslint.config.mjs
  postcss.config.mjs
  video-panel-mockup.html
  launcher.vbs
  WINDOWS.md
)

# The standalone build is copied under .next/standalone so desktop/main.ts can
# use it as the service cwd. The second pass keeps that guard independent of
# Next's tracing cleanup in case a stale standalone directory is reused.
for relative in "${PRUNE_RELATIVE_PATHS[@]}"; do
  remove_payload_path "$relative"
  remove_payload_path ".next/standalone/$relative"
done

# The start*/stop* globs must not require a hyphen: start.command, start.sh,
# stop.command and stop.sh are source-run entry points that are meaningless in
# an installed app. The legacy launcher and shortcut helpers are documented as
# historical/dev resources that are not packaged.
find "$PAYLOAD" \( \
  -name '.env' -o \
  -name '.env.*' -o \
  -name '*.lock' -o \
  -name 'start*.cmd' -o \
  -name 'start*.ps1' -o \
  -name 'start*.sh' -o \
  -name 'start*.command' -o \
  -name 'stop*.cmd' -o \
  -name 'stop*.ps1' -o \
  -name 'stop*.sh' -o \
  -name 'stop*.command' -o \
  -name 'create-desktop-shortcut.*' -o \
  -name 'launcher.vbs' -o \
  -name 'launcher.html' \
\) -exec rm -rf {} +

for pattern in 'start*.command' 'start*.sh' 'stop*.command' 'stop*.sh' 'launcher.*' 'create-desktop-shortcut.*'; do
  if find "$PAYLOAD" -name "$pattern" -print -quit | grep -q .; then
    echo "Installer payload still contains a source-run launcher: $pattern" >&2
    exit 1
  fi
done

for forbidden in "${PRUNE_RELATIVE_PATHS[@]}"; do
  if [ -e "$PAYLOAD/$forbidden" ] || [ -e "$STANDALONE_PAYLOAD/$forbidden" ]; then
    echo "Installer payload still contains forbidden local or development path: $forbidden" >&2
    exit 1
  fi
done
for forbidden in .env.local .env .env.*; do
  if find "$PAYLOAD" -name "$forbidden" -print -quit | grep -q .; then
    echo "Installer payload still contains forbidden environment path: $forbidden" >&2
    exit 1
  fi
done

find "$PAYLOAD/dist-desktop" -type f \( -name '*.map' -o -name '*.ts' -o -name '*.tsx' \) -delete
if find "$PAYLOAD/dist-desktop" -type f \( -name '*.map' -o -name '*.ts' -o -name '*.tsx' \) -print -quit | grep -q .; then
  echo "Installer payload contains desktop source or sourcemap files under dist-desktop." >&2
  exit 1
fi

BUNDLED_NODE="$PAYLOAD/runtime/bin/node"
BUNDLED_FFMPEG="$STANDALONE_PAYLOAD/node_modules/ffmpeg-static/ffmpeg"
BUNDLED_FFPROBE="$STANDALONE_PAYLOAD/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe"
if [ ! -x "$BUNDLED_NODE" ]; then
  echo "Installer payload missing private Node runtime: $BUNDLED_NODE" >&2
  exit 1
fi
if ! binary_has_arch "$BUNDLED_NODE" arm64; then
  echo "Installer payload contains a non-arm64 private Node runtime: $BUNDLED_NODE" >&2
  exit 1
fi
if ! "$BUNDLED_NODE" -p "process.versions.node.split('.')[0]" | grep -qx 22; then
  echo "Installer payload private Node runtime is not Node 22.x: $BUNDLED_NODE" >&2
  exit 1
fi
if [ ! -x "$BUNDLED_FFMPEG" ]; then
  echo "Installer payload missing bundled ffmpeg binary: $BUNDLED_FFMPEG" >&2
  exit 1
fi
if ! binary_has_arch "$BUNDLED_FFMPEG" arm64; then
  echo "Installer payload contains a non-arm64 ffmpeg binary: $BUNDLED_FFMPEG" >&2
  exit 1
fi
if ! "$BUNDLED_FFMPEG" -version >/dev/null 2>&1; then
  echo "Installer payload contains an unusable ffmpeg binary: $BUNDLED_FFMPEG" >&2
  exit 1
fi
# ffprobe-static 3.1.0 labels its macOS file as arm64 even when the payload is
# actually x86_64. Shipping that file causes an exec-format error on a clean
# Apple Silicon Mac. The runtime already has a tested ffmpeg metadata fallback,
# so omit an unusable ffprobe instead of packaging the wrong architecture.
if [ -e "$BUNDLED_FFPROBE" ]; then
  if ! binary_has_arch "$BUNDLED_FFPROBE" arm64 || ! "$BUNDLED_FFPROBE" -version >/dev/null 2>&1; then
    echo "Removing incompatible bundled ffprobe; metadata probing will use the bundled ffmpeg fallback."
    rm -f "$BUNDLED_FFPROBE"
  fi
fi

echo "Generating macOS icon..."
bash scripts/generate-icns.sh "$APP/Contents/Resources/app.icns"

sign_macos_bundle() {
  local identity="$1"
  local sign_args=(--force --deep --sign "$identity")
  if [ "$identity" != "-" ]; then
    sign_args+=(--options runtime --timestamp)
  fi

  # Electron ships helper apps/frameworks inside Contents/Frameworks. Sign
  # those code bundles explicitly before signing the outer product bundle.
  if [ -d "$APP/Contents/Frameworks" ]; then
    while IFS= read -r -d '' nested; do
      codesign "${sign_args[@]}" "$nested"
    done < <(find "$APP/Contents/Frameworks" -type d \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) -print0)
  fi
  codesign "${sign_args[@]}" "$APP"
}

if [ "$MAC_SIGNING_IDENTITY" = "-" ] || [ -z "$MAC_NOTARY_PROFILE" ]; then
  echo "Building a local-only Electron package without a complete signing/notarization release identity."
  echo "The resulting app/DMG is not notarized and is for local testing only."
else
  echo "Signing Electron app with identity: $MAC_SIGNING_IDENTITY"
fi
sign_macos_bundle "$MAC_SIGNING_IDENTITY"
codesign --verify --deep --strict "$APP"

echo "Creating DMG..."
rm -rf "$DMG_STAGE"
mkdir -p "$DMG_STAGE/.background"
cp -R "$APP" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
node scripts/generate-dmg-background.mjs "$DMG_STAGE/.background/background.png"

rm -f "$DMG_RW_PATH" "$DMG_PATH"
hdiutil create -volname "$APP_NAME" \
  -srcfolder "$DMG_STAGE" \
  -ov \
  -format UDRW \
  "$DMG_RW_PATH"

MOUNT_DIR="$(mktemp -d /tmp/creative-studio-dmg.XXXXXX)"
cleanup_dmg_mount() {
  if mount | grep -q "on $MOUNT_DIR "; then
    hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
  fi
  rm -rf "$MOUNT_DIR"
}
trap cleanup_dmg_mount EXIT

hdiutil attach -readwrite -noverify -noautoopen -mountpoint "$MOUNT_DIR" "$DMG_RW_PATH" >/dev/null
mkdir -p "$MOUNT_DIR/.background"
SetFile -a V "$MOUNT_DIR/.background" || true

osascript <<APPLESCRIPT
tell application "Finder"
  set mountedFolder to POSIX file "$MOUNT_DIR" as alias
  set backgroundImage to POSIX file "$MOUNT_DIR/.background/background.png" as alias
  open mountedFolder
  set dmgWindow to container window of mountedFolder
  set current view of dmgWindow to icon view
  set bounds of dmgWindow to {100, 100, 740, 520}
  set viewOptions to the icon view options of dmgWindow
  set arrangement of viewOptions to not arranged
  set icon size of viewOptions to 96
  set background picture of viewOptions to backgroundImage
  set position of item "$APP_NAME.app" of mountedFolder to {160, 215}
  set position of item "Applications" of mountedFolder to {480, 215}
  update mountedFolder without registering applications
  delay 1
end tell
APPLESCRIPT

sync
hdiutil detach "$MOUNT_DIR" >/dev/null
trap - EXIT
rm -rf "$MOUNT_DIR"
hdiutil convert "$DMG_RW_PATH" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" >/dev/null
rm -f "$DMG_RW_PATH"

if [ -n "$MAC_NOTARY_PROFILE" ]; then
  if [ "$MAC_SIGNING_IDENTITY" = "-" ]; then
    echo "CREATIVE_STUDIO_MAC_NOTARY_PROFILE requires a real Developer ID signing identity." >&2
    exit 1
  fi
  require_command xcrun
  echo "Submitting DMG for notarization with keychain profile: $MAC_NOTARY_PROFILE"
  xcrun notarytool submit "$DMG_PATH" --keychain-profile "$MAC_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
  echo "Notarization completed and stapled."
else
  echo "Notarization skipped: CREATIVE_STUDIO_MAC_NOTARY_PROFILE is unset."
fi

SIZE="$(du -h "$DMG_PATH" | awk '{print $1}')"
echo ""
echo "macOS installer created: $DMG_PATH ($SIZE)"
