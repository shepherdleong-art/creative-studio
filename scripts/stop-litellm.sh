#!/bin/bash
set -u

script_dir="$(cd "$(dirname "$0")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
data_root="${CREATIVE_STUDIO_DATA_ROOT:-$project_root}"
stack_file="$data_root/storage/run/stack.json"

if [ ! -f "$stack_file" ]; then
    echo "没有发现由本项目启动的 LiteLLM。"
    exit 0
fi

litellm_pid="$(STACK_FILE="$stack_file" node -e '
  const fs = require("fs");
  try {
    const value = JSON.parse(fs.readFileSync(process.env.STACK_FILE, "utf8")).litellmPid;
    if (Number.isInteger(value) && value > 0) process.stdout.write(String(value));
  } catch {}
')"

if [ -n "$litellm_pid" ] && kill -0 "$litellm_pid" 2>/dev/null; then
    command_line="$(ps -p "$litellm_pid" -o command= 2>/dev/null || true)"
    case "$command_line" in
        *"$project_root/.venv-litellm/"*litellm*)
            kill "$litellm_pid" 2>/dev/null || true
            for _ in {1..20}; do
                kill -0 "$litellm_pid" 2>/dev/null || break
                sleep 0.25
            done
            if kill -0 "$litellm_pid" 2>/dev/null; then
                kill -KILL "$litellm_pid" 2>/dev/null || true
            fi
            echo "LiteLLM 已停止。"
            ;;
        *)
            echo "状态文件中的 PID 不属于本项目 LiteLLM，未结束该进程。" >&2
            ;;
    esac
fi

rm -f "$stack_file"
