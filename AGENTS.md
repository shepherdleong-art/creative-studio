# AGENTS.md

本文件面向 AI 编码代理，介绍本仓库的结构、命令与约定。阅读前默认你对项目一无所知。

## 项目概览

**Creative Studio（产品素材工作台）** 是一个本地优先的 AI 素材生产工作台：把一张产品素材图推进到「场景图 → 分镜图 → 口播脚本 → 视频任务 → 成片剪辑 → ZIP 导出包」的完整流水线。API Key、项目数据、生成结果全部保存在本机，不依赖外部后台。

- 技术栈：Next.js 16（App Router）+ React 19 + TypeScript（strict）+ Tailwind CSS 4 + SQLite（`better-sqlite3`）+ `sharp`（图片处理）+ `archiver`（ZIP 导出）+ `ffmpeg-static`/`ffprobe-static`（成片渲染）。
- 运行形态：既能 `npm run dev` 作为普通 Web 应用跑，也能打包成带私有 Node 运行时的 Windows（Inno Setup）/ macOS（DMG，仅 Apple Silicon）桌面安装包。
- UI 语言为中文。核心领域术语：项目（project）、场景图（scene image）、分镜（shot/storyboard）、脚本（script）、视频任务（video job）、成片剪辑（final edit）。
- 许可证：GPL-3.0-only。

## 常用命令

```bash
npm run dev                  # 开发服务器，localhost:3000（需 Node.js 20+）
npm run dev:win              # 开发服务器绑定 127.0.0.1（Windows）
npm run build                # 生产构建：next build + scripts/sync-standalone-assets.mjs
npm run start                # 启动生产服务器
npm run lint                 # ESLint（eslint.config.mjs，eslint-config-next core-web-vitals + typescript）
npm run icons                # 从源图重新生成应用图标
npm run build:win-installer  # Windows 安装包（PowerShell + Inno Setup，须在 Windows 上跑）
npm run build:mac-installer  # macOS DMG（bash；须 Apple Silicon 主机 + Node 22.x + Xcode CLT）
```

终端用户快启脚本（非开发用途）：`start.command` / `stop.command`（macOS）、`start-windows.cmd` / `stop-windows.cmd`（Windows），会检查 Node、装依赖、起服务并打开浏览器。

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
components/             React UI（工作台各面板）；components/final-edit/ 是成片剪辑编辑器；
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
- `data-root.ts` — 解析本地数据根目录：优先 `CREATIVE_STUDIO_DATA_ROOT` 环境变量，否则 `process.cwd()`。`data/`、`storage/` 都挂在它下面，写路径时一律走 `dataRoot()`。
- `queue.ts` / `video-queue.ts` — 图片/视频任务的内存中队列：向供应商提交任务、轮询状态、下载结果、失败重试；支持暂停/恢复。视频并发由 `VIDEO_CONCURRENCY` 环境变量控制（1–6，默认 3）。
- `providers/` — 图片生成适配器：`openai-compatible`、`packy-images`、`packy-gemini-image`、`geekai-json`。
- `script-providers/` — 脚本（LLM）生成：`gemini`、`openai-compatible`（覆盖 Qwen/Kimi/GPT 等），配置存库。
- `video-providers/` — 视频生成适配器：`kling`（可灵）、`jimeng`（即梦）。
- `final-edit/` — 成片剪辑模块（当前迭代重点）：`schema.ts`（独立版本化迁移）、`domain.ts`/`types.ts`（时间线、字幕、文字样式等领域模型）、`renderer.ts`（ffmpeg 渲染成片）、`worker.ts`（渲染任务 drain 循环，重启时把 running 任务恢复为 queued）、`workspace.ts`、`proposal.ts`、`bgm.ts`，以及 `adapters/`（视频分析 `video-analysis.ts`、TTS `tts-registry.ts`/`vapi-qwen-tts.ts`、字幕对齐 `alignment.ts`）。
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
- **数据库迁移**：核心表走 `CORE_DB_MIGRATIONS` 追加式 `ALTER TABLE`（启动时逐条 try/catch）；成片剪辑模块在 `lib/final-edit/schema.ts` 用 `{version, sql}` 的版本化迁移。两种都不要修改已发布条目。
- **路径**：所有本地文件路径基于 `dataRoot()`，不要硬编码 `data/`、`storage/` 相对路径。
- **TypeScript**：strict 模式；路径别名 `@/*` 指向仓库根。ESLint 用 Next.js 官方 flat config，无额外自定义规则。
- **UI**：界面文案为中文；视觉风格为 Apple 官网式精致极简（见 `docs/2026-06-12-session-summary.md`）。
- **文档**：设计、评审、会话记录放 `docs/`，文件名带日期前缀（`YYYY-MM-DD-主题.md`）；较大功能的规格与计划放 `docs/superpowers/specs/` 和 `docs/superpowers/plans/`。
- **关闭端点**：`POST /api/shutdown` 会延迟 500ms 后 `process.exit(0)`，供安装版启停脚本调用，不要在开发流程里误触。
- 仓库另有一份 `CLAUDE.md`，内容与本文件类似；若改动了架构或命令，两处都要同步。

## 安全注意事项

- `.env.local` 存放 LLM API Key（Gemini、Qwen、Kimi、GPT 等），**绝不提交**；`.gitignore` 已排除 `.env*`。
- 供应商 API Key 存本地 SQLite（`providers.apiKey` 等列），前端只显示"是否已配置"，不回显明文——保持这个约束。
- `data/`、`storage/`、`outputs/`、`dist/` 是本机运行数据，gitignored，也不要打进安装包。
- 日志会脱敏 API Key（`lib/logger.ts`）；新增日志点时不要打印请求头、密钥或完整鉴权串。
- 安装包构建脚本会裁剪并断言负载中不含 `data/`、`storage/`、`outputs/`、`docs/`、`scripts/`、`.git/` 等开发路径；改动打包逻辑时保留这些断言。

## 桌面打包与部署

- `next.config.ts` 使用 `output: 'standalone'`，并通过 `outputFileTracingExcludes` 排除数据/文档/脚本目录；`ffmpeg-static`、`ffprobe-static` 在 `serverExternalPackages` 中，由 `scripts/sync-standalone-assets.mjs` 强制拷入 standalone（`npm run build` 会自动执行）。
- **Windows**：`scripts/build-win-installer.ps1` 跑生产构建、下载配套私有 Node 运行时、用 Inno Setup（`installer/windows/CreativeStudio.iss`）组装，输出 `dist/windows/CreativeStudioSetup.exe`。默认卸载保留本地数据。
- **macOS**：`scripts/build-mac-installer.sh` 输出 `dist/macos/产品素材工作台-<version>.dmg`，仅 Apple Silicon。构建机必须用 Node 22.x（内置运行时锁定 Node 22.22.3），主版本不一致会导致 `better-sqlite3`/`sharp` 原生模块 ABI 不匹配；还需要 Xcode Command Line Tools。用户侧说明见 `MACOS.md`。
