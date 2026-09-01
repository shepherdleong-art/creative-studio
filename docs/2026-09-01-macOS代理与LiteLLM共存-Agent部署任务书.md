# macOS 代理与 LiteLLM 共存：Agent 部署任务书

> 用途：把本文件发送到公司 Mac，并让当地的编码 Agent 在 Creative Studio 源码目录执行。
> 目标：Codex/OpenAI 保持走代理；Creative Studio 通过本机 LiteLLM 直连公司网关；Clash Verge 开启 TUN 时仍能解析并直连公司内网。

## 给部署 Agent 的任务

在目标电脑上完成审计、部署、验证和可恢复备份。不要把“配置文件存在”“进程启动过”或“模型列表可见”当作成功；只有对应验收项有运行时证据，才能报告完成。

执行原则：

- 先读取目标仓库的 `AGENTS.md` 和 `docs/reference/公司网关与COS中转.md`，再操作。
- 先运行 `git status --short --branch`，保留用户已有改动；只修改本任务明确涉及的文件，不暂存、不提交、不推送。
- 目标是 macOS 源码运行。macOS DMG 安装版不含 `config.yaml` 与 `.venv-litellm`，不适用本任务。
- LiteLLM 和 Next 必须只监听 `127.0.0.1`。任何实际密钥只保存在目标电脑的 `config.yaml` / `.env.local`，不得输出到对话、日志、命令历史或 Git。
- 修改 Clash 前备份当前活动订阅绑定的 Rules/Merge 扩展；UID 必须现场读取，不能照抄别台电脑的 UID。
- 公司域名只查询公司 DNS。禁止用公共 DNS 探测公司网关。
- 安装依赖、修改 Clash、重新激活订阅、切换 TUN 和发送真实公司请求都属于有副作用动作；仅在用户授权覆盖对应动作时执行。
- 真实验收默认只允许一次低成本文本请求。图片、视频、COS 上传和持久任务不在本任务范围内。

## 用户发送本文件时可附上的授权文字

如果希望 Agent 一次做完，可以把下面这段和本文件一起发送：

> 请读取并执行《macOS 代理与 LiteLLM 共存：Agent 部署任务书》。授权你在本机 Creative Studio 源码目录安装项目锁定的 LiteLLM 依赖、补齐 LiteLLM 子进程代理隔离、备份并修改当前 Clash Verge 订阅的 Rules/Merge 扩展、重新激活订阅，并发送一次文档约定的最小文本请求。不要生成图片或视频，不要创建持久任务，不要提交或推送 Git，不要回显任何 Key。TUN 当前状态先保持不变；若需要实际切换 TUN 验收，请在切换前单独向我确认。

如果公司电脑不允许安装软件，删掉其中“安装项目锁定的 LiteLLM 依赖”，让 Agent 在环境缺失处停下报告。

## 预期网络拓扑

```text
Codex / OpenAI
    └─ 保留系统代理或父 shell 代理 ──> Clash Verge ──> 公网

Creative Studio
    └─ http://127.0.0.1:4000 ──> LiteLLM 子进程
                                      ├─ 不继承 HTTP(S)_PROXY / ALL_PROXY
                                      └─ 公司域名 + 私网网段 DIRECT ──> 公司网关

TUN 开启时
    └─ Clash 使用公司 DNS 解析公司域名，再由最高优先级 DIRECT 规则放行
```

`NO_PROXY` 只能处理部分进程代理，不能绕过 TUN 的系统路由和 DNS 接管。因此必须同时完成“LiteLLM 子进程隔离”和“Clash DIRECT + 内网 DNS”两层。

## 阶段 0：现场审计

在仓库根目录执行：

```bash
pwd
git status --short --branch
uname -m
sw_vers
node --version
python3.12 --version
command -v curl lsof ruby
```

完成标准：

- 工作目录确实是 Creative Studio 源码根目录。
- `uname -m` 为 `arm64`；Node 满足仓库 `AGENTS.md` 要求；Python 推荐 3.12。
- 已记录目标分支和原始脏工作区，后续能区分本任务改动与用户改动。

只检查代理变量是否存在，不输出其值：

