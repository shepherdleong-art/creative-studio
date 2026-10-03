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
source "$PROJECT_ROOT/scripts/canvas-profile.sh"
canvas_require_node

# 状态文件校验 / health 核身 / 优雅关闭 / 兜底强杀全部委托给共享 Node 工具
# （scripts/runtime/desktop-service.mjs）；工具不可用时必须明确报错并退出，
# 绝不静默跳过停机。
# Node 定位:CREATIVE_STUDIO_NODE 约定优先;未设置时探测常见安装位置
# (Homebrew / workbuddy current 指针等),双击启动的 shell 未必有开发终端的 PATH。

RUNTIME_TOOLS="$PROJECT_ROOT/scripts/runtime"

NODE_BIN="${CREATIVE_STUDIO_NODE:-}"
if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(locate_node)" || NODE_BIN=""
fi
if [ -z "$NODE_BIN" ] || ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "❌ 未找到 Node.js，无法调用共享停机工具；未对任何进程执行停止操作。" >&2
    if [ -t 0 ]; then read -p "按回车键关闭此窗口..."; fi
    exit 1
fi
export CREATIVE_STUDIO_NODE="$NODE_BIN"

echo "🛑 正在停止产品素材工作台（桌面版）..."
echo ""

# 桌面版有两个受控数据根：源码运行用项目目录，安装版用应用支持目录。
DATA_ROOTS=()
if [ -n "${CREATIVE_STUDIO_DATA_ROOT:-}" ]; then
    DATA_ROOTS+=("$CREATIVE_STUDIO_DATA_ROOT")
fi


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

    # 状态文件即使误从另一个目录复制，也必须验证实际监听进程归属。
    port="${origin##*:}"
    owned=0
    for listener in $(node "$PROJECT_ROOT/scripts/runtime/ports.mjs" listeners "$port" 2>/dev/null); do
        if node "$PROJECT_ROOT/scripts/runtime/process-tree.mjs" check-owner "$listener" "$PROJECT_ROOT" >/dev/null 2>&1; then
            owned=1
        fi
    done
    if [ "$owned" -ne 1 ]; then
        echo "服务进程不属于画布目录，未发送关闭请求。"
        continue
    fi

    stop_output="$("$NODE_BIN" "$RUNTIME_TOOLS/desktop-service.mjs" stop --root "$data_root" 2>&1)"
    stop_rc=$?
    case "$stop_rc" in
        0)
            case "$stop_output" in
                *state=none*)
                    # 该数据根没有任何状态记录：不是运行中的桌面版实例，静默跳过。
                    ;;
                *action=killed*)
                    echo "⚠️  服务在 20 秒内没有退出，已按归属校验强制停止。"
                    STOPPED_ANY=1
                    ;;
                *action=stopped*)
                    origin="$(printf '%s\n' "$stop_output" | sed -n 's/^origin=//p')"
                    echo "🔎 找到运行中的服务：$origin"
                    echo "   正在请求优雅关闭..."
                    echo "✅ 私有服务已优雅停止。"
                    STOPPED_ANY=1
                    ;;
            esac
            ;;
        2)
            # instance 不匹配或归属不明：工具只报告不动手。
            case "$stop_output" in
                *instance=mismatch*)
                    origin="$(printf '%s\n' "$stop_output" | sed -n 's/^origin=//p')"
                    echo "ℹ️  $origin 上没有匹配的实例，清理陈旧状态文件。"
                    rm -f "$data_root/storage/run/electron-service.json"
                    ;;
                *)
                    echo "⚠️  服务未在期限内退出且进程归属不明，仅报告，未强制停止。"
                    STOPPED_ANY=1
                    ;;
            esac
            ;;
        1)
            case "$stop_output" in
                *action=reported-only*)
                    # 状态文件无法解析或 origin/instanceId 非法（fail-closed，
                    # 工具未发起任何请求、未终止任何进程）→ 报告并跳到下一个数据根。
                    echo "⚠️  状态文件无法识别，跳过：$data_root/storage/run/electron-service.json"
                    ;;
                *)
                    echo "❌ 共享停机工具执行失败（退出码 ${stop_rc}）：$stop_output" >&2
                    if [ -t 0 ]; then read -p "按回车键关闭此窗口..."; fi
                    exit 1
                    ;;
            esac
            ;;
        *)
            echo "❌ 共享停机工具执行失败（退出码 ${stop_rc}）：$stop_output" >&2
            if [ -t 0 ]; then read -p "按回车键关闭此窗口..."; fi
            exit 1
            ;;
    esac
