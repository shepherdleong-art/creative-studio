#!/bin/bash
# 批量图片编辑工作台 — 关闭服务脚本
# 双击此文件或在终端运行: bash stop.sh

echo "🛑 正在关闭批量图片编辑工作台..."

# 查找并关闭 Next.js dev server 进程
PIDS=$(lsof -ti :3000 2>/dev/null)

if [ -z "$PIDS" ]; then
    echo "ℹ️  没有发现运行中的服务 (端口 3000 未被占用)"
else
    for PID in $PIDS; do
        kill "$PID" 2>/dev/null && echo "✅ 已关闭进程 PID: $PID"
    done
fi

# 同时也清理可能残留的 node 进程
NODE_PIDS=$(ps aux | grep "[n]ext dev" | awk '{print $2}')
for PID in $NODE_PIDS; do
    kill "$PID" 2>/dev/null && echo "✅ 已关闭 Next.js 进程 PID: $PID"
done

echo ""
echo "👋 服务已停止"
echo ""
read -p "按回车键关闭此窗口..."
