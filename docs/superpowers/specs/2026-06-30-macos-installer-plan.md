# Plan: macOS Installer (.dmg) for Creative Studio — Windows parity

## Context

Creative Studio already ships a **Windows installer** (`CreativeStudioSetup.exe`). Despite the "installer" framing, **this is not an Electron app**. The Windows pipeline is:

- `next build` with `output: 'standalone'` → `.next/standalone/server.js`
- A bundled **private Node.js runtime** (downloaded `node-v22.22.3-win-x64.zip`)
- A compiled **C# launcher** (`installer/windows/launcher.cs` → `CreativeStudio.exe`) that picks a port, starts `node server.js`, and opens the browser to a branded splash (`launcher.html`)
- **Inno Setup** (`installer/windows/CreativeStudio.iss`) packs it all into `dist/windows/CreativeStudioSetup.exe`
- Orchestrated by `scripts/build-win-installer.ps1`

The user wants the **same experience on macOS**, reusing the **same icon**. The app layer is already cross-platform-ready, so this is almost entirely **packaging-shell** work: a `.app` bundle, a bundled darwin Node runtime, an `.icns` from the existing icon, and a `.dmg` build script mirroring the PowerShell one.

**Confirmed decisions:** Apple Silicon only (`darwin-arm64`) · **Unsigned** (ad-hoc only, like the unsigned Windows build) · **`.dmg`** (drag-to-Applications).

**Outcome:** `npm run build:mac-installer` produces `dist/macos/产品素材工作台-<version>.dmg`. The user drags `产品素材工作台.app` to Applications, double-clicks, and the browser opens to the running app — identical UX to Windows, same icon.

---

## What already works (reuse as-is, do NOT modify)

| Piece | File | Why it's reused |
|---|---|---|
| Standalone build | `next.config.ts` (`output: 'standalone'`, `outputFileTracingIncludes`) | Already platform-agnostic. The react-trace fix (commit `2fb6a8c`) applies equally on macOS. |
| Data-root indirection | `lib/data-root.ts` → `dataRoot()` reads `CREATIVE_STUDIO_DATA_ROOT` | Lets us point all DB/storage writes to a writable macOS location **without touching any app code**. |
| Graceful shutdown | `app/api/shutdown/route.ts` (`POST /api/shutdown`) + PID at `storage/run/server.pid` | Reused for the "stop" helper. |
| Icon master + PNG ladder | `app/icon.svg`, `public/icons/app-icon-{16,32,64,128,256,512,1024}.png` | All sizes `iconutil` needs already exist; `.icns` is assembled from them. |
| Icon generator | `scripts/generate-app-icons.mjs` (`npm run icons`) | Regenerates the PNG ladder from `app/icon.svg` before icns assembly. **No changes needed.** |
| Splash page | `launcher.html` | Optional reuse (see launcher note below). |