```bash
for proxy_var in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
  if printenv "$proxy_var" >/dev/null; then
    echo "$proxy_var=present"
  else
    echo "$proxy_var=absent"
  fi
done
```

检查本机端口，不结束未知进程：

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN || true
lsof -nP -iTCP:4000 -sTCP:LISTEN || true
```

如果 3000 或 4000 已被未知进程占用，先识别归属并报告；不要按端口直接杀进程。

## 阶段 1：准备源码态 LiteLLM

### 1.1 检查凭据文件

仓库根目录必须存在 `config.yaml`。它含公司网关 Key，用户应通过公司批准的安全方式放到目标电脑；Agent 不得猜测、索要粘贴到聊天或打印文件内容。

```bash
test -f config.yaml
git check-ignore config.yaml
chmod 600 config.yaml
```

完成标准：`config.yaml` 存在、被 Git 忽略、权限不宽于当前用户读写。若缺失，停在这里让用户安全放置文件。

配置中的请求可靠性参数必须位于 `router_settings`，并保留其他现有键：

```yaml
router_settings:
  num_retries: 0
  timeout: 110
```

应用侧超时约 120 秒，LiteLLM 应先结束上游请求，避免客户端先断开而公司网关继续占用并发。检查时只输出结果与模型是否存在，不打印 `api_key`：

```bash
ruby -ryaml -e 'x=YAML.safe_load(File.read("config.yaml"), aliases: true) || {}; r=x["router_settings"] || {}; valid=r.key?("num_retries") && r["num_retries"].to_i == 0 && r.key?("timeout") && r["timeout"].to_i == 110; abort("router_settings invalid") unless valid; names=Array(x["model_list"]).map { |m| m["model_name"] }; abort("text model missing") unless names.include?("GPT-5-6-Luna-Standard"); puts "router_settings=valid text_model=present"'
```

### 1.2 创建或复用虚拟环境

若 `.venv-litellm/bin/litellm` 已存在，先验证后复用。缺失时，在已获安装授权的前提下执行：

```bash
python3.12 -m venv .venv-litellm
.venv-litellm/bin/python -m pip install -r requirements-litellm.txt
```

验证：

```bash
.venv-litellm/bin/python --version
.venv-litellm/bin/python -m pip check
.venv-litellm/bin/python -c 'import litellm, socksio; print("litellm_import=ok socksio_import=ok")'
.venv-litellm/bin/python -c 'from importlib.metadata import version; assert version("litellm")=="1.89.2"; assert version("socksio")=="1.0.0"; print("locked_versions=valid")'
```

仓库当前锁定 `litellm[proxy]==1.89.2` 与 `socksio==1.0.0`。以 `requirements-litellm.txt` 为准，不自行升级。若 pip 缓存权限异常，可临时使用项目专用缓存：

```bash
PIP_CACHE_DIR=/tmp/creative-studio-pip-cache .venv-litellm/bin/python -m pip install -r requirements-litellm.txt
```

完成标准：虚拟环境为目标 Mac 原生架构，`pip check` 成功，LiteLLM 与 SOCKS 依赖均能导入。

## 阶段 2：隔离 LiteLLM 子进程的代理

检查 `scripts/start-litellm.sh`。启动 LiteLLM 的命令块必须具备以下语义：

```bash
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
    --port "$proxy_port"
