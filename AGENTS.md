# AGENTS.md

本文件面向 AI 编码代理，介绍本仓库的结构、命令与约定。阅读前默认你对项目一无所知。

## 项目概览

**Creative Studio（产品素材工作台）** 是一个本地优先的 AI 素材生产工作台：把一张产品素材图推进到「场景图 → 分镜图 → 口播脚本 → 视频任务 → 成片剪辑 → ZIP 导出包」的完整流水线。API Key、项目数据、生成结果全部保存在本机，不依赖外部后台。

- 技术栈：Next.js 16（App Router）+ React 19 + TypeScript（strict）+ Tailwind CSS 4 + SQLite（`better-sqlite3`）+ `sharp`（图片处理）+ `archiver`（ZIP 导出）+ `ffmpeg-static`/`ffprobe-static`（成片渲染）。
- 运行形态：既能 `npm run dev` 作为普通 Web 应用跑，也能打包成带私有 Node 运行时的 Windows（Inno Setup）/ macOS（DMG，仅 Apple Silicon）桌面安装包。
- UI 语言为中文。核心领域术语：项目（project）、场景图（scene image）、分镜（shot/storyboard）、脚本（script）、视频任务（video job）、成片剪辑（final edit）。
- 许可证：GPL-3.0-only。

## Sol + Luna 子代理协作

- 主代理 Sol 负责理解需求、澄清边界、思考与拆解任务、协调执行，并对交付做独立最终审核；不得把 Luna 的完成声明直接当作最终验收。
- 自定义代理 `luna_worker` 是本项目的默认执行代理。凡适合委派的实现、测试、机械修改、证据收集或只读核验，Sol 默认先拆成边界明确的任务交给 `luna_worker`；不适合并行或委派会增加冲突时，由 Sol 保持串行协调。
- 生成执行代理时必须选择自定义 `luna_worker`，设置 `fork_turns="none"`，且不在生成调用中显式传入 `model` 或推理强度；模型、Max 推理强度与 `workspace-write` 沙箱统一由 `.codex/agents/luna_worker.toml` 提供。不要设置 `agents.default_subagent_model`。
- 因为 `luna_worker` 不继承主线程历史，Sol 的任务说明必须自包含，至少写明目标、范围、相关路径、约束、验证方式和停止点；只读任务必须显式禁止修改文件与外部状态。
- Luna 返回结果后，Sol 必须检查实际 diff 和工作树边界，按风险独立复跑必要验证，再由 Sol 给出最终审核结论与用户答复。

## 常用命令

```bash
npm run dev                  # 开发服务器，localhost:3000（需 Node.js 20+）；predev 会先尝试拉起 LiteLLM sidecar（失败只禁用公司供应商，不阻塞 dev）
npm run dev:win              # 开发服务器绑定 127.0.0.1（Windows）
npm run build                # 生产构建：next build + scripts/sync-standalone-assets.mjs
npm run start                # 启动生产服务器
npm run lint                 # ESLint（eslint.config.mjs，eslint-config-next core-web-vitals + typescript）
npm run icons                # 从源图重新生成应用图标
npm run build:win-installer  # Windows 安装包（PowerShell + Inno Setup，须在 Windows 上跑）
npm run build:mac-installer  # macOS DMG（bash；须 Apple Silicon 主机 + Node 22.x + Xcode CLT）
```

终端用户快启脚本（非开发用途）：`start.command` / `stop.command`（macOS）、`start-windows.cmd` / `stop-windows.cmd`（Windows），会检查 Node、装依赖、起服务并打开浏览器。

