#!/bin/bash
# 私有画布开发运行配置；不决定产品是否拆分。配置不读取父进程的数据根。
CANVAS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
export CREATIVE_STUDIO_DATA_ROOT="$CANVAS_ROOT"
export CREATIVE_STUDIO_LITELLM_PORT=4100
export PORT=3100
export HOSTNAME=127.0.0.1

# 网页版与桌面版共用画布数据库，只允许一个启动入口持有锁。
canvas_acquire() {
    CANVAS_LOCK="$CANVAS_ROOT/storage/run/canvas-launch.lock"
    mkdir -p "$CANVAS_ROOT/storage/run"
    if [ -d "$CANVAS_LOCK" ]; then
        local owner
        owner="$(cat "$CANVAS_LOCK/pid" 2>/dev/null || true)"
        if [[ "$owner" =~ ^[1-9][0-9]*$ ]] && ! kill -0 "$owner" 2>/dev/null; then
            rm -f "$CANVAS_LOCK/pid"
            rmdir "$CANVAS_LOCK" 2>/dev/null || true
        fi
    fi
    if ! mkdir "$CANVAS_LOCK" 2>/dev/null; then
        echo "画布已有启动入口运行，未重复启动或停止代理。" >&2
        exit 1
    fi
    echo "$$" > "$CANVAS_LOCK/pid"
}
canvas_release() {
    if [ "$(cat "$CANVAS_ROOT/storage/run/canvas-launch.lock/pid" 2>/dev/null || true)" = "$$" ]; then
        rm -f "$CANVAS_ROOT/storage/run/canvas-launch.lock/pid"
        rmdir "$CANVAS_ROOT/storage/run/canvas-launch.lock" 2>/dev/null || true
    fi
}
