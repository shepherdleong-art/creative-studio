# AGENTS.md

本文件面向 AI 编码代理，介绍本仓库的结构、命令与约定。阅读前默认你对项目一无所知。

> **维护约定（先读这条）**
> - 本文件只写「**读代码读不出来、不写就会踩坑**」的约定与红线。
> - 实现细节写进 `docs/reference/` 并在这里留一行指针；**单条 bullet 超过 3 行就是该下沉的信号**。
> - 变更日志式的「这次 PR 改了什么」不属于本文件——那是 commit message 和 `docs/` 的活。
> - 仓库唯一的说明书就是本文件；`CLAUDE.md` 只是一行 `@AGENTS.md` 引用，**不要在那边另写一份**。

## 项目概览

**Creative Studio（产品素材工作台）** 是一个本地优先的 AI 素材生产工作台：把一张产品素材图推进到「场景图 → 分镜图 → 口播脚本 → 视频任务 → 成片剪辑 → ZIP 导出包」的完整流水线。API Key、项目数据、生成结果全部保存在本机，不依赖外部后台。

- 技术栈：Next.js 16（App Router）+ React 19 + TypeScript（strict）+ Tailwind CSS 4 + SQLite（`better-sqlite3`）+ `sharp`（图片处理）+ `archiver`（ZIP 导出）+ `ffmpeg-static`/`ffprobe-static`（成片渲染）。
- 运行形态：既能 `npm run dev` 作为普通 Web 应用跑，也能打包成带私有 Node 运行时的 Windows（Inno Setup）/ macOS（DMG，仅 Apple Silicon）桌面安装包。
- UI 语言为中文。核心领域术语：项目（project）、场景图（scene image）、分镜（shot/storyboard）、脚本（script）、视频任务（video job）、成片剪辑（final edit）。领域词汇表见 `CONTEXT.md`。
- 许可证：GPL-3.0-only。

## 常用命令

```bash
npm run dev                  # 开发服务器，localhost:3000（需 Node.js 20+）；predev 会先尝试拉起 LiteLLM sidecar（失败只禁用公司供应商，不阻塞 dev）
npm run dev:win              # 开发服务器绑定 127.0.0.1（Windows）
npm run dev:desktop          # 编译 Electron 负载并对既有 standalone 产物跑桌面壳
npm run build                # 生产构建：next build + scripts/sync-standalone-assets.mjs
npm run start                # 启动生产服务器
npm run lint                 # ESLint（eslint.config.mjs，eslint-config-next core-web-vitals + typescript）
npm run icons                # 从源图重新生成应用图标
npm run build:win-installer  # Windows 安装包（PowerShell + Inno Setup，须在 Windows 上跑）
npm run build:mac-installer  # macOS DMG（bash；须 Apple Silicon 主机 + Node 22.x + Xcode CLT）
```

**终端用户快启脚本**（非开发用途）：`start.command` / `stop.command`（macOS 网页版）、`start-desktop.command` / `stop-desktop.command`（macOS 桌面版）、`start-windows.cmd` / `stop-windows.cmd`（Windows）。两个 macOS 入口共用同一数据根，**不能同时跑**（桌面入口在 3000 被占用时会告警）；`start-desktop.command --rebuild` 强制重跑一次 `npm run build`。免安装包装配、便携 Node/Python 运行时与 manifest 校验见 `docs/reference/打包与桌面运行.md`。

**公司网关联动**（macOS / Windows 源码运行）：`.venv-litellm` 与 `config.yaml` 齐备时，各启动入口会先拉起本机 LiteLLM 代理（端口 4000，启动参数**必须显式 `--host 127.0.0.1`**）。组件缺失或 sidecar 失败**只禁用公司供应商，不阻塞工作台**。停止脚本、启动窗口 Ctrl+C、UI 关闭按钮都会把代理一并关掉。完整启停链路与免安装模式差异见 `docs/reference/公司网关与COS中转.md`。

## 测试

没有 `npm test` 脚本。测试是 `scripts/` 下的独立文件，靠 Node 22+ 原生 TypeScript 支持直接运行：