公司网关联动（macOS / Windows 源码运行）：`.venv-litellm` 与 `config.yaml` 齐备时，macOS 的 `start.command` 与 `npm run dev` 的 `predev` 钩子都经 `scripts/start-litellm.sh`、Windows 的 `start-windows.cmd` 经 `scripts/start-stack.ps1 -SkipApp` 拉起 LiteLLM（端口 4000，启动参数必须显式 `--host 127.0.0.1`）再起 dev server；依赖锁定在 `requirements-litellm.txt`，组件缺失或 sidecar 失败只禁用公司供应商，不阻塞工作台。参考图的公网交付走腾讯云 COS（`CREATIVE_STUDIO_COS_*`，见 `lib/cos-media.ts`）。安全约束：本机服务（app 与代理）不得暴露到公网，公网交付只走 COS。两平台停止脚本、启动窗口 Ctrl+C、以及 UI 的关闭按钮（`/api/shutdown` 读取 `storage/run/stack.json` 的受控 `stopScript`）都会把代理一并关闭。状态文件：`storage/run/stack.json`（无 BOM JSON）。注意 `scripts/*.ps1` 必须保存为 **UTF-8 带 BOM**（PS 5.1 按 ANSI 读无 BOM 的中文会解析失败）。

## 测试

没有 `npm test` 脚本。测试是 `scripts/` 下的独立文件，靠 Node 22+ 原生 TypeScript 支持直接运行：

```bash
node scripts/db-migrations.test.ts      # 运行单个测试文件
node scripts/<name>.test.ts             # 其余测试同理
```

测试约定：

- 测试文件为 `scripts/*.test.ts`（少量 `*.test.mjs`），用 `node:assert/strict` 断言，无测试框架。
- 从 `lib/` 导入时带 `.ts` 扩展名（tsconfig 开了 `allowImportingTsExtensions`）。
- 数据库测试用 `better-sqlite3` 的 `:memory:` 实例；文件类测试用 `os.tmpdir()` 下 `fs.mkdtempSync` 的临时目录。
- 部分测试（如 `final-edit-render.test.ts`）会真实调用 ffmpeg/sharp 合成测试素材，依赖本机 ffmpeg 可用（见下文 `lib/ffmpeg.ts` 的解析顺序）。
- `scripts/final-edit-canvas.playwright.test.mjs` 是 Playwright 浏览器测试，运行方式与其他测试不同，参与前先看文件头部的说明。
- 改动某个模块时，优先跑与它同名的测试文件（如改 `lib/db-migrations.ts` 就跑 `db-migrations.test.ts`）。

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
installer/windows/      Inno Setup 脚本 + C# 启动器 + 启停 PS 脚本
installer/macos/        .app bundle 模板（Info.plist、launcher.c、launcher.sh）
docs/                   设计/评审/会话记录，按日期前缀命名；
                        docs/superpowers/{specs,plans}/ 放较大功能的规格与计划文档
