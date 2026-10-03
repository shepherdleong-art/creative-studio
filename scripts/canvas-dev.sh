#!/bin/bash
set -eu
source "$(dirname "$0")/canvas-profile.sh"
canvas_require_node
cd "$CANVAS_ROOT"
if lsof -nP -iTCP:3100 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "画布端口 3100 已占用，未启动或打开其他实例。" >&2
    exit 1
fi
if [ -f storage/run/electron-service.json ]; then
    echo "检测到画布桌面状态，请先运行 stop-desktop.command，再启动网页版。" >&2
    exit 1
fi
canvas_acquire
trap canvas_release EXIT
bash scripts/start-litellm.sh || echo "画布代理未就绪，公司供应商暂不可用。"
server_pid=""
cleanup() {
    if [ -n "$server_pid" ]; then
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
    fi
    bash scripts/stop-litellm.sh
    canvas_release
}
trap cleanup EXIT
trap 'exit 130' INT TERM
canvas_mode=dev
if [ "${1:-}" = "--production" ]; then canvas_mode=start; fi
node node_modules/next/dist/bin/next "$canvas_mode" --hostname 127.0.0.1 --port 3100 &
server_pid=$!
wait "$server_pid"
