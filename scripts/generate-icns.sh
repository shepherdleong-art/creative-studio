#!/bin/bash
set -euo pipefail

SRC="public/icons"
OUT="${1:-installer/macos/app.icns}"
TMP="$(mktemp -d)"
WORK="$TMP/app.iconset"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$WORK" "$(dirname "$OUT")"
cp "$SRC/app-icon-16.png" "$WORK/icon_16x16.png"
cp "$SRC/app-icon-32.png" "$WORK/icon_16x16@2x.png"
cp "$SRC/app-icon-32.png" "$WORK/icon_32x32.png"
cp "$SRC/app-icon-64.png" "$WORK/icon_32x32@2x.png"
cp "$SRC/app-icon-128.png" "$WORK/icon_128x128.png"
cp "$SRC/app-icon-256.png" "$WORK/icon_128x128@2x.png"
cp "$SRC/app-icon-256.png" "$WORK/icon_256x256.png"
cp "$SRC/app-icon-512.png" "$WORK/icon_256x256@2x.png"
cp "$SRC/app-icon-512.png" "$WORK/icon_512x512.png"
cp "$SRC/app-icon-1024.png" "$WORK/icon_512x512@2x.png"

if iconutil -c icns "$WORK" -o "$OUT"; then
  echo "icns -> $OUT"
  exit 0
fi

echo "iconutil failed; writing ICNS container directly..." >&2
node - "$SRC" "$OUT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [src, out] = process.argv.slice(2);
const entries = [
  ['icp4', 'app-icon-16.png'],
  ['icp5', 'app-icon-32.png'],
  ['icp6', 'app-icon-64.png'],
  ['ic07', 'app-icon-128.png'],
  ['ic08', 'app-icon-256.png'],
  ['ic09', 'app-icon-512.png'],
  ['ic10', 'app-icon-1024.png'],
].map(([type, filename]) => {
  const data = fs.readFileSync(path.join(src, filename));
  const chunk = Buffer.alloc(8 + data.length);
  chunk.write(type, 0, 'ascii');
  chunk.writeUInt32BE(chunk.length, 4);
  data.copy(chunk, 8);
  return chunk;
});

const header = Buffer.alloc(8);
header.write('icns', 0, 'ascii');
header.writeUInt32BE(8 + entries.reduce((sum, chunk) => sum + chunk.length, 0), 4);
fs.writeFileSync(out, Buffer.concat([header, ...entries]));
NODE
echo "icns -> $OUT"
