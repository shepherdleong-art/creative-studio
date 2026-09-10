#!/bin/bash
set -u

script_dir="$(cd "$(dirname "$0")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
data_root="${CREATIVE_STUDIO_DATA_ROOT:-$project_root}"
stack_file="$data_root/storage/run/stack.json"

# stack.json 的读与清委托给共享 Node 工具（scripts/runtime/stack-state.mjs）。
NODE_BIN="${CREATIVE_STUDIO_NODE:-node}"
RUNTIME_TOOLS="$script_dir/runtime"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "缺少 Node.js，无法调用共享工具" >&2
    exit 1
fi

if [ ! -f "$stack_file" ]; then
    echo "没有发现由本项目启动的 LiteLLM。"
    exit 0
fi

state_json="$("$NODE_BIN" "$RUNTIME_TOOLS/stack-state.mjs" read "$data_root")" || {
    echo "读取 stack.json 失败（共享工具不可用），未做任何停止操作。" >&2
    exit 1
}
litellm_pid="$(printf '%s' "$state_json" | "$NODE_BIN" -e '
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      const value = JSON.parse(raw).litellmPid;
      if (Number.isInteger(value) && value > 0) process.stdout.write(String(value));
    } catch {}
  });')"

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

"$NODE_BIN" "$RUNTIME_TOOLS/stack-state.mjs" clear "$data_root" || {
    echo "清理 stack.json 失败（共享工具不可用）。" >&2
    exit 1
}
