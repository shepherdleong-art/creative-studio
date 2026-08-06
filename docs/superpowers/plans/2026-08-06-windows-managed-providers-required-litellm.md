# Windows Managed Providers and Required LiteLLM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重新构建 Windows 安装包，使受管安装版只显示并执行 provision 清单中的公司图片、脚本、视频供应商和固定豆包 TTS；LiteLLM 自动启动且健康前全局锁定生产功能；源码开发模式保持原行为。

**Architecture:** 用 `CREATIVE_STUDIO_MANAGED_DEPLOYMENT=1` 区分 Windows 受管安装版。provision 导入原子发布无秘密的 v2 清单；服务端以“受管状态机 + 供应商角色策略”为唯一权威，列表、CRUD、任务创建和队列执行都复用同一策略。Windows 启动链以 UTF-8 启动私有 CPython/LiteLLM，并通过无秘密状态文件向 Node/UI 暴露 `unconfigured / starting / ready / failed`。豆包 TTS 继续直连官方 HTTPS API，但调用前仍须通过全局 LiteLLM 就绪门禁。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript strict、SQLite/better-sqlite3、Node.js 原生测试、C# Windows launcher、PowerShell 5.1、Inno Setup、私有 CPython 3.12.10 + LiteLLM 1.89.2。

---

## 依据与不变量

- 已批准设计：[Windows 受管供应商与 LiteLLM 强制启动设计](../specs/2026-08-06-windows-managed-providers-required-litellm-design.md)。
- 当前实机根因：`H:\Creative Studio\storage\logs\litellm.err.log` 中是 CP936 读取 UTF-8 `config.yaml` 触发的 `UnicodeDecodeError`；同一内置 Python 加 `-X utf8` 后可读取。
- 只在“已安装 Windows 布局”设置受管变量。`npm run dev`、`npm run dev:win`、`start-windows.cmd`、macOS 和 launcher 的源码开发布局都保持 unrestricted。
- v1 provision envelope 不升级；升级的是导入后的本地 `data/provisioning/state.json`，从 v1 到 v2。
- v1 本地状态在受管模式下一律视为需要重新导入，不根据名称、模型名或 URL 猜测供应商。
- 历史供应商行不删除、不改写为其他供应商，也不作为 fallback；受管安装版通过读过滤、写拒绝和执行复检使其不可见、不可编辑、不可调用。
- 豆包固定 ID 为 `doubao-seed-tts-2`、类型为 `doubao-http-chunked`，直连 provision 验证过的 HTTPS endpoint。
- LiteLLM 只监听 `127.0.0.1:4000`；未知进程占用端口时不得接管或结束该进程。
- API、状态文件和 UI 不返回 API Key、密码、完整 YAML、runtime env、PID、Authorization/Bearer 或带签名 COS URL。
- 当前工作树已有用户改动：
  - `scripts/build-win-installer.ps1`
  - `scripts/windows-installer.test.mjs`

  实施时先读 diff，再在其基础上追加；不得回退其中对 `.tmp-pdf-text` 的裁剪和负载禁入断言。
- 所有改动过的 `installer/windows/*.ps1` 与 `scripts/*.ps1` 保存为 UTF-8 BOM；状态 JSON 保存为 UTF-8 无 BOM。
- 自动化 smoke test 不调用真实公司模型或真实豆包 TTS，不产生计费。

## 文件地图

### 新增生产文件

- `lib/managed-deployment.ts`：受管环境开关与公共 phase 类型。
- `lib/managed-provider-policy.ts`：四类供应商的纯策略、数据库读取和拒绝错误。
- `lib/managed-workbench.ts`：组合 provision v2 与 LiteLLM runtime，得出全局 phase。
- `lib/company-sidecar-control.ts`：以固定参数异步启动/重启受控 PowerShell 脚本。
- `app/api/managed-deployment/status/route.ts`：安全状态查询。
- `app/api/managed-deployment/guard.ts`：生产 API 复用的 HTTP 423 门禁。
- `app/api/company-provider/start/route.ts`：固定 action 的 LiteLLM 重试入口。
- `components/managed-deployment/ManagedDeploymentProvider.tsx`：客户端状态上下文与轮询。
- `components/managed-deployment/ManagedDeploymentNotice.tsx`：全局锁定提示。
- `components/managed-deployment/ManagedProviderSettings.tsx`：受管只读设置与导入/重试。
- `installer/windows/restart-company-sidecar.ps1`：只回收归属当前安装根的 sidecar 后重启。

### 新增测试文件

- `scripts/managed-provider-policy.test.ts`
- `scripts/managed-deployment-runtime.test.ts`
- `scripts/managed-provider-routes.test.mjs`
- `scripts/managed-provider-execution.test.ts`
- `scripts/managed-api-guard-coverage.test.mjs`
- `scripts/managed-deployment-ui-contract.test.mjs`
- `scripts/windows-managed-installer-smoke.test.mjs`

### 主要修改文件

- Provision：`lib/provisioning/types.ts`、`lib/provisioning/service.ts`、`app/api/provisioning/route.ts`、`components/provisioning/ProvisioningImportCard.tsx`。
- Runtime：`lib/company-provider-runtime.ts`、`lib/provider-execution-gate.ts`、`instrumentation.ts`。
- Provider API：`app/api/providers/route.ts`、`app/api/providers/[id]/route.ts`、`app/api/providers/[id]/activate-only/route.ts`、`app/api/providers/script/route.ts`、`app/api/providers/script/[id]/route.ts`、`app/api/providers/video/route.ts`、`app/api/providers/video/[id]/route.ts`、`app/api/providers/tts/route.ts`、`app/api/providers/tts/[id]/route.ts`、`app/api/providers/tts/[id]/preview/route.ts`。
- 执行入口：`lib/image-provider-selection.ts`、`lib/queue.ts`、`lib/script-providers/store.ts`、`lib/script-providers/index.ts`、`lib/video-queue.ts`、`lib/final-edit/runtime.ts`、`lib/final-edit/worker.ts`、`lib/batch-production/executors.ts`、`lib/batch-production/narration-executor.ts`、`lib/batch-production/runner.ts`。
- 页面：`app/layout.tsx`、`app/page.tsx`、`app/settings/page.tsx`、`app/projects/new/page.tsx`、`app/projects/[id]/page.tsx`、`components/ProviderSettings.tsx`、`components/company-provider/CompanyProviderRuntimeStatus.tsx`。
- Windows：`installer/windows/launcher.cs`、`installer/windows/start-company-sidecar.ps1`、`installer/windows/start-installed.ps1`、`installer/windows/README-INSTALLED.md`、`installer/windows/CreativeStudio.iss`、`scripts/build-litellm-sidecar.ps1`、`scripts/build-win-installer.ps1`。
- 回归测试：`scripts/provisioning.test.ts`、`scripts/company-provider-runtime.test.ts`、`scripts/company-provider-startup.test.mjs`、`scripts/litellm-sidecar.test.mjs`、`scripts/windows-installer.test.mjs`、`scripts/provider-execution-gate.test.ts`、`scripts/image-provider-selection.test.ts`、`scripts/provider-config-resolvers.test.ts`。

