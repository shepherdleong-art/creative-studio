# 成片包装（自动混剪 + 包装导出）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 creative-studio 工作台新增「成片包装」环节——把已生成的分镜视频片段按脚本顺序自动拼接为成品竖版视频（可选口播配音、BGM 压低混音、烧录字幕、封面标题、片头贴片），产物随创作包 ZIP 导出，且能力完整内嵌进 Windows/macOS 桌面安装包（不依赖任何外部服务进程）。

**Architecture:** 三层——(1) 纯函数引擎层（时间线编排、ASS 字幕、FFmpeg filter_complex 参数构建），全部可单测；(2) 执行层：单并发本地渲染队列（仿 `lib/video-queue.ts` 的轮询/恢复习惯），spawn 打包内置的 ffmpeg 静态二进制；(3) API + UI 层：新工作台 Tab + `final_video_jobs` 表 + REST 路由，产物落 `storage/final-videos/` 复用现有 `/api/videos`、`/api/images` 服务与 ZIP 导出。

**Tech Stack:** 现有栈不变（Next.js 16 + React 19 + better-sqlite3 + TS）。新增依赖：`ffmpeg-static`、`ffprobe-static`（GPL 静态二进制，随平台安装；项目本身是 GPL-3.0，协议兼容）。口播 TTS 走阿里云 DashScope `qwen-tts` HTTP API（Phase 6，可整期裁剪）。

**参考实现：** 混剪工具的计划文档 `/Users/liangpeijian/for-cc/AI-mixcut/AI-remix-master/short-video-mashup-tool/docs/plans/2026-07-04-pipeline-evolution.md` 已把同类 FFmpeg 逻辑（BGM sidechaincompress ducking、ASS 定位字幕、封面 drawtext、片头贴片）用 Python 写全，本计划的对应模块是它的 TypeScript 移植：

| 本计划模块 | 参考该文档章节 |
|---|---|
| `lib/final-video/ffmpeg-graph.ts` 音频图 | §Task 3.2 `_build_audio_filter` |
| `lib/final-video/subtitles.ts` | §Task 4.3 `build_ass` / `resolve_font` |
| `lib/final-video/cover.ts` | §Task 4.2 `cover_service.py` |

遇到滤镜细节拿不准时对照它，但**字段名、接口一律以本文档为准**。

---

## 0. 执行者必读：现状关键事实

| 事实 | 位置 |
|---|---|
| 所有本地路径从 `dataRoot()` 派生；`storage/` 下的 mp4 由 `/api/videos/[...path]` 提供（含 Range），图片由 `/api/images/[...path]` 提供 | `lib/data-root.ts`、`app/api/videos/[...path]/route.ts` |
| 分镜片段成功后落 `storage/videos/`，`video_jobs.localVideoPath` 存**绝对路径**，`durationSec` 是请求时长（实际时长可能差零点几秒，必须 ffprobe） | `lib/video-queue.ts:274-291`、`lib/db.ts:263` |
| 脚本草稿存 `script_drafts.outputJson`（`ScriptOutput` JSON：`shots[].{shotId,shotIndex,voiceover,subtitle}`、`fullScript`、`shotSetId`） | `lib/script-providers/types.ts:62-88` |
| 队列惯例：模块级状态 + 启动时恢复卡死的 running 任务 + API 路由里 idle 则自动拉起 | `lib/video-queue.ts:77-127`、`app/api/shot-sets/[id]/video-jobs/route.ts:62-72` |
| 日志写 `writeLog({jobId, projectId, level, message})` | `lib/logger.ts`（用法见 video-queue.ts:139-144） |
| 新表直接加进 `lib/db.ts` 主 `db.exec` 模板（`CREATE TABLE IF NOT EXISTS` 每次启动执行）；加列才进 `lib/db-migrations.ts` | `lib/db.ts:311` 之前 |
| 测试是独立文件 `node scripts/<name>.test.ts`（Node 22 原生跑 TS，`node:assert/strict`），无测试框架 | `scripts/storage-url.test.ts` 为样板 |
| UI 样式令牌：`btn-primary/btn-secondary/btn-danger/btn-sm`、`input-field`、`label`、`text-ink-secondary/tertiary`、`border-hairline`、`bg-surface-subtle` | `app/globals.css`、`components/VideoGenerationPanel.tsx` |
| 工作台 Tab：`components/ProjectWorkbenchTabs.tsx`（TABS 数组）+ `app/projects/[id]/page.tsx:92`（WORKBENCH_TABS）+ 同文件 :542-590（内容分支） | — |
| ZIP 导出：`app/api/projects/[id]/creative-package/route.ts`，只允许打包 `storage/` 内文件 | `lib/zip-download.ts:87-101` |
| 安装包：`next.config.ts` `output:'standalone'` → `scripts/sync-standalone-assets.mjs` 补拷贝 → `scripts/build-mac-installer.sh` / `build-win-installer.ps1` 组装并断言 payload 干净 | — |
| ⚠️ 国内网络安装 `ffmpeg-static` 可能拉不到 GitHub Release，先设 `export FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static` 再 `npm install` | — |

---

## 1. 全局设计决策（先读完再动手，后续任务不得改名）

### 1.1 存储布局

```
storage/final-videos/<jobId>/
  <outputName>.mp4        # 成品
  cover.jpg               # 封面（始终生成，兼作列表缩略图）
  manifest.json           # 产物清单（§1.4）
  work/                   # 中间产物（ass/tts 分段/口播音轨），成功后删除
storage/bgm/              # 用户 BGM 库（上传或手工放入）
```

### 1.2 PackageConfig（`final_video_jobs.packageJson`，UI 表单 ↔ 引擎的唯一契约）

```json
{
  "outputName": "final-1720000000000",
  "width": 1080, "height": 1920, "fps": 30,
  "narration": { "mode": "none", "voice": "Cherry", "speed": 1.0 },
  "bgm": { "path": "/abs/storage/bgm/x.mp3", "volume": 0.25, "ducking": true },
  "cover": { "titleText": "三大亮点", "titleSize": 72, "titleColor": "#ffffff", "introDurationSec": 0 },
  "subtitle": { "enabled": true, "fontSize": 56, "color": "#ffffff", "strokeColor": "#000000", "strokeWidth": 2, "marginBottomPct": 10 }
}
```

- `narration.mode`: `"none" | "tts"`（Phase 6 前后端都只接受 `none`）
- `bgm` 可为 `null`；`cover.introDurationSec` ∈ {0,1,2}，>0 时片头贴片作为 concat 的第一段（单趟渲染，不做二次转码）
- 分辨率预设：竖版 1080×1920（默认）、横版 1920×1080、方形 1080×1080

### 1.3 TimelineSegment（`timelineJson`，引擎内部时间线）

```json
{
  "shotId": "…", "shotIndex": 1, "videoJobId": "…",
  "clipPath": "/abs/storage/videos/video-xxx.mp4",
  "clipDurationSec": 5.04,
  "voiceover": "口播文案", "subtitle": "字幕文案",
  "narrationDurationSec": 0,
  "segmentDurationSec": 5.04,
  "startSec": 0
}
```

`segmentDurationSec = max(clipDurationSec, narrationDurationSec + 0.15)`——口播比片段长时用 `tpad` 末帧定格拉长画面，**不缩放不裁剪片段内容**。`startSec` 已含片头时长偏移，字幕时间轴直接用它。

### 1.4 manifest.json

```json
{
  "schemaVersion": 1,
  "jobId": "…", "projectId": "…", "shotSetId": "…", "scriptDraftId": "…",
  "createdAt": "2026-07-04T10:00:00.000Z",
  "package": { }, "timeline": [ ],
  "output": { "video": "/abs/….mp4", "cover": "/abs/…/cover.jpg", "durationSec": 21.4, "width": 1080, "height": 1920 }
}
```

### 1.5 任务步骤与进度区间（执行器写死，UI 据此显示）

| currentStep | progress | 说明 |
|---|---|---|
| queued | 0 | 排队 |
| preparing | 5 | 校验素材 + ffprobe 各片段实际时长 |
| tts | 8→20 | 逐段合成口播（mode=none 跳过） |
| narration | 25 | 拼装口播整轨（mode=none 跳过） |
| cover | 28 | 生成封面 jpg |
| subtitles | 30 | 生成 ASS 文件 |
| render | 32→95 | FFmpeg 合成（真实帧进度） |
| finalize | 98 | 写 manifest、清理 work/ |
| done | 100 | |

### 1.6 ffmpeg 二进制解析顺序（`lib/ffmpeg.ts` 唯一入口，任何模块不得自行 spawn）

1. 环境变量 `CREATIVE_STUDIO_FFMPEG` / `CREATIVE_STUDIO_FFPROBE`（存在且文件存在）
2. `ffmpeg-static` / `ffprobe-static` 包内二进制
3. PATH 上的 `ffmpeg` / `ffprobe`

---

## Phase 1：基础设施（ffmpeg 接入 + 数据层）

### Task 1: ffmpeg 依赖与封装

**Files:**
- Modify: `package.json`
- Modify: `next.config.ts`
- Modify: `scripts/sync-standalone-assets.mjs`
- Create: `lib/ffmpeg.ts`
- Create: `types/ffprobe-static.d.ts`（仅当 tsc 报缺类型时）
- Test: `scripts/ffmpeg-resolve.test.ts`

- [ ] **Step 1: 安装依赖**

```bash
export FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static
npm install ffmpeg-static ffprobe-static
```

Expected: `node -e "console.log(require('ffmpeg-static'))"` 输出一个存在的绝对路径。

- [ ] **Step 2: 写失败测试**

```ts
// scripts/ffmpeg-resolve.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveFfmpegPath, resolveFfprobePath } from '../lib/ffmpeg.ts';

const ffmpeg = resolveFfmpegPath();
const ffprobe = resolveFfprobePath();

assert.ok(ffmpeg.length > 0, 'ffmpeg path resolved');
assert.ok(ffprobe.length > 0, 'ffprobe path resolved');
assert.ok(ffmpeg === 'ffmpeg' || fs.existsSync(ffmpeg), 'ffmpeg binary exists');

const r = spawnSync(ffmpeg, ['-version'], { encoding: 'utf-8' });
assert.equal(r.status, 0, 'ffmpeg -version runs');
assert.match(r.stdout, /ffmpeg version/);

const p = spawnSync(ffprobe, ['-version'], { encoding: 'utf-8' });
assert.equal(p.status, 0, 'ffprobe -version runs');

console.log('ffmpeg-resolve tests passed');
```

Run: `node scripts/ffmpeg-resolve.test.ts`
Expected: FAIL（`lib/ffmpeg.ts` 不存在）。

- [ ] **Step 3: 实现 `lib/ffmpeg.ts`**

```ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export function resolveFfmpegPath(): string {
  const env = process.env.CREATIVE_STUDIO_FFMPEG;
  if (env && fs.existsSync(env)) return env;
  if (typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  return 'ffmpeg';
}

export function resolveFfprobePath(): string {
  const env = process.env.CREATIVE_STUDIO_FFPROBE;
  if (env && fs.existsSync(env)) return env;
  const p = (ffprobeStatic as { path?: string })?.path;
  if (p && fs.existsSync(p)) return p;
  return 'ffprobe';
}

export interface RunFfmpegOptions {
  /** 每次解析到 -progress 输出时回调（已换算为秒） */
  onProgressSec?: (outTimeSec: number) => void;
  timeoutMs?: number;
}

/** 运行 ffmpeg，非零退出码时用 stderr 尾部报错。args 必须含 -y 与输出路径。 */
export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), args, { windowsHide: true });
    let stderrTail = '';
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          done(new Error(`ffmpeg timeout after ${opts.timeoutMs}ms: ${stderrTail.slice(-500)}`));
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (buf: Buffer) => {
      if (!opts.onProgressSec) return;
      let last = -1;
      const re = /out_time_us=(\d+)/g;
      const text = buf.toString();
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) last = Number(m[1]);
      if (last >= 0) opts.onProgressSec(last / 1e6);
    });
    child.stderr.on('data', (buf: Buffer) => {
      stderrTail = (stderrTail + buf.toString()).slice(-4000);
    });
    child.on('error', (err) => done(err));
    child.on('close', (code) => {
      if (code === 0) done();
      else done(new Error(`ffmpeg exited with code ${code}: ${stderrTail.slice(-1500)}`));
    });
  });
}

/** ffprobe 取媒体时长（秒） */
export function probeDurationSec(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveFfprobePath(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      { windowsHide: true }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const dur = parseFloat(out.trim());
      if (code === 0 && Number.isFinite(dur)) resolve(dur);
      else reject(new Error(`ffprobe failed for ${filePath}: ${err.slice(-500)}`));
    });
  });
}

const filterCache = new Map<string, boolean>();

/** 探测滤镜可用性（sidechaincompress / tpad 等），结果缓存 */
export function supportsFilter(name: string): Promise<boolean> {
  const cached = filterCache.get(name);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const child = spawn(resolveFfmpegPath(), ['-hide_banner', '-filters'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.on('error', () => resolve(false));
    child.on('close', () => {
      const ok = new RegExp(`\\s${name}\\s`).test(out);
      filterCache.set(name, ok);
      resolve(ok);
    });
  });
}
```

