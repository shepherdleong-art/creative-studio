#!/bin/bash
# 产品素材工作台 — 桌面版（Electron）停止脚本
# 双击此文件，或在终端运行: bash stop-desktop.command
#
# 正常退出请用应用菜单的「退出」，或在启动窗口按 Ctrl+C。
# 这个脚本用于应用失去响应、或从 Finder 启动后没有终端窗口可用的情况。
#
# 与 stop.command 的分工：stop.command 只负责网页版（3000 端口的 dev
# server），管不到桌面版监听随机端口的私有 Node 服务。
set -u

cd "$(dirname "$0")"

PROJECT_ROOT="$(pwd -P)"

echo "🛑 正在停止产品素材工作台（桌面版）..."
echo ""

# 桌面版有两个受控数据根：源码运行用项目目录，安装版用应用支持目录。
DATA_ROOTS=()
if [ -n "${CREATIVE_STUDIO_DATA_ROOT:-}" ]; then
    DATA_ROOTS+=("$CREATIVE_STUDIO_DATA_ROOT")
fi
DATA_ROOTS+=("$PROJECT_ROOT")
DATA_ROOTS+=("$HOME/Library/Application Support/CreativeStudio")

# 只读取本项目写出的状态文件，并校验 origin 必须是 loopback。
read_service_state() {
    local state_file="$1"
    STATE_FILE="$state_file" node -e '
      const fs = require("fs");
      try {
        const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
        const origin = String(state.origin || "");
        const instanceId = String(state.instanceId || "");
        const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(origin);
        if (state.version !== 1 || !match) process.exit(0);
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(0);
        if (!/^[A-Za-z0-9-]{1,128}$/.test(instanceId)) process.exit(0);
        process.stdout.write(`http://127.0.0.1:${port} ${instanceId}`);
      } catch {}
    ' 2>/dev/null
}

# 健康接口回报的 instanceId 必须与状态文件一致，才认定这个端口确实是
# 本应用的服务，而不是别的进程恰好占用了同一个端口。
verify_instance() {
    local origin="$1"
    local expected="$2"
    local actual
    actual="$(curl -fsS -m 2 "$origin/api/desktop/health" 2>/dev/null \
        | node -e '
            let raw = "";
            process.stdin.on("data", (chunk) => { raw += chunk; });
            process.stdin.on("end", () => {
              try { process.stdout.write(String(JSON.parse(raw).instanceId || "")); } catch {}
            });
          ' 2>/dev/null)"
    [ -n "$actual" ] && [ "$actual" = "$expected" ]
}

STOPPED_ANY=0

for data_root in "${DATA_ROOTS[@]}"; do
    state_file="$data_root/storage/run/electron-service.json"
    [ -f "$state_file" ] || continue

    state="$(read_service_state "$state_file")"
    if [ -z "$state" ]; then
        echo "⚠️  状态文件无法识别，跳过：$state_file"
        continue
    fi
    origin="${state%% *}"
    instance_id="${state##* }"

    if ! verify_instance "$origin" "$instance_id"; then
        echo "ℹ️  $origin 上没有匹配的实例，清理陈旧状态文件。"
        rm -f "$state_file"
        continue
    fi

    echo "🔎 找到运行中的服务：$origin"
    echo "   正在请求优雅关闭..."
    # /api/shutdown 会结束自己的进程，因此响应缺失是正常的。
    curl -fsS -m 15 -X POST "$origin/api/shutdown" >/dev/null 2>&1 || true

    stopped=0
    for _ in $(seq 1 40); do
        if ! verify_instance "$origin" "$instance_id"; then
            stopped=1
            break
        fi
        sleep 0.5
    done

    if [ "$stopped" -eq 1 ]; then
        echo "✅ 私有服务已优雅停止。"
    else
        echo "⚠️  服务在 20 秒内没有退出，将转为强制停止。"
    fi
    STOPPED_ANY=1
done

# 服务退出后 Electron 会跟着退出；这里只对残留的外壳做兜底，并且严格
# 按可执行文件路径匹配，绝不按名字或端口误杀其他进程。
terminate_shell() {
    local pattern="$1"
    local label="$2"
    local pids
    pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
    [ -n "$pids" ] || return 0

    echo "🧹 正在回收残留的$label..."
    for pid in $pids; do
        kill "$pid" 2>/dev/null || true
    done
    for _ in $(seq 1 20); do
        pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
        [ -n "$pids" ] || break
        sleep 0.5
    done
    pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        for pid in $pids; do
            kill -KILL "$pid" 2>/dev/null || true
        done
    fi
    STOPPED_ANY=1
}

terminate_shell "/Applications/产品素材工作台.app/Contents/MacOS/CreativeStudio" "安装版外壳"
terminate_shell "$PROJECT_ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "源码版外壳"

# 私有 Node 服务是 detached 的，外壳异常退出时它会成为孤儿。只回收
# 工作目录确属本项目 standalone 产物的进程。
STANDALONE_DIRS=("$PROJECT_ROOT/.next/standalone")
for data_root in "${DATA_ROOTS[@]}"; do
    STANDALONE_DIRS+=("$data_root/.next/standalone")
done

for pid in $(pgrep -f "next-server" 2>/dev/null || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | sed 's/^n//')"
    [ -n "$cwd" ] || continue
    for standalone in "${STANDALONE_DIRS[@]}"; do
        if [ "$cwd" = "$standalone" ]; then
            echo "🧹 正在回收孤儿服务进程 $pid"
            kill "$pid" 2>/dev/null || true
            STOPPED_ANY=1
            break
        fi
    done
done

# 只关闭由本项目状态文件记录的 LiteLLM sidecar，不按端口误杀其他服务。
bash "$PROJECT_ROOT/scripts/stop-litellm.sh"

echo ""
if [ "$STOPPED_ANY" -eq 1 ]; then
    echo "👋 桌面版已停止"
else
    echo "ℹ️  没有发现运行中的桌面版实例"
fi
echo ""
read -p "按回车键关闭此窗口..."