## Task 1：发布 provision v2 受管清单

**Files**

- Modify: `lib/provisioning/types.ts`
- Modify: `lib/provisioning/service.ts`
- Test: `scripts/provisioning.test.ts`

- [ ] **Step 1：先写失败测试**

在 `scripts/provisioning.test.ts` 增加以下断言场景：

1. 导入后 `state.json` 为 schema v2，四类数组只来自已验证 payload。
2. TTS 数组只包含固定 `doubao-seed-tts-2`。
3. `readProvisioningState` 会重验 `config.yaml` SHA-256。
4. v1、篡改 hash、重复 ID、非法 TTS ID 都返回未配置。
5. 数据库 upsert 失败时 config、runtime env、state 和数据库都回到导入前状态。
6. 第二次导入原子替换清单和凭据，不残留旧 video ID。
7. 状态 JSON 不含 gateway key、TTS key、COS key、YAML 或密码。

测试使用固定非秘密 ID：

```ts
assert.deepEqual(state.managedProviders, {
  image: ['company-image'],
  script: ['company-script'],
  video: ['company-video-a', 'company-video-b'],
  tts: ['doubao-seed-tts-2'],
});
assert.equal(state.schemaVersion, 2);
```

- [ ] **Step 2：运行测试并确认红灯**

Run: `node scripts/provisioning.test.ts`
Expected: 因 `readProvisioningState` 和 v2 字段尚不存在而失败；不能是测试语法错误。

- [ ] **Step 3：定义无秘密的 v2 类型**

在 `lib/provisioning/types.ts` 增加：

```ts
export const PROVISIONING_STATE_SCHEMA_VERSION = 2 as const;

export interface ManagedProviderAllowlist {
  image: string[];
  script: string[];
  video: string[];
  tts: ['doubao-seed-tts-2'];
}

export interface ProvisioningStateV2 {
  schemaVersion: typeof PROVISIONING_STATE_SCHEMA_VERSION;
  profileName: string;
  importedAt: string;
  configHash: string;
  managedProviders: ManagedProviderAllowlist;
}
```

保留 `PROVISIONING_SCHEMA_VERSION = 1`，因为加密 envelope 格式没有变化。

- [ ] **Step 4：让状态成为最后发布点**

在 `lib/provisioning/service.ts`：

- 从验证后的 payload 构造 allowlist；对 video ID 去重并保持 payload 顺序。
- 暴露 `readProvisioningState(root)`，只返回完整校验通过的 v2 对象或 `null`。
- 把数据库语句改为可由外层 transaction 包裹的函数。
- 在同一 SQLite transaction 中依次安装 config/runtime、upsert 数据库、最后安装 state；任何异常都回滚 SQLite 并恢复文件快照。
- 不修改非清单供应商行。
- `readProvisioningStatus` 只从 `readProvisioningState` 派生安全摘要。

核心构造必须等价于：

```ts
const managedProviders: ManagedProviderAllowlist = {
  image: [payload.image.id],
  script: [payload.script.id],
  video: Array.from(new Set(payload.videos.map((provider) => provider.id))),
  tts: ['doubao-seed-tts-2'],
};
```

- [ ] **Step 5：回归**

Run: `node scripts/provisioning.test.ts`
Expected: PASS，且临时目录无残留 `.tmp`/`.bak`。

- [ ] **Step 6：提交**

```powershell
git add -- lib/provisioning/types.ts lib/provisioning/service.ts scripts/provisioning.test.ts
git commit -m "feat: publish managed provider provisioning state"
```

## Task 2：建立纯受管供应商策略

**Files**

- Create: `lib/managed-deployment.ts`
- Create: `lib/managed-provider-policy.ts`
- Create: `scripts/managed-provider-policy.test.ts`

- [ ] **Step 1：写策略矩阵测试**

覆盖：

- 未设置受管变量时所有现有 provider 行都是 unrestricted。
- 受管但无有效 v2 state 时四类 provider 均拒绝。
- ID 在清单但角色结构不符仍拒绝。
- image 只允许 `gateway-task-image`、loopback URL 和公司 gateway key env。
- script 只允许 `executionScope=company`、loopback URL 和三种 provision 脚本协议。
- video 只允许 `openai-video`、loopback URL 和公司 gateway key env。
- TTS 只允许固定 ID、`doubao-http-chunked` 和 HTTPS endpoint。
- `localhost`、`127.0.0.1`、`[::1]` 接受；带用户名/密码、非 HTTP 或非 loopback 拒绝。
- 轮换后的旧 ID 立即拒绝，不 fallback 到新 ID。

代表性断言：

```ts
const verdict = evaluateManagedProvider({
  managed: true,
  kind: 'video',
  allowlist,
  provider: {
    id: 'company-video-a',
    type: 'kling',
    baseUrl: 'http://127.0.0.1:4000/v1',
    apiKeyEnv: 'CREATIVE_STUDIO_GATEWAY_API_KEY',
  },
});
assert.deepEqual(verdict, {
  allowed: false,
  code: 'managed_provider_role_invalid',
  message: '该供应商不符合公司受管配置',
});
```

- [ ] **Step 2：确认红灯**

Run: `node scripts/managed-provider-policy.test.ts`
Expected: module-not-found。

- [ ] **Step 3：实现环境开关和纯策略**

`lib/managed-deployment.ts` 的公共契约：

```ts
export const MANAGED_DEPLOYMENT_ENV = 'CREATIVE_STUDIO_MANAGED_DEPLOYMENT';
export type ManagedWorkbenchPhase =
  | 'unrestricted'
  | 'unconfigured'
  | 'starting'
  | 'ready'
  | 'failed';

export function isManagedDeployment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[MANAGED_DEPLOYMENT_ENV] === '1';
}
```

`lib/managed-provider-policy.ts` 提供：

- `evaluateManagedProvider`：无 I/O 的结构策略。
- `assertManagedProviderAllowed`：统一抛出带稳定 code 的错误。
- `filterManagedProviders`：集合 API 过滤。
- `loadManagedProviderAllowlist`：从 `readProvisioningState` 加载，不自行猜测。