**Templates to mirror (read, don't import):** `scripts/build-win-installer.ps1`, `installer/windows/CreativeStudio.iss`, `installer/windows/launcher.cs`.

---

## Key deviations from Windows (important — read before implementing)

1. **Data lives outside the `.app`.** Windows stores data next to the EXE. On macOS the app sits in `/Applications` (not user-writable; writing inside a bundle is wrong and breaks signing). Set `CREATIVE_STUDIO_DATA_ROOT="$HOME/Library/Application Support/CreativeStudio"` (ASCII path, stable across renames). The launcher `mkdir -p`s it. DB → `…/CreativeStudio/data/workbench.db`, uploads/logs/pid → `…/CreativeStudio/storage/…`. This is the standard macOS convention and works purely via the existing `dataRoot()` env hook.
2. **Ad-hoc codesign is required for launchability** on Apple Silicon (`codesign --force --deep --sign -`). This is *not* notarization and needs no Apple account — it only prevents "is damaged / can't be opened". First-open is still Gatekeeper-gated; document `xattr -dr com.apple.quarantine` / right-click→Open.
3. **Launcher behavior:** primary = **poll-then-open the server URL directly** (robust, no `file://` query/Unicode edge cases). The `launcher.html` splash is an optional enhancement (a brief Dock-bounce while the readiness poll runs, ~1–3s, is acceptable).
4. **Node ABI must match.** Native modules (`better-sqlite3`, `sharp`) are compiled at `npm ci` time against the build host's Node ABI; the bundled runtime is Node `22.22.3`. **Build host must run Node 22.x** or the packaged server crashes with an ABI mismatch. Stated as a prerequisite + verified.

---

## Deliverables

### New files
- `installer/macos/Info.plist` — bundle metadata (template with `__VERSION__`)
- `installer/macos/launcher.sh` — installed as `Contents/MacOS/CreativeStudio`
- `scripts/generate-icns.sh` — builds `app.icns` from `public/icons/app-icon-*.png`
- `scripts/build-mac-installer.sh` — the orchestrator (mirrors `build-win-installer.ps1`)
- `MACOS.md` — install / stop / uninstall / Gatekeeper docs (parallel to `WINDOWS.md`)

### Modified files
- `package.json` — add one script:
  ```json
  "build:mac-installer": "bash scripts/build-mac-installer.sh"
  ```
- `README.md` — add a "Mac 快速启动" section pointing at `MACOS.md` (parallel to the existing Windows section).

### Bundle naming (mirrors Windows: Chinese display, ASCII internals)
- Bundle: `产品素材工作台.app` · Executable: `CreativeStudio` · Identifier: `com.creativestudio.workbench`
- DMG: `dist/macos/产品素材工作台-<version>.dmg` (volume name `产品素材工作台`)
- Data dir: `~/Library/Application Support/CreativeStudio`

---

## File specs

### 1. `installer/macos/Info.plist` (full)
`__VERSION__` is substituted by the build script from `package.json` `version`.
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>                  <string>产品素材工作台</string>
  <key>CFBundleDisplayName</key>           <string>产品素材工作台</string>
  <key>CFBundleIdentifier</key>            <string>com.creativestudio.workbench</string>
  <key>CFBundleVersion</key>               <string>__VERSION__</string>
  <key>CFBundleShortVersionString</key>    <string>__VERSION__</string>
  <key>CFBundleExecutable</key>            <string>CreativeStudio</string>
  <key>CFBundleIconFile</key>              <string>app.icns</string>
  <key>CFBundlePackageType</key>           <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key> <string>6.0</string>
  <key>LSMinimumSystemVersion</key>        <string>11.0</string>
  <key>NSHighResolutionCapable</key>       <true/>
  <key>LSApplicationCategoryType</key>     <string>public.app-category.graphics-design</string>
</dict>
</plist>
```

### 2. `installer/macos/launcher.sh` (full — mirrors `launcher.cs` logic)
Installed to `Contents/MacOS/CreativeStudio` with `chmod +x`. Launch-and-exit: it spawns Node detached, opens the browser, and returns (the Dock icon vanishes; the server keeps running under launchd — same as the Windows EXE).
```bash
#!/bin/bash
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)"             # …/Contents/MacOS
APP_DIR="$(cd "$SELF/../Resources/app" && pwd)"   # payload root (server.js lives here)
NODE_BIN="$APP_DIR/runtime/bin/node"
SERVER="$APP_DIR/server.js"

# Writable data location (NOT inside the bundle) — reuses dataRoot() via env
DATA_ROOT="${CREATIVE_STUDIO_DATA_ROOT:-$HOME/Library/Application Support/CreativeStudio}"
mkdir -p "$DATA_ROOT/storage/logs" "$DATA_ROOT/storage/run"

PORT="${CREATIVE_STUDIO_PORT:-3000}"
HOST="127.0.0.1"
URL="http://$HOST:$PORT"

# Single-instance: if the server already answers, just open the browser and exit
if curl -fsS -o /dev/null --max-time 2 "$URL"; then
  open "$URL"; exit 0
fi

# Start the standalone server detached, with the same env contract as Windows
PORT="$PORT" HOSTNAME="$HOST" NODE_ENV="production" \
CREATIVE_STUDIO_DATA_ROOT="$DATA_ROOT" \
nohup "$NODE_BIN" "$SERVER" \
  >>"$DATA_ROOT/storage/logs/server.out.log" \
  2>>"$DATA_ROOT/storage/logs/server.err.log" &
echo $! >"$DATA_ROOT/storage/run/server.pid"

# Wait for readiness (~30s max), then open the app in the default browser
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null --max-time 1 "$URL" && break
  sleep 1
