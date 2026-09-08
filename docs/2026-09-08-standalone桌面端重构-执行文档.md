# standalone 桌面端重构 — 执行文档

> 2026-09-08 立项。依据：`docs/reference/打包与桌面运行.md` + 当日全量勘察（勘察结论见下）。
> 执行方式：按 Phase 逐段由子代理实施，每阶段独立可验证、由主代理复核 diff 后单独 commit，全部完成后统一 push。
> **方案决策（已经批准）：Phase 1 采用 Node 单一实现**（备选保守版见 §九，仅作存档）。
> **每阶段开工前重读本文件与 `docs/reference/打包与桌面运行.md`。**

## 一、目标与非目标

**目标（四项全做，Windows/macOS 双平台对齐）：**

1. 收敛启停与状态管理的重复实现（端口探测×6 处、stack.json 管理×7 处、electron-service.json 校验×4 处，PS/bash 各一套）。
2. 打包流水线整合：禁止清单单一来源（next.config.ts / sync-standalone-assets.mjs / build-win-installer.ps1 / build-mac-installer.sh 四处手工同步）。
3. Electron 壳内部结构梳理（desktop/ 模块拆分，保持安全契约不变量）。
4. 清死代码与过期文案。

**非目标（明确不做）：**

- macOS 免安装包 / 便携 Python（红线：`python-runtime/` 只进 Windows 免安装包；macOS 继续 `.venv-litellm`）。
- `runtime/server-entry.js` 的猴子补丁机制（随机端口 + ready 标记 + instanceId 核身已闭环，不动）。
- launcher.cs / launcher.c / launcher.sh 删除（测试快照守护的历史资源：windows-installer.test.mjs 断言 launcher.cs 不得编译；macos-installer.test.mjs 读取 launcher.c/sh 做守护快照）。
- 公司供应商进入安装版（红线：安装版永远没有公司供应商）。
- 功能面改动（本次不碰业务功能）。

## 二、现状关键事实（勘察结论）

### desktop/（Electron 壳，被测试固化的干净资产）

- `desktop/main.ts`（579 行）：单实例锁、BrowserWindow、close-to-hide、before-quit 确认（查 `/api/desktop/activity`）、`resolveServicePaths()`（`:388-405`，优先 `.next/standalone/runtime/server-entry.js`，可用 `CREATIVE_STUDIO_STANDALONE_ROOT` 覆盖）。
- `desktop/service.ts`（572 行）：spawn 私有 Node（跳过 Electron 自身）+ 环境注入（`:525-550`，含 `loadEnvFile(<dataRoot>/.env.local)`、`CREATIVE_STUDIO_DESKTOP_SECRET` 每次启动新生成）+ ready 标记解析（`:317-347`）+ health instanceId 核身（`:354-398`）+ 状态文件 `storage/run/electron-service.json`（`:107-132`，0600 原子写）+ 停机链（`:414-488`，POST /api/shutdown → 等 20s → 进程组 SIGTERM → SIGKILL；Win 用 taskkill /T /F）。
- `desktop/ipc.ts`（117 行）：8 通道，7 个 `ipcMain.handle` 全走 `protectedHandler`（senderFrame === mainFrame 且 sameOrigin）。`desktop/preload.ts`（59 行）：冻结 7 方法白名单，无 fs/path/child_process。
- 守护测试：`scripts/electron-shell-security.test.mjs`（**不硬编码 desktop 文件清单**，断言不变量：恰好一个 `new BrowserWindow`、6 项 webPreferences 显式、通道字面量双端一致、依赖图无 native/无越界相对 import/无动态 require）、`scripts/electron-phase234-contract.test.mjs`。**结论：模块拆分可行，不变量必须保持。**
- `dist-desktop/` 是 `tsc -p desktop/tsconfig.json` 产物（commonjs，outDir 平铺），gitignored。

### 启停脚本与状态文件（债集中区）

- 端口探测 6 处半重复：`start-windows.ps1:37`、`start-desktop-windows.ps1:209`、`start-stack.ps1:134-139`、`stop-stack.ps1:15-29`、`stop-windows.ps1:19-54`、mac 侧 5 处 lsof（start/stop.command、start-desktop/stop-desktop.command、start-litellm.sh）。
- stack.json 管理 7 处：写（start-stack.ps1、start-litellm.sh）、删（stop-stack.ps1、stop-litellm.sh）、检查（start-desktop-windows.ps1、start-windows.ps1、stop-windows.ps1）、读（lib/shutdown.ts）。**PS/bash 字段不一致**：PS 版有 `appCmdPid/appPort/litellmRuntime/litellmInterpreter`，bash 版没有。
- electron-service.json「正则校验 origin + instanceId health 核身」4 处独立实现：`desktop/service.ts`、`stop-windows.ps1:60-79`、`stop-desktop.command:28-61`、`installer/windows/stop-installed.ps1:21-52`。
- `start-litellm.sh:32` 已内联 `node -e` 读 stack.json——「脚本调 node」是既有模式，收敛到 Node 工具不引入新前提。