稳定拒绝码至少包含：

```ts
export type ManagedProviderPolicyCode =
  | 'managed_state_missing'
  | 'managed_provider_not_allowed'
  | 'managed_provider_role_invalid';
```

- [ ] **Step 4：策略回归**

Run: `node scripts/managed-provider-policy.test.ts`
Expected: PASS。

Run: `node scripts/provider-config-resolvers.test.ts`
Expected: PASS，证明 unrestricted 解析没有回归。

- [ ] **Step 5：提交**

```powershell
git add -- lib/managed-deployment.ts lib/managed-provider-policy.ts scripts/managed-provider-policy.test.ts
git commit -m "feat: enforce managed provider identities"
```

## Task 3：建立 LiteLLM 状态机、控制器和服务端门禁

**Files**

- Create: `lib/managed-workbench.ts`
- Create: `lib/company-sidecar-control.ts`
- Create: `app/api/managed-deployment/status/route.ts`
- Create: `app/api/managed-deployment/guard.ts`
- Create: `app/api/company-provider/start/route.ts`
- Create: `scripts/managed-deployment-runtime.test.ts`
- Modify: `lib/company-provider-runtime.ts`
- Modify: `app/api/provisioning/route.ts`
- Modify: `instrumentation.ts`
- Modify: `scripts/company-provider-runtime.test.ts`

- [ ] **Step 1：写状态机和控制器失败测试**

用临时 data root、注入 fetch/processCheck/spawn 验证：

- unrestricted 不读 provision，不启动 PowerShell。
- v1/缺失/哈希错误为 `unconfigured`。
- v2 有效且 sidecar status 为 starting 时为 `starting`。
- 只有受控 PID 存活、listener 归属一致且 health HTTP 200 才为 `ready`。
- runtime 缺失、未知端口占用、提前退出、健康超时都为 `failed`，reason 是固定安全文案。
- status API 不包含 root、PID、命令行、Key 或日志正文。
- `requestCompanySidecar('start')` 与 `requestCompanySidecar('restart')` 只拼固定脚本和固定参数。
- provision 导入成功触发 restart；导入失败不触发。
- 并发 start 幂等，不产生第二个受管 sidecar。

状态响应契约：

```ts
assert.deepEqual(status, {
  managed: true,
  phase: 'starting',
  configured: true,
  profileName: '公司统一配置',
  importedAt: '2026-08-06T00:00:00.000Z',
  configHashPrefix: '0123456789ab',
  proxyAvailable: false,
  reason: '正在启动公司模型服务',
});
```

- [ ] **Step 2：确认红灯**

Run: `node scripts/managed-deployment-runtime.test.ts`
Expected: 新模块不存在。

- [ ] **Step 3：扩展 runtime 检查**

`lib/company-provider-runtime.ts`：

- 增加 `starting` 状态。
- 读取 `storage/run/company-sidecar-status.json`，只接受 schema、status、code、reason、updatedAt 的窄类型。
- `stack.json` 仍用于进程归属验证，但 API 永不返回 PID/path。
- health 只请求 loopback liveliness，不探测真实公司上游。
- 即使 safe status 写了 ready，也必须重新验证受控 PID 和 health 200。

- [ ] **Step 4：实现受管工作台组合状态**

`lib/managed-workbench.ts` 提供：

```ts
export interface ManagedWorkbenchStatus {
  managed: boolean;
  phase: ManagedWorkbenchPhase;
  configured: boolean;
  profileName: string | null;
  importedAt: string | null;
  configHashPrefix: string | null;
  proxyAvailable: boolean;
  reason: string;
}

export async function inspectManagedWorkbench(): Promise<ManagedWorkbenchStatus>;
export async function assertManagedWorkbenchReady(): Promise<void>;
```

非受管直接返回 `unrestricted`；受管按 provision v2 优先，再组合 sidecar runtime。

- [ ] **Step 5：实现固定参数 sidecar 控制器**

`lib/company-sidecar-control.ts` 使用 `spawn('powershell.exe', args, { windowsHide: true, detached: true, stdio: 'ignore' })`，确认返回 ChildProcess 后调用 `unref()`；脚本路径只能由 `dataRoot()` 下的安装布局推导。允许 action 只有 `start` 和 `restart`；任何用户输入都不得进入命令行。

- [ ] **Step 6：接入 API、导入和开机**

- `GET /api/managed-deployment/status` 返回安全状态。
- `POST /api/company-provider/start` 受管模式下触发 start，立即返回 `202`；unrestricted 返回 `404`。
- `POST /api/provisioning` 成功发布后触发 restart，响应改为“正在启动公司模型服务”，不再要求重启 EXE。
- `instrumentation.ts` 在加载 provision runtime env 后，仅受管模式异步 ensure-start；不得阻塞 Node/UI 启动。
- `app/api/managed-deployment/guard.ts` 将未 ready 映射为 HTTP `423` 和稳定 JSON：

```ts
{
  error: '请先导入公司配置并等待 LiteLLM 就绪',
  code: 'managed_workbench_locked',
  phase: 'unconfigured'
}
```

- [ ] **Step 7：回归**

Run:

```powershell
node scripts/managed-deployment-runtime.test.ts
node scripts/company-provider-runtime.test.ts
node scripts/provisioning.test.ts
```

Expected: 全部 PASS，无 PowerShell 子进程被真实启动。

- [ ] **Step 8：提交**

```powershell
git add -- lib/managed-workbench.ts lib/company-sidecar-control.ts lib/company-provider-runtime.ts app/api/managed-deployment app/api/company-provider/start app/api/provisioning/route.ts instrumentation.ts scripts/managed-deployment-runtime.test.ts scripts/company-provider-runtime.test.ts
git commit -m "feat: gate managed workbench on LiteLLM readiness"
```

## Task 4：修复 Windows UTF-8 sidecar 并标记安装布局

**Files**

- Create: `installer/windows/restart-company-sidecar.ps1`
- Modify: `installer/windows/launcher.cs`
- Modify: `installer/windows/start-company-sidecar.ps1`
- Modify: `installer/windows/start-installed.ps1`
- Modify: `installer/windows/CreativeStudio.iss`
- Modify: `installer/windows/README-INSTALLED.md`
- Modify: `scripts/build-litellm-sidecar.ps1`
- Modify: `scripts/build-win-installer.ps1`
- Modify: `scripts/company-provider-startup.test.mjs`
- Modify: `scripts/litellm-sidecar.test.mjs`
- Modify: `scripts/windows-installer.test.mjs`