```bash
node scripts/db-migrations.test.ts      # 运行单个测试文件
node scripts/<name>.test.ts             # 其余测试同理
```

- 测试文件为 `scripts/*.test.ts`（少量 `*.test.mjs`），用 `node:assert/strict` 断言，无测试框架。
- 从 `lib/` 导入时带 `.ts` 扩展名（tsconfig 开了 `allowImportingTsExtensions`）。
- 数据库测试用 `better-sqlite3` 的 `:memory:` 实例；文件类测试用 `os.tmpdir()` 下 `fs.mkdtempSync` 的临时目录。
- 部分测试（如 `final-edit-render.test.ts`）会真实调用 ffmpeg/sharp 合成素材，依赖本机 ffmpeg 可用。
- `scripts/final-edit-canvas.playwright.test.mjs` 是 Playwright 浏览器测试，运行方式不同，动它前先看文件头。
- **改动某个模块时，优先跑与它同名的测试文件**（改 `lib/db-migrations.ts` 就跑 `db-migrations.test.ts`）。
- 打包边界测试：`python-runtime-windows.test.mjs`、`company-provider-startup.test.mjs`、`windows-portable-payload.test.mjs`、`standalone-desktop-boundary.test.mjs`、`windows-installer.test.mjs`。`macos-installer-payload.test.mjs` 只能在 Apple Silicon 构建机上跑。

## 目录结构与代码组织

```text
app/                    Next.js 页面与 API 路由
  page.tsx              首页：项目列表
  projects/new          新建项目
  projects/[id]         项目工作台（五个步骤的主界面）
  settings              供应商配置页
  api/                  ~19 组 REST 路由：projects、jobs、images、shot-sets、
                        scene-references、video-jobs、video-prompt-templates、
                        providers、videos、upload、system-fonts、shutdown，
                        以及成片剪辑的 final-edit / final-edit-groups /
                        final-edit-variants / final-edit-jobs /
                        final-edit-assets / final-edit-bgm / final-edit-proposals
components/             React UI（工作台各面板）；components/mixcut/ 是正式第五步“智能混剪”；
                        components/final-edit/ 保留预览、检查器和 Canvas 等共享编辑能力；
                        components/ui/ 是通用原语（目前只有 Icon.tsx）
lib/                    核心业务逻辑（见下）
data/                   本地 SQLite 库 workbench.db（gitignored）
storage/                上传素材、生成产物、日志（gitignored；含 bgm/final-edits/videos 等子目录）
scripts/                测试文件、安装包构建脚本、启停辅助脚本、资源同步脚本
installer/windows/      Electron 安装包脚本（Inno Setup）+ 安装停止/清理 PS 脚本；`launcher.cs` 仅历史资源，不打包
installer/macos/        .app bundle 元数据模板（Info.plist）；launcher.c/launcher.sh 仅历史资源，不打包
docs/                   设计/评审/会话记录，按日期前缀命名；
                        docs/reference/ 放常驻参考（架构细节，见下）；
                        docs/superpowers/{specs,plans}/ 放较大功能的规格与计划文档
                        （目录名属历史沿革，与当前使用的工具无关）
outputs/                阶段性规格、测试清单、交付记录（gitignored）
python-runtime/         免安装包内置便携 Python + LiteLLM（gitignored，只进 Windows 免安装包）
types/                  第三方包的类型补丁（ffprobe-static.d.ts）
```

### `docs/reference/` — 深水区参考

细节多、变动频繁的模块已下沉到这四份文档。**动到对应代码前先读它**，别只看下面的一句话摘要：

| 文档 | 什么时候读 |
| --- | --- |
| `docs/reference/批量生产模块.md` | 改 `lib/batch-production/` 任何东西 |
| `docs/reference/公司网关与COS中转.md` | 改公司网关、尺寸吸附、参考图交付、尾帧、COS |
| `docs/reference/供应商与队列.md` | 新增/修改图片、脚本、视频供应商适配器 |
| `docs/reference/打包与桌面运行.md` | 改打包脚本、快启脚本、Electron 桌面壳 |