done
open "$URL"
exit 0
# Optional splash parity: replace the final `open "$URL"` with
#   open "file://$APP_DIR/launcher.html?port=$PORT"
# (reuses launcher.html; verify `open` preserves the query on your macOS first)
```

### 3. `scripts/generate-icns.sh` (full)
Reuses the existing PNG ladder — all required sizes already exist in `public/icons/`.
```bash
#!/bin/bash
set -euo pipefail
SRC="public/icons"          # app-icon-{16,32,64,128,256,512,1024}.png
OUT="${1:-installer/macos/app.icns}"
WORK="$(mktemp -d)/app.iconset"; mkdir -p "$WORK"
cp "$SRC/app-icon-16.png"   "$WORK/icon_16x16.png"
cp "$SRC/app-icon-32.png"   "$WORK/icon_16x16@2x.png"
cp "$SRC/app-icon-32.png"   "$WORK/icon_32x32.png"
cp "$SRC/app-icon-64.png"   "$WORK/icon_32x32@2x.png"
cp "$SRC/app-icon-128.png"  "$WORK/icon_128x128.png"
cp "$SRC/app-icon-256.png"  "$WORK/icon_128x128@2x.png"
cp "$SRC/app-icon-256.png"  "$WORK/icon_256x256.png"
cp "$SRC/app-icon-512.png"  "$WORK/icon_256x256@2x.png"
cp "$SRC/app-icon-512.png"  "$WORK/icon_512x512.png"
cp "$SRC/app-icon-1024.png" "$WORK/icon_512x512@2x.png"
iconutil -c icns "$WORK" -o "$OUT"
echo "icns → $OUT"
```

### 4. `scripts/build-mac-installer.sh` (orchestrator — numbered steps mirroring `build-win-installer.ps1`)
Args: `--skip-npm-ci` (optional). Node version pinned to match the bundled runtime.
```
NODE_VERSION=22.22.3
ARCH=darwin-arm64
VERSION=$(node -p "require('./package.json').version")
APP="dist/macos/产品素材工作台.app"
PAYLOAD="$APP/Contents/Resources/app"
```
1. **Preflight:** assert `node -v` major == 22 (else abort with the ABI warning). Assert `iconutil`, `codesign`, `hdiutil`, `sips` exist (ship with Xcode CLT; hint `xcode-select --install`).
2. `npm ci` unless `--skip-npm-ci` → installs **darwin-arm64** prebuilds of `better-sqlite3` & `sharp`.
3. `rm -rf .next/dev`; `npm run build` → `.next/standalone`, `.next/static`.
4. `npm run icons` → refresh `public/icons/app-icon-*.png` from `app/icon.svg`.
5. Ensure `.cache/macos-installer/` and `dist/macos/`.
6. Download (cached) `https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$ARCH.tar.gz`; extract → `.cache/macos-installer/node-v$NODE_VERSION-$ARCH/`.
7. **Build the `.app` skeleton:** wipe `$APP`; create `Contents/MacOS`, `Contents/Resources/app`.
   - Render `installer/macos/Info.plist` with `__VERSION__`→`$VERSION` into `$APP/Contents/Info.plist`.
   - Copy `installer/macos/launcher.sh` → `$APP/Contents/MacOS/CreativeStudio`; `chmod +x`.
   - `echo 'APPL????' > $APP/Contents/PkgInfo`.
8. **Assemble payload** into `$PAYLOAD` (mirror the Windows copy set):
   - `cp -R .next/standalone/. "$PAYLOAD"/`
   - `cp -R .next/static "$PAYLOAD/.next/static"`
   - `cp -R public "$PAYLOAD/public"`
   - `cp -R .cache/macos-installer/node-v$NODE_VERSION-$ARCH "$PAYLOAD/runtime"` (so `runtime/bin/node` sits beside `server.js`)
   - `cp launcher.html "$PAYLOAD/"` (kept for the optional splash)
9. **Prune** dev/secret paths from `$PAYLOAD` (mirror the `.ps1` prune list): `data storage outputs installer docs scripts .git .claude .next/cache .next/dev .env .env.* *.lock package-lock.json launcher.vbs WINDOWS.md start-*.{cmd,ps1,sh,command} stop-*.{cmd,ps1}`.
   Then **hard-assert** none of `data/`, `storage/`, `outputs/`, `.env.local` remain in `$PAYLOAD` → `exit 1` if found.
10. **Icon:** `bash scripts/generate-icns.sh "$APP/Contents/Resources/app.icns"`.
11. **Ad-hoc sign:** `codesign --force --deep --sign - "$APP"` (verify with `codesign -dv "$APP"`).
12. **DMG:** stage `dist/macos/dmg/` = `产品素材工作台.app` + symlink `Applications -> /Applications`; then
    `hdiutil create -volname 产品素材工作台 -srcfolder dist/macos/dmg -ov -format UDZO "dist/macos/产品素材工作台-$VERSION.dmg"`.
13. Print the final artifact path + size.

### 5. `MACOS.md` (docs)
- **Prerequisites:** macOS 11+ (Apple Silicon), Node 22.x, Xcode Command Line Tools.
- **Build:** `npm run build:mac-installer` → `dist/macos/产品素材工作台-<version>.dmg`.
- **Install:** open the DMG, drag `产品素材工作台.app` to Applications.
- **First launch (Gatekeeper, unsigned):** right-click → Open (once), or
  `xattr -dr com.apple.quarantine "/Applications/产品素材工作台.app"`.
- **Stop:** `curl -X POST http://127.0.0.1:3000/api/shutdown` (graceful), or `kill "$(cat ~/Library/Application\ Support/CreativeStudio/storage/run/server.pid)"`.
- **Uninstall:** move the app to Trash; delete data with `rm -rf ~/Library/Application\ Support/CreativeStudio`.
- **Data location:** `~/Library/Application Support/CreativeStudio` (DB, uploads, logs).

