#!/bin/bash
set -euo pipefail

NODE_VERSION=22.22.3
ARCH=darwin-arm64
APP_NAME="产品素材工作台"
SKIP_NPM_CI=0

for arg in "$@"; do
  case "$arg" in
    --skip-npm-ci) SKIP_NPM_CI=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
DIST_ROOT="dist/macos"
APP="$DIST_ROOT/$APP_NAME.app"
PAYLOAD="$APP/Contents/Resources/app"
CACHE_DIR=".cache/macos-installer"
NODE_NAME="node-v$NODE_VERSION-$ARCH"
NODE_TARBALL="$CACHE_DIR/$NODE_NAME.tar.gz"
NODE_EXTRACTED="$CACHE_DIR/$NODE_NAME"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/$NODE_NAME.tar.gz"
DMG_STAGE="$DIST_ROOT/dmg"
DMG_PATH="$DIST_ROOT/$APP_NAME-$VERSION.dmg"
DMG_RW_PATH="$DIST_ROOT/$APP_NAME-$VERSION.rw.dmg"

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
  case "$(cd "$(dirname "$target")" 2>/dev/null && pwd -P)/$(basename "$target")" in
    "$(cd "$PAYLOAD" && pwd -P)"/*) rm -rf "$target" ;;
    *) echo "Refusing to prune outside installer payload: $target" >&2; exit 1 ;;
  esac
}

echo "Preflight..."
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" != "22" ]; then
  echo "Creative Studio macOS packaging requires Node 22.x on the build host." >&2
  echo "The bundled runtime is Node $NODE_VERSION; mismatched native module ABI can crash better-sqlite3 or sharp." >&2
  exit 1
fi

for command in iconutil codesign hdiutil sips curl tar npm node clang osascript SetFile; do
  require_command "$command"
done

if [ "$SKIP_NPM_CI" -eq 1 ]; then
  echo "Skipping npm ci because --skip-npm-ci was provided."
else
  echo "Installing npm dependencies..."
  npm ci
fi

rm -rf .next/dev

echo "Building Next.js standalone app..."
npm run build

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
mkdir -p "$APP/Contents/MacOS" "$PAYLOAD"
sed "s/__VERSION__/$VERSION/g" installer/macos/Info.plist >"$APP/Contents/Info.plist"
cp installer/macos/launcher.sh "$APP/Contents/Resources/launcher.sh"
chmod +x "$APP/Contents/Resources/launcher.sh"
clang -arch arm64 -mmacosx-version-min=11.0 -O2 \
  installer/macos/launcher.c \
  -o "$APP/Contents/MacOS/CreativeStudio"
printf 'APPL????' >"$APP/Contents/PkgInfo"

echo "Assembling installer payload..."
copy_dir_contents ".next/standalone" "$PAYLOAD"
mkdir -p "$PAYLOAD/.next"
copy_dir_contents ".next/static" "$PAYLOAD/.next/static"
copy_dir_contents "public" "$PAYLOAD/public"
copy_dir_contents "$NODE_EXTRACTED" "$PAYLOAD/runtime"
cp launcher.html "$PAYLOAD/"

echo "Pruning local-only and development paths..."
for relative in \
  data \
  storage \
  outputs \
  installer \
  docs \
  scripts \
  .git \
  .claude \
  .next/cache \
  .next/dev \
  node_modules/.cache \
  tsconfig.tsbuildinfo \
  package-lock.json \
  launcher.vbs \
  WINDOWS.md; do
  remove_payload_path "$relative"
done

find "$PAYLOAD" -maxdepth 1 \( \
  -name '.env' -o \
  -name '.env.*' -o \
  -name '*.lock' -o \
  -name 'start-*.cmd' -o \
  -name 'start-*.ps1' -o \
  -name 'start-*.sh' -o \
  -name 'start-*.command' -o \
  -name 'stop-*.cmd' -o \
  -name 'stop-*.ps1' \
\) -exec rm -rf {} +

for forbidden in data storage outputs .env.local; do
  if [ -e "$PAYLOAD/$forbidden" ]; then
    echo "Installer payload still contains forbidden local data path: $PAYLOAD/$forbidden" >&2
    exit 1
  fi
done

for ffbin in \
  "node_modules/ffmpeg-static/ffmpeg" \
  "node_modules/ffprobe-static/bin/darwin/arm64/ffprobe"; do
  if [ ! -x "$PAYLOAD/$ffbin" ]; then
    echo "Installer payload missing bundled ffmpeg binary: $PAYLOAD/$ffbin" >&2
    exit 1
  fi
done

echo "Generating macOS icon..."
bash scripts/generate-icns.sh "$APP/Contents/Resources/app.icns"

echo "Signing app bundle ad-hoc..."
codesign --force --deep --sign - "$APP"
codesign -dv "$APP" >/dev/null

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

SIZE="$(du -h "$DMG_PATH" | awk '{print $1}')"
echo ""
echo "macOS installer created: $DMG_PATH ($SIZE)"
