#!/bin/bash
# 产品素材工作台 — 一键启动脚本
# 双击此文件或在终端运行: bash start.sh

cd "$(dirname "$0")"

echo "========================================"
echo "   🖼️  产品素材工作台"
echo "========================================"
echo ""

# Node 定位:PATH 优先;双击启动的 shell 未必继承开发终端的 PATH(托管 Node
# 常装在非标准位置),探测 Homebrew / workbuddy(跟随 current 指针,升级后
# 版本目录会变,不写死版本号)等常见位置,找到后把其 bin 目录前置到 PATH。
locate_node() {
    if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
    local candidate wb_root wb_version
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
        if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
    done
    wb_root="$HOME/.workbuddy/binaries/node/versions"
    if [ -f "$wb_root/current" ]; then
        wb_version="$(cat "$wb_root/current" 2>/dev/null)"
        if [ -n "$wb_version" ] && [ -x "$wb_root/$wb_version/bin/node" ]; then
            printf '%s\n' "$wb_root/$wb_version/bin/node"; return 0
        fi
    fi
    for candidate in "$wb_root"/*/bin/node; do
        if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
    done
    return 1
}

NODE_BIN="$(locate_node)" || {
    echo "❌ 未找到 Node.js，请先安装: https://nodejs.org"
    echo "   (推荐安装 LTS 版本)"
    read -p "按回车键退出..."
    exit 1
}
case ":$PATH:" in
    *":$(dirname "$NODE_BIN"):"*) ;;
    *) export PATH="$(dirname "$NODE_BIN"):$PATH" ;;
esac
# LiteLLM sidecar 脚本按同一约定复用这个运行时。
export CREATIVE_STUDIO_NODE="$(command -v node)"

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "📦 首次运行，正在安装依赖..."
    npm install
    echo ""
fi

# 公司供应商运行环境是可选 sidecar；失败只禁用公司供应商，不阻塞工作台。
STACK_STARTED=0
if [ -x ".venv-litellm/bin/litellm" ] && [ -f "config.yaml" ]; then
    if bash scripts/start-litellm.sh; then
        STACK_STARTED=1
    else
        echo "⚠️  LiteLLM 启动失败，继续启动工作台；公司供应商暂不可用。"
    fi
fi

cleanup() {
    if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    if [ "$STACK_STARTED" -eq 1 ]; then
        bash scripts/stop-litellm.sh
    fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "🚀 正在启动服务..."
echo ""

# Start dev server
npm run dev -- --hostname 127.0.0.1 &
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
