#!/bin/bash
set -u
LAUNCHER_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$LAUNCHER_DIR/node-runtime.sh"
"$NODE_BIN" "$LAUNCHER_DIR/launcher.mjs" start "$@"