### `lib/` 核心模块

**数据库**

- `db.ts` / `db-migrations.ts` — SQLite 初始化（WAL、外键）。`CORE_DB_MIGRATIONS` 是扁平 SQL 列表，启动时逐条执行并 try/catch 跳过已应用项。**新增字段往后追加，不要改已有条目。**
- `schema-upgrade/` — 共享安全升级设施：SQLite Online Backup、磁盘预检、跨进程写锁、可修复 JSONL 审计、统一 gate 与恢复候选重验。路径全部基于 `dataRoot()`；升级失败不得阻塞不依赖新结构的旧功能。
- `video-provider-schema.ts` — 旧 `video_providers` CHECK 约束的安全升级。**只有新增或改为 `openai-video` 供应商时**才在共享锁内先备份再重建；普通数据库启动不得重建旧表。

**批量生产** — 细节见 `docs/reference/批量生产模块.md`

- `batch-production/` — 独立的批量生产 Module，自带 `{version, sql}` 迁移流（v1–v23，权威清单直接看 `schema.ts`）和 `readiness.ts` 闸门。红线：迁移只能追加；批量迁移必须过共享备份/锁/审计 gate，不许塞回会吞错误的旧 core runner；**只从 `media-core/` 导入，绝不从 `final-edit/` 导入**；静音占位素材只能预览，不得通过正式发布。

**供应商与队列** — 细节见 `docs/reference/供应商与队列.md`

- `queue.ts` / `video-queue.ts` — 提交 → 轮询 → 下载 → 重试的内存队列，支持暂停/恢复。视频并发由 `VIDEO_CONCURRENCY` 控制（1–10，默认 10，可按项目在面板调整）。
- `providers/` — 图片生成适配器。多图编辑的图片顺序统一约定为**待编辑底图在前（图1）、参考图在后（图2-N）**。
- `script-providers/` — 脚本（LLM）生成适配器，按持久化的 `apiStyle` 选择协议。公司 `GPT-5-6-Luna-*` **只接受 `temperature=1`**，三层保障与连带影响见参考文档。
- `video-providers/` — 视频生成适配器。尾帧能力由各适配器 `tailFrameCapability(model)` 按**精确模型 allowlist** 声明，不许放宽成前缀匹配。
- `provider-concurrency.ts` / `cost.ts` — 每供应商并发上限；每个 job 记录预估成本。

**公司网关与素材交付** — 细节见 `docs/reference/公司网关与COS中转.md`

- `company-gateway-size.ts`（size 白名单与吸附/裁切映射）、`cos-media.ts`（腾讯云 COS 参考图中转）、`local-image-url.ts`（COS 未配置时的本地 URL 回退）、`gateway-media-url.ts`（结果 URL 归一化与带鉴权下载）、`image-output-normalize.ts`（产出图规整；公司 `nativeDelivery` 模型只裁不缩）、`seed.ts`（内置与公司供应商补种）。
- 红线：**本机服务（app 与代理）不得暴露到公网，公网交付只走 COS**；COS 密钥只在 `.env.local`，签名参数绝不进日志；公司尾帧两帧都必须走 COS 预签名 URL，任一 gate 失败在 POST 前 fail closed。

**成片与媒体**