- [ ] **Step 1：先审阅已有工作树修改**

Run:

```powershell
git diff -- scripts/build-win-installer.ps1 scripts/windows-installer.test.mjs
```

Expected: 只看到已知的 `.tmp-pdf-text` 裁剪/禁入修正。后续补丁在该 diff 上追加。

- [ ] **Step 2：扩充静态契约测试**

测试必须断言：

- launcher 仅 installed 分支设置 `CREATIVE_STUDIO_MANAGED_DEPLOYMENT=1`。
- launcher 仅 installed 分支调用强制 sidecar ensure；源码 dev layout 不改为受管启动链。
- dev layout 不设置受管变量。
- sidecar Python 参数包含 `-X utf8 -m litellm.proxy.proxy_cli`。
- 子进程环境包含 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`LITELLM_LOCAL_MODEL_COST_MAP=True`。
- sidecar 只接受 provision state schema v2。
- 启动脚本写无 BOM `company-sidecar-status.json`。
- 缺 runtime、state 无效、未知端口、提前退出、健康超时均写 failed 并返回非零。
- restart 脚本只停止 `stack.json` 证明属于当前 runtime/config/root 的 PID。
- build payload 包含 start/stop/restart 脚本和私有 runtime。
- 所有 PowerShell 文件有 UTF-8 BOM。
- 负载仍排除 `data`、`storage`、`outputs`、`docs`、`scripts` 开发目录、真实 `config.yaml`、`.env*`、`*.provision` 和 `.tmp-pdf-text`；安装版所需的裁剪后 `scripts` 目录只含明确 allowlist。

- [ ] **Step 3：确认旧实现不满足契约**

Run:

```powershell
node scripts/company-provider-startup.test.mjs
node scripts/litellm-sidecar.test.mjs
node scripts/windows-installer.test.mjs
```

Expected: 至少因 optional/best-effort 文案、schema v1 或缺 `-X utf8` 失败。

- [ ] **Step 4：修改 launcher 的布局信号**

让 `DetectLayout` 额外返回 `bool isInstalled`。只有 `isInstalled` 为 true 才调用 `StartCompanySidecar` 并给 Node 设置：

```csharp
psi.EnvironmentVariables["CREATIVE_STUDIO_MANAGED_DEPLOYMENT"] = "1";
```

Node 仍立即启动以显示导入 UI；sidecar 启动失败不弹出致命 launcher 对话框，但服务端状态必须保持 locked/failed。删掉“optional”“workbench remains usable offline”等旧语义。

- [ ] **Step 5：修复 sidecar 编码和状态发布**

`start-company-sidecar.ps1` 使用参数数组，不把 Key 放入命令行：

```powershell
$sidecarArguments = @(
  '-X', 'utf8',
  '-m', 'litellm.proxy.proxy_cli',
  '--host', '127.0.0.1',
  '--port', [string]$proxyPortNumber,
  '--num_workers', '1',
  '--config', $ConfigPath,
  '--telemetry', 'false'
)
[Environment]::SetEnvironmentVariable('PYTHONUTF8', '1', 'Process')
[Environment]::SetEnvironmentVariable('PYTHONIOENCODING', 'utf-8', 'Process')
```

每个分支原子写安全状态：

```json
{
  "schemaVersion": 1,
  "status": "failed",
  "code": "runtime_missing",
  "reason": "内置 LiteLLM 运行环境缺失，请重新安装",
  "updatedAt": "2026-08-06T00:00:00.000Z"
}
```

状态 JSON 无 PID、路径或秘密；完整脱敏诊断仍写本地日志。ready 前不得写 ready。

launcher、instrumentation 和导入后的 restart 可能同时触发启动。脚本须先在 `storage/run/company-sidecar-start.lock` 获取跨进程独占 FileStream，并持有到复用已有进程或完成 health 判定；未获得锁的调用等待当前状态收敛后退出，不能再创建第二个 Python 进程。锁文件不保存内容，进程退出即释放句柄。

- [ ] **Step 6：实现 restart 与构建复制**

- restart 先调用既有受控 stop，再调用 start。
- `start-installed.ps1` 设置 data root 和 managed env。
- `build-litellm-sidecar.ps1` 的 import/self-check 同样使用 `-X utf8`。
- Inno 与 build 脚本复制 restart controller。
- README 改为“LiteLLM 是受管安装版生产功能的必需服务”。
- 用 .NET `UTF8Encoding($true)` 重新保存所有改动过的 PS1，保持 BOM。

- [ ] **Step 7：回归**

Run:

```powershell
node scripts/company-provider-startup.test.mjs
node scripts/litellm-sidecar.test.mjs
node scripts/windows-installer.test.mjs
```

Expected: 全部 PASS，测试 YAML 含 `价格 € / 中文` 等非 CP936 安全字符。

- [ ] **Step 8：PowerShell 5.1 语法与 BOM 检查**

Run:

```powershell
$paths = @(
  'installer/windows/start-company-sidecar.ps1',
  'installer/windows/restart-company-sidecar.ps1',
  'installer/windows/start-installed.ps1',
  'scripts/build-litellm-sidecar.ps1',
  'scripts/build-win-installer.ps1'
)
foreach ($path in $paths) {
  $tokens = $null
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $path), [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count) { throw ($errors | Out-String) }
  $bytes = [IO.File]::ReadAllBytes((Resolve-Path $path))
  if ($bytes.Length -lt 3 -or $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
    throw "$path is missing its UTF-8 BOM"
  }
}
'POWERSHELL_UTF8_BOM_OK'
```

Expected: `POWERSHELL_UTF8_BOM_OK`。

- [ ] **Step 9：提交**

先用 `git diff --check` 和 `git diff --stat` 确认边界，然后：

```powershell
git add -- installer/windows/launcher.cs installer/windows/start-company-sidecar.ps1 installer/windows/restart-company-sidecar.ps1 installer/windows/start-installed.ps1 installer/windows/CreativeStudio.iss installer/windows/README-INSTALLED.md scripts/build-litellm-sidecar.ps1 scripts/build-win-installer.ps1 scripts/company-provider-startup.test.mjs scripts/litellm-sidecar.test.mjs scripts/windows-installer.test.mjs
git commit -m "fix: require UTF-8 LiteLLM in Windows installer"
```

## Task 5：锁定供应商列表和 CRUD API

**Files**