### 打包链与禁止清单

- 三条链：`build-win-installer.ps1`（Inno）、`build-windows-portable.ps1`（免安装包，8 步白名单装配）、`build-mac-installer.sh`（DMG，仅 arm64）。
- 禁止清单 4 处手工同步：`next.config.ts:11-32`（outputFileTracingExcludes 24 项）、`sync-standalone-assets.mjs`（localOnlyRoots 清理 + 断言）、`build-win-installer.ps1:160-242`（双层 prune）、`build-mac-installer.sh`（PRUNE_RELATIVE_PATHS + find 删除）。
- 免安装包运行时脚本白名单在 `build-windows-portable.ps1:90-99`（8 个脚本），改动启停脚本文件名/参数时必须同步此清单与 `verify-portable-payload.mjs`、`start-desktop-windows.ps1` 的 manifest 预检。

### 死代码与过期文案

- `installer/windows/start-installed.ps1`：全仓内容级 grep 零引用（iss、构建脚本、测试都不提），确认死代码。
- `start-stack.ps1:102` 非 SkipApp 分支硬编码 `.cache\windows-installer\node-v22.22.3-win-x64\node.exe` 作 app Node——该分支无人使用（网页版走 dev、桌面版不经 start-stack 起 app），潜在死路径。
- 旧产品名「批量图片编辑工作台」残留：`start-windows.ps1:14`、`start-desktop-windows.ps1:34`、`start/stop.command` 头部。

### 已知缺口（2026-08-10 整改文档，非本期范围，仅登记）

3 处 FFmpeg 短调用信号缺口（lut-catalog.ts:269 / project-asset-media.ts:230 / final-edit/video-frame.ts:48，有意保留）、桌面内点参考图是下载而非新标签、linked 大素材登记 60s 无进度、混剪不支持原生导入、`batch-render-smoke.test.ts` 存量失败。

## 三、红线（全程不得破）

- `scripts/*.ps1` 必须存为 **UTF-8 带 BOM**；`stack.json` 必须**无 BOM** JSON。
- 停机链 fail-closed 语义不得弱化：优雅停机 → 超时 → 按归属校验强杀；3000/4000 未知属主只报告不杀。
- 安装包负载禁入断言（data/storage/outputs/docs/scripts/.git/.env*/config.yaml/.venv-litellm/python-runtime）保留且继续由测试守护。
- 本机服务绑定 127.0.0.1 不变，不得暴露公网。
- 公司供应商只在源码运行时可用。

## 四、Phase 0 — 死代码与过期文案（小步先行，单独提交）

1. 删 `installer/windows/start-installed.ps1`；再跑一次内容级 grep 确认零引用；`windows-installer.test.mjs` 若有快照断言同步删。
2. `start-stack.ps1` 非 SkipApp 死分支移除或改为显式报错引导走 start-desktop-windows.ps1；同步 `company-provider-startup.test.mjs` 契约断言。
3. 旧产品名统一改「产品素材工作台」：`start-windows.ps1`、`start-desktop-windows.ps1`、`start.command`、`stop.command`、`start-desktop.command`、`stop-desktop.command` 的头部注释/横幅。
4. 验证：`node scripts/windows-installer.test.mjs`、`node scripts/company-provider-startup.test.mjs`、`start-*`/`stop-*` 契约测试全绿；改动过的 .ps1 重存 BOM 并由测试断言。
5. 提交：`refactor: 清理安装版死代码与脚本过期文案`。

## 五、Phase 1 — 启停与状态管理收敛（核心，Node 单一实现）

### 5.1 新增 `scripts/runtime/`（.mjs，Node 22 直跑，零新增依赖）

