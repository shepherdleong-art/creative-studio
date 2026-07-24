#!/bin/bash
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SELF/../Resources/app" && pwd)"
NODE_BIN="$APP_DIR/runtime/bin/node"
SERVER="$APP_DIR/server.js"

DATA_ROOT="${CREATIVE_STUDIO_DATA_ROOT:-$HOME/Library/Application Support/CreativeStudio}"
mkdir -p "$DATA_ROOT/storage/logs" "$DATA_ROOT/storage/run"

PORT="${CREATIVE_STUDIO_PORT:-3000}"
HOST="127.0.0.1"
URL="http://$HOST:$PORT"

if curl -fsS -o /dev/null --max-time 2 "$URL"; then
  open "$URL"
  exit 0
fi

PORT="$PORT" HOSTNAME="$HOST" NODE_ENV="production" \
CREATIVE_STUDIO_DATA_ROOT="$DATA_ROOT" \
CREATIVE_STUDIO_DESKTOP="1" \
nohup "$NODE_BIN" "$SERVER" \
  >>"$DATA_ROOT/storage/logs/server.out.log" \
  2>>"$DATA_ROOT/storage/logs/server.err.log" &
echo $! >"$DATA_ROOT/storage/run/server.pid"

for _ in $(seq 1 30); do
  curl -fsS -o /dev/null --max-time 1 "$URL" && break
  sleep 1
done

open "$URL"
exit 0