若 `npm run lint` / tsc 报 `ffprobe-static` 缺类型，创建 `types/ffprobe-static.d.ts`：

```ts
declare module 'ffprobe-static' {
  const ffprobe: { path: string };
  export default ffprobe;
}
```

- [ ] **Step 4: standalone 打包接入**

`next.config.ts` 在 `nextConfig` 对象顶层加一行（`output: 'standalone',` 之后）：

```ts
  serverExternalPackages: ['ffmpeg-static', 'ffprobe-static'],
```

`scripts/sync-standalone-assets.mjs` 末尾 `console.log` 之前追加：

```js
// ffmpeg/ffprobe 静态二进制不会被 Next 的文件追踪收录，强制拷入 standalone
for (const pkg of ['ffmpeg-static', 'ffprobe-static']) {
  copyDirectory(join(root, 'node_modules', pkg), join(standaloneDir, 'node_modules', pkg));
}
```

- [ ] **Step 5: 测试通过 + 提交**

Run: `node scripts/ffmpeg-resolve.test.ts` → `ffmpeg-resolve tests passed`；`npm run lint` → 无新告警。

```bash
git add package.json package-lock.json next.config.ts scripts/sync-standalone-assets.mjs lib/ffmpeg.ts scripts/ffmpeg-resolve.test.ts types/ 2>/dev/null || git add package.json package-lock.json next.config.ts scripts/sync-standalone-assets.mjs lib/ffmpeg.ts scripts/ffmpeg-resolve.test.ts
git commit -m "feat: bundle ffmpeg/ffprobe static binaries with resolver and spawn helpers"
```

### Task 2: 数据层（final_video_jobs 表 + 类型 + 视频 URL helper）

**Files:**
- Modify: `lib/db.ts`（`script_drafts` 表定义之后、主模板串收尾 `` `); `` 之前）
- Modify: `lib/storage-url.ts`
- Create: `lib/final-video/types.ts`
- Test: `scripts/storage-url.test.ts`（追加）

- [ ] **Step 1: db.ts 加表**

在 `lib/db.ts` 主 `db.exec` 模板内、`script_drafts` 表之后追加：

```sql
    CREATE TABLE IF NOT EXISTS final_video_jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      shotSetId TEXT NOT NULL,
      scriptDraftId TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','canceled')),
      currentStep TEXT NOT NULL DEFAULT 'queued',
      progress REAL NOT NULL DEFAULT 0,
      packageJson TEXT NOT NULL DEFAULT '{}',
      timelineJson TEXT NOT NULL DEFAULT '[]',
      outputPath TEXT,
      coverPath TEXT,
      manifestPath TEXT,
      durationSec REAL,
      errorMessage TEXT,
      startedAt TEXT,
      finishedAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (shotSetId) REFERENCES shot_sets(id) ON DELETE CASCADE,
      FOREIGN KEY (scriptDraftId) REFERENCES script_drafts(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_final_video_jobs_project ON final_video_jobs(projectId);
    CREATE INDEX IF NOT EXISTS idx_final_video_jobs_status ON final_video_jobs(status);
```

- [ ] **Step 2: `lib/final-video/types.ts`**

```ts
/** 成片包装的共享类型。字段契约见 docs/superpowers/plans/2026-07-04-final-video-packaging.md §1.2-1.3 */

export interface NarrationConfig {
  mode: 'none' | 'tts';
  voice: string;
  speed: number;
}

export interface BgmConfig {
  path: string;
  volume: number;
  ducking: boolean;
}

export interface CoverConfig {
  titleText: string;
  titleSize: number;
  titleColor: string;
  introDurationSec: number;
}

export interface SubtitleStyle {
  enabled: boolean;
  fontSize: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  /** 字幕基线距底部的画面高度百分比 */
  marginBottomPct: number;
}

export interface PackageConfig {
  outputName: string;
  width: number;
  height: number;
  fps: number;
  narration: NarrationConfig;
  bgm: BgmConfig | null;
  cover: CoverConfig;
  subtitle: SubtitleStyle;
}

export interface TimelineSegment {
  shotId: string;
  shotIndex: number;
  videoJobId: string;
  clipPath: string;
  clipDurationSec: number;
  voiceover: string;
  subtitle: string;
  narrationDurationSec: number;
  segmentDurationSec: number;
  startSec: number;
}

export interface FinalVideoJobRow {
  id: string;
  projectId: string;
  shotSetId: string;
  scriptDraftId: string | null;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';
  currentStep: string;
  progress: number;
  packageJson: string;
  timelineJson: string;
  outputPath: string | null;
  coverPath: string | null;
  manifestPath: string | null;
  durationSec: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export function defaultPackageConfig(): PackageConfig {
  return {
    outputName: `final-${Date.now()}`,
    width: 1080,
    height: 1920,
    fps: 30,
    narration: { mode: 'none', voice: 'Cherry', speed: 1.0 },
    bgm: null,
    cover: { titleText: '', titleSize: 72, titleColor: '#ffffff', introDurationSec: 0 },
    subtitle: { enabled: true, fontSize: 56, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 10 },
  };
}

/** 浅合并用户提交的部分配置（narration/bgm/cover/subtitle 为对象级覆盖） */
export function mergePackageConfig(partial: Partial<PackageConfig> | undefined): PackageConfig {
  const base = defaultPackageConfig();
  if (!partial || typeof partial !== 'object') return base;
  return {
    ...base,
    ...partial,
    narration: { ...base.narration, ...(partial.narration ?? {}) },
    bgm: partial.bgm === null ? null : partial.bgm ? { ...partial.bgm } : base.bgm,
    cover: { ...base.cover, ...(partial.cover ?? {}) },
    subtitle: { ...base.subtitle, ...(partial.subtitle ?? {}) },
  };
}
```

- [ ] **Step 3: `lib/storage-url.ts` 加视频 URL helper（保持既有函数签名不变）**

整文件替换为：

```ts
import path from 'node:path';
import { dataRoot } from './data-root';

function toStorageUrl(filePath: string | null | undefined, prefix: string, storageRoot: string) {
  if (!filePath) return '';

  const resolvedRoot = path.resolve(storageRoot);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep)) return '';

  const relativePath = path
    .relative(resolvedRoot, resolvedFile)
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/');

  return relativePath ? `${prefix}/${relativePath}` : '';
}

export function toStorageImageUrl(filePath: string | null | undefined, storageRoot = path.resolve(dataRoot(), 'storage')) {
  return toStorageUrl(filePath, '/api/images', storageRoot);
}

export function toStorageVideoUrl(filePath: string | null | undefined, storageRoot = path.resolve(dataRoot(), 'storage')) {
  return toStorageUrl(filePath, '/api/videos', storageRoot);
}
```

- [ ] **Step 4: 追加测试并跑全量相关测试**

`scripts/storage-url.test.ts` 末尾追加：

```ts
import { toStorageVideoUrl } from '../lib/storage-url.ts';

assert.equal(
  toStorageVideoUrl(path.join(storageRoot, 'final-videos', 'j1', 'final 01.mp4'), storageRoot),
  '/api/videos/final-videos/j1/final%2001.mp4'
);
assert.equal(toStorageVideoUrl('/etc/passwd', storageRoot), '');
```

Run: `node scripts/storage-url.test.ts` → 无输出（全通过）；`node scripts/db-migrations.test.ts` → 通过（确认建表 SQL 无语法错误）。

- [ ] **Step 5: 提交**

```bash
git add lib/db.ts lib/storage-url.ts lib/final-video/types.ts scripts/storage-url.test.ts
git commit -m "feat: final_video_jobs table, package config types, storage video url helper"
```

---

## Phase 2：纯函数引擎（全部 TDD，不碰进程/DB）

### Task 3: 时间线编排 `buildTimeline`

**Files:**
- Create: `lib/final-video/timeline.ts`
- Test: `scripts/final-video-timeline.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// scripts/final-video-timeline.test.ts
import assert from 'node:assert/strict';
import { buildTimeline, NARRATION_TAIL_PAD_SEC } from '../lib/final-video/timeline.ts';

const scriptShots = [
  { shotId: 's2', shotIndex: 2, voiceover: '第二句', subtitle: '字幕二' },
  { shotId: 's1', shotIndex: 1, voiceover: '第一句', subtitle: '字幕一' },
  { shotId: 's3', shotIndex: 3, voiceover: '第三句', subtitle: '字幕三' },
];
const clips = [
  { shotId: 's1', videoJobId: 'vj1', clipPath: '/a/1.mp4', clipDurationSec: 5.0 },
  { shotId: 's2', videoJobId: 'vj2', clipPath: '/a/2.mp4', clipDurationSec: 4.96 },
];

// 按 shotIndex 排序；缺片段的镜头产出 issue 并跳过
const r1 = buildTimeline({ scriptShots, clips });
assert.equal(r1.segments.length, 2);
assert.deepEqual(r1.segments.map((s) => s.shotIndex), [1, 2]);
assert.equal(r1.issues.length, 1);
assert.equal(r1.issues[0].shotId, 's3');
assert.equal(r1.segments[0].startSec, 0);
assert.equal(r1.segments[1].startSec, 5.0);
assert.equal(r1.totalDurationSec, 9.96);
assert.equal(r1.segments[0].segmentDurationSec, 5.0);

// 口播长于片段 → 该段拉长到口播 + 尾部余量；片头偏移全部 startSec
const r2 = buildTimeline({
  scriptShots, clips,
  narrationDurations: { s1: 6.0 },
  introDurationSec: 1,
});
assert.equal(r2.segments[0].segmentDurationSec, Number((6.0 + NARRATION_TAIL_PAD_SEC).toFixed(2)));
assert.equal(r2.segments[0].startSec, 1);
assert.equal(r2.segments[1].startSec, Number((1 + 6.0 + NARRATION_TAIL_PAD_SEC).toFixed(2)));
assert.equal(r2.segments[0].narrationDurationSec, 6.0);

// 全部缺片段 → segments 为空
const r3 = buildTimeline({ scriptShots, clips: [] });
assert.equal(r3.segments.length, 0);
assert.equal(r3.issues.length, 3);

console.log('final-video-timeline tests passed');
```

Run: `node scripts/final-video-timeline.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现**

```ts
// lib/final-video/timeline.ts
import { TimelineSegment } from './types';

/** 口播结束后画面多停留的秒数，避免音频戛然而止 */
export const NARRATION_TAIL_PAD_SEC = 0.15;

export interface TimelineShotInput {
  shotId: string;
  shotIndex: number;
  voiceover: string;
  subtitle: string;
}

export interface TimelineClipInput {
  shotId: string;
  videoJobId: string;
  clipPath: string;
  clipDurationSec: number;
}

export interface TimelineIssue {
  shotIndex: number;
  shotId: string;
  reason: string;
}

export interface TimelineResult {
  segments: TimelineSegment[];
  issues: TimelineIssue[];
  totalDurationSec: number;
}

const round2 = (n: number) => Number(n.toFixed(2));

export function buildTimeline(input: {
  scriptShots: TimelineShotInput[];
  clips: TimelineClipInput[];
  narrationDurations?: Record<string, number>;
  introDurationSec?: number;
}): TimelineResult {
  const intro = input.introDurationSec ?? 0;
  const clipByShot = new Map(input.clips.map((c) => [c.shotId, c]));
  const segments: TimelineSegment[] = [];
  const issues: TimelineIssue[] = [];
  let cursor = intro;

  const ordered = [...input.scriptShots].sort((a, b) => a.shotIndex - b.shotIndex);
  for (const shot of ordered) {
    const clip = clipByShot.get(shot.shotId);
    if (!clip) {
      issues.push({ shotIndex: shot.shotIndex, shotId: shot.shotId, reason: '缺少已完成的视频片段' });
      continue;
    }
    const narration = input.narrationDurations?.[shot.shotId] ?? 0;
    const segmentDurationSec =
      narration > 0 ? Math.max(clip.clipDurationSec, narration + NARRATION_TAIL_PAD_SEC) : clip.clipDurationSec;
    segments.push({
      shotId: shot.shotId,
      shotIndex: shot.shotIndex,
      videoJobId: clip.videoJobId,
      clipPath: clip.clipPath,
      clipDurationSec: clip.clipDurationSec,
      voiceover: shot.voiceover,
      subtitle: shot.subtitle,
      narrationDurationSec: narration,
      segmentDurationSec: round2(segmentDurationSec),
      startSec: round2(cursor),
    });
    cursor += segmentDurationSec;
  }
  return { segments, issues, totalDurationSec: round2(cursor) };
}
```