```

如果现有脚本已经等价，保持不动；如果缺失，只对该启动块做最小补丁。不得清除父 shell、Codex 或 Next 的代理变量，也不得把监听地址改成 `0.0.0.0`。

检查 `scripts/litellm-macos-startup.test.mjs`。测试必须逐一断言大小写两套 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 都在 LiteLLM 启动块中通过 `env -u` 清除。缺失时补测试，再补实现。

运行：

```bash
node scripts/litellm-macos-startup.test.mjs
node scripts/litellm-router-timeout.test.mjs
node scripts/company-provider-startup.test.mjs
node scripts/company-provider-runtime.test.ts
bash -n scripts/start-litellm.sh
git diff --check -- scripts/start-litellm.sh scripts/litellm-macos-startup.test.mjs
```

`litellm-router-timeout.test.mjs` 只访问本机假上游，不访问公司网络。完成标准：测试全绿、shell 语法通过、diff check 通过；变更只影响 LiteLLM 子进程。

## 阶段 3：配置 Clash Verge 的 DIRECT 与内网 DNS

### 3.1 确认代理客户端

本任务按 Clash Verge Rev 编写。其 macOS 配置目录通常是：

```text
~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/
```

如果实际使用其他代理客户端，先报告客户端名称和配置机制，再把下述语义映射到该客户端；不要把 Clash 文件格式硬套过去。

### 3.2 识别公司 DNS

先用 macOS 原生解析器确认公司域名在当前公司网络/VPN下可解析：

```bash
dscacheutil -q host -a name llm-gateway-idc.linshimuye.com
scutil --dns
```

选择规则：

- 有匹配公司域名后缀的专用 resolver 时，使用其中的 nameserver。
- 没有专用 resolver 时，使用当前默认 resolver 的内网 nameserver。
- 记录一到两台当前内网 DNS；不要把另一台电脑的 DNS IP 照搬过来。
- 不向 `1.1.1.1`、`8.8.8.8`、`223.5.5.5`、`119.29.29.29` 等公共 DNS 查询公司域名。

完成标准：macOS 原生解析成功，Agent 已从目标电脑现场配置中得到公司 DNS，而非猜测。

### 3.3 找到活动订阅绑定的扩展

优先通过 Clash Verge UI 编辑当前订阅的 Rules 与 Merge 扩展。若需要读取文件，先从 `profiles.yaml` 找当前订阅及其 `option.rules` / `option.merge`，不得假设固定 UID。

读取元数据时只输出 UID、名称和绑定关系，不输出订阅 URL、secret 或节点内容。修改前给两个扩展文件分别创建带时间戳的备份。

可用下面的只读命令识别绑定关系：

```bash
clash_root="$HOME/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev"
CLASH_ROOT="$clash_root" ruby -ryaml -e 'x=YAML.load_file(File.join(ENV.fetch("CLASH_ROOT"), "profiles.yaml")); get=->(h,k) { h[k] || h[k.to_sym] }; current=get.call(x,"current"); item=Array(get.call(x,"items")).find { |v| get.call(v,"uid") == current }; option=get.call(item,"option") || {}; puts "current_uid=#{current}"; puts "current_name=#{get.call(item,"name")}"; puts "rules_uid=#{get.call(option,"rules")}"; puts "merge_uid=#{get.call(option,"merge")}"'
```

拿到 `rules_uid` 与 `merge_uid` 后，确认对应文件位于 `$clash_root/profiles/`。先备份，再通过 UI 或最小文件补丁合并内容；不得整文件覆盖已有扩展。

### 3.4 Rules 扩展

把以下四条放到当前订阅 Rules 扩展的 `prepend`，保留已有 `append`、`delete` 和其他规则：

```yaml
prepend:
  - 'DOMAIN,llm-gateway-idc.linshimuye.com,DIRECT'
  - 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve'
  - 'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve'
  - 'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve'
```

这四条必须位于运行时规则表最前面；只出现在扩展文件中还不算完成。

### 3.5 Merge 扩展

在当前订阅 Merge 扩展中合并下面的精确域名策略，把占位符替换为阶段 3.2 现场识别到的 DNS。保留 Merge 文件其他键及已有 `nameserver-policy` 条目：

```yaml
dns:
  nameserver-policy:
    'llm-gateway-idc.linshimuye.com':
      - <公司DNS-1>
      - <公司DNS-2>
