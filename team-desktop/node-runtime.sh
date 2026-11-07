#!/bin/bash
# 供 team-desktop 的 .command 入口 source；不单独执行。

if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
else
    NODE_BIN=""
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
        if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
    done
fi
if [ -z "$NODE_BIN" ]; then
    echo "❌ 未找到 Node.js 22.x，请先安装 arm64 版 Node.js 22。" >&2
    read -r -p "按回车键退出..."
    exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
export CREATIVE_STUDIO_NODE="$NODE_BIN"