- `ports.mjs` — `findListenerPids(port)`（Windows `netstat -ano` / unix `lsof -ti tcp:<port>` 单处封装）、`waitPortReleased(port, timeoutMs)`。
- `process-tree.mjs` — `assertOwnedByRoot(pid, rootDir)`（Win：CIM 进程命令行/可执行路径归属；unix：`ps` command/cwd 校验）、`killTree(pid)`（Win `taskkill /T /F`；unix 进程组 SIGTERM → 2s → SIGKILL）。
- `stack-state.mjs` — stack.json 读/写/清/校验，统一 schema：`{ version, appPid?, appPort?, appCmdPid?, litellmPid?, litellmPort?, litellmRuntime?, litellmInterpreter?, startedAt }`，原子写（tmp+rename）无 BOM。读取方对缺字段容忍（`lib/shutdown.ts` 的 `stopControlledSidecar` 兼容旧缺字段文件）。
- `desktop-service.mjs` — electron-service.json 读/校验 + `/api/desktop/health` instance 核身 + 优雅停机链（POST /api/shutdown 15s 预算 → 轮询最长 20s → 归属校验后兜底强杀；未知属主只报告）。CLI 形态：`node scripts/runtime/desktop-service.mjs stop --root <dataRoot>`，供三个停止脚本共用。

### 5.2 脚本改薄壳 delegate

- Windows：`stop-windows.ps1`、`stop-stack.ps1`、`installer/windows/stop-installed.ps1`、`start-stack.ps1` 端口预检段、`start-desktop-windows.ps1:209` 的 3000 占用检查、`start-windows.ps1:37`。
- macOS：`stop-desktop.command`（三 dataRoot 扫描 + health 核身 + 强杀段）、`stop.command`、`start-litellm.sh` 的 stack.json 读写段、`stop-litellm.sh`。
- delegate 失败（node 缺失/工具异常）必须明确报错退出非零，不得静默跳过停机。

### 5.3 测试

- 新增：`scripts/runtime-ports.test.mjs`（真 loopback 监听测探测与释放等待）、`runtime-stack-state.test.mjs`（临时目录测 schema/原子写/缺字段容忍）、`runtime-desktop-service.test.mjs`（本地 http server 测 health 核身与停机链，含 instance 不匹配不误杀）。
- 契约测试同步改断言为「delegate 到共享工具」：`stop-desktop-command.test.mjs`、`company-provider-startup.test.mjs`、`windows-installer.test.mjs` 的 stop-installed 段、`start-*`/`stop-*` 静态契约。
- 免安装包白名单同步：`build-windows-portable.ps1:90-99` 运行时脚本白名单需包含新增 `scripts/runtime/*.mjs`（或以目录收录），`verify-portable-payload.mjs` 与启动预检同步。

### 5.4 验证与提交

验证矩阵全跑（见 §八）+ Windows 本机真实烟测（桌面版 start/stop、网页版 start/stop、sidecar 拉起/回收）。提交：`refactor: 启停与状态管理收敛到共享 Node 运行时工具`。

## 六、Phase 2 — 禁止清单单一来源

1. 新增 `scripts/packaging/forbidden-paths.json`：核心禁入清单 + 各消费者合法差集的结构化表达（standalone 额外排除 desktop/dist-desktop 等）。
2. 消费者改读共享清单：
   - `next.config.ts`（outputFileTracingExcludes；TS import JSON，注意 Next config 加载方式兼容）；
   - `scripts/sync-standalone-assets.mjs`（localOnlyRoots 清理与断言）；
   - `scripts/build-win-installer.ps1`（`Get-Content | ConvertFrom-Json`）；
   - `scripts/build-mac-installer.sh`（`node -p` 读取）。
3. 守护测试改为「消费者清单 == 共享清单 + 声明差集」：`standalone-desktop-boundary.test.mjs`、`windows-installer.test.mjs`、`macos-installer.test.mjs`、`windows-portable-payload.test.mjs`。
4. 验证：`npm run build` 全量 + 边界测试套件。提交：`refactor: 打包禁止清单单一来源化`。

## 七、Phase 3 — desktop/ 模块拆分（纯机械，契约不变）

- `main.ts` → `main.ts`（入口/单实例锁/生命周期编排）+ `window.ts`（BrowserWindow 创建、close-to-hide、before-quit 确认）+ `theme.ts`（nativeTheme 同步）。
- `service.ts` → `service-spawn.ts`（Node 路径解析、env 注入、spawn）+ `service-ready.ts`（ready 标记 + health 核身）+ `service-state.ts`（electron-service.json 原子读写清）+ `service-shutdown.ts`（停机链）。
- 约束：全部相对 import 平铺（tsconfig outDir 平铺，打包 package.json main 指向不变）；**恰好一个 `new BrowserWindow`**、全部 `ipcMain.handle` 走 protectedHandler、preload 白名单、通道字面量不变。
- 验证：`electron-shell-security.test.mjs`、`electron-phase234-contract.test.mjs`、`standalone-desktop-boundary.test.mjs` 全绿 + `npm run build` + 桌面真实启动烟测。提交：`refactor: desktop 壳按职责拆分模块`。