```

只有一台 DNS 时保留一项即可。本任务不要求重写 `fake-ip-filter`，避免覆盖订阅已有过滤列表。

### 3.6 激活并验证运行时

保存后，在 Clash Verge 的“订阅”页面点击“重新激活订阅”。如应用要求额外确认，按用户对本任务的授权范围处理。

验证生成后的运行时配置，而不是只看源扩展：

- 公司域名 DIRECT 为第 1 条。
- 三个私网网段 DIRECT 紧随其后。
- `dns.nameserver-policy.llm-gateway-idc.linshimuye.com` 等于现场识别的公司 DNS。
- 保持用户原始 TUN 开关状态；此阶段不为了验证擅自切换 TUN。

Clash Verge Rev 当前通常把生成配置写到 `clash-verge.yaml`。重新激活后可做只读检查；若该版本路径不同，使用 UI 的“查看运行时订阅”完成同样核对：

```bash
runtime_config="$clash_root/clash-verge.yaml"
RUNTIME_CONFIG="$runtime_config" ruby -ryaml -e 'x=YAML.safe_load(File.read(ENV.fetch("RUNTIME_CONFIG")), aliases: true) || {}; wanted=[["DOMAIN","llm-gateway-idc.linshimuye.com","DIRECT"],["IP-CIDR","10.0.0.0/8","DIRECT","no-resolve"],["IP-CIDR","172.16.0.0/12","DIRECT","no-resolve"],["IP-CIDR","192.168.0.0/16","DIRECT","no-resolve"]]; actual=Array(x["rules"]).first(4).map { |r| r.to_s.split(",") }; abort("top DIRECT rules mismatch") unless actual == wanted; policy=(x.dig("dns","nameserver-policy") || {})["llm-gateway-idc.linshimuye.com"]; abort("company DNS policy missing") if Array(policy).empty?; puts "top_direct_rules=4 company_dns_policy=present"'
```

完成标准：重新激活成功，运行时配置同时包含四条最高优先级 DIRECT 和精确域名 DNS 策略。若用户切换另一份订阅，需要给新订阅重新绑定相同 Rules/Merge 扩展。

## 阶段 4：启动并做本机验收

优先在长驻终端/PTY中启动工作台，让 `predev` 管理 LiteLLM sidecar：

```bash
npm run dev
```

也可按用户使用习惯运行源码态 `start.command` 或 `start-desktop.command`。不要用一次性 shell 返回值证明 sidecar 长驻。

在另一终端验证：

```bash
curl --noproxy 127.0.0.1 -fsS http://127.0.0.1:4000/health/liveliness
curl --noproxy 127.0.0.1 -fsS -o /dev/null -w 'app_http=%{http_code}\n' http://127.0.0.1:3000/
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:4000 -sTCP:LISTEN
```

预期：

- LiteLLM health 返回 `"I'm alive!"`。
- 工作台返回 HTTP 200。
- 3000 与 4000 都只监听 `127.0.0.1`。

从 `storage/run/stack.json` 读取 LiteLLM PID，并把 `ps` 输出直接交给过滤器；不要把完整进程环境打印到对话：

```bash
litellm_pid="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync("storage/run/stack.json","utf8")); process.stdout.write(String(x.litellmPid))')"
ps eww -p "$litellm_pid" -o command= | ruby -e 's=STDIN.read; %w[HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy].each { |k| puts "#{k}=#{s.match?(/(?:^|\s)#{Regexp.escape(k)}=/) ? "present" : "absent"}" }'
```

完成标准：六个变量全部为 `absent`，同时 Codex/父 shell 的代理配置没有被本任务清除。

## 阶段 5：真实公司链路验收

### 5.1 普通系统代理模式

只有用户明确授权真实公司 API 流量后，才发送一次最小文本请求。当前项目可用的低副作用探针：

```bash
curl --noproxy 127.0.0.1 \
  --silent --show-error --fail \
  --connect-timeout 10 --max-time 120 \
  -H 'Content-Type: application/json' \
  --data '{"model":"GPT-5-6-Luna-Standard","messages":[{"role":"system","content":"You are a connectivity probe."},{"role":"user","content":"只回复 OK"}],"temperature":1,"max_tokens":8}' \
  http://127.0.0.1:4000/v1/chat/completions