- [ ] **Step 3: 测试通过 + 提交**

Run: `node scripts/final-video-timeline.test.ts` → `final-video-timeline tests passed`

```bash
git add lib/final-video/timeline.ts scripts/final-video-timeline.test.ts
git commit -m "feat: final video timeline builder with narration-aware segment durations"
```

### Task 4: ASS 字幕生成

**Files:**
- Create: `lib/final-video/subtitles.ts`
- Test: `scripts/final-video-subtitles.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// scripts/final-video-subtitles.test.ts
import assert from 'node:assert/strict';
import { buildAss, resolveFontFile, platformFontName } from '../lib/final-video/subtitles.ts';

const style = { enabled: true, fontSize: 56, color: '#ff0000', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 10 };
const segments = [
  { subtitle: '第一句', startSec: 1, segmentDurationSec: 2.5 },
  { subtitle: '', startSec: 3.5, segmentDurationSec: 1 },
  { subtitle: '换行\n测试', startSec: 4.5, segmentDurationSec: 3 },
];

const ass = buildAss(segments, style, 1080, 1920);

assert.match(ass, /\[Script Info\]/);
assert.match(ass, /PlayResX: 1080/);
assert.match(ass, /PlayResY: 1920/);
// 红色 #ff0000 → ASS 是 BGR：&H000000FF
assert.match(ass, /&H000000FF/);
// 空字幕不产 Dialogue
assert.equal((ass.match(/^Dialogue:/gm) || []).length, 2);
// 时间格式：起于 0:00:01.00，第三句起于 0:00:04.50 止于 0:00:07.50
assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:03\.50,/);
assert.match(ass, /Dialogue: 0,0:00:04\.50,0:00:07\.50,/);
// 换行转 \N
assert.match(ass, /换行\\N测试/);
// MarginV = 1920 * 10% = 192
assert.match(ass, /,20,20,192,1/);

// 字体解析：返回空串或真实存在的文件
const font = resolveFontFile();
assert.ok(font === '' || require('node:fs').existsSync(font));
assert.ok(platformFontName().length > 0);

console.log('final-video-subtitles tests passed');
```

Run: `node scripts/final-video-subtitles.test.ts` → FAIL。

- [ ] **Step 2: 实现**

```ts
// lib/final-video/subtitles.ts
/**
 * ASS 字幕构建（PlayRes = 输出分辨率，Alignment 2 底部居中）。
 * 参考：混剪计划 §Task 4.3 build_ass 的 TS 移植，时间轴改用 startSec（已含片头偏移）。
 */
import fs from 'node:fs';
import { SubtitleStyle } from './types';

const PLATFORM_FONTS: Record<string, string[]> = {
  darwin: [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
  ],
  win32: ['C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\simhei.ttf'],
  linux: [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  ],
};

const PLATFORM_FONT_NAMES: Record<string, string> = {
  darwin: 'PingFang SC',
  win32: 'Microsoft YaHei',
  linux: 'Noto Sans CJK SC',
};

/** 返回本机可用的中文字体文件路径；找不到返回 ''（libass 回退默认字体） */
export function resolveFontFile(): string {
  for (const cand of PLATFORM_FONTS[process.platform] ?? []) {
    if (fs.existsSync(cand)) return cand;
  }
  return '';
}

export function platformFontName(): string {
  return PLATFORM_FONT_NAMES[process.platform] ?? 'sans-serif';
}

function assTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function bgr(hexColor: string): string {
  const c = hexColor.replace('#', '');
  if (c.length !== 6) return 'FFFFFF';
  return `${c.slice(4, 6)}${c.slice(2, 4)}${c.slice(0, 2)}`.toUpperCase();
}

export interface AssSegment {
  subtitle: string;
  startSec: number;
  segmentDurationSec: number;
}

export function buildAss(segments: AssSegment[], style: SubtitleStyle, width: number, height: number): string {
  const marginV = Math.round((height * style.marginBottomPct) / 100);
  const header =
    '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    `PlayResX: ${width}\n` +
    `PlayResY: ${height}\n\n` +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, ' +
    'Bold, Italic, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    `Style: Default,${platformFontName()},${style.fontSize},&H00${bgr(style.color)},` +
    `&H00${bgr(style.strokeColor)},&H80000000,0,0,${style.strokeWidth},0,2,20,20,${marginV},1\n\n` +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

  const lines = [header];
  for (const seg of segments) {
    const text = (seg.subtitle || '').trim();
    if (!text) continue;
    const start = assTime(seg.startSec);
    const end = assTime(seg.startSec + seg.segmentDurationSec);
    lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text.replace(/\n/g, '\\N')}`);
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 3: 测试通过 + 提交**

Run: `node scripts/final-video-subtitles.test.ts` → passed

```bash
git add lib/final-video/subtitles.ts scripts/final-video-subtitles.test.ts
git commit -m "feat: ASS subtitle builder with cross-platform CJK font resolution"
```

### Task 5: FFmpeg 渲染参数构建（视频拼接 + 音频图 + 字幕挂载）

**Files:**
- Create: `lib/final-video/ffmpeg-graph.ts`
- Test: `scripts/final-video-graph.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// scripts/final-video-graph.test.ts
import assert from 'node:assert/strict';
import { buildRenderArgs, escapeSubtitlePath, escapeDrawtext } from '../lib/final-video/ffmpeg-graph.ts';

assert.equal(escapeSubtitlePath('C:\\work\\a b.ass'), "C\\:/work/a b.ass");
assert.equal(escapeDrawtext("50%:off 'x'"), "50\\%\\:off \\'x\\'");

const seg = (i: number, clipDur: number, segDur: number) => ({
  shotId: `s${i}`, shotIndex: i, videoJobId: `vj${i}`, clipPath: `/clips/${i}.mp4`,
  clipDurationSec: clipDur, voiceover: '', subtitle: `字${i}`,
  narrationDurationSec: 0, segmentDurationSec: segDur, startSec: 0,
});

// 基础：两段拼接 + 字幕 + BGM（无口播）→ afade 收尾，无 sidechain
const a1 = buildRenderArgs({
  segments: [seg(1, 5, 5), seg(2, 4, 4)],
  width: 1080, height: 1920, fps: 30,
  totalDurationSec: 9,
  introDurationSec: 0, coverJpgPath: null,
  narrationTrackPath: null,
  bgm: { path: '/bgm/x.mp3', volume: 0.25, ducking: true },
  duckingSupported: true,
  assPath: '/tmp/subs.ass', fontsDir: '/System/Library/Fonts',
  outputPath: '/out/final.mp4',
});
const g1 = a1[a1.indexOf('-filter_complex') + 1];
assert.match(g1, /concat=n=2:v=1:a=0\[vcat\]/);
assert.match(g1, /subtitles=filename='\/tmp\/subs\.ass':fontsdir='\/System\/Library\/Fonts'\[vsub\]/);
assert.match(g1, /afade=t=out/);
assert.doesNotMatch(g1, /sidechaincompress/);
assert.ok(a1.includes('-stream_loop'));
assert.equal(a1[a1.indexOf('-t') + 1], '9.000');
assert.ok(a1.includes('-map'));
assert.equal(a1[a1.length - 1], '/out/final.mp4');

// 口播 + BGM + ducking 支持 → sidechaincompress；tpad 只出现在需要拉长的段
const a2 = buildRenderArgs({
  segments: [seg(1, 5, 6.15), seg(2, 4, 4)],
  width: 1080, height: 1920, fps: 30,
  totalDurationSec: 10.15,
  introDurationSec: 0, coverJpgPath: null,
  narrationTrackPath: '/work/narration.m4a',
  bgm: { path: '/bgm/x.mp3', volume: 0.2, ducking: true },
  duckingSupported: true,
  assPath: null, fontsDir: '',
  outputPath: '/out/final.mp4',
});
const g2 = a2[a2.indexOf('-filter_complex') + 1];
assert.match(g2, /sidechaincompress/);
assert.match(g2, /tpad=stop_mode=clone:stop_duration=1\.150/);
assert.equal((g2.match(/tpad/g) || []).length, 1);
assert.doesNotMatch(g2, /subtitles=/);

// ducking 不支持 → 退化为 amix
const a3 = buildRenderArgs({
  segments: [seg(1, 5, 5)],
  width: 1080, height: 1920, fps: 30,
  totalDurationSec: 5,
  introDurationSec: 0, coverJpgPath: null,
  narrationTrackPath: '/work/narration.m4a',
  bgm: { path: '/bgm/x.mp3', volume: 0.2, ducking: true },
  duckingSupported: false,
  assPath: null, fontsDir: '',
  outputPath: '/out/final.mp4',
});
assert.doesNotMatch(a3[a3.indexOf('-filter_complex') + 1], /sidechaincompress/);
assert.match(a3[a3.indexOf('-filter_complex') + 1], /amix=inputs=2/);

// 片头贴片：第一输入是 -loop 1 -t <intro> -i cover.jpg，concat n=3
const a4 = buildRenderArgs({
  segments: [seg(1, 5, 5), seg(2, 4, 4)],
  width: 1080, height: 1920, fps: 30,
  totalDurationSec: 10,
  introDurationSec: 1, coverJpgPath: '/out/cover.jpg',
  narrationTrackPath: null, bgm: null, duckingSupported: false,
  assPath: null, fontsDir: '',
  outputPath: '/out/final.mp4',
});
assert.equal(a4[a4.indexOf('-loop') + 1], '1');
assert.match(a4[a4.indexOf('-filter_complex') + 1], /concat=n=3:v=1:a=0\[vcat\]/);
// 无任何音频 → -an
assert.ok(a4.includes('-an'));

console.log('final-video-graph tests passed');
```

Run: `node scripts/final-video-graph.test.ts` → FAIL。

- [ ] **Step 2: 实现**