## 八、验证矩阵（每阶段收尾必跑）

```bash
node scripts/standalone-desktop-boundary.test.mjs
node scripts/electron-shell-security.test.mjs
node scripts/electron-phase234-contract.test.mjs
node scripts/windows-portable-payload.test.mjs      # Windows 行为段需 win32
node scripts/verify-portable-payload.test.mjs
node scripts/windows-installer.test.mjs
node scripts/macos-installer.test.mjs
node scripts/company-provider-startup.test.mjs
node scripts/python-runtime-windows.test.mjs
node scripts/portable-data-migration.test.mjs && node scripts/portable-data-migration-wrapper.test.mjs
node scripts/release-version.test.mjs
npx tsc --noEmit && npm run lint
```

macOS 真机烟测清单（用户在 Mac 上执行）：start.command / stop.command、start-desktop.command / stop-desktop.command、`scripts/build-mac-installer.sh`（若本期动到 DMG 链）。

## 九、备选方案存档（未采用）

Phase 1 不做 Node 单一实现，改为语言内收敛：PS 侧抽共享 `.psm1` 模块、bash 侧抽共享 `lib.sh`，跨语言双实现保留。工作量约一半、风险更低，但 PS/bash 两份逻辑仍需手工对齐，stack.json schema 不一致问题依旧。若 Node delegate 路线发现不可行点（如某脚本运行环境无 node），回退此方案并在本节记录原因。

## 十、执行记录

| 阶段 | 状态 | 提交 | 备注 |
|---|---|---|---|
| Phase 0 | ✅ 完成 | 见 git log | 2026-09-08：start-installed.ps1 删除；start-stack.ps1 死分支移除+非 SkipApp 显式拒绝；旧产品名修正含 start.sh/stop.sh（README 引用、面向终端）；launcher.vbs / create-desktop-shortcut.ps1 属安装包剔除的历史/行为面文件，不动。既有环境性失败（与本次无关）：start-desktop/stop-desktop-command 契约测试的 Unix 可执行位断言在 Windows Checkout 恒失败；litellm-macos-startup 读本机 gitignored config.yaml 的断言失败 |
| Phase 1 | ✅ 完成 | 3c843a9 + 4ba26b2 | 1a 共享工具+4 单测；1b Win/Mac 全部 delegate。补记：build-win-installer.ps1 必须随包装配 runtime 工具（已补，原文档遗漏）；desktop/service.ts 状态文件无 pid 字段 → desktop-service.mjs 的 killed 分支暂不可达，stop-windows.ps1 保留端口属主兜底强杀；stop.sh 仍内联 lsof（原 §二 漏计，实为 6 处），留 Phase 4 对齐 |
| Phase 2 | ✅ 完成 | aca303b | forbidden-paths.json 单一来源（core+消费者差集+fileEntries）；实际消费者 5 个（新发现 macos-installer-payload.test.mjs 硬编码同清单）；修正失同步：.claude 入 core；JSON 必须 ASCII-only（PS 5.1 按 ANSI 读无 BOM 文件的坑，已加测试断言）；勘误 §二：next.config excludes 实际 18 项（非 24）；npm run build 全量跑通 |
| Phase 3 | ✅ 完成 | 466920b | main/service 拆分为 7 个模块（main/window/theme/service-spawn/ready/state/shutdown）；守护测试按新结构 retarget 且断言语义不降级；免安装包 desktop 文件白名单 4→9 同步（payloadFiles/manifest/启动预检/verify-portable-payload 四处）；Inno/DMG 整目录拷贝 dist-desktop 无需改；dev:desktop 真实烟测通过（启动→health 核身→共享工具优雅停机→干净退出） |
| Phase 4 | ✅ 完成 | 见 git log | stack.json schema 两端一致（Phase 1b 已落）；macOS 脚本 delegate（Phase 1b 已落）；发现并根治 start.sh/stop.sh 漂移：两文件是 .command 的过期变体（start.sh 裸 `npm run dev` 无 `--hostname 127.0.0.1`，会绑 0.0.0.0 暴露局域网；stop.sh 无 LiteLLM 侧车清理且无归属校验）→ 改为单行转发 shim，.command 为单一事实来源。macOS 真机烟测清单待用户在 Mac 执行 |