- Create: `scripts/managed-provider-routes.test.mjs`
- Modify: `app/api/providers/route.ts`
- Modify: `app/api/providers/[id]/route.ts`
- Modify: `app/api/providers/[id]/activate-only/route.ts`
- Modify: `app/api/providers/script/route.ts`
- Modify: `app/api/providers/script/[id]/route.ts`
- Modify: `app/api/providers/video/route.ts`
- Modify: `app/api/providers/video/[id]/route.ts`
- Modify: `app/api/providers/tts/route.ts`
- Modify: `app/api/providers/tts/[id]/route.ts`
- Modify: `lib/script-providers/store.ts`

- [ ] **Step 1：写 API 绕过测试**

测试三组环境：

1. unrestricted：现有 list/CRUD 契约不变。
2. managed + unconfigured：四个 list 都返回空数组；item 不暴露历史行。
3. managed + v2：list 只返回“ID 在清单且角色结构有效”的行；隐藏 item 返回 404；所有 POST/PATCH/PUT/DELETE/activate-only 返回 403。

统一只读错误：

```json
{
  "error": "受管安装版只能通过统一配置导入更新供应商",
  "code": "managed_provider_read_only"
}
```

不得把“存在但被隐藏”和“确实不存在”区分给客户端。

- [ ] **Step 2：确认红灯**

Run: `node scripts/managed-provider-routes.test.mjs`
Expected: 现有 route 尚未调用受管策略而失败。

- [ ] **Step 3：在所有 provider route 复用同一策略**

- GET collection：先读数据库，再按 kind 调用 `filterManagedProviders`。
- GET item：查询后调用 `assertManagedProviderAllowed`；拒绝映射为 404。
- 所有通用写方法：解析 body/formData 和写数据库之前先拒绝。
- script store 的 `getAvailableProviders` 和 `resolveStoredScriptProvider` 也按策略过滤/拒绝，避免内部调用绕过 HTTP。
- 返回结构继续只包含 `hasApiKey/configured`，不回显 key。

- [ ] **Step 4：回归**

Run:

```powershell
node scripts/managed-provider-routes.test.mjs
node scripts/provider-config-resolvers.test.ts
node scripts/provider-execution-gate.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5：提交**

```powershell
git add -- app/api/providers lib/script-providers/store.ts scripts/managed-provider-routes.test.mjs
git commit -m "feat: make managed providers read only"
```

## Task 6：锁定项目、图片、脚本和视频生产入口

**Files**

- Create: `scripts/managed-provider-execution.test.ts`
- Create: `scripts/managed-api-guard-coverage.test.mjs`
- Modify: `lib/provider-execution-gate.ts`
- Modify: `lib/image-provider-selection.ts`
- Modify: `lib/queue.ts`
- Modify: `lib/script-providers/index.ts`
- Modify: `lib/video-queue.ts`
- Modify: `app/api/projects/route.ts`
- Modify: `app/api/projects/[id]/run/route.ts`
- Modify: `app/api/projects/[id]/scene-jobs/route.ts`
- Modify: `app/api/projects/[id]/script/route.ts`
- Modify: `app/api/projects/[id]/video-run/route.ts`
- Modify: `app/api/shot-sets/[id]/apply-scene/route.ts`
- Modify: `app/api/shot-sets/[id]/video-jobs/route.ts`
- Modify: `app/api/shot-sets/[id]/video-jobs/batch/route.ts`
- Modify: `app/api/jobs/[id]/regenerate/route.ts`
- Modify: `app/api/jobs/[id]/retry/route.ts`
- Modify: `app/api/jobs/[id]/resume-poll/route.ts`
- Modify: `app/api/video-jobs/[id]/retry/route.ts`
- Modify: `app/api/video-jobs/[id]/resume-poll/route.ts`
- Modify: every `app/api/**/route.ts` that exports POST, PUT, PATCH or DELETE and is not one of the explicit locked-state exemptions below

- [ ] **Step 1：写双层门禁失败测试**

使用注入的 adapter 计数器验证：

- API 非 ready 时在读取上传体或写任务前返回 423。
- 静态覆盖测试扫描全部 route 文件；每个 POST/PUT/PATCH/DELETE handler 必须调用全局受管 guard、受管 provider 写拒绝，或属于精确的豁免清单。
- ready 但 provider 不在 allowlist 时返回稳定拒绝，不创建 job。
- queue 在真正调用 adapter 前重新检查 ready + provider policy。
- 导入轮换后，已排队旧 provider job 失败为明确受管策略错误，adapter 调用次数为 0。
- image resolver 的 SELECT 包含 `type/baseUrl/apiKeyEnv/enabled` 并执行角色校验。
- script `completeJson`、视觉分析、video submit/poll/resume 全部二次复检。
- unrestricted 的已有 provider 仍可通过原 gate。

代表性执行边界：

```ts
await assertManagedWorkbenchReady();
assertManagedProviderAllowed('image', provider, allowlist);
await adapter.submit(request);
```

- [ ] **Step 2：确认红灯**

Run: `node scripts/managed-provider-execution.test.ts`
Expected: adapter 被调用或缺少受管错误码，因此失败。

- [ ] **Step 3：扩展统一执行错误**

`lib/provider-execution-gate.ts` 增加：

```ts
type ProviderExecutionGateCode =
  | 'ready'
  | 'managed_workbench_locked'
  | 'managed_provider_not_allowed'
  | 'managed_provider_role_invalid'
  | 'provider_disabled'
  | 'provider_unconfigured'
  | 'provider_route_invalid'
  | 'runtime_not_configured'
  | 'runtime_stopped'
  | 'runtime_unavailable'
  | 'transport_unavailable';
