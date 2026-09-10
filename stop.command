#!/bin/bash
# 产品素材工作台 — 关闭服务脚本
# 双击此文件或在终端运行: bash stop.sh

echo "🛑 正在关闭产品素材工作台..."

cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd -P)"

# 端口探测与进程归属校验委托给共享 Node 工具；工具不可用时必须明确报错并退出，
# 绝不静默继续。
NODE_BIN="${CREATIVE_STUDIO_NODE:-node}"
RUNTIME_TOOLS="$PROJECT_ROOT/scripts/runtime"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "❌ 未找到 Node.js，无法调用共享停机工具；未对任何进程执行停止操作。" >&2
    read -p "按回车键退出..."
    exit 1
fi

# 查找并关闭 Next.js dev server 进程（只结束确属本项目的进程；
# 端口上的未知属主只报告，绝不误杀）。
PIDS="$("$NODE_BIN" "$RUNTIME_TOOLS/ports.mjs" listeners 3000 2>/dev/null)" || {
    echo "❌ 端口探测失败（共享工具不可用），未对任何进程执行停止操作。" >&2
    read -p "按回车键退出..."
    exit 1
}

if [ -z "$PIDS" ]; then
    echo "ℹ️  没有发现运行中的服务 (端口 3000 未被占用)"
else
    for PID in $PIDS; do
        check_output="$("$NODE_BIN" "$RUNTIME_TOOLS/process-tree.mjs" check-owner "$PID" "$PROJECT_ROOT" 2>&1)"
        check_rc=$?
        if [ "$check_rc" -eq 0 ]; then
            if "$NODE_BIN" "$RUNTIME_TOOLS/process-tree.mjs" kill-tree "$PID" >/dev/null 2>&1; then
                echo "✅ 已关闭进程 PID: $PID"
            else
                echo "⚠️  未能关闭进程 ${PID}，请手动检查。" >&2
            fi
        elif [ -n "$check_output" ]; then
            echo "⚠️  归属校验失败（${check_output}），未触碰进程 ${PID}。" >&2
        else
            echo "⚠️  端口 3000 的占用进程（PID ${PID}）不属于本项目，未停止。"
        fi
    done
fi

# 同时也清理可能残留的 node 进程（同样只结束项目所属进程）。
NODE_PIDS=$(ps aux | grep "[n]ext dev" | awk '{print $2}')
for PID in $NODE_PIDS; do
    check_output="$("$NODE_BIN" "$RUNTIME_TOOLS/process-tree.mjs" check-owner "$PID" "$PROJECT_ROOT" 2>&1)"
    check_rc=$?
    if [ "$check_rc" -eq 0 ]; then
        if "$NODE_BIN" "$RUNTIME_TOOLS/process-tree.mjs" kill-tree "$PID" >/dev/null 2>&1; then
            echo "✅ 已关闭 Next.js 进程 PID: $PID"
        else
            echo "⚠️  未能关闭进程 ${PID}，请手动检查。" >&2
        fi
    elif [ -n "$check_output" ]; then
        echo "⚠️  归属校验失败（${check_output}），未触碰进程 ${PID}。" >&2
    else
        echo "⚠️  Next.js 进程（PID ${PID}）不属于本项目，未停止。"
    fi
done

# 只关闭由本项目状态文件记录的 LiteLLM sidecar，不按端口误杀其他服务。
if ! bash "$PROJECT_ROOT/scripts/stop-litellm.sh"; then
    echo "❌ 停止 LiteLLM 侧车失败，请手动检查。" >&2
fi

echo ""
echo "👋 服务已停止"
echo ""
read -p "按回车键关闭此窗口..."