- `final-edit/` — “智能混剪”第五步的后端：版本化 schema、时间线/字幕领域模型、ffmpeg 渲染、渲染 worker（重启把 running 恢复为 queued）、工作区/提案/BGM，以及视频分析、TTS、对齐等 `adapters/`。共享媒体基础（存储路径、匹配、封面标题、场景检测、TTS 与对齐、`render-contract.ts` 的 24fps / 20 帧片头常量）在 `media-core/`，旧路径只做兼容再导出。**混剪上下文与外部素材按 `projectId + shotSetId` 隔离，不许从文件名或时间戳推断归属。**
- `ffmpeg.ts` — 解析 ffmpeg/ffprobe（`CREATIVE_STUDIO_FFMPEG`/`_FFPROBE` → static 包 → PATH），封装带进度回调、超时、stderr 尾部报错和 AbortSignal 的 `runFfmpeg`，并提供直接子进程的停机广播/等待；`probeDurationSec` 在 ffprobe 失败时回退 ffmpeg 解析。
- `shutdown.ts` — **唯一**的进程级优雅停机编排：停批量调度、广播并排空直接 FFmpeg、关闭 SQLite、按 `stack.json` 受控停 LiteLLM。UI 关闭端点与 SIGTERM/SIGINT 共用且幂等。
- **停机信号契约**：成片 prepare 与批量口播任务向停机 worker 注册**同一个** AbortController；TTS 归一化/拼接与五分钟 prepare 预览都接收任务信号，被打断的 prepare 行退回 `queued` 走租约式恢复。另有三处**按策略保留的信号缺口**（都是有意为之的短调用，靠进程级 FFmpeg 停机兜底）：`lut-catalog.ts`（10s）、`project-asset-media.ts`（60s）、`final-edit/video-frame.ts`（30s）——动它们之前先确认是否还需要保持缺口。

**其他**

- `data-root.ts` — 本地数据根解析（`CREATIVE_STUDIO_DATA_ROOT` 优先，否则 `process.cwd()`）。**所有本地路径一律走 `dataRoot()`，不要硬编码 `data/`、`storage/`。**
- `logger.ts` — 同时写数据库与 `storage/logs/`，主动脱敏 API Key。新增日志点不要打印请求头、密钥或完整鉴权串。

### 数据流

1. 用户创建项目 → 上传场景/输入图 → 配置提示词与模型。
2. 任务提交给供应商，写入 `jobs` 表并记录轮询状态（`lastPolledAt`、`pollCount`、`maxAttempts`）。
3. 队列异步轮询，完成后下载图片并经 sharp 规整尺寸。
4. 结果进 `image_assets`，组织为 `shot_sets` → `shots` → `shot_result_candidates`（保留每次重做的历史候选）。
5. LLM 供应商生成口播脚本；基于分镜创建视频任务。
6. 成片剪辑：分析视频素材 → 生成配音（TTS）与字幕对齐 → 组时间线 → ffmpeg 渲染成片。
7. 项目产物导出为 ZIP（含分镜全部历史候选）。

## 开发约定

- **供应商适配器模式**：图片/脚本/视频三层都用适配器。新增供应商时实现对应 adapter 接口并注册，不要改动队列等核心逻辑。
- **数据库迁移**：核心表继续走 `CORE_DB_MIGRATIONS` 追加式 `ALTER TABLE`；成片剪辑在 `lib/final-edit/schema.ts`（`FINAL_EDIT_MIGRATIONS`）、批量生产在 `lib/batch-production/schema.ts` 各自使用独立 `{version, sql}` 流。批量迁移和旧供应商表重建前必须经 `lib/schema-upgrade/` 完成已验证备份、跨进程锁和审计。**三种流都不许修改已发布条目**，也不许把批量复杂迁移塞回会吞掉错误的旧 core runner。
- **并发**：`projects.concurrency` 控制单个项目的最大并行任务提交数。
- **路径**：所有本地文件路径基于 `dataRoot()`。
- **TypeScript**：strict 模式；路径别名 `@/*` 指向仓库根。ESLint 用 Next.js 官方 flat config，无额外自定义规则。
- **UI**：界面文案为中文；视觉风格为 Apple 官网式精致极简（见 `docs/2026-06-12-session-summary.md`）。
- **外观主题**：全局三态（浅色/深色/跟随系统）由 `html[data-theme="dark"]` 驱动——暗色令牌与组件覆盖集中在 `app/globals.css` 末尾，mixcut 两个 CSS module 各自带暗色覆盖块；偏好存 `localStorage["creative-studio-theme"]`，水合前初始化脚本在 `app/layout.tsx`，切换按钮是 `components/ThemeToggle.tsx`。新增 UI 颜色一律走设计令牌，不要新增硬编码浅色值（深色覆盖只补丁存量）。
- **文档**：常驻架构参考放 `docs/reference/`；设计、评审、会话记录放 `docs/`，文件名带日期前缀（`YYYY-MM-DD-主题.md`）；较大功能的规格与计划放 `docs/superpowers/{specs,plans}/`——**这个目录名是历史沿革，与当前使用的任何 skill 无关**，新文档照旧往里放，不要按名字另起炉灶。
- **关闭端点**：`POST /api/shutdown` 先 await `gracefulShutdown`（各步骤有界超时）再延迟 100ms `process.exit(0)`，供安装版启停脚本调用；不要在开发流程里误触。SIGTERM/SIGINT 也走同一入口。