```

受管模式先验证全局 ready 和 allowlist；unrestricted 继续走现有语义。

- [ ] **Step 4：覆盖所有有副作用的 API，而不只覆盖模型 route**

`POST /api/projects` 也必须锁定，确保“新建项目”无法通过直接 API 绕过。只读项目列表和详情保持可读。所有 POST/PUT/PATCH/DELETE handler 在解析大文件、写数据库、触发文件操作或启动队列前调用 shared guard。

锁定态的全局豁免只有：

- `POST /api/provisioning`：导入或轮换统一配置。
- `POST /api/company-provider/start`：重试启动 LiteLLM。
- `POST /api/shutdown`：正常回收应用和受管 sidecar。
- batch/task control 请求中的 `pause / stop / cancel`：只允许停止或降级运行状态；同一 route 的 `resume` 仍需 ready。

provider CRUD route 不在豁免中：受管模式始终由 Task 5 的只读策略拒绝。上传、项目编辑/删除、素材变更、代理生成、LUT/BGM 导入、final-edit 写操作、batch 写操作都在 locked 时返回 423。另对有写副作用的 GET `/api/batch-production/prepare` 与 `/api/projects/[id]/final-edit/bootstrap` 做显式门禁。

`scripts/managed-api-guard-coverage.test.mjs` 扫描 route 源码并维护上述三条固定 path 豁免和两条 action 级豁免；任何新 mutation handler 未声明 guard 时测试失败并打印具体文件。

- [ ] **Step 5：在 queue/adapter 前二次复检**

- `lib/queue.ts` 每次加载 job provider 后检查 enabled、全局 ready 和 image policy。
- `lib/script-providers/index.ts` 在 `completeJson`、`analyzeSellingPoints`、视觉分析入口检查。
- `lib/video-queue.ts` 在 submit、needs_check 补抓和 retry claim 后检查。
- 不自动替换 providerId。

- [ ] **Step 6：回归**

Run:

```powershell
node scripts/managed-provider-execution.test.ts
node scripts/managed-api-guard-coverage.test.mjs
node scripts/provider-execution-gate.test.ts
node scripts/image-provider-selection.test.ts
```

Expected: 全部 PASS，adapter 负例调用次数为 0。

- [ ] **Step 7：提交**

```powershell
git add -- lib/provider-execution-gate.ts lib/image-provider-selection.ts lib/queue.ts lib/script-providers/index.ts lib/video-queue.ts app/api 'scripts/managed-provider-execution.test.ts' 'scripts/managed-api-guard-coverage.test.mjs'
git commit -m "feat: guard managed model execution"
```

## Task 7：锁定豆包 TTS、单条混剪与批量生产

**Files**

- Modify: `app/api/providers/tts/[id]/preview/route.ts`
- Modify: `app/api/projects/[id]/final-edit/bootstrap/route.ts`
- Modify: `app/api/projects/[id]/final-edit/draft/route.ts`
- Modify: `app/api/projects/[id]/final-edit/preflight/route.ts`
- Modify: `app/api/projects/[id]/final-edit/start/route.ts`
- Modify: `app/api/final-edit-assets/[videoJobId]/reanalyze/route.ts`
- Modify: `app/api/final-edit-groups/[id]/narration/route.ts`
- Modify: `app/api/final-edit-variants/[id]/render/route.ts`
- Modify: `app/api/final-edit-jobs/[id]/retry/route.ts`
- Modify: `app/api/batch-production/prepare/route.ts`
- Modify: `app/api/batch-production/batches/route.ts`
- Modify: `app/api/batch-production/batches/[id]/snapshot/route.ts`
- Modify: `app/api/batch-production/batches/[id]/start/route.ts`
- Modify: `app/api/batch-production/batches/[id]/assets/analyze/route.ts`
- Modify: `app/api/batch-production/tasks/[taskId]/retry/route.ts`
- Modify: `app/api/batch-production/tasks/[taskId]/control/route.ts`
- Modify: `app/api/batch-production/batches/[id]/control/route.ts`
- Modify: `lib/final-edit/runtime.ts`
- Modify: `lib/final-edit/worker.ts`
- Modify: `lib/batch-production/executors.ts`
- Modify: `lib/batch-production/narration-executor.ts`
- Modify: `lib/batch-production/runner.ts`
- Test: `scripts/managed-provider-execution.test.ts`
- Test: `scripts/final-edit-doubao-tts.test.ts`
- Test: `scripts/final-edit-tts.test.ts`
- Test: `scripts/batch-narration-seam.test.ts`
- Test: `scripts/batch-render-narration-gate.test.ts`
- Test: `scripts/batch-m2-narration-bgm.test.ts`

- [ ] **Step 1：扩展失败测试**

增加：

- LiteLLM failed 时豆包 preview、final-edit narration、batch narration 均拒绝，HTTP/worker 都不调用 TTS adapter。
- ready 时只有 `doubao-seed-tts-2` 可用。
- 豆包请求目标保持其 provision HTTPS URL，绝不改成 `127.0.0.1:4000`。
- V-API 或历史 TTS provider 即使 enabled 也不可用。
- final-edit 视觉分析和批量内容分析只用受管 script provider。
- batch runner 领取历史任务时再次复检 provider 和全局 ready。
- locked 时 pause/stop/cancel 仍可执行；resume/retry/start 被拒绝。

- [ ] **Step 2：确认红灯**

Run: `node scripts/managed-provider-execution.test.ts`
Expected: TTS 或 worker 负例仍触发 adapter。

- [ ] **Step 3：在 TTS 和 worker 的最后边界复检**

`lib/final-edit/runtime.ts` 和 `lib/batch-production/narration-executor.ts` 在读取 provider 行后、`getFinalEditTtsAdapter` 或 `synthesize` 前：

```ts
await assertManagedWorkbenchReady();
assertManagedProviderAllowed('tts', {
  id: providerId,
  type: row.type,
  baseUrl: row.baseUrl,
  keyEnv: row.keyEnv,
}, allowlist);
```

不要把豆包 base URL 重写到 LiteLLM。final-edit worker、batch executors/runner 同样在真实 adapter 前检查。

- [ ] **Step 4：覆盖所有生产 route**

- final-edit 的 bootstrap/draft/preflight/start、重新分析、生成口播、render、retry 调 shared guard。
- batch 的 prepare、创建、snapshot、start、素材分析、retry 调 shared guard。
- batch/task control 解析目标状态后：`pause/stop/cancel` 放行，`resume` 要求 ready。
- 纯读取、recovery listing、shutdown 保持可用。

- [ ] **Step 5：回归**

Run:

```powershell
node scripts/managed-provider-execution.test.ts
node scripts/final-edit-doubao-tts.test.ts
node scripts/final-edit-tts.test.ts
node scripts/batch-narration-seam.test.ts
node scripts/batch-render-narration-gate.test.ts
node scripts/batch-m2-narration-bgm.test.ts
```

Expected: 全部 PASS；测试网络层只访问本地 fake server。

- [ ] **Step 6：提交**

```powershell
git add -- 'app/api/providers/tts/[id]/preview/route.ts' 'app/api/projects/[id]/final-edit' 'app/api/final-edit-assets/[videoJobId]/reanalyze/route.ts' 'app/api/final-edit-groups/[id]/narration/route.ts' 'app/api/final-edit-variants/[id]/render/route.ts' 'app/api/final-edit-jobs/[id]/retry/route.ts' app/api/batch-production/prepare/route.ts app/api/batch-production/batches/route.ts 'app/api/batch-production/batches/[id]/snapshot/route.ts' 'app/api/batch-production/batches/[id]/start/route.ts' 'app/api/batch-production/batches/[id]/assets/analyze/route.ts' 'app/api/batch-production/tasks/[taskId]/retry/route.ts' 'app/api/batch-production/tasks/[taskId]/control/route.ts' 'app/api/batch-production/batches/[id]/control/route.ts' lib/final-edit/runtime.ts lib/final-edit/worker.ts lib/batch-production/executors.ts lib/batch-production/narration-executor.ts lib/batch-production/runner.ts scripts/managed-provider-execution.test.ts scripts/final-edit-doubao-tts.test.ts scripts/final-edit-tts.test.ts scripts/batch-narration-seam.test.ts scripts/batch-render-narration-gate.test.ts scripts/batch-m2-narration-bgm.test.ts
git commit -m "feat: gate managed editing and Doubao TTS"
```

## Task 8：实现首启锁定 UI 和只读设置页

**Files**

- Create: `components/managed-deployment/ManagedDeploymentProvider.tsx`
- Create: `components/managed-deployment/ManagedDeploymentNotice.tsx`
- Create: `components/managed-deployment/ManagedProviderSettings.tsx`
- Create: `scripts/managed-deployment-ui-contract.test.mjs`
- Modify: `app/layout.tsx`
- Modify: `app/page.tsx`
- Modify: `app/settings/page.tsx`
- Modify: `app/projects/new/page.tsx`
- Modify: `app/projects/[id]/page.tsx`
- Modify: `components/ProviderSettings.tsx`
- Modify: `components/provisioning/ProvisioningImportCard.tsx`
- Modify: `components/company-provider/CompanyProviderRuntimeStatus.tsx`

- [ ] **Step 1：写 UI 契约测试**

断言源码与渲染契约包含：

- 初始状态未知时显示 skeleton，不短暂显示第三方 CRUD。
- unconfigured 首页主操作是“先导入公司配置”，新建按钮 disabled/不可导航。
- starting 显示“正在启动公司模型服务”并每 1 秒轮询。
- ready 自动停止快速轮询并解锁，无需刷新/重启。
- failed 显示安全原因、“重新启动 LiteLLM”和“重新导入配置”。
- managed 设置页没有供应商类型选择、新增、删除、启停或 key 编辑控件。
- ready 设置页只读显示 profile、导入时间、代理状态及四类允许供应商。
- unrestricted 设置页继续呈现完整现有 CRUD。
- 直接访问 `/projects/new` 或项目工作台时，非 ready 只显示锁定面板，不挂载生产组件。

- [ ] **Step 2：确认红灯**

Run: `node scripts/managed-deployment-ui-contract.test.mjs`
Expected: 新组件不存在。

- [ ] **Step 3：实现全局客户端状态**

`ManagedDeploymentProvider` 首次拉取 `/api/managed-deployment/status`；managed 且 starting/failed 时轮询，ready/unrestricted 降低或停止轮询；导入和重试后提供 `refreshNow()`。

公共 hook：

```ts
export interface ManagedDeploymentContextValue {
  loading: boolean;
  status: ManagedWorkbenchStatus | null;
  locked: boolean;
  refreshNow: () => Promise<void>;
}