```ts
// lib/final-video/ffmpeg-graph.ts
/**
 * 单趟 FFmpeg 渲染参数构建：
 *   视频：各片段 scale-cover-crop → (按需 tpad 定格) → concat → (可选 subtitles)
 *   音频：口播/BGM 组合，BGM 可 sidechaincompress ducking（探测失败退化 amix）
 * 参考：混剪计划 §Task 3.2 音频图的 TS 移植；输出时长用显式 -t 保证确定性。
 */
import { TimelineSegment } from './types';

/** subtitles/fontsdir 的 filter 内路径转义（Windows 盘符冒号 + 反斜杠 + 单引号） */
export function escapeSubtitlePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** drawtext 文本转义 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

export interface RenderGraphInput {
  segments: TimelineSegment[];
  width: number;
  height: number;
  fps: number;
  totalDurationSec: number;
  introDurationSec: number;
  coverJpgPath: string | null;
  /** 已含片头静音偏移的完整口播音轨（Task 14 产出），无口播传 null */
  narrationTrackPath: string | null;
  bgm: { path: string; volume: number; ducking: boolean } | null;
  duckingSupported: boolean;
  assPath: string | null;
  fontsDir: string;
  outputPath: string;
}

export function buildRenderArgs(g: RenderGraphInput): string[] {
  const { width: w, height: h, fps } = g;
  const args: string[] = ['-hide_banner', '-nostats'];
  const hasIntro = g.introDurationSec > 0 && !!g.coverJpgPath;

  // ── 输入 ──
  if (hasIntro) args.push('-loop', '1', '-t', String(g.introDurationSec), '-i', g.coverJpgPath!);
  for (const s of g.segments) args.push('-i', s.clipPath);
  let narrIdx = -1;
  let bgmIdx = -1;
  let next = (hasIntro ? 1 : 0) + g.segments.length;
  if (g.narrationTrackPath) {
    narrIdx = next++;
    args.push('-i', g.narrationTrackPath);
  }
  if (g.bgm) {
    bgmIdx = next++;
    args.push('-stream_loop', '-1', '-i', g.bgm.path);
  }

  // ── 视频图 ──
  const scaleChain = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`;
  const parts: string[] = [];
  const vLabels: string[] = [];
  const base = hasIntro ? 1 : 0;
  if (hasIntro) {
    parts.push(`[0:v]${scaleChain}[vintro]`);
    vLabels.push('[vintro]');
  }
  g.segments.forEach((s, i) => {
    const pad = s.segmentDurationSec - s.clipDurationSec;
    const padPart = pad > 0.01 ? `,tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}` : '';
    parts.push(`[${base + i}:v]setpts=PTS-STARTPTS,${scaleChain}${padPart}[v${i}]`);
    vLabels.push(`[v${i}]`);
  });
  parts.push(`${vLabels.join('')}concat=n=${vLabels.length}:v=1:a=0[vcat]`);
  let vOut = '[vcat]';
  if (g.assPath) {
    const fontsdir = g.fontsDir ? `:fontsdir='${escapeSubtitlePath(g.fontsDir)}'` : '';
    parts.push(`[vcat]subtitles=filename='${escapeSubtitlePath(g.assPath)}'${fontsdir}[vsub]`);
    vOut = '[vsub]';
  }

  // ── 音频图 ──
  let aOut = '';
  if (narrIdx >= 0 && bgmIdx >= 0) {
    if (g.bgm!.ducking && g.duckingSupported) {
      parts.push(
        `[${bgmIdx}:a]volume=${g.bgm!.volume}[bgmv]`,
        `[${narrIdx}:a]asplit=2[narrA][narrB]`,
        `[bgmv][narrA]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]`,
        `[duck][narrB]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`
      );
    } else {
      parts.push(
        `[${bgmIdx}:a]volume=${g.bgm!.volume}[bgmv]`,
        `[bgmv][${narrIdx}:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`
      );
    }
    aOut = '[aout]';
  } else if (narrIdx >= 0) {
    parts.push(`[${narrIdx}:a]anull[aout]`);
    aOut = '[aout]';
  } else if (bgmIdx >= 0) {
    const fadeStart = Math.max(0, g.totalDurationSec - 1.5);
    parts.push(`[${bgmIdx}:a]volume=${g.bgm!.volume},afade=t=out:st=${fadeStart.toFixed(2)}:d=1.5[aout]`);
    aOut = '[aout]';
  }

  args.push('-filter_complex', parts.join(';'));
  args.push('-map', vOut);
  if (aOut) args.push('-map', aOut, '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-t', g.totalDurationSec.toFixed(3),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-y', g.outputPath
  );
  return args;
}
```

- [ ] **Step 3: 测试通过 + 提交**

Run: `node scripts/final-video-graph.test.ts` → passed

```bash
git add lib/final-video/ffmpeg-graph.ts scripts/final-video-graph.test.ts
git commit -m "feat: single-pass ffmpeg render graph (concat, tpad, bgm ducking, subtitles)"
```

### Task 6: 封面生成参数

**Files:**
- Create: `lib/final-video/cover.ts`
- Test: `scripts/final-video-graph.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

`scripts/final-video-graph.test.ts` 末尾 `console.log` 之前追加：

```ts
import { buildCoverArgs } from '../lib/final-video/cover.ts';

const c1 = buildCoverArgs({
  sourceVideoPath: '/clips/1.mp4',
  titleText: '三大亮点', titleSize: 72, titleColor: '#ffffff',
  width: 1080, height: 1920,
  fontFile: '/System/Library/Fonts/PingFang.ttc',
  outJpgPath: '/out/cover.jpg',
});
assert.equal(c1[c1.indexOf('-ss') + 1], '0.5');
const vf1 = c1[c1.indexOf('-vf') + 1];
assert.match(vf1, /drawtext=text='三大亮点'/);
assert.match(vf1, /fontfile='\/System\/Library\/Fonts\/PingFang\.ttc'/);
assert.equal(c1[c1.length - 1], '/out/cover.jpg');

// 无标题 → 无 drawtext
const c2 = buildCoverArgs({
  sourceVideoPath: '/clips/1.mp4', titleText: '', titleSize: 72, titleColor: '#ffffff',
  width: 1080, height: 1920, fontFile: '', outJpgPath: '/out/cover.jpg',
});
assert.doesNotMatch(c2[c2.indexOf('-vf') + 1], /drawtext/);
```

Run → FAIL。

- [ ] **Step 2: 实现**

```ts
// lib/final-video/cover.ts
/** 封面 = 首个片段 0.5s 处抽帧 + 可选居中标题。参考：混剪计划 §Task 4.2。 */
import { escapeDrawtext, escapeSubtitlePath } from './ffmpeg-graph';

export interface CoverArgsInput {
  sourceVideoPath: string;
  titleText: string;
  titleSize: number;
  titleColor: string;
  width: number;
  height: number;
  fontFile: string;
  outJpgPath: string;
}

export function buildCoverArgs(input: CoverArgsInput): string[] {
  const { width: w, height: h } = input;
  const vfParts = [`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`];
  const title = input.titleText.trim();
  if (title) {
    const fontPart = input.fontFile ? `:fontfile='${escapeSubtitlePath(input.fontFile)}'` : '';
    vfParts.push(
      `drawtext=text='${escapeDrawtext(title)}':fontsize=${input.titleSize}:fontcolor=${input.titleColor}` +
        `:x=(w-text_w)/2:y=(h-text_h)/2:borderw=4:bordercolor=black${fontPart}`
    );
  }
  return [
    '-hide_banner',
    '-ss', '0.5',
    '-i', input.sourceVideoPath,
    '-vf', vfParts.join(','),
    '-frames:v', '1',
    '-q:v', '2',
    '-y', input.outJpgPath,
  ];
}
```

- [ ] **Step 3: 测试通过 + 提交**

Run: `node scripts/final-video-graph.test.ts` → passed

```bash
git add lib/final-video/cover.ts scripts/final-video-graph.test.ts
git commit -m "feat: cover frame extraction with centered title drawtext"
```

---

## Phase 3：执行层（渲染队列 + 端到端冒烟）

### Task 7: 渲染队列与执行器

**Files:**
- Create: `lib/final-video/render-queue.ts`

- [ ] **Step 1: 实现（本任务无单测——纯函数已覆盖，进程编排靠 Task 8 e2e 与手动验收）**

```ts
// lib/final-video/render-queue.ts
/**
 * 成片渲染队列：单并发（本地 CPU 密集），仿 video-queue 的恢复/自启惯例。
 * 步骤与进度区间见 docs/superpowers/plans/2026-07-04-final-video-packaging.md §1.5
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db';
import { dataRoot } from '../data-root';
import { writeLog } from '../logger';
import { runFfmpeg, probeDurationSec, supportsFilter } from '../ffmpeg';
import { buildTimeline, TimelineClipInput, TimelineShotInput } from './timeline';
import { buildAss, resolveFontFile } from './subtitles';
import { buildRenderArgs } from './ffmpeg-graph';
import { buildCoverArgs } from './cover';
import { FinalVideoJobRow, PackageConfig, mergePackageConfig } from './types';

const RENDER_TIMEOUT_MS = 20 * 60 * 1000;

let running = false;

export function getFinalVideoQueueStatus(): 'idle' | 'running' {
  return running ? 'running' : 'idle';
}

export function startFinalVideoQueue(): void {
  if (running) return;
  running = true;
  void (async () => {
    const db = getDb();
    try {
      db.prepare(
        `UPDATE final_video_jobs SET status = 'pending', errorMessage = 'Recovered from interrupted run'
         WHERE status = 'running'`
      ).run();
      for (;;) {
        const job = db
          .prepare(`SELECT * FROM final_video_jobs WHERE status = 'pending' ORDER BY createdAt LIMIT 1`)
          .get() as FinalVideoJobRow | undefined;
        if (!job) break;
        db.prepare(
          `UPDATE final_video_jobs SET status = 'running', startedAt = datetime('now'), errorMessage = NULL WHERE id = ?`
        ).run(job.id);
        try {
          await runFinalVideoJob(job);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeLog({ jobId: job.id, projectId: job.projectId, level: 'error', message: `Final video job failed: ${msg}` });
          db.prepare(
            `UPDATE final_video_jobs SET status = 'failed', errorMessage = ?, finishedAt = datetime('now')
             WHERE id = ? AND status = 'running'`
          ).run(msg.slice(0, 2000), job.id);
        }
      }
    } finally {
      running = false;
    }
  })();
}

function setStep(jobId: string, step: string, progress: number) {
  getDb()
    .prepare(`UPDATE final_video_jobs SET currentStep = ?, progress = ? WHERE id = ? AND status = 'running'`)
    .run(step, progress, jobId);
}

function jobStillRunning(jobId: string): boolean {
  const row = getDb().prepare(`SELECT status FROM final_video_jobs WHERE id = ?`).get(jobId) as
    | { status: string }
    | undefined;
  return row?.status === 'running';
}

async function runFinalVideoJob(job: FinalVideoJobRow): Promise<void> {
  const db = getDb();
  const pkg: PackageConfig = mergePackageConfig(JSON.parse(job.packageJson || '{}'));
  const logInfo = (message: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message });

  // ── preparing：脚本分镜 + 片段 + 实际时长 ──
  setStep(job.id, 'preparing', 5);
  const draft = db
    .prepare(`SELECT outputJson FROM script_drafts WHERE id = ?`)
    .get(job.scriptDraftId) as { outputJson: string } | undefined;
  if (!draft) throw new Error('脚本草稿不存在，无法确定分镜顺序与字幕');
  const draftOutput = JSON.parse(draft.outputJson) as {
    shots?: Array<{ shotId: string; shotIndex: number; voiceover?: string; subtitle?: string }>;
  };
  const scriptShots: TimelineShotInput[] = (draftOutput.shots ?? []).map((s) => ({
    shotId: s.shotId,
    shotIndex: s.shotIndex,
    voiceover: String(s.voiceover ?? ''),
    subtitle: String(s.subtitle ?? ''),
  }));
  if (scriptShots.length === 0) throw new Error('脚本草稿中没有分镜');

  const clipRows = db
    .prepare(
      `SELECT shotId, id as videoJobId, localVideoPath FROM video_jobs
       WHERE shotSetId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL
       ORDER BY createdAt DESC`
    )
    .all(job.shotSetId) as Array<{ shotId: string | null; videoJobId: string; localVideoPath: string }>;
  const latestByShot = new Map<string, { videoJobId: string; localVideoPath: string }>();
  for (const row of clipRows) {
    if (row.shotId && !latestByShot.has(row.shotId) && fs.existsSync(row.localVideoPath)) {
      latestByShot.set(row.shotId, row);
    }
  }
  const clips: TimelineClipInput[] = [];
  for (const [shotId, row] of latestByShot) {
    clips.push({
      shotId,
      videoJobId: row.videoJobId,
      clipPath: row.localVideoPath,
      clipDurationSec: await probeDurationSec(row.localVideoPath),
    });
  }
  logInfo(`Prepared ${clips.length} clips for ${scriptShots.length} script shots`);

  // ── 工作目录 ──
  const jobDir = path.join(dataRoot(), 'storage', 'final-videos', job.id);
  const workDir = path.join(jobDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  // ── tts（Phase 6 交付 lib/final-video/tts.ts；在那之前 create 路由拒绝 mode='tts'）──
  let narrationDurations: Record<string, number> = {};
  let narrationFiles: Record<string, string> = {};
  if (pkg.narration.mode === 'tts') {
    setStep(job.id, 'tts', 8);
    const tts = await import('./tts');
    const synth = await tts.synthesizeNarrationSegments({
      segments: scriptShots.map((s) => ({ shotId: s.shotId, text: s.voiceover })),
      voice: pkg.narration.voice,
      speed: pkg.narration.speed,
      workDir,
      onProgress: (done, total) => setStep(job.id, 'tts', 8 + Math.round((done / Math.max(1, total)) * 12)),
    });
    narrationDurations = synth.durations;
    narrationFiles = synth.files;
  }

  // ── 时间线 ──
  const intro = pkg.cover.introDurationSec > 0 ? pkg.cover.introDurationSec : 0;
  const timeline = buildTimeline({ scriptShots, clips, narrationDurations, introDurationSec: intro });
  if (timeline.segments.length === 0) {
    throw new Error(`没有可用片段：${timeline.issues.map((i) => `分镜${i.shotIndex}${i.reason}`).join('；')}`);
  }
  db.prepare(`UPDATE final_video_jobs SET timelineJson = ? WHERE id = ?`).run(
    JSON.stringify(timeline.segments),
    job.id
  );
  for (const issue of timeline.issues) {
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'warn', message: `分镜 ${issue.shotIndex} 被跳过：${issue.reason}` });
  }

  // ── 口播整轨 ──
  let narrationTrackPath: string | null = null;
  if (pkg.narration.mode === 'tts') {
    setStep(job.id, 'narration', 25);
    const tts = await import('./tts');
    narrationTrackPath = await tts.buildNarrationTrack({
      timeline: timeline.segments,
      files: narrationFiles,
      introDurationSec: intro,
      workDir,
    });
  }

  // ── 封面（始终生成，intro>0 时兼作片头贴片）──
  setStep(job.id, 'cover', 28);
  const fontFile = resolveFontFile();
  const coverPath = path.join(jobDir, 'cover.jpg');
  await runFfmpeg(
    buildCoverArgs({
      sourceVideoPath: timeline.segments[0].clipPath,
      titleText: pkg.cover.titleText,
      titleSize: pkg.cover.titleSize,
      titleColor: pkg.cover.titleColor,
      width: pkg.width,
      height: pkg.height,
      fontFile,
      outJpgPath: coverPath,
    }),
    { timeoutMs: 60_000 }
  );

  // ── 字幕 ──
  setStep(job.id, 'subtitles', 30);
  let assPath: string | null = null;
  if (pkg.subtitle.enabled && timeline.segments.some((s) => s.subtitle.trim())) {
    assPath = path.join(workDir, 'subs.ass');
    fs.writeFileSync(assPath, buildAss(timeline.segments, pkg.subtitle, pkg.width, pkg.height), 'utf-8');
  }

  // ── 渲染 ──
  setStep(job.id, 'render', 32);
  const duckingSupported = await supportsFilter('sidechaincompress');
  const safeName = (pkg.outputName || `final-${Date.now()}`).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const outputPath = path.join(jobDir, `${safeName}.mp4`);
  let lastProgressWrite = 0;
  await runFfmpeg(
    buildRenderArgs({
      segments: timeline.segments,
      width: pkg.width,
      height: pkg.height,
      fps: pkg.fps,
      totalDurationSec: timeline.totalDurationSec,
      introDurationSec: intro,
      coverJpgPath: intro > 0 ? coverPath : null,
      narrationTrackPath,
      bgm: pkg.bgm && fs.existsSync(pkg.bgm.path) ? pkg.bgm : null,
      duckingSupported,
      assPath,
      fontsDir: fontFile ? path.dirname(fontFile) : '',
      outputPath,
    }),
    {
      timeoutMs: RENDER_TIMEOUT_MS,
      onProgressSec: (sec) => {
        const now = Date.now();
        if (now - lastProgressWrite < 1000) return;
        lastProgressWrite = now;
        if (!jobStillRunning(job.id)) return;
        const pct = 32 + Math.min(63, (sec / Math.max(0.1, timeline.totalDurationSec)) * 63);
        setStep(job.id, 'render', Math.round(pct));
      },
    }
  );

  // ── finalize ──
  setStep(job.id, 'finalize', 98);
  const actualDuration = await probeDurationSec(outputPath);
  const manifestPath = path.join(jobDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        jobId: job.id,
        projectId: job.projectId,
        shotSetId: job.shotSetId,
        scriptDraftId: job.scriptDraftId,
        createdAt: new Date().toISOString(),
        package: pkg,
        timeline: timeline.segments,
        output: { video: outputPath, cover: coverPath, durationSec: actualDuration, width: pkg.width, height: pkg.height },
      },
      null,
      2
    ),
    'utf-8'
  );
  fs.rmSync(workDir, { recursive: true, force: true });

  db.prepare(
    `UPDATE final_video_jobs SET
       status = 'succeeded', currentStep = 'done', progress = 100,
       outputPath = ?, coverPath = ?, manifestPath = ?, durationSec = ?,
       finishedAt = datetime('now')
     WHERE id = ? AND status = 'running'`
  ).run(outputPath, coverPath, manifestPath, actualDuration, job.id);
  logInfo(`Final video rendered: ${outputPath} (${actualDuration.toFixed(1)}s)`);
}
```

