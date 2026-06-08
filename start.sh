#!/bin/bash
# 批量图片编辑工作台 — 一键启动脚本
# 双击此文件或在终端运行: bash start.sh

cd "$(dirname "$0")"

echo "========================================"
echo "   🖼️  批量图片编辑工作台"
echo "========================================"
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ 未找到 Node.js，请先安装: https://nodejs.org"
    echo "   (推荐安装 LTS 版本)"
    read -p "按回车键退出..."
    exit 1
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "📦 首次运行，正在安装依赖..."
    npm install
    echo ""
fi

echo "🚀 正在启动服务..."
echo ""

# Start dev server
npm run dev &
SERVER_PID=$!

# Wait for server to be ready
echo "⏳ 等待服务就绪..."
for i in {1..30}; do
    if curl -s -o /dev/null http://localhost:3000 2>/dev/null; then
        echo ""
        echo "✅ 服务已启动!"
        echo ""
        echo "📋 访问地址: http://localhost:3000"
        echo ""
        echo "💡 使用说明:"
        echo "   1. 先打开「供应商配置」页面，填入 API Key"
        echo "   2. 点击「新建项目」开始批量编辑"
        echo "   3. 关闭此窗口即可停止服务"
        echo ""

        # Open browser
        if command -v open &> /dev/null; then
            open http://localhost:3000
        fi

        echo "按 Ctrl+C 停止服务"
        wait $SERVER_PID
        exit 0
    fi
    sleep 1
done

echo "❌ 服务启动超时，请检查是否有端口冲突"
read -p "按回车键退出..."
exit 1