export function useManagedDeployment(): ManagedDeploymentContextValue;
```

- [ ] **Step 4：改首页和工作台入口**

- 首页仍可读取并展示空项目列表。
- 非 ready 时不以 `href="/projects/new"` 渲染主按钮。
- 首页醒目卡片直达 `/settings#provisioning`。
- `projects/new` 与 `projects/[id]` 在加载任何 provider/生产组件前分支到 `ManagedDeploymentNotice`。
- 若重装保留旧项目，只显示项目存在和锁定说明，不进入生产。
- 首页的项目删除、项目编辑和其他写操作在 locked 时隐藏或禁用；服务端覆盖测试保证直接请求同样返回 423。

- [ ] **Step 5：分流设置页**

`app/settings/page.tsx` 等状态确定后再选择：

```tsx
if (managed.loading) return <SettingsSkeleton />;
if (managed.status?.managed) return <ManagedProviderSettings />;
return <DeveloperProviderSettings />;
```

受管组件保留 provision 导入和 key 轮换，但所有供应商为只读。现有 generic fetch/effect 只在 unrestricted 分支执行，避免隐藏数据先请求再闪现。

- [ ] **Step 6：更新导入反馈**

导入成功后立即显示 starting，调用 `refreshNow`；删除“关闭并重新打开”文案。重试按钮 POST `/api/company-provider/start`，随后轮询 status。

- [ ] **Step 7：回归**

Run:

```powershell
node scripts/managed-deployment-ui-contract.test.mjs
node scripts/final-edit-mixcut-ui-contract.test.mjs
node scripts/batch-phase-e-ui-contract.test.mjs
```

Expected: 全部 PASS。

- [ ] **Step 8：提交**

```powershell
git add -- components/managed-deployment app/layout.tsx app/page.tsx app/settings/page.tsx 'app/projects/new/page.tsx' 'app/projects/[id]/page.tsx' components/ProviderSettings.tsx components/provisioning/ProvisioningImportCard.tsx components/company-provider/CompanyProviderRuntimeStatus.tsx scripts/managed-deployment-ui-contract.test.mjs
git commit -m "feat: add managed deployment onboarding"
```

## Task 9：完成源码级回归与安全审计

**Files**

- Modify only when a failing assertion reveals an in-scope defect.

- [ ] **Step 1：运行全部新增与直接相关测试**

Run:

```powershell
node scripts/provisioning.test.ts
node scripts/managed-provider-policy.test.ts
node scripts/managed-deployment-runtime.test.ts
node scripts/managed-provider-routes.test.mjs
node scripts/managed-provider-execution.test.ts
node scripts/managed-api-guard-coverage.test.mjs
node scripts/managed-deployment-ui-contract.test.mjs
node scripts/company-provider-runtime.test.ts
node scripts/company-provider-startup.test.mjs
node scripts/litellm-sidecar.test.mjs
node scripts/windows-installer.test.mjs
node scripts/provider-execution-gate.test.ts
node scripts/image-provider-selection.test.ts
node scripts/provider-config-resolvers.test.ts
node scripts/final-edit-doubao-tts.test.ts
node scripts/final-edit-tts.test.ts
node scripts/batch-narration-seam.test.ts
node scripts/batch-render-narration-gate.test.ts
node scripts/batch-m2-narration-bgm.test.ts
```

Expected: 全部退出码 0。

- [ ] **Step 2：lint 与生产构建**

Run:

```powershell
npm run lint
npm run build
```

Expected: ESLint 0 error；Next production build 和 standalone asset sync 成功。