outputs/                阶段性规格、测试清单、交付记录（gitignored）
types/                  第三方包的类型补丁（ffprobe-static.d.ts）
```

### `lib/` 核心模块

- `db.ts` / `db-migrations.ts` — SQLite 初始化（WAL 模式、外键开启）。`CORE_DB_MIGRATIONS` 是扁平的 `ALTER TABLE` / `UPDATE` 语句列表，每次启动逐条执行并 try/catch 跳过已应用的列；新增字段就往后追加，不要改已有条目。
- `schema-upgrade/` — 共享数据库安全升级基础设施：SQLite Online Backup、磁盘预检、跨进程 SQLite 写锁、可修复尾部中断的 JSONL 审计、统一 gate 和恢复候选重验。锁数据库与审计文件均基于 `dataRoot()`，升级失败不得阻塞不依赖新结构的旧功能。
- `batch-production/` — 新批量生产 Module；`schema.ts` 使用独立版本表和逐版本 `IMMEDIATE` 事务，`readiness.ts` 通过共享 gate 执行备份、迁移和持久审计。已发布 migration v1–v9：v1 批次身份表，v2 项目素材 `batch_assets` + 素材分析版本 `batch_asset_analysis`（素材身份是内容指纹、不依赖路径），v3 批次版本 `batch_production_versions` + 素材池 `batch_asset_pool_items`，v4 项目脚本 `batch_scripts` + 脚本快照 `batch_script_snapshots`，v5 成片计划 `batch_output_plans` + 成片版本 `batch_output_versions`（份数决定 N 条计划），v6 生产任务 `batch_tasks` + 任务尝试 `batch_task_attempts`（重试只增加尝试），v7 正式产物 `batch_artifacts` + 计划当前成片指向，v8 将正式产物改为按计划与路径追加保存并保护其批次谱系不被物理删除，v9 增加批次逻辑删除、批次版本不可逆冻结以及批次内外部文案所有权。整体输入以版本的 `inputState` 为准：首次开跑后旧版本永久冻结，修改必须新建版本；外部文案只能在所属批次版本内快照，显式保存到项目时复制成独立项目脚本。领域接口在 `assets.ts`/`versions.ts`/`scripts.ts`/`plans.ts`/`tasks.ts`/`artifacts.ts`。v10 新增素材来源表 `batch_asset_sources`；v11 给脚本和快照追加结构化封面标题、shotSetId 与内容修订身份；v12 增加项目脚本来源可用性和目录同步所有权：有修订身份或当前仍存在上游草稿的同步项会被正向认领，后续失效或删除时退出准备区；无法与独立项目脚本可靠区分的更早历史行保守保留，历史快照始终不变。素材来源类型 `BatchAssetSourceKind` 只在 `assets.ts` 定义，来源表是多来源权威数据；读取端兼容 v10 无 `kind` 的旧位置 JSON，旧托管来源按 `dataRoot()/storage/batch-media` 根恢复。`media-catalog.ts` 只信 `video_jobs` 权威记录，验证项目/shotSet、受控路径、真实视频容器和完整 SHA-256；托管目录由 `dataRoot()` 推导，linked 重新定位必须指定来源 id 且内容完全一致。`prepare.ts` + `GET /api/batch-production/prepare` 在 readiness gate 后自动同步输入；`components/mixcut/MixcutWorkspace.tsx` 提供“单条精准混剪/批量生产”模式入口。Phase B 在 `batch-flow.ts` 中以单事务确认 draft 整体输入，相同输入幂等，输入变化才新建版本；`startBatchProduction` 在开跑事务中同步最新项目脚本、校验素材池与精确 N 条计划并永久冻结。第五步可创建/选择批次、设置每脚本份数、选择带分析版本的素材、检查 N 张卡片并开跑；API 为 `POST/GET /api/batch-production/batches`、`GET /api/batch-production/batches/[id]`、`POST .../[id]/snapshot` 和 `PUT .../[id]/start`。Phase C 在 `scheduler.ts` 提供原子领取、有限租约、控制态感知的过期/启动恢复、失败重试与暂停/继续/停止；`executors.ts` 提供统一任务执行 Adapter 与真实进度报告（不可测阶段不伪造百分比）；`runner.ts` 提供领取-执行-落账循环和进程内单例调度，应用关闭与用户停止是不同中断语义。v13 给尝试加租约与 interrupted、任务加 requestKey/expectedState、批次加 controlState。`instrumentation.ts` 在 Node 启动时通过 readiness gate 恢复调度，开跑和任务读取 API 幂等兜底；进度与控制 API 为 `GET .../[id]/tasks`、`POST .../[id]/control` 与 `POST /api/batch-production/tasks/[taskId]/retry`。`GET /api/batch-production/recovery` 只列出并重新验证恢复候选；运行中的 API 禁止覆盖主数据库。未就绪时只关闭批量入口，不能阻塞旧项目与单条精准混剪。Phase D（媒体准备）在 v14 新增 LUT/代理缓存与 `proxy_generate`，v15 进一步规范化 LUT 指纹和完整色彩快照，并新增带批次版本外键的稳定 `batch_proxy_requests`，使任务不再指向可删除的 cache 行。LUT 色彩快照（关闭或引用一个已验证 LUT）纳入 `createBatchSnapshot`/`addAssetToPool`/`matchesCurrentInput` 的冻结输入身份；代理是否已生成不参与这个身份。`lib/ffmpeg.ts` 的 `runFfmpeg` 新增可选 `signal`，真正终止子进程并等 `close` 事件后才 reject 可区分的 AbortError。`scheduler.ts` 新增单任务级 `pauseTask`/`resumeTask`/`cancelTask`（不影响同批次其他任务或批次 controlState），`runner.ts` 心跳同时检查任务级 `expectedState`；`createBatchTask` 同时验证 project→batch→version→proxy request 谱系，并释放已经失效的历史 requestKey。新增 `lut-catalog.ts`（导入用真实 FFmpeg `lut3d` 验证损坏内容、按内容指纹去重、归档与安全物理清理）、`color-pipeline.ts`（完整色彩快照 → 显式 SDR FFmpeg filter）、`proxy-cache.ts`（稳定请求、全局 proxyKey 复用、安全路径、进程内读写租约、pending-delete 释放后自动完成）、`proxy-executor.ts`（按请求冻结的原片/LUT 指纹重验、磁盘预检、进程内单并发、合作取消、临时文件+原子发布、真实 FFmpeg 进度）、`preview.ts`（安全解析匹配代理/原片与 LUT 等待警告）、`export-preflight.ts`（正式输出只读前检，绝不回退代理）。API 新增 LUT、代理请求、任务控制、缓存用量/清理、Range 预览与导出前检；`BatchPreparationPanel.tsx` 提供 LUT、代理、任务、预览和清理入口，设置页提供全局代理缓存清理。
- Phase E（联合分配与正式导出）在 v16 增加联合分配运行和批次内素材排除；`allocator.ts` 是一次读取全部冻结输入的纯确定性分配器，`allocation-store.ts` 保留运行谱系并保证单条重分配不改其他计划。`batch-renderer.ts` 只读指纹一致的原片和冻结 LUT，复用 `ColorPipeline`，通过原有 batch scheduler 真实渲染；`batch-export.ts` 成对追加发布视频/封面并拒绝覆盖。`phase-e.ts` 负责可恢复启动、任务接线和逐条正式发布，`batch-workspace.ts` 聚合卡片状态，输出媒体 route 只接受稳定 ID。没有真实口播时仅生成显式静音候选，正式发布门禁必须要求已核验的 storage 相对口播快照。
- Phase A 的项目素材卡在快照前通过 `asset-preparation.ts` 使用既有 batch scheduler 排队本地 FFprobe 基础分析；结果明确标记为 `technical`，不冒充内容理解。`project-asset-media.ts` 只按 `projectId + assetId` 解析并重验权威来源、完整 SHA-256 与真实容器，生成受控 960×540 JPEG 缩略图并提供原片 Range 预览；`startBatchProduction` 不再重复创建素材分析任务。
- `video-provider-schema.ts` — 旧 `video_providers` CHECK 约束的安全升级；只有新增或改为 `openai-video` 供应商时才在共享锁内先备份再重建，普通数据库启动不得直接重建旧表。
- `data-root.ts` — 解析本地数据根目录：优先 `CREATIVE_STUDIO_DATA_ROOT` 环境变量，否则 `process.cwd()`。`data/`、`storage/` 都挂在它下面，写路径时一律走 `dataRoot()`。
- `local-image-url.ts` — 把 `storage/` 下的本地图片转成 `/api/images/...` 的 HTTP URL，供只接受真实 URL 的网关上游（腾讯等）拉取；地址默认自动探测（第一张非内部 IPv4 + `PORT`/3000），可用 `CREATIVE_STUDIO_PUBLIC_BASE_URL` 覆盖，探测不到时调用方回退 data URL。
- `cos-media.ts` — 腾讯云 COS 参考图中转。配置 `CREATIVE_STUDIO_COS_SECRET_ID` / `CREATIVE_STUDIO_COS_SECRET_KEY` / `CREATIVE_STUDIO_COS_DOMAIN`（可选 `CREATIVE_STUDIO_COS_PREFIX` 默认 `ref-images/`、`CREATIVE_STUDIO_COS_URL_TTL_SEC` 默认 86400、`CREATIVE_STUDIO_COS_SIGN_HOST`）后，`gateway-task-image` / `openai-video` 适配器提交任务时把参考图按内容 SHA-256 命名上传（GET `Range: bytes=0-0` 查重跳过重复上传）并生成 24h 预签名 GET URL 传给网关；手写 `q-sign-algorithm=sha1` 签名（`node:crypto`，零新增依赖），上传/下载都走配置的自定义域名。注意 CDN 自定义域名回源会把 Host 改写成源站默认端点（如 `<bucket>.cos.ap-guangzhou.myqcloud.com`），且会把 HEAD 改写为 GET——此时必须把 `CREATIVE_STUDIO_COS_SIGN_HOST` 设为源站端点用于签名，查重不能用 HEAD。COS 未配置或上传失败时适配器回退 `local-image-url` 的本机 URL 逻辑。密钥只放 `.env.local`，日志不得打印签名参数。
- `gateway-media-url.ts` — 网关结果 URL 归一化（把网关误配的 localhost/相对路径结果地址改写到网关 origin）与带鉴权下载（仅当目标指向网关 origin 才附 Bearer）。
- `queue.ts` / `video-queue.ts` — 图片/视频任务的内存中队列：向供应商提交任务、轮询状态、下载结果、失败重试；支持暂停/恢复。视频并发由 `VIDEO_CONCURRENCY` 环境变量控制（1–6，默认 3）。
- `providers/` — 图片生成适配器：`openai-compatible`、`packy-images`、`packy-gemini-image`、`geekai-json`、`gateway-task-image`（New API 类中转网关把图片模型挂在 `/v1/videos` 异步任务协议下的场景，与 geekai-json 同为提交→轮询→下载三段式）。
- `script-providers/` — 脚本（LLM）生成：`gemini`、`openai-compatible`（Chat Completions）、`openai-responses`（Responses/SSE，覆盖 Packy GPT 等）与 `anthropic-messages`（`/v1/messages`，覆盖 Packy Kimi 等），配置存库并由 `apiStyle` 选择协议。
- `video-providers/` — 视频生成适配器：`kling`（可灵）、`jimeng`（即梦）、`openai-video`（New API 类统一中转网关的 OpenAI 风格 `/v1/videos` 协议，Bearer Key 鉴权）。
- `company-gateway-size.ts` — 公司模型网关（llm-gateway-idc.linshimuye.com，经本地 LiteLLM 代理转发，代理配置在 `config.yaml`）的 size 白名单与吸附逻辑；`gateway-task-image` / `openai-video` 适配器仅对公司模型把请求 size 吸附到文档允许的像素组合并补 `response_format`；网关完成态常不带产物 URL，两个适配器都会回退用**提交时返回的原始任务 id** 拼 `/v1/videos/<id>/content` 下载（轮询响应里的 id 可能丢 model_id，拼地址不要用它）。
- `final-edit/` — “智能混剪”正式第五步的后端：`schema.ts`（独立版本化迁移）、`domain.ts`/`types.ts`（时间线、字幕、文字样式等领域模型）、`renderer.ts`（ffmpeg 渲染成片）、`worker.ts`（渲染任务 drain 循环，重启时把 running 任务恢复为 queued）、`workspace.ts`、`proposal.ts`、`bgm.ts`，以及 `adapters/`（视频分析 `video-analysis.ts`、TTS `tts-registry.ts`/`vapi-qwen-tts.ts`/`doubao-tts.ts`、字幕对齐 `alignment.ts`）。Mixcut 上下文与外部素材必须按 `projectId + shotSetId` 隔离。
- `ffmpeg.ts` — 解析 ffmpeg/ffprobe 二进制：环境变量 `CREATIVE_STUDIO_FFMPEG`/`CREATIVE_STUDIO_FFPROBE` → ffmpeg-static/ffprobe-static → PATH；封装 `runFfmpeg`（带进度回调、超时、stderr 尾部报错）和 `probeDurationSec`（ffprobe 失败时回退 ffmpeg 解析）。
- `logger.ts` — 同时写数据库和 `storage/logs/` 文件；会主动脱敏 API Key，不要在日志里打印密钥。
- `provider-concurrency.ts` / `cost.ts` — 每供应商并发上限；每个 job 记录预估成本。
- `image-output-normalize.ts` — 生成图与目标尺寸不一致时用 sharp 居中裁切并记日志。
- `seed.ts` — 启动时向 `video_providers` 等表写入内置供应商预设。

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
- **数据库迁移**：既有核心表继续走 `CORE_DB_MIGRATIONS` 追加式 `ALTER TABLE`（启动时逐条 try/catch）；成片剪辑在 `lib/final-edit/schema.ts`、批量生产在 `lib/batch-production/schema.ts` 分别使用独立 `{version, sql}` 迁移。批量迁移和旧供应商表重建前必须经 `lib/schema-upgrade/` 完成已验证的一致备份、跨进程锁和审计。三种迁移流都不要修改已发布条目，也不要把批量复杂迁移塞回会吞掉错误的旧 core runner。
- **路径**：所有本地文件路径基于 `dataRoot()`，不要硬编码 `data/`、`storage/` 相对路径。
- **TypeScript**：strict 模式；路径别名 `@/*` 指向仓库根。ESLint 用 Next.js 官方 flat config，无额外自定义规则。
- **UI**：界面文案为中文；视觉风格为 Apple 官网式精致极简（见 `docs/2026-06-12-session-summary.md`）。
- **文档**：设计、评审、会话记录放 `docs/`，文件名带日期前缀（`YYYY-MM-DD-主题.md`）；较大功能的规格与计划放 `docs/superpowers/specs/` 和 `docs/superpowers/plans/`。
- **关闭端点**：`POST /api/shutdown` 会延迟 500ms 后 `process.exit(0)`，供安装版启停脚本调用，不要在开发流程里误触。
- 仓库另有一份 `CLAUDE.md`，内容与本文件类似；若改动了架构或命令，两处都要同步。

## 安全注意事项

- `.env.local` 存放 LLM API Key（Gemini、Qwen、Kimi、GPT 等）与腾讯云 COS 密钥（`CREATIVE_STUDIO_COS_*`），**绝不提交**；`.gitignore` 已排除 `.env*`。
- 供应商 API Key 存本地 SQLite（`providers.apiKey` 等列），前端只显示"是否已配置"，不回显明文——保持这个约束。
- `data/`、`storage/`、`outputs/`、`dist/` 是本机运行数据，gitignored，也不要打进安装包。
- 日志会脱敏 API Key（`lib/logger.ts`）；新增日志点时不要打印请求头、密钥或完整鉴权串。
- 安装包构建脚本会裁剪并断言负载中不含 `data/`、`storage/`、`outputs/`、`docs/`、`scripts/`、`.git/`、`.env*`、`config.yaml`、`.venv-litellm/` 等本机数据、密钥或开发路径；改动打包逻辑时保留这些断言。

## 桌面打包与部署

- `next.config.ts` 使用 `output: 'standalone'`，并通过 `outputFileTracingExcludes` 排除数据/文档/脚本目录；`ffmpeg-static`、`ffprobe-static` 在 `serverExternalPackages` 中，由 `scripts/sync-standalone-assets.mjs` 强制拷入 standalone（`npm run build` 会自动执行）。
- **Windows**：`scripts/build-win-installer.ps1` 跑生产构建、下载配套私有 Node 运行时、用 Inno Setup（`installer/windows/CreativeStudio.iss`）组装，输出 `dist/windows/CreativeStudioSetup.exe`。默认卸载保留本地数据。
- **macOS**：`scripts/build-mac-installer.sh` 输出 `dist/macos/产品素材工作台-<version>.dmg`，仅 Apple Silicon。构建机必须用 arm64 Node 22.x（内置运行时锁定 Node 22.22.3），主版本或架构不一致会导致 `better-sqlite3`/`sharp` 原生模块 ABI 不匹配；还需要 Xcode Command Line Tools。脚本会校验 FFmpeg 为 arm64，并移除错误标为 arm64 的 x86_64 `ffprobe-static`，由已测试的 FFmpeg 元数据探测回退接管。用户侧说明见 `MACOS.md`。