```

如果 `config.yaml` 设置了本地 `master_key`，通过临时环境变量添加本地 Authorization header，不把 Key 写进文档、脚本或 shell 历史。

完成标准：HTTP 200，模型返回简短内容；记录状态和 token 用量，不扩展到图片、视频或持久任务。

### 5.2 TUN 模式

TUN 验收是独立门槛。只有用户明确授权切换 TUN 和第二次最小请求时执行：

1. 记录原始 TUN 状态。
2. 开启 TUN，确认 Clash 运行时仍保留四条最高优先级 DIRECT 与公司 DNS policy。
3. 重复阶段 4 的本机验收和阶段 5.1 的一次最小文本请求。
4. 按用户要求保留 TUN，或恢复原始状态。

没有实际开启 TUN 并成功请求时，最终报告必须写“配置已就绪，TUN 开启态未验证”，不能写“TUN 已验证”。

## 故障定位

| 现象 | 优先检查 | 处理目标 |
| --- | --- | --- |
| 日志出现 `_create_proxy_connection` | LiteLLM PID 的六个代理变量 | 只清 LiteLLM 子进程，重启后六项均为 `absent` |
| `Cannot connect to host ...:443` | 公司网络/VPN、DNS、Clash DIRECT 顺序 | 原生 DNS 可解析；公司域名和私网规则位于最前 |
| 仅开启 TUN 后失败 | 运行时 `nameserver-policy` | 公司域名只使用目标电脑当前内网 DNS |
| LiteLLM 启动后很快消失 | 启动终端生命周期、`stack.json`、4000 监听 | 使用长驻终端/PTY；同时验证 PID、端口和 health |
| 4000 被占用 | `lsof` 显示的进程归属 | 不覆盖、不误杀未知进程 |
| Luna 返回 temperature 400 | 请求体 | `GPT-5-6-Luna-*` 固定 `temperature=1` |
| `/v1/models` 正常但真实请求失败 | 上游网络、Key、模型权限 | 模型列表只证明本地配置加载，不证明上游可用 |
| pip 安装尝试 Rust 源码构建 | Python 架构与锁定版本 | 使用原生 arm64 Python 3.12 和仓库锁定的 LiteLLM 版本 |

排障日志：

```text
storage/logs/litellm.out.log
storage/logs/litellm.err.log
storage/run/stack.json
```

读取日志时先脱敏；不得贴出 Authorization、API Key、订阅 URL、完整签名 URL 或完整进程环境。

## 回滚

1. 用备份恢复当前订阅的 Rules/Merge 扩展，再“重新激活订阅”。
2. 如果修改了仓库文件，只反向撤销本任务的具体 hunk；脏工作区中不得用 `git reset --hard` 或整文件 checkout 覆盖用户改动。
3. 只停止项目状态文件记录且路径归属正确的 LiteLLM：

   ```bash
   ./scripts/stop-litellm.sh
   ```

4. `.venv-litellm`、`config.yaml`、日志和用户数据默认保留；删除它们需要用户另行明确授权。
5. 若验收时改变过 TUN，恢复用户要求的最终状态。

## 最终完成标准

全部满足才能报告“普通代理模式部署完成”：

- LiteLLM 依赖与 `config.yaml` 在目标电脑就绪，Key 未泄露。
- LiteLLM 子进程六个代理变量全部缺失；Codex/父 shell 代理保留。
- Next 与 LiteLLM 分别只监听 `127.0.0.1:3000`、`127.0.0.1:4000`。
- Clash 运行时前四条为公司域名和三个私网网段的 DIRECT。
- Clash 运行时公司域名 DNS policy 指向目标电脑现场识别的公司 DNS。
- LiteLLM health 和工作台 HTTP 健康。
- 获授权时，一次最小文本请求 HTTP 200；未获授权则明确标记“未运行”。

只有完成阶段 5.2，才能额外报告“TUN 开启态已验证”。

## Agent 最终报告模板

```text
部署结论：完成 / 部分完成 / 失败

环境：
- macOS / 架构 / Node / Python：
- 仓库分支与原始脏工作区：
- 代理客户端与原始 TUN 状态：

已完成：
- LiteLLM 子进程代理隔离：
- Clash DIRECT：
- 公司 DNS policy：
- 127.0.0.1:3000 / 4000：
- 本地 health：
- 普通代理模式真实文本请求：已运行 / 未获授权
- TUN 开启态真实文本请求：已运行 / 未获授权

验证：
- 测试命令与通过数量：
- HTTP 状态与最小请求 token 数（不得包含 Key）：

改动：
- 仓库文件：
- Clash 扩展及备份：
- 创建的本机运行环境：

未完成或不确定：
-

Git：未暂存 / 未提交 / 未推送
```
