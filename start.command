#!/bin/bash
set -eu
cd "$(dirname "$0")"
echo "画布开发版：http://127.0.0.1:3100（代理 4100）"
exec bash scripts/canvas-dev.sh