- [ ] **Step 3：检查开发模式不变**

在未设置 managed env 的测试进程运行 provider route 与 execution 回归；断言第三方列表、CRUD 和 external execution 的原有契约仍通过。确认 `start-windows.cmd` 和 macOS 文件不含 `CREATIVE_STUDIO_MANAGED_DEPLOYMENT`。

Run:

```powershell
rg -n "CREATIVE_STUDIO_MANAGED_DEPLOYMENT" start-windows.cmd installer/macos scripts/build-mac-installer.sh
```

Expected: 无匹配，`rg` 退出码 1。

- [ ] **Step 4：秘密与路径审计**

Run:

```powershell
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' "Authorization|Bearer |gatewayApiKey|secretKey|runtime.env|config.yaml" app/api/managed-deployment app/api/company-provider lib/managed-workbench.ts lib/company-sidecar-control.ts components/managed-deployment installer/windows/start-company-sidecar.ps1 installer/windows/restart-company-sidecar.ps1
```

Expected: 只出现输入字段名、固定文件名或明确的拒绝/脱敏代码；不存在打印值、响应回显或把秘密拼进命令行的逻辑。

- [ ] **Step 5：diff 审核**

Run:

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: 无 whitespace error；改动仅覆盖本计划文件地图和已知安装包修正。

- [ ] **Step 6：返回所属任务修复回归**

仅当本任务产生代码修复时：

```powershell
git add -- lib/managed-workbench.ts scripts/managed-deployment-runtime.test.ts
git commit -m "test: close managed installer regressions"
```

这条提交只处理状态机回归；其他失败回到拥有该文件的 Task，使用该 Task 已列出的精确文件集合提交。不得使用 `git add .`。

## Task 10：重建 EXE、扫描负载并做隔离 smoke test

**Files**

- Create: `scripts/windows-managed-installer-smoke.test.mjs`
- Modify: `scripts/windows-installer.test.mjs` when the packaged contract needs an additional assertion
- Build output: `dist/windows/CreativeStudioSetup.exe`

- [ ] **Step 1：先写安装后 smoke test**

测试脚本必须：

1. 接受固定 CLI 参数 `--installer dist/windows/CreativeStudioSetup.exe`。
2. 在 `os.tmpdir()` 创建唯一安装目录和唯一 data root。
3. 静默安装后确认 bundled Node、Python、LiteLLM、start/stop/restart 脚本存在。
4. 首启确认 app 只监听 `127.0.0.1`，status 为 unconfigured，新建项目 API 返回 423，四类 provider list 为空。
5. 生成只含 dummy key 和 `example.invalid` 上游的测试 provision；通过真实导入 API 导入，绝不发起模型/TTS调用。
6. 让真实 bundled LiteLLM 读取含 `价格 € / 中文` 的 UTF-8 YAML，确认 phase 从 starting 到 ready。
7. 确认 ready 后只列出测试清单中的公司 image/script/video 和固定豆包，历史 seeded Kling/Jimeng 不可见。
8. 停止流程后确认 Node 与 owned LiteLLM 都退出。
9. 在 `finally` 中只清理测试创建且已验证位于该唯一临时根下的目录。

- [ ] **Step 2：提交 smoke 测试**

```powershell
git add -- scripts/windows-managed-installer-smoke.test.mjs scripts/windows-installer.test.mjs
git commit -m "test: add managed Windows installer smoke"
```

- [ ] **Step 3：构建安装包**

Run:

```powershell
npm run build:win-installer
```

Expected: `dist/windows/CreativeStudioSetup.exe` 存在，构建脚本完成 payload forbidden-path assertions。

- [ ] **Step 4：静态负载与签名信息检查**

Run:

```powershell
node scripts/windows-installer.test.mjs
Get-Item -LiteralPath 'dist/windows/CreativeStudioSetup.exe' | Select-Object FullName,Length,LastWriteTime
Get-FileHash -Algorithm SHA256 -LiteralPath 'dist/windows/CreativeStudioSetup.exe'
Get-AuthenticodeSignature -LiteralPath 'dist/windows/CreativeStudioSetup.exe' | Select-Object Status,StatusMessage
```

Expected: 测试 PASS；输出文件大小和 SHA-256；签名状态如实记录，不把未签名描述成已签名。

- [ ] **Step 5：运行隔离安装 smoke**

Run:

```powershell
node scripts/windows-managed-installer-smoke.test.mjs --installer dist/windows/CreativeStudioSetup.exe
```

Expected: PASS；无真实模型或 TTS 请求；临时 Node/LiteLLM 全部回收。

- [ ] **Step 6：验证现有测试安装的升级行为**

对用户明确指定的 `H:\Creative Studio` 先做只读路径解析和进程归属检查，再用新 EXE 覆盖升级；不得删除该目录或本地数据。升级后：

- 旧 v1 state 显示“请重新导入公司配置”并保持锁定。
- 用户在页面重新导入真实 provision 和密码。
- 不重启 EXE，LiteLLM 自动启动并转 ready。
- 页面只显示公司供应商和豆包。
- 只执行 health/list/门禁验证，不发真实计费模型请求。

此步骤需要写入 `H:\Creative Studio` 时按执行环境申请权限；如果用户尚未在场输入 provision 密码，就停在明确的“等待用户导入”验收点，不读取或索要明文 Key。

- [ ] **Step 7：最终交付记录**

最终答复必须给出：

- 新安装包的绝对可点击路径。
- 文件大小、SHA-256、Authenticode 实际状态。
- 自动化测试、production build、隔离 smoke 的结果。
- `H:\Creative Studio` 是否已升级，以及是否仍等待用户重新导入。
- 明确说明：受管安装版只有公司 API + 豆包；豆包直连官方；LiteLLM 未 ready 时生产功能保持锁定；开发模式不受影响。

## 完成定义

- 所有十个任务的 checkbox 均完成。
- 受管模式的策略在 UI、HTTP route、provider resolver、queue/worker 四层一致。
- locked 状态除 provision、LiteLLM 重试、shutdown 和安全停止动作外保持只读。
- fresh install 首屏可打开但生产锁定，提示先导入。
- 导入后自动 restart/start LiteLLM，健康后无重启解锁。
- 每次 installed EXE 启动都 ensure LiteLLM；失败可见、可重试、不可降级生产。
- 安装版不可见、不可编辑、不可执行非清单 provider。
- 豆包只直连官方 HTTPS endpoint，但全局门禁仍依赖 LiteLLM ready。
- unrestricted 开发流程通过回归。
- 新 EXE 完成负载扫描、隔离 smoke，并交付 hash。