done

# 服务退出后 Electron 会跟着退出；这里只对残留的外壳做兜底，并且严格
# 按可执行文件路径匹配，绝不按名字或端口误杀其他进程。发现用 pgrep
# （按精确路径），归属复核与终止委托给 scripts/runtime/process-tree.mjs。
terminate_shell() {
    local owner_root="$1"
    local pattern="$2"
    local label="$3"
    local pids pid check_rc check_output
    pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
    [ -n "$pids" ] || return 0

    echo "🧹 正在回收残留的$label..."
    for pid in $pids; do
        check_output="$("$NODE_BIN" "$RUNTIME_TOOLS/process-tree.mjs" check-owner "$pid" "$owner_root" 2>&1)"
        check_rc=$?
        if [ "$check_rc" -eq 0 ]; then
            if ! "$NODE_BIN" "$RUNTIME_TOOLS/process-tree.mjs" kill-tree "$pid" >/dev/null 2>&1; then
                echo "⚠️  未能回收进程 ${pid}，请手动检查。" >&2
            fi
            STOPPED_ANY=1
        elif [ -n "$check_output" ]; then
            echo "⚠️  归属校验失败（${check_output}），未触碰进程 ${pid}。" >&2
        fi
    done
}

terminate_shell \
    "$PROJECT_ROOT" \
    "$PROJECT_ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
    "源码版外壳"

# 私有 Node 服务是 detached 的，外壳异常退出时它会成为孤儿。只回收
# 工作目录确属本项目 standalone 产物的进程（归属复核交给 process-tree.mjs）。
STANDALONE_DIRS=("$PROJECT_ROOT/.next/standalone")
for data_root in "${DATA_ROOTS[@]}"; do
    STANDALONE_DIRS+=("$data_root/.next/standalone")
done

for pid in $(pgrep -f "next-server" 2>/dev/null || true); do
    for standalone in "${STANDALONE_DIRS[@]}"; do
        check_output="$("$NODE_BIN" "$RUNTIME_TOOLS/process-tree.mjs" check-owner "$pid" "$standalone" 2>&1)"
        check_rc=$?
        if [ "$check_rc" -eq 0 ]; then
            echo "🧹 正在回收孤儿服务进程 $pid"
            if ! "$NODE_BIN" "$RUNTIME_TOOLS/process-tree.mjs" kill-tree "$pid" >/dev/null 2>&1; then
                echo "⚠️  未能回收进程 ${pid}，请手动检查。" >&2
            fi
            STOPPED_ANY=1
            break
        elif [ -n "$check_output" ]; then
            echo "⚠️  归属校验失败（${check_output}），未触碰进程 ${pid}。" >&2
        fi
    done
done

# 只关闭由本项目状态文件记录的 LiteLLM sidecar，不按端口误杀其他服务。
if ! bash "$PROJECT_ROOT/scripts/stop-litellm.sh"; then
    echo "❌ 停止 LiteLLM 侧车失败，请手动检查。" >&2
    STOPPED_ANY=1
fi

echo ""
if [ "$STOPPED_ANY" -eq 1 ]; then
    echo "👋 桌面版已停止"
else
    echo "ℹ️  没有发现运行中的桌面版实例"
fi
echo ""
if [ -t 0 ]; then read -p "按回车键关闭此窗口..."; fi
