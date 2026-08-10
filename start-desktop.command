#!/bin/bash
# 产品素材工作台 — 桌面版（Electron）一键启动脚本
# 双击此文件，或在终端运行: bash start-desktop.command [--rebuild]
#
# 与 start.command（网页版）的区别：
#   - 这里启动的是 Electron 桌面壳 + 私有 Node 服务跑 production standalone 构建，
#     不是 dev server；服务监听 127.0.0.1 的随机端口，不占用 3000。
#   - 源码态运行时数据根仍是本项目目录（data/、storage/），与网页版共用同一个数据库。
set -u

cd "$(dirname "$0")"

REBUILD=0
for arg in "$@"; do
    case "$arg" in
        --rebuild) REBUILD=1 ;;
        *)
            echo "未知参数: $arg" >&2
            echo "用法: bash start-desktop.command [--rebuild]" >&2
            exit 1
            ;;
    esac
done

echo "========================================"
echo "   🖥️  产品素材工作台 · 桌面版"
echo "========================================"
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ 未找到 Node.js，请先安装: https://nodejs.org"
    echo "   (推荐安装 LTS 版本)"
    read -p "按回车键退出..."
    exit 1
fi

# 显式指定私有 Node 服务使用的运行时：桌面壳在非打包态会逐个扫 PATH 找 node，
# 双击启动的 login shell 里 PATH 未必与开发终端一致，这里锁定当前这一个。
CREATIVE_STUDIO_NODE="$(command -v node)"
export CREATIVE_STUDIO_NODE

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "📦 首次运行，正在安装依赖..."
    npm install
    echo ""
fi

# Electron 运行时二进制不随 npm 包元数据安装，缺失时显式补装后硬断言。
ELECTRON_BINARY="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON_BINARY" ]; then
    echo "📦 正在安装 Electron 运行时..."
    if [ ! -f "node_modules/electron/install.js" ]; then
        echo "❌ 缺少 electron 依赖，请先运行 npm install" >&2
        read -p "按回车键退出..."
        exit 1
    fi
    (cd node_modules/electron && "$CREATIVE_STUDIO_NODE" install.js)
    if [ ! -x "$ELECTRON_BINARY" ]; then
        echo "❌ Electron 运行时安装失败：$ELECTRON_BINARY" >&2
        read -p "按回车键退出..."
        exit 1
    fi
    echo ""
fi

# 桌面版和网页版共用 data/workbench.db；同时运行会有并发写入风险。
if lsof -ti :3000 > /dev/null 2>&1; then
    echo "⚠️  检测到 3000 端口已被占用，网页版可能正在运行。"
    echo "   桌面版与网页版共用 data/workbench.db，同时运行有并发写入风险。"
    echo "   建议先双击 stop.command 停掉网页版。"
    read -p "仍要继续启动桌面版？(y/N) " reply
    case "$reply" in
        y|Y) echo "" ;;
        *) exit 1 ;;
    esac
fi

# 公司供应商运行环境是可选 sidecar；失败只禁用公司供应商，不阻塞工作台。
STACK_STARTED=0
if [ -x ".venv-litellm/bin/litellm" ] && [ -f "config.yaml" ]; then
    if bash scripts/start-litellm.sh; then
        STACK_STARTED=1
    else
        echo "⚠️  LiteLLM 启动失败，继续启动工作台；公司供应商暂不可用。"
    fi
    echo ""
fi

# 桌面壳退出时会请求 /api/shutdown，那条链路已经会停掉受控的 LiteLLM；
# 这里的 trap 只是异常退出时的兜底，stop-litellm.sh 本身幂等。
cleanup() {
    if [ "$STACK_STARTED" -eq 1 ]; then
        bash scripts/stop-litellm.sh
    fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# 桌面壳要求 production standalone 产物存在，dev server 的产物不适用。
STANDALONE_SERVER=".next/standalone/server.js"
STANDALONE_ENTRY=".next/standalone/runtime/server-entry.js"
if [ "$REBUILD" -eq 1 ] || [ ! -f "$STANDALONE_SERVER" ] || [ ! -f "$STANDALONE_ENTRY" ]; then
    if [ "$REBUILD" -eq 1 ]; then
        echo "🔁 正在重新构建工作台（--rebuild）..."
    else
        echo "🏗️  未找到 standalone 构建产物，正在首次构建（需要几分钟）..."
    fi
    if ! npm run build; then
        echo "❌ 构建失败，请查看上方错误输出。" >&2
        read -p "按回车键退出..."
        exit 1
    fi
    echo ""
else
    # 变量名紧跟全角字符时必须用 ${} 界定，否则 bash 会把多字节字符并进变量名。
    echo "📦 使用已有构建产物：${STANDALONE_SERVER}（$(date -r "$STANDALONE_SERVER" "+%Y-%m-%d %H:%M")）"
    echo "   代码有更新时，请改用: bash start-desktop.command --rebuild"
    echo ""
fi

echo "🔧 正在编译桌面壳..."
if ! npm run build:desktop; then
    echo "❌ 桌面壳编译失败，请查看上方错误输出。" >&2
    read -p "按回车键退出..."
    exit 1
fi
echo ""

echo "🚀 正在启动桌面版..."
echo ""
echo "💡 使用说明:"
echo "   1. 服务只监听 127.0.0.1 的随机端口，不会暴露到公网"
echo "   2. 关闭窗口只是隐藏，请从应用菜单选择「退出」结束后台任务"
echo "   3. 直接关闭此终端窗口也会触发桌面版优雅退出"
echo ""

./node_modules/.bin/electron .