- [ ] **Step 2: lint + 提交**

Run: `npm run lint` → 无新告警（`./tts` 的动态 import 在 Task 14 前会被 TS 报「找不到模块」——若报错，本任务先创建占位模块 `lib/final-video/tts.ts`，内容如下，Task 14 整文件替换）：

```ts
// lib/final-video/tts.ts —— Phase 6 (Task 14) 实现真实逻辑前的守卫占位
import { TimelineSegment } from './types';

export async function synthesizeNarrationSegments(_opts: {
  segments: Array<{ shotId: string; text: string }>;
  voice: string;
  speed: number;
  workDir: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ files: Record<string, string>; durations: Record<string, number> }> {
  throw new Error('口播（TTS）功能尚未启用');
}

export async function buildNarrationTrack(_opts: {
  timeline: TimelineSegment[];
  files: Record<string, string>;
  introDurationSec: number;
  workDir: string;
}): Promise<string> {
  throw new Error('口播（TTS）功能尚未启用');
}
```

```bash
git add lib/final-video/render-queue.ts lib/final-video/tts.ts
git commit -m "feat: final video render queue and job executor"
```

### Task 8: 端到端冒烟测试（lavfi 合成素材，全链路真实渲染）

**Files:**
- Test: `scripts/final-video-e2e.test.ts`

- [ ] **Step 1: 写测试（首次即应通过——它验证的是 Phase 1-2 模块与真实 ffmpeg 的协作）**

```ts
// scripts/final-video-e2e.test.ts
// 用 lavfi 生成 2 个测试片段 + 1 段正弦 BGM，跑一遍「时间线→ASS→渲染参数→ffmpeg」全链路。
// 运行约 10-20 秒。仅本地/CI 手动跑：node scripts/final-video-e2e.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg, probeDurationSec } from '../lib/ffmpeg.ts';
import { buildTimeline } from '../lib/final-video/timeline.ts';
import { buildAss, resolveFontFile } from '../lib/final-video/subtitles.ts';
import { buildRenderArgs } from '../lib/final-video/ffmpeg-graph.ts';
import { buildCoverArgs } from '../lib/final-video/cover.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-e2e-'));
const clip = (name: string, dur: number) => path.join(tmp, name);

async function main() {
  const c1 = clip('c1.mp4', 2);
  const c2 = clip('c2.mp4', 3);
  const bgm = path.join(tmp, 'bgm.m4a');
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=30', '-pix_fmt', 'yuv420p', '-y', c1]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=3:size=360x640:rate=30', '-pix_fmt', 'yuv420p', '-y', c2]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:a', 'aac', '-y', bgm]);

  const timeline = buildTimeline({
    scriptShots: [
      { shotId: 'a', shotIndex: 1, voiceover: '', subtitle: '第一段字幕' },
      { shotId: 'b', shotIndex: 2, voiceover: '', subtitle: '第二段字幕' },
    ],
    clips: [
      { shotId: 'a', videoJobId: 'v1', clipPath: c1, clipDurationSec: await probeDurationSec(c1) },
      { shotId: 'b', videoJobId: 'v2', clipPath: c2, clipDurationSec: await probeDurationSec(c2) },
    ],
    introDurationSec: 1,
  });
  assert.equal(timeline.segments.length, 2);

  const coverJpg = path.join(tmp, 'cover.jpg');
  await runFfmpeg(
    buildCoverArgs({
      sourceVideoPath: c1, titleText: '测试标题', titleSize: 48, titleColor: '#ffffff',
      width: 540, height: 960, fontFile: resolveFontFile(), outJpgPath: coverJpg,
    })
  );
  assert.ok(fs.existsSync(coverJpg));

  const assPath = path.join(tmp, 'subs.ass');
  fs.writeFileSync(
    assPath,
    buildAss(timeline.segments, { enabled: true, fontSize: 32, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 10 }, 540, 960),
    'utf-8'
  );

  const out = path.join(tmp, 'final.mp4');
  const font = resolveFontFile();
  await runFfmpeg(
    buildRenderArgs({
      segments: timeline.segments,
      width: 540, height: 960, fps: 30,
      totalDurationSec: timeline.totalDurationSec,
      introDurationSec: 1, coverJpgPath: coverJpg,
      narrationTrackPath: null,
      bgm: { path: bgm, volume: 0.3, ducking: false },
      duckingSupported: false,
      assPath, fontsDir: font ? path.dirname(font) : '',
      outputPath: out,
    }),
    { timeoutMs: 120_000 }
  );

  const dur = await probeDurationSec(out);
  assert.ok(Math.abs(dur - timeline.totalDurationSec) < 0.35, `duration ${dur} ≈ ${timeline.totalDurationSec}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`final-video-e2e passed (${dur.toFixed(2)}s output)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: 运行 + 提交**

Run: `node scripts/final-video-e2e.test.ts`
Expected: `final-video-e2e passed (…s output)`。若报 `sidechaincompress`/`tpad` 相关错误，记录到文末「计划外偏差」，检查 ffmpeg-static 版本 ≥ 6。

```bash
git add scripts/final-video-e2e.test.ts
git commit -m "test: end-to-end final video render smoke with lavfi fixtures"
```

---

## Phase 4：API 与 UI

### Task 9: BGM 库路由

**Files:**
- Create: `app/api/bgm/route.ts`

- [ ] **Step 1: 实现**

```ts
// app/api/bgm/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { dataRoot } from '@/lib/data-root';

export const runtime = 'nodejs';

const BGM_EXTS = ['.mp3', '.m4a', '.wav', '.aac', '.flac'];

function bgmDir(): string {
  const dir = path.join(dataRoot(), 'storage', 'bgm');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function GET() {
  try {
    const dir = bgmDir();
    const files = fs
      .readdirSync(dir)
      .filter((name) => BGM_EXTS.includes(path.extname(name).toLowerCase()))
      .sort()
      .map((name) => ({ name, path: path.join(dir, name) }));
    return NextResponse.json({ bgm: files, dir });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: '缺少文件' }, { status: 400 });
    const ext = path.extname(file.name).toLowerCase();
    if (!BGM_EXTS.includes(ext)) {
      return NextResponse.json({ error: `不支持的音频格式：${ext}（支持 ${BGM_EXTS.join(' ')}）` }, { status: 400 });
    }
    const base = path
      .basename(file.name, ext)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .slice(0, 80) || 'bgm';
    const dir = bgmDir();
    let target = path.join(dir, `${base}${ext}`);
    if (fs.existsSync(target)) target = path.join(dir, `${base}-${Date.now()}${ext}`);
    fs.writeFileSync(target, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ success: true, name: path.basename(target), path: target });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: 验证 + 提交**

Run: `npm run dev` 后
`curl -s http://localhost:3000/api/bgm` → `{"bgm":[],"dir":"…/storage/bgm"}`
`curl -s -F "file=@/System/Library/Sounds/Glass.aiff" http://localhost:3000/api/bgm` → 400（格式校验生效）

```bash
git add app/api/bgm/route.ts
git commit -m "feat: BGM library list/upload endpoints"
```

### Task 10: 成片任务路由（create/list/preview/详情/重试/删除）

**Files:**
- Create: `lib/final-video/draft.ts`
- Create: `app/api/projects/[id]/final-videos/route.ts`
- Create: `app/api/projects/[id]/final-videos/preview/route.ts`
- Create: `app/api/final-video-jobs/[id]/route.ts`
- Create: `app/api/final-video-jobs/[id]/retry/route.ts`

- [ ] **Step 1: 草稿匹配 helper**

```ts
// lib/final-video/draft.ts
/** 找到指定分镜组的最新脚本草稿（outputJson.shotSetId 匹配）。 */
import type BetterSqlite3 from 'better-sqlite3';

export interface MatchedDraft {
  id: string;
  output: {
    title?: string;
    shotSetId?: string;
    shots?: Array<{ shotId: string; shotIndex: number; voiceover?: string; subtitle?: string }>;
    fullScript?: string;
  };
}

export function findScriptDraftForShotSet(
  db: BetterSqlite3.Database,
  projectId: string,
  shotSetId: string
): MatchedDraft | null {
  const drafts = db
    .prepare(`SELECT id, outputJson FROM script_drafts WHERE projectId = ? ORDER BY createdAt DESC`)
    .all(projectId) as Array<{ id: string; outputJson: string }>;
  for (const d of drafts) {
    try {
      const output = JSON.parse(d.outputJson);
      if (output?.shotSetId === shotSetId) return { id: d.id, output };
    } catch {
      continue;
    }
  }
  return null;
}
```

- [ ] **Step 2: create + list 路由**