---

## Verification

### A. Build-time (run by implementer; re-checkable by Claude/codex)
- `node -v` → `v22.*`; `npm run build:mac-installer` exits `0`.
- Artifact exists: `dist/macos/产品素材工作台-<version>.dmg`.
- Bundle structure present: `Contents/MacOS/CreativeStudio` (executable bit set), `Contents/Resources/app.icns`, `Contents/Resources/app/server.js`, `Contents/Resources/app/runtime/bin/node`, `Contents/Info.plist`.
- `file "$PAYLOAD/runtime/bin/node"` → `Mach-O 64-bit executable arm64`.
- Native modules shipped: `$PAYLOAD/node_modules/better-sqlite3` and `…/sharp` exist.
- **No leakage:** `find "$PAYLOAD" -maxdepth 1 \( -name data -o -name storage -o -name outputs -o -name .env.local \)` returns nothing.
- `plutil -lint "$APP/Contents/Info.plist"` → OK; `CFBundleIconFile`=`app.icns`; version == package.json.
- `codesign -dv "$APP"` → shows a (ad-hoc) signature.
- `iconutil -l` / `sips -g pixelWidth "$APP/Contents/Resources/app.icns"` → includes 1024px; icon visually matches `app/icon.svg` (same icon as Windows).

### B. Manual smoke test (the real proof)
1. Mount DMG → drag app to `/Applications` → clear quarantine (above).
2. Double-click → default browser opens → app loads at `http://127.0.0.1:3000`. **Finder & Dock show the app icon** (same as Windows).
3. `~/Library/Application Support/CreativeStudio/data/workbench.db` is created; `storage/` populates.
4. Create a project + upload an image → confirms `better-sqlite3` + `sharp` load on the bundled Node (check `storage/logs/server.err.log` for **no** `NODE_MODULE_VERSION` / ABI errors).
5. Relaunch the app → **single-instance**: browser opens, no second server (only one `node` PID).
6. Stop via `POST /api/shutdown` → server exits; PID file gone.

### C. Out of scope (future, only if needed)
- Developer-ID signing + notarization (for distribution beyond the user's own machines).
- Universal/Intel (`darwin-x64`) build.
- Auto-update.

---

## Execution order (suggested)
1. `installer/macos/Info.plist` + `installer/macos/launcher.sh` (the bundle's two novel files).
2. `scripts/generate-icns.sh` → run it once standalone to confirm a valid `.icns`.
3. `scripts/build-mac-installer.sh` → iterate to a clean `.dmg`.
4. `package.json` script + `MACOS.md` + `README.md` section.
5. Run Verification A, then B.
