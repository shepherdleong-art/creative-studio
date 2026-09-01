#!/bin/bash
set -u

script_dir="$(cd "$(dirname "$0")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
data_root="${CREATIVE_STUDIO_DATA_ROOT:-$project_root}"
proxy_port="${CREATIVE_STUDIO_LITELLM_PORT:-4000}"
litellm_exe="$project_root/.venv-litellm/bin/litellm"
config_file="$project_root/config.yaml"
log_dir="$data_root/storage/logs"
run_dir="$data_root/storage/run"
stack_file="$run_dir/stack.json"
health_url="http://127.0.0.1:$proxy_port/health/liveliness"

if ! [[ "$proxy_port" =~ ^[0-9]+$ ]] || [ "$proxy_port" -lt 1 ] || [ "$proxy_port" -gt 65535 ]; then
    echo "LiteLLM 端口无效: $proxy_port" >&2
    exit 1
fi
if [ ! -x "$litellm_exe" ]; then
    echo "缺少 LiteLLM: $litellm_exe" >&2
    exit 1
fi
if [ ! -f "$config_file" ]; then
    echo "缺少配置文件: $config_file" >&2
    exit 1
fi

mkdir -p "$log_dir" "$run_dir"

# 只接管由本项目状态文件记录且仍健康的 sidecar。
if [ -f "$stack_file" ]; then
    existing_pid="$(STACK_FILE="$stack_file" node -e '
      const fs = require("fs");
      try {
        const value = JSON.parse(fs.readFileSync(process.env.STACK_FILE, "utf8")).litellmPid;
        if (Number.isInteger(value) && value > 0) process.stdout.write(String(value));
      } catch {}
    ')"
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null && curl -fsS "$health_url" >/dev/null 2>&1; then
        echo "LiteLLM 已就绪: $health_url"
        exit 0
    fi
fi

# 端口上若是未知进程，绝不覆盖或误杀；确认空闲后才清理陈旧状态。
if lsof -nP -iTCP:"$proxy_port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "端口 $proxy_port 已被其他进程占用，未启动 LiteLLM。" >&2
    exit 1
fi
rm -f "$stack_file"

echo "正在启动 LiteLLM（仅监听 127.0.0.1:${proxy_port}）..."
# 离线加载模型价格表：避免启动时拉取 remote cost map 超时拖慢启动
# Codex/终端可能通过 HTTP(S)_PROXY 或 ALL_PROXY 访问公网；公司网关必须按本机内网路由直连。
# 代理变量只从 LiteLLM 子进程移除，不影响 Codex、Next 或当前 shell。
env \
    -u HTTP_PROXY \
    -u HTTPS_PROXY \
    -u ALL_PROXY \
    -u http_proxy \
    -u https_proxy \
    -u all_proxy \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    PYTHONUTF8=1 \
    "$litellm_exe" \
    --config "$config_file" \
    --host 127.0.0.1 \
    --port "$proxy_port" \
    >>"$log_dir/litellm.out.log" \
    2>>"$log_dir/litellm.err.log" &
litellm_pid=$!

ready=0
for _ in {1..30}; do
    if ! kill -0 "$litellm_pid" 2>/dev/null; then
        break
    fi
    if curl -fsS "$health_url" >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 2
done

if [ "$ready" -ne 1 ]; then
    kill "$litellm_pid" 2>/dev/null || true
    wait "$litellm_pid" 2>/dev/null || true
    rm -f "$stack_file"
    echo "LiteLLM 60 秒内未就绪，请查看 $log_dir/litellm.err.log" >&2
    exit 1
fi

STACK_FILE="$stack_file" \
LITELLM_PID="$litellm_pid" \
PROXY_PORT="$proxy_port" \
STOP_SCRIPT="$script_dir/stop-litellm.sh" \
node -e '
  const fs = require("fs");
  const state = {
    litellmPid: Number(process.env.LITELLM_PID),
    proxyPort: Number(process.env.PROXY_PORT),
    stopScript: process.env.STOP_SCRIPT,
    startedAt: new Date().toISOString().replace(/Z$/, ""),
  };
  fs.writeFileSync(process.env.STACK_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
'

echo "LiteLLM 已就绪: $health_url"