```ts
// app/api/projects/[id]/final-videos/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { mergePackageConfig, FinalVideoJobRow, PackageConfig } from '@/lib/final-video/types';
import { findScriptDraftForShotSet } from '@/lib/final-video/draft';
import { startFinalVideoQueue } from '@/lib/final-video/render-queue';
import { toStorageImageUrl, toStorageVideoUrl } from '@/lib/storage-url';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const db = getDb();
    const body = (await request.json().catch(() => ({}))) as {
      shotSetId?: string;
      packageConfig?: Partial<PackageConfig>;
    };
    const shotSetId = body.shotSetId;
    if (!shotSetId) return NextResponse.json({ error: 'shotSetId is required' }, { status: 400 });

    const shotSet = db
      .prepare(`SELECT id FROM shot_sets WHERE id = ? AND projectId = ?`)
      .get(shotSetId, projectId);
    if (!shotSet) return NextResponse.json({ error: '分镜组不存在' }, { status: 404 });

    const draft = findScriptDraftForShotSet(db, projectId, shotSetId);
    if (!draft) return NextResponse.json({ error: '该分镜组还没有匹配的脚本草稿，请先在「脚本生成」中生成' }, { status: 400 });

    const clipCount = db
      .prepare(
        `SELECT COUNT(DISTINCT shotId) as count FROM video_jobs
         WHERE shotSetId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL`
      )
      .get(shotSetId) as { count: number };
    if (clipCount.count === 0) {
      return NextResponse.json({ error: '该分镜组还没有已完成的视频片段' }, { status: 400 });
    }

    const pkg = mergePackageConfig(body.packageConfig);
    if (pkg.narration.mode !== 'none' && pkg.narration.mode !== 'tts') {
      return NextResponse.json({ error: `未知口播模式: ${pkg.narration.mode}` }, { status: 400 });
    }
    // Phase 6 (Task 14/15) 落地前，口播固定关闭：
    if (pkg.narration.mode === 'tts') {
      return NextResponse.json({ error: '口播（TTS）功能尚未启用' }, { status: 400 });
    }

    const jobId = uuidv4();
    db.prepare(
      `INSERT INTO final_video_jobs (id, projectId, shotSetId, scriptDraftId, packageJson)
       VALUES (?, ?, ?, ?, ?)`
    ).run(jobId, projectId, shotSetId, draft.id, JSON.stringify(pkg));

    startFinalVideoQueue();
    return NextResponse.json({ success: true, jobId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const db = getDb();
    const rows = db
      .prepare(`SELECT * FROM final_video_jobs WHERE projectId = ? ORDER BY createdAt DESC`)
      .all(projectId) as FinalVideoJobRow[];
    const jobs = rows.map((row) => {
      let packageConfig: PackageConfig | Record<string, never> = {};
      try {
        packageConfig = mergePackageConfig(JSON.parse(row.packageJson));
      } catch {
        /* keep empty */
      }
      return {
        id: row.id,
        shotSetId: row.shotSetId,
        status: row.status,
        currentStep: row.currentStep,
        progress: row.progress,
        durationSec: row.durationSec,
        errorMessage: row.errorMessage,
        createdAt: row.createdAt,
        packageConfig,
        outputUrl: toStorageVideoUrl(row.outputPath),
        coverUrl: toStorageImageUrl(row.coverPath),
      };
    });
    return NextResponse.json({ jobs });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 3: preview 路由（提交前预览分镜↔片段匹配情况）**

```ts
// app/api/projects/[id]/final-videos/preview/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getDb } from '@/lib/db';
import { buildTimeline } from '@/lib/final-video/timeline';
import { findScriptDraftForShotSet } from '@/lib/final-video/draft';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const shotSetId = request.nextUrl.searchParams.get('shotSetId');
    if (!shotSetId) return NextResponse.json({ error: 'shotSetId is required' }, { status: 400 });
    const db = getDb();

    const draft = findScriptDraftForShotSet(db, projectId, shotSetId);
    if (!draft) return NextResponse.json({ draft: null, segments: [], issues: [] });

    const clipRows = db
      .prepare(
        `SELECT shotId, id as videoJobId, localVideoPath, durationSec FROM video_jobs
         WHERE shotSetId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL
         ORDER BY createdAt DESC`
      )
      .all(shotSetId) as Array<{ shotId: string | null; videoJobId: string; localVideoPath: string; durationSec: number }>;
    const latest = new Map<string, { videoJobId: string; localVideoPath: string; durationSec: number }>();
    for (const row of clipRows) {
      if (row.shotId && !latest.has(row.shotId) && fs.existsSync(row.localVideoPath)) latest.set(row.shotId, row);
    }

    const scriptShots = (draft.output.shots ?? []).map((s) => ({
      shotId: s.shotId,
      shotIndex: s.shotIndex,
      voiceover: String(s.voiceover ?? ''),
      subtitle: String(s.subtitle ?? ''),
    }));
    // 预览用请求时长近似，正式渲染时执行器会 ffprobe 实际时长
    const { segments, issues, totalDurationSec } = buildTimeline({
      scriptShots,
      clips: [...latest.entries()].map(([shotId, c]) => ({
        shotId,
        videoJobId: c.videoJobId,
        clipPath: c.localVideoPath,
        clipDurationSec: c.durationSec,
      })),
    });
    return NextResponse.json({
      draft: { id: draft.id, title: draft.output.title ?? '' },
      segments,
      issues,
      totalDurationSec,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 4: 任务详情 / 删除 / 重试路由**

```ts
// app/api/final-video-jobs/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { FinalVideoJobRow } from '@/lib/final-video/types';
import { toStorageImageUrl, toStorageVideoUrl } from '@/lib/storage-url';

export const runtime = 'nodejs';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const row = getDb().prepare(`SELECT * FROM final_video_jobs WHERE id = ?`).get(id) as FinalVideoJobRow | undefined;
  if (!row) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json({
    job: { ...row, outputUrl: toStorageVideoUrl(row.outputPath), coverUrl: toStorageImageUrl(row.coverPath) },
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db.prepare(`SELECT status FROM final_video_jobs WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!row) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (row.status === 'running') return NextResponse.json({ error: '任务执行中，不能删除' }, { status: 409 });

  const jobDir = path.join(dataRoot(), 'storage', 'final-videos', id);
  const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
  if (path.resolve(jobDir).startsWith(storageRoot + path.sep)) {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
  db.prepare(`DELETE FROM final_video_jobs WHERE id = ?`).run(id);
  return NextResponse.json({ success: true });
}
```

```ts
// app/api/final-video-jobs/[id]/retry/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { startFinalVideoQueue } from '@/lib/final-video/render-queue';

export const runtime = 'nodejs';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db.prepare(`SELECT status FROM final_video_jobs WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!row) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (row.status !== 'failed' && row.status !== 'canceled') {
    return NextResponse.json({ error: `当前状态 ${row.status} 不能重试` }, { status: 409 });
  }
  db.prepare(
    `UPDATE final_video_jobs SET status = 'pending', currentStep = 'queued', progress = 0, errorMessage = NULL WHERE id = ?`
  ).run(id);
  startFinalVideoQueue();
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 5: 验证 + 提交**

Run: `npm run lint`；`npm run dev` 起服务后对一个真实项目：
`curl -s "http://localhost:3000/api/projects/<projectId>/final-videos/preview?shotSetId=<shotSetId>"` → 返回 segments/issues；
`curl -s -X POST http://localhost:3000/api/projects/<projectId>/final-videos -H 'Content-Type: application/json' -d '{"shotSetId":"<shotSetId>"}'` → `{"success":true,"jobId":"…"}`，随后 GET 列表看到任务推进至 `succeeded`，`storage/final-videos/<jobId>/` 出现 mp4 + cover.jpg + manifest.json。

```bash
git add lib/final-video/draft.ts app/api/projects/[id]/final-videos app/api/final-video-jobs
git commit -m "feat: final video job API (create/list/preview/detail/retry/delete)"
```

### Task 11: 工作台「成片包装」Tab 与面板

**Files:**
- Modify: `components/ProjectWorkbenchTabs.tsx`
- Modify: `app/projects/[id]/page.tsx:92`（WORKBENCH_TABS）与 :582 附近（内容分支）
- Create: `components/FinalVideoPanel.tsx`

- [ ] **Step 1: Tab 注册**

`components/ProjectWorkbenchTabs.tsx`：

```ts
export type WorkbenchTabId = 'scene' | 'storyboard' | 'script' | 'video' | 'package';
```

TABS 数组 `video` 项之后追加：

```ts
  { id: 'package', label: '成片包装', description: 'BGM、字幕、封面标题，一键合成成品' },
```

`app/projects/[id]/page.tsx:92`：

```ts
const WORKBENCH_TABS: WorkbenchTabId[] = ['scene', 'storyboard', 'script', 'video', 'package'];
```

同文件顶部 import 区追加：

```ts
import FinalVideoPanel from '@/components/FinalVideoPanel';
```

`activeTab === 'video'` 分支之后追加：

```tsx
            {activeTab === 'package' && (
              <div className="video-generation-section">
                <div className="video-generation-heading">
                  <h2 className="text-base font-semibold">成片包装</h2>
                  <p className="mt-1 text-sm text-ink-secondary">按脚本顺序拼接分镜视频，配 BGM、字幕与封面标题，输出可发布成品。</p>
                </div>
                <FinalVideoPanel projectId={project.id} />
              </div>
            )}
```

- [ ] **Step 2: 面板组件**

```tsx
// components/FinalVideoPanel.tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface ShotSetOption { id: string; name: string }
interface PreviewSegment { shotIndex: number; subtitle: string; clipDurationSec: number }
interface PreviewIssue { shotIndex: number; reason: string }
interface PreviewData {
  draft: { id: string; title: string } | null;
  segments: PreviewSegment[];
  issues: PreviewIssue[];
  totalDurationSec: number;
}
interface BgmFile { name: string; path: string }
interface FinalJob {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';
  currentStep: string;
  progress: number;
  durationSec: number | null;
  errorMessage: string | null;
  createdAt: string;
  packageConfig: { outputName?: string };
  outputUrl: string;
  coverUrl: string;
}

const STEP_LABELS: Record<string, string> = {
  queued: '排队中', preparing: '准备素材', tts: '合成口播', narration: '拼装口播音轨',
  cover: '生成封面', subtitles: '生成字幕', render: '合成视频', finalize: '写入产物', done: '完成',
};

const RESOLUTIONS = [
  { key: '9:16', label: '竖版 1080×1920', width: 1080, height: 1920 },
  { key: '16:9', label: '横版 1920×1080', width: 1920, height: 1080 },
  { key: '1:1', label: '方形 1080×1080', width: 1080, height: 1080 },
];

export default function FinalVideoPanel({ projectId }: { projectId: string }) {
  const [shotSets, setShotSets] = useState<ShotSetOption[]>([]);
  const [selectedSetId, setSelectedSetId] = useState('');
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [bgmFiles, setBgmFiles] = useState<BgmFile[]>([]);
  const [jobs, setJobs] = useState<FinalJob[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 包装配置表单
  const [resolution, setResolution] = useState('9:16');
  const [bgmPath, setBgmPath] = useState('');
  const [bgmVolume, setBgmVolume] = useState(0.25);
  const [ducking, setDucking] = useState(true);
  const [coverTitle, setCoverTitle] = useState('');
  const [introSec, setIntroSec] = useState(0);
  const [subtitleEnabled, setSubtitleEnabled] = useState(true);
  const [subtitleSize, setSubtitleSize] = useState(56);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadShotSets = useCallback(async () => {
    const resp = await fetch(`/api/projects/${projectId}/shot-sets`);
    const data = await resp.json().catch(() => ({}));
    // 与 VideoGenerationPanel.tsx 读取分镜组列表的解析保持一致
    const sets: ShotSetOption[] = (data.shotSets ?? data.sets ?? []).map((s: { id: string; name: string }) => ({ id: s.id, name: s.name }));
    setShotSets(sets);
    if (sets.length > 0 && !selectedSetId) setSelectedSetId(sets[0].id);
  }, [projectId, selectedSetId]);

  const loadPreview = useCallback(async (setId: string) => {
    if (!setId) { setPreview(null); return; }
    const resp = await fetch(`/api/projects/${projectId}/final-videos/preview?shotSetId=${encodeURIComponent(setId)}`);
    setPreview(await resp.json().catch(() => null));
  }, [projectId]);

  const loadBgm = useCallback(async () => {
    const resp = await fetch('/api/bgm');
    const data = await resp.json().catch(() => ({}));
    setBgmFiles(data.bgm ?? []);
  }, []);

  const loadJobs = useCallback(async () => {
    const resp = await fetch(`/api/projects/${projectId}/final-videos`);
    const data = await resp.json().catch(() => ({}));
    setJobs(data.jobs ?? []);
  }, [projectId]);

  useEffect(() => {
    loadShotSets();
    loadBgm();
    loadJobs();
  }, [loadShotSets, loadBgm, loadJobs]);

  useEffect(() => {
    loadPreview(selectedSetId);
  }, [selectedSetId, loadPreview]);

  // 有活跃任务时每 2s 轮询
  useEffect(() => {
    const active = jobs.some((j) => j.status === 'pending' || j.status === 'running');
    if (active && !pollTimer.current) {
      pollTimer.current = setInterval(loadJobs, 2000);
    }
    if (!active && pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    return () => {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    };
  }, [jobs, loadJobs]);

  const handleUploadBgm = useCallback(async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch('/api/bgm', { method: 'POST', body: form });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { setError(data.error || '上传失败'); return; }
    await loadBgm();
    setBgmPath(data.path);
  }, [loadBgm]);

  const handleSubmit = useCallback(async () => {
    if (!selectedSetId) return;
    setSubmitting(true);
    setError('');
    const res = RESOLUTIONS.find((r) => r.key === resolution) ?? RESOLUTIONS[0];
    try {
      const resp = await fetch(`/api/projects/${projectId}/final-videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shotSetId: selectedSetId,
          packageConfig: {
            outputName: `final-${Date.now()}`,
            width: res.width,
            height: res.height,
            bgm: bgmPath ? { path: bgmPath, volume: bgmVolume, ducking } : null,
            cover: { titleText: coverTitle, titleSize: 72, titleColor: '#ffffff', introDurationSec: introSec },
            subtitle: { enabled: subtitleEnabled, fontSize: subtitleSize, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 10 },
          },
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || '提交失败');
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [projectId, selectedSetId, resolution, bgmPath, bgmVolume, ducking, coverTitle, introSec, subtitleEnabled, subtitleSize, loadJobs]);

  const handleRetry = useCallback(async (id: string) => {
    await fetch(`/api/final-video-jobs/${id}/retry`, { method: 'POST' });
    await loadJobs();
  }, [loadJobs]);

  const handleDelete = useCallback(async (id: string) => {
    await fetch(`/api/final-video-jobs/${id}`, { method: 'DELETE' });
    await loadJobs();
  }, [loadJobs]);

  return (
    <div className="mt-3 space-y-4">
      {/* ① 分镜组与匹配预览 */}
      <div className="rounded-lg border border-hairline p-4">
        <label className="label">选择分镜组</label>
        <select value={selectedSetId} onChange={(e) => setSelectedSetId(e.target.value)} className="input-field text-sm">
          {shotSets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {shotSets.length === 0 && <p className="mt-1 text-xs text-ink-tertiary">暂无分镜组，请先完成分镜与视频生成。</p>}

        {preview && !preview.draft && (
          <p className="mt-2 text-xs text-ink-tertiary">该分镜组还没有匹配的脚本草稿，请先在「脚本生成」中生成。</p>
        )}
        {preview?.draft && (
          <div className="mt-3">
            <p className="text-xs text-ink-secondary">脚本：{preview.draft.title || preview.draft.id}　预计成片 ≈ {preview.totalDurationSec.toFixed(1)}s</p>
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-left text-ink-tertiary">
                  <th className="py-1 pr-2">分镜</th><th className="py-1 pr-2">字幕</th><th className="py-1">片段</th>
                </tr>
              </thead>
              <tbody>
                {preview.segments.map((s) => (
                  <tr key={s.shotIndex} className="border-t border-hairline">
                    <td className="py-1 pr-2">#{s.shotIndex}</td>
                    <td className="py-1 pr-2 text-ink-secondary">{s.subtitle || '—'}</td>
                    <td className="py-1">✓ {s.clipDurationSec.toFixed(1)}s</td>
                  </tr>
                ))}
                {preview.issues.map((i) => (
                  <tr key={`issue-${i.shotIndex}`} className="border-t border-hairline">
                    <td className="py-1 pr-2">#{i.shotIndex}</td>
                    <td className="py-1 pr-2 text-ink-tertiary">—</td>
                    <td className="py-1 text-red-500">✗ {i.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ② 包装配置 */}
      <div className="rounded-lg border border-hairline p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">画面比例</label>
            <select value={resolution} onChange={(e) => setResolution(e.target.value)} className="input-field text-sm">
              {RESOLUTIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">封面标题（留空则不加字）</label>
            <input value={coverTitle} onChange={(e) => setCoverTitle(e.target.value)} className="input-field text-sm" placeholder="如：三大亮点一次看完" />
          </div>
          <div>
            <label className="label">片头贴片</label>
            <select value={introSec} onChange={(e) => setIntroSec(Number(e.target.value))} className="input-field text-sm">
              <option value={0}>无</option><option value={1}>1 秒</option><option value={2}>2 秒</option>
            </select>
          </div>
          <div>
            <label className="label">BGM</label>
            <select value={bgmPath} onChange={(e) => setBgmPath(e.target.value)} className="input-field text-sm">
              <option value="">无 BGM</option>
              {bgmFiles.map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
            </select>
            <div className="mt-1 flex items-center gap-2 text-xs text-ink-secondary">
              <input type="file" accept=".mp3,.m4a,.wav,.aac,.flac" className="text-xs"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadBgm(f); e.target.value = ''; }} />
            </div>
            {bgmPath && (
              <div className="mt-1 flex items-center gap-2 text-xs">
                <span className="text-ink-tertiary">音量 {Math.round(bgmVolume * 100)}%</span>
                <input type="range" min={0.05} max={0.6} step={0.05} value={bgmVolume} onChange={(e) => setBgmVolume(Number(e.target.value))} />
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={ducking} onChange={(e) => setDucking(e.target.checked)} /> 口播时压低
                </label>
              </div>
            )}
          </div>
          <div>
            <label className="label">字幕</label>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={subtitleEnabled} onChange={(e) => setSubtitleEnabled(e.target.checked)} /> 烧录字幕
              </label>
              {subtitleEnabled && (
                <span className="flex items-center gap-1 text-ink-secondary">
                  字号 <input type="number" min={28} max={96} value={subtitleSize} onChange={(e) => setSubtitleSize(Number(e.target.value))} className="input-field w-16 text-xs" />
                </span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={handleSubmit}
          disabled={submitting || !preview?.draft || (preview?.segments.length ?? 0) === 0}
          className="btn-primary btn-sm"
        >
          {submitting ? '提交中…' : '开始合成成片'}
        </button>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      {/* ③ 任务列表 */}
      <div className="space-y-2">
        {jobs.length === 0 && <p className="text-xs text-ink-tertiary">暂无成片任务。</p>}
        {jobs.map((job) => (
          <div key={job.id} className="rounded-lg border border-hairline p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{job.packageConfig.outputName || job.id}</p>
                <p className="text-xs text-ink-tertiary">
                  {STEP_LABELS[job.currentStep] || job.currentStep}
                  {job.status === 'succeeded' && job.durationSec ? ` · ${job.durationSec.toFixed(1)}s` : ''}
                  {job.status === 'failed' ? ' · 失败' : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {job.status === 'failed' && (
                  <button onClick={() => handleRetry(job.id)} className="btn-secondary btn-sm">重试</button>
                )}
                {job.status !== 'running' && job.status !== 'pending' && (
                  <button onClick={() => handleDelete(job.id)} className="btn-danger btn-sm">删除</button>
                )}
                {job.status === 'succeeded' && job.outputUrl && (
                  <a href={job.outputUrl} download className="btn-secondary btn-sm">下载</a>
                )}
              </div>
            </div>
            {(job.status === 'pending' || job.status === 'running') && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-surface-subtle">
                <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(job.progress)}%`, background: 'var(--color-accent)' }} />
              </div>
            )}
            {job.status === 'failed' && job.errorMessage && (
              <p className="mt-2 break-all text-xs text-red-500">{job.errorMessage}</p>
            )}
            {job.status === 'succeeded' && job.outputUrl && (
              <div className="mt-2 flex items-start gap-3">
                <video controls preload="metadata" src={job.outputUrl} poster={job.coverUrl || undefined} className="max-h-72 rounded-lg border border-hairline" />
                {job.coverUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={job.coverUrl} alt="封面" className="max-h-72 rounded-lg border border-hairline object-cover" />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

注意：`loadShotSets` 里的响应字段解析（`data.shotSets ?? data.sets`）必须和 `components/VideoGenerationPanel.tsx` 实际使用的字段一致——动手时打开该文件核对一次，以它为准。

- [ ] **Step 3: 验证 + 提交**

Run: `npm run lint`；`npm run dev` → 打开一个已有视频片段的项目 → 「成片包装」Tab 可见 → 选分镜组出现匹配预览 → 提交任务 → 进度条推进到 100 → 页面内可播放成品、下载、看封面。刷新页面任务列表恢复。

```bash
git add components/ProjectWorkbenchTabs.tsx components/FinalVideoPanel.tsx app/projects/[id]/page.tsx
git commit -m "feat: final video packaging workbench tab with preview, config form, job list"
```

---

## Phase 5：导出与安装包

### Task 12: 创作包 ZIP 收编成片

**Files:**
- Modify: `app/api/projects/[id]/creative-package/route.ts`

- [ ] **Step 1: 加入成片条目**

在「Add script files」段之前插入（即 videos 循环结束后）：

```ts
    // Add final packaged videos
    const finalRows = db.prepare(`
      SELECT id, outputPath, coverPath, manifestPath, packageJson, durationSec FROM final_video_jobs
      WHERE projectId = ? AND status = 'succeeded' AND outputPath IS NOT NULL
      ORDER BY createdAt
    `).all(projectId) as Array<{
      id: string; outputPath: string; coverPath: string | null;
      manifestPath: string | null; packageJson: string; durationSec: number | null;
    }>;
    const manifestFinals: Array<{ filename: string; cover: string; durationSec: number | null }> = [];
    const storageRootForFinals = path.resolve(path.join(dataRoot(), 'storage'));
    for (const f of finalRows) {
      let outputName = f.id;
      try { outputName = String(JSON.parse(f.packageJson).outputName || f.id); } catch { /* keep id */ }
      const resolvedOut = path.resolve(f.outputPath);
      if (!resolvedOut.startsWith(storageRootForFinals + path.sep) || !fs.existsSync(resolvedOut)) continue;
      const videoEntry = addEntry(resolvedOut, `${prefix}finals/${outputName}.mp4`);
      let coverEntry = '';
      if (f.coverPath && fs.existsSync(f.coverPath) && path.resolve(f.coverPath).startsWith(storageRootForFinals + path.sep)) {
        coverEntry = addEntry(path.resolve(f.coverPath), `${prefix}finals/${outputName}-cover.jpg`);
      }
      if (f.manifestPath && fs.existsSync(f.manifestPath) && path.resolve(f.manifestPath).startsWith(storageRootForFinals + path.sep)) {
        addEntry(path.resolve(f.manifestPath), `${prefix}finals/${outputName}-manifest.json`);
      }
      manifestFinals.push({ filename: videoEntry, cover: coverEntry, durationSec: f.durationSec });
    }
```

manifest 对象追加字段（`shots: manifestShots,` 之后）：

```ts
      finalVideos: manifestFinals,
```

- [ ] **Step 2: 验证 + 提交**

对有成片的项目下载创作包，ZIP 内出现 `finals/<outputName>.mp4`、`-cover.jpg`、`-manifest.json`，`manifest.json` 有 `finalVideos` 字段。

```bash
git add app/api/projects/[id]/creative-package/route.ts
git commit -m "feat: include packaged final videos in creative package export"
```

### Task 13: 安装包断言与文档

**Files:**
- Modify: `scripts/build-mac-installer.sh:149-154`（forbidden 循环之后）
- Modify: `scripts/build-win-installer.ps1:134-139`（$forbiddenPayload 循环之后）
- Modify: `CLAUDE.md`、`MACOS.md`

- [ ] **Step 1: macOS 断言**

`build-mac-installer.sh` 的 forbidden 循环之后追加：

```bash
for ffbin in \
  "node_modules/ffmpeg-static/ffmpeg" \
  "node_modules/ffprobe-static/bin/darwin/arm64/ffprobe"; do
  if [ ! -x "$PAYLOAD/$ffbin" ]; then
    echo "Installer payload missing bundled ffmpeg binary: $PAYLOAD/$ffbin" >&2
    exit 1
  fi
done
```

- [ ] **Step 2: Windows 断言**

`build-win-installer.ps1` 的 `$forbiddenPayload` 循环之后追加：

```powershell
$ffmpegBinaries = @(
  'node_modules\ffmpeg-static\ffmpeg.exe',
  'node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe'
)
foreach ($relativePath in $ffmpegBinaries) {
  $target = Join-Path $AppDir $relativePath
  if (-not (Test-Path $target)) {
    throw "Installer payload missing bundled ffmpeg binary: $target"
  }
}
```

（若 ffprobe-static 包内实际二进制路径与上述不符，以 `node -e "console.log(require('ffprobe-static').path)"` 输出为准修正两处断言。）

- [ ] **Step 3: 文档**

- `CLAUDE.md` Architecture 的 `lib/` 清单加一行：`final-video/ — 成片包装引擎（时间线/ASS 字幕/FFmpeg 渲染图/渲染队列），ffmpeg 二进制经 lib/ffmpeg.ts 解析（env → ffmpeg-static → PATH）`；Desktop packaging 一节加：`ffmpeg-static/ffprobe-static 由 sync-standalone-assets.mjs 拷入 standalone，两个安装脚本会断言其存在`。
- `MACOS.md` 数据目录说明处补充：成品位于 `storage/final-videos/`，BGM 库位于 `storage/bgm/`。

- [ ] **Step 4: 构建验证 + 提交**

Run: `npm run build` → 成功且 `.next/standalone/node_modules/ffmpeg-static/ffmpeg` 存在。
（有条件时跑 `npm run build:mac-installer` 全量验证，安装后在无 Homebrew ffmpeg 的环境合成一条成片。）

```bash
git add scripts/build-mac-installer.sh scripts/build-win-installer.ps1 CLAUDE.md MACOS.md
git commit -m "build: assert bundled ffmpeg binaries in installer payloads, document final-video module"
```

---

## Phase 6：口播 TTS（可整期裁剪；裁剪后成片=画面+BGM+字幕+封面）

### Task 14: qwen-tts 客户端与口播音轨

**Files:**
- Modify: `lib/final-video/tts.ts`（整文件替换 Task 7 的占位）
- Modify: `app/api/projects/[id]/final-videos/route.ts`（放开 `mode==='tts'` 的 400 拦截，改为校验 API key）

- [ ] **Step 1: 实现 tts.ts**

```ts
// lib/final-video/tts.ts
/**
 * 口播合成：DashScope qwen-tts（HTTP，非流式）→ 逐段音频 → 按时间线拼装整轨。
 * 语速用本地 atempo 实现（provider 无关）。API key: QWEN_TTS_API_KEY || DASHSCOPE_API_KEY。
 * 若 DashScope 响应结构与此处不符，以官方文档为准调整解析并在计划偏差记录注明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, probeDurationSec } from '../ffmpeg';
import { TimelineSegment } from './types';

const QWEN_TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

export function resolveTtsApiKey(): string {
  return process.env.QWEN_TTS_API_KEY || process.env.DASHSCOPE_API_KEY || '';
}

async function synthesizeOne(text: string, voice: string, apiKey: string): Promise<Buffer> {
  const resp = await fetch(QWEN_TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen-tts', input: { text, voice } }),
  });
  if (!resp.ok) throw new Error(`qwen-tts HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = (await resp.json()) as { output?: { audio?: { url?: string } } };
  const url = data?.output?.audio?.url;
  if (!url) throw new Error(`qwen-tts 未返回音频 URL: ${JSON.stringify(data).slice(0, 300)}`);
  const audio = await fetch(url);
  if (!audio.ok) throw new Error(`口播音频下载失败 HTTP ${audio.status}`);
  return Buffer.from(await audio.arrayBuffer());
}

export async function synthesizeNarrationSegments(opts: {
  segments: Array<{ shotId: string; text: string }>;
  voice: string;
  speed: number;
  workDir: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ files: Record<string, string>; durations: Record<string, number> }> {
  const apiKey = resolveTtsApiKey();
  if (!apiKey) throw new Error('未配置口播 API key（QWEN_TTS_API_KEY 或 DASHSCOPE_API_KEY）');
  const speed = Math.min(2, Math.max(0.5, opts.speed || 1));
  const targets = opts.segments.filter((s) => s.text.trim());
  const files: Record<string, string> = {};
  const durations: Record<string, number> = {};
  let done = 0;
  for (const seg of targets) {
    const raw = path.join(opts.workDir, `tts-${seg.shotId}-raw.wav`);
    const final = path.join(opts.workDir, `tts-${seg.shotId}.m4a`);
    fs.writeFileSync(raw, await synthesizeOne(seg.text.trim(), opts.voice, apiKey));
    const atempo = Math.abs(speed - 1) > 0.01 ? ['-filter:a', `atempo=${speed}`] : [];
    await runFfmpeg(['-i', raw, ...atempo, '-c:a', 'aac', '-b:a', '128k', '-y', final], { timeoutMs: 60_000 });
    fs.unlinkSync(raw);
    files[seg.shotId] = final;
    durations[seg.shotId] = await probeDurationSec(final);
    done += 1;
    opts.onProgress?.(done, targets.length);
  }
  return { files, durations };
}

/** 按最终时间线拼装整轨：每段 apad 到 segmentDurationSec，无口播段填静音，片头前置静音。 */
export async function buildNarrationTrack(opts: {
  timeline: TimelineSegment[];
  files: Record<string, string>;
  introDurationSec: number;
  workDir: string;
}): Promise<string> {
  const out = path.join(opts.workDir, 'narration.m4a');
  const args: string[] = ['-hide_banner'];
  const parts: string[] = [];
  const labels: string[] = [];
  let inputIdx = 0;

  if (opts.introDurationSec > 0) {
    parts.push(`aevalsrc=0:d=${opts.introDurationSec}:s=44100[aintro]`);
    labels.push('[aintro]');
  }
  opts.timeline.forEach((seg, k) => {
    const file = opts.files[seg.shotId];
    if (file && seg.narrationDurationSec > 0) {
      args.push('-i', file);
      parts.push(`[${inputIdx}:a]apad=whole_dur=${seg.segmentDurationSec.toFixed(3)}[a${k}]`);
      inputIdx += 1;
    } else {
      parts.push(`aevalsrc=0:d=${seg.segmentDurationSec.toFixed(3)}:s=44100[a${k}]`);
    }
    labels.push(`[a${k}]`);
  });
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[aout]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '128k', '-y', out);
  await runFfmpeg(args, { timeoutMs: 120_000 });
  return out;
}
```

- [ ] **Step 2: create 路由放开 tts**

`app/api/projects/[id]/final-videos/route.ts` 中删除「Phase 6 落地前」那段 400 拦截，替换为：

```ts
    if (pkg.narration.mode === 'tts') {
      const { resolveTtsApiKey } = await import('@/lib/final-video/tts');
      if (!resolveTtsApiKey()) {
        return NextResponse.json({ error: '未配置口播 API key：请在 .env.local 设置 QWEN_TTS_API_KEY（或 DASHSCOPE_API_KEY）' }, { status: 400 });
      }
    }
```

- [ ] **Step 3: 验证 + 提交**

`.env.local` 配好 key 后，`curl -s -X POST http://localhost:3000/api/projects/<pid>/final-videos -H 'Content-Type: application/json' -d '{"shotSetId":"<sid>","packageConfig":{"narration":{"mode":"tts","voice":"Cherry","speed":1.0}}}'` → 任务完成后成品带口播；口播长于片段的分镜末帧定格、音画同步；配 BGM 时口播段音乐明显压低。

```bash
git add lib/final-video/tts.ts app/api/projects/[id]/final-videos/route.ts
git commit -m "feat: qwen-tts narration synthesis and timeline-aligned narration track"
```

### Task 15: 口播 UI 控件

**Files:**
- Modify: `components/FinalVideoPanel.tsx`

- [ ] **Step 1: 表单加口播区**

状态区追加：

```ts
  const [narrationMode, setNarrationMode] = useState<'none' | 'tts'>('none');
  const [voice, setVoice] = useState('Cherry');
  const [speed, setSpeed] = useState(1.0);
```

「包装配置」grid 里追加一格（BGM 之前）：

```tsx
          <div>
            <label className="label">口播配音</label>
            <select value={narrationMode} onChange={(e) => setNarrationMode(e.target.value as 'none' | 'tts')} className="input-field text-sm">
              <option value="none">不配音（仅画面+BGM）</option>
              <option value="tts">AI 配音（qwen-tts）</option>
            </select>
            {narrationMode === 'tts' && (
              <div className="mt-1 flex items-center gap-2 text-xs">
                <select value={voice} onChange={(e) => setVoice(e.target.value)} className="input-field w-24 text-xs">
                  {['Cherry', 'Serena', 'Ethan', 'Chelsie'].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <span className="text-ink-tertiary">语速 {speed.toFixed(1)}x</span>
                <input type="range" min={0.8} max={1.5} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
              </div>
            )}
          </div>
```

`handleSubmit` 的 `packageConfig` 增加：

```ts
            narration: { mode: narrationMode, voice, speed },
```

并把 `narrationMode, voice, speed` 加进 `handleSubmit` 的依赖数组。

- [ ] **Step 2: 验证 + 提交**

Run: `npm run lint`；UI 全流程：选 AI 配音 → 出片含口播；未配 key 时提交报清晰错误。

```bash
git add components/FinalVideoPanel.tsx
git commit -m "feat: narration voice/speed controls in final video panel"
```

---

## 统一验收（全部任务完成后跑一遍）

```bash
node scripts/ffmpeg-resolve.test.ts
node scripts/final-video-timeline.test.ts
node scripts/final-video-subtitles.test.ts
node scripts/final-video-graph.test.ts
node scripts/final-video-e2e.test.ts
node scripts/storage-url.test.ts
node scripts/db-migrations.test.ts
npm run lint
npm run build      # 确认 .next/standalone/node_modules/ffmpeg-static/ffmpeg 存在
```

手动清单：
1. 真实项目：脚本 + ≥2 个分镜片段 → 成片包装 Tab → 预览表正确标出缺片段的分镜 → 提交 → 进度真实推进 → 成品可播、字幕/BGM/封面标题符合配置。
2. 创作包 ZIP 含 `finals/`。
3. `npm run build:mac-installer` 产出 DMG，安装到干净环境（无系统 ffmpeg）后合成成功。
4. TTS（若实施 Phase 6）：口播/字幕/画面对齐，ducking 生效。

## 风险与注意事项

1. **amix `normalize=0` 需要 ffmpeg ≥ 4.4**，ffmpeg-static（≥6）满足；用户用 `CREATIVE_STUDIO_FFMPEG` 覆盖旧版时会报错——报错信息里带 stderr 尾部，可定位。
2. **`sidechaincompress` 缺失时自动退化 amix**（executor 已探测），不作为失败条件。
3. **国内网络装 ffmpeg-static**：先设 `FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static`。CI/打包机同理。
4. **qwen-tts 响应结构**以 DashScope 当前文档为准；解析失败的报错里带原始 JSON 前 300 字符，便于修正。
5. **口播显著长于片段**时末帧定格（tpad clone）可能观感生硬——这是 v1 已知取舍；后续可换慢速播放（setpts）或提示用户精简口播。
6. **Windows 字幕路径**：`escapeSubtitlePath` 已处理盘符冒号；`fontsdir` 指向 `C:\Windows\Fonts` 同样经它转义。若 Windows 上字幕不渲染，优先检查该转义结果。
7. **删除任务**会连带删除 `storage/final-videos/<jobId>/` 整目录（已限制在 storage 内），已导出的 ZIP 不受影响。
8. 本功能不含「批量混剪 / LLM 素材匹配」（一批素材 × N 条文案）；若将来需要，走混剪工具的 `/api/mashup/jobs`（见参考实现文档 Phase 2/5），与本模块互不冲突。

## 计划外偏差记录

执行中与本计划不一致的决策（接口改名、降级、跳过项）记录于此：

- **ffprobe-static arm64 二进制不可用**：npm 包 `ffprobe-static` 在 `bin/darwin/arm64/` 路径下提供的是 x86_64 二进制，无法在 Apple Silicon 上运行。`probeDurationSec` 增加了 ffmpeg 回退（解析 stderr `Duration:` 行），确保 macOS ARM64 上也能正常获取媒体时长；`resolveFfprobePath` 增加了 `spawnSync -version` 可用性验证。
- **Node ESM 模块解析**：Node.js 22 运行 `.ts` 文件时，不带扩展名的相对 import（如 `./data-root`）无法解析。`lib/storage-url.ts` 的 `./data-root` 改为 `./data-root.ts`；所有 `import type` 接口引入改为显式 `import type` 避免 Node strip-types 剥离后运行时缺失导出。
- **测试适配**：`scripts/ffmpeg-resolve.test.ts` 不再强制要求 ffprobe `-version` 成功（二进制在当前系统上不可用），改为验证 `probeDurationSec` 的 ffmpeg 回退链路。`scripts/final-video-subtitles.test.ts` 将 `require('node:fs')` 改为 ESM `import fs`。