## Agent skills

本仓库常用的 skill 装在**全局**（Claude Code 插件 `mattpocock-skills@claude-plugins-official`，user scope），仓库里不含任何 skill 文件——换一台机器或新克隆一份代码不会自带，需各自 `claude plugin install mattpocock-skills`。

- **本仓库没跑过 `/setup-matt-pocock-skills`**：`to-tickets`、`triage`、`to-spec` 这类要读 issue tracker 配置的 skill 会现场追问「issue 放哪、label 用什么」。纯方法论的（`tdd`、`diagnosing-bugs`、`grilling`、`prototype`、`research`、`codebase-design`）不受影响，直接可用。
- `CONTEXT.md` 由 `/domain-modeling` 维护，格式见该 skill 的 `CONTEXT-FORMAT.md`（术语 + `_避免：别名_`）。**它只是词汇表**：实现细节、规格、临时笔记一律不进——那些归 `docs/`。
- skill 产出的规格与计划落到 `docs/superpowers/{specs,plans}/`（见「目录结构与代码组织」）。

## 安全注意事项

- `.env.local` 存放 LLM API Key（Gemini、Qwen、Kimi、GPT 等）与腾讯云 COS 密钥（`CREATIVE_STUDIO_COS_*`），**绝不提交**；`.gitignore` 已排除 `.env*`。
- 供应商 API Key 存本地 SQLite（`providers.apiKey` 等列），前端只显示「是否已配置」，不回显明文——保持这个约束。
- `data/`、`storage/`、`outputs/`、`dist/` 是本机运行数据，gitignored，也不要打进安装包。
- 日志会脱敏 API Key（`lib/logger.ts`）；新增日志点不要打印请求头、密钥或完整鉴权串。
- 安装包构建脚本会裁剪并断言负载中不含 `data/`、`storage/`、`outputs/`、`docs/`、`scripts/`、`.git/`、`.env*`、`config.yaml`、`.venv-litellm/`、`python-runtime/`；**改动打包逻辑时保留这些断言**。`python-runtime/` 只进 Windows 免安装包，不进 Git、Inno/DMG 安装包与 standalone。
- 本机服务（app 与 LiteLLM 代理）**不得暴露到公网**，公网交付只走 COS。

## 桌面打包与部署

完整流程、脚本参数与 Electron 状态文件契约见 `docs/reference/打包与桌面运行.md`。必须记住的几条：

- `next.config.ts` 用 `output: 'standalone'`；`ffmpeg-static`/`ffprobe-static` 与 sharp 的 `node_modules/@img` 由 `scripts/sync-standalone-assets.mjs` **强制拷入**（Next 文件追踪只收 `.node`，会漏掉同目录 libvips DLL 导致 `ERR_DLOPEN_FAILED`）。
- **macOS 构建机必须是 arm64 Node 22.x**，主版本或架构不一致会让 `better-sqlite3`/`sharp` 原生模块 ABI 不匹配；另需 Xcode CLT。发版还需 Developer ID + notarytool 配置，`--allow-adhoc` 仅限本地。
- `scripts/*.ps1` 必须存为 **UTF-8 带 BOM**（PS 5.1 按 ANSI 读无 BOM 中文会解析失败）；`storage/run/stack.json` 则是**无 BOM** JSON。
- 打包出的 `.app` 不含 `config.yaml` 与 `.venv-litellm/`，所以**公司供应商只在源码运行时可用，安装版永远没有**。
- 用户侧 macOS 安装/卸载/数据位置说明见 `MACOS.md`。
