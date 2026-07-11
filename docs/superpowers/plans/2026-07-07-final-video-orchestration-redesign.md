# 成片包装 v2：口播主轴 + AI 编排混剪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Execute one phase at a time, run that phase's verification commands, and stop for review before starting the next phase. Do not reinterpret the locked product decisions below.

**Goal:** 把现有“按分镜顺序全长拼接”改成“口播决定总时长，AI 从候选视频池挑选并排列画面，用户审核后再渲染”的成片工作流。

**Architecture:** 新增一个可编辑的 `final_video_drafts` 工作流聚合，保存 TTS 后的口播节拍、素材池、AI 编排和预览版本；现有 `final_video_jobs` 继续只表示不可变的渲染任务。确定性 solver 只消费快照，不访问数据库、不调用 AI；AI、TTS、视觉识别和 UI 都通过草稿接口给 solver 准备输入。

**Tech Stack:** Next.js App Router、React、TypeScript、better-sqlite3、Node 22 原生 TypeScript 测试、FFmpeg/FFprobe、ASS 字幕、现有脚本与口播供应商体系。

## Global Constraints

- 本功能继续位于 Creative Studio 的 `成片包装` Tab；不引入 Electron/FastAPI 第二套应用。
- 本期素材只使用同一 `shot_set` 下成功且本地文件存在的 AI 视频任务；不接实拍素材上传。
- 口播是主时间轴；按自然句整段合成 TTS，不为迁就画面切分而切开或重新合成音频，正式渲染也不得裁断口播音频。
- `targetDurationSec` 是软约束，默认容差 `durationTolerancePct = 0.2`。
- `targetDurationSec` 包含片头；口播内容目标为 `targetDurationSec - cover.introDurationSec`。
- 单个正常画面最长 `maxClipSeconds = 4`；只有最后兜底定格允许超过，并必须产生 warning issue。
- LLM 只输出选片、排序、节拍映射和 gap；不得输出秒数。
- 正常 assignment 不复用 `clipId`；gap filler 可以延展相邻 clip，但必须在 issue 和 manifest 中标明。
- 只裁片尾，绝不裁片头；短片段优先提前切到下一片段，只有最后没有下一片段时才定格。
- 进入成片 Tab 不自动触发付费调用。TTS、视觉识别和 AI 编排都由明确按钮触发。
- 旧的成功成片继续展示、下载和导出；旧的失败任务不再用新版重试，UI 提示用户新建草稿。
- 内置封面/字幕模板继续保持少量、可控；本计划不增加可视化模板编辑器。
- 所有消费者都要做运行时 JSON 校验；不能只依赖 TypeScript 类型断言。
- 正式完成门禁必须包含 `npm run lint`、全部 final-video 脚本测试、`scripts/db-migrations.test.ts` 和 `npm run build`。

---

## 0. 开工前先读

执行者必须先读这些当前实现，不能只读本计划：

- `lib/final-video/types.ts`
- `lib/final-video/timeline.ts`
- `lib/final-video/render-queue.ts`
- `lib/final-video/ffmpeg-graph.ts`
- `lib/final-video/subtitles.ts`
- `lib/final-video/tts.ts`
- `components/FinalVideoPanel.tsx`
- `app/api/projects/[id]/final-videos/route.ts`
- `app/api/projects/[id]/final-videos/preview/route.ts`
- `app/api/final-video-jobs/[id]/route.ts`
- `app/api/final-video-jobs/[id]/retry/route.ts`
- `app/api/projects/[id]/script/route.ts`
- `lib/script-providers/openai-compatible.ts`
- `lib/script-providers/gemini.ts`
- `lib/db.ts`
- `lib/db-migrations.ts`
- `app/api/projects/[id]/creative-package/route.ts`

当前事实：

1. `POST /api/projects/[id]/final-videos` 目前创建 job 后立即启动渲染队列。
2. TTS 目前在 `render-queue.ts` 内执行，因此在正式 job 创建前不存在可供人工审核的真实口播时长。
3. 当前 preview 路由只返回 JSON，不会生成低清 MP4。
4. 当前脚本归一化会强制 `shots.length === shotRows.length`；新版不要破坏 `shots[]`，独立口播节拍放在成片草稿中。
5. `final_video_jobs.status` 有 SQLite CHECK，保持现有 `pending/running/succeeded/failed/canceled`，不要把审核状态塞进去。

---

## 1. 锁定的产品决策

以下决策不得在实现中自行改写：

1. 口播是主轴，成片时长由片头加真实 TTS 总时长决定。
2. 画面与口播解绑；视频任务只作为候选素材池。
3. 目标时长允许默认 ±20% 偏差，越界警告但不自动裁口播。
4. 本期只用 AI 分镜视频；实拍素材不进入本计划。
5. 顺序固定为：准备草稿 → TTS → 源图视觉描述 → AI 编排 → 人工审核 → 预览 → 正式渲染。
6. LLM 不计算时间，solver 不调用 LLM。
7. 没有贴合画面的节拍必须显示 gap 红标。
8. L0 solver 必须先于 AI 和 UI 接线完成。
9. 视觉识别只看实际源图，不依赖旧 prompt 或 `visualIntent`。
10. 用户只换片、调顺序、处理 gap，不直接编辑秒数。
11. 一个视频可以覆盖多个连续口播节拍，正常显示不超过 4 秒。
12. 视频够长只裁尾；视频太短提前切下一条；最后无下一条才定格。
13. 纯 BGM 模式保留，不调用 TTS、视觉识别或编排 LLM。
14. 候选池通常 8–9 条，成片通常使用 4–5 条。

### 1.1 对“长句跨画面”的唯一实现解释

画面编排的最小单位是 `NarrationBeat`，但 **beat 是口播音频时间轴上的时间片，不是独立音频**。口播 **按自然句（`groupId`）整段合成一次 TTS**，绝不为了迁就画面切分而把句子切开重新合成——音频是主轴，必须保持自然韵律。合成得到整句真实时长后，若该句 `durationSec > maxClipSeconds`，服务端先把整句音频时间轴切成连续的固定窗口（每窗 `min(maxClipSeconds, remaining)`），再按窗口在整句时长中的累计比例映射文字边界；文字边界可以吸附到附近标点，但不得改变时间窗口长度。所有窗口共享同一个 `groupId` 和整句音频路径，每个窗口天然 `durationSec <= maxClipSeconds`，且窗口时长之和严格等于整句真实时长。于是“长句跨两个画面”由同一句下多个连续 beat 表达：画面按 beat 切换，音频与字幕仍是完整自然的一句。文字切点只是画面语义提示，无需与语音逐字对齐；不允许同一个 beat 被两个 assignment 重复引用。

---

## 2. 模块与文件职责

| 模块 | 文件 | 责任 |
|---|---|---|
| 共享契约 | `lib/final-video/types.ts` | 草稿、节拍、素材池、编排、timeline、issue、package config 类型与解析 |
| 草稿存取 | `lib/final-video/draft-store.ts` | `final_video_drafts` CRUD、revision 乐观锁、快照创建 |
| 草稿准备 | `lib/final-video/prepare-draft.ts` | 生成/复用口播节拍、TTS、构建素材池、写回草稿 |
| 素材池 | `lib/final-video/clip-pool.ts` | 从成功 video job 构建候选池并 ffprobe 真实时长 |
| 视觉识别 | `lib/final-video/vision.ts` | 源图描述、缓存、供应商调用 |
| AI 编排 | `lib/final-video/orchestrate.ts` | LLM JSON 输出、严格校验、确定性 fallback |
| 时间线 | `lib/final-video/solve-timeline.ts` | 纯函数；将编排和真实节拍时长转换成视频段 |
| 字幕 | `lib/final-video/subtitles.ts` | 从 `NarrationBeat[]` 按 `groupId` 合并成整句生成 ASS |
| FFmpeg 图 | `lib/final-video/ffmpeg-graph.ts` | trim/tpad/concat/字幕/BGM/口播混音 |
| 渲染队列 | `lib/final-video/render-queue.ts` | 只消费 job 快照；支持 preview/final 两种 kind |
| 工作流 API | `app/api/final-video-drafts/**` | prepare、describe、arrange、PATCH、preview、render |
| 现有 job API | `app/api/projects/[id]/final-videos/**` | GET 只列正式 job；旧 POST 返回 409 并提示改用草稿工作流 |
| UI | `components/FinalVideoPanel.tsx` | 草稿配置、付费动作按钮、审核、预览、正式提交 |

删除旧 `lib/final-video/timeline.ts` 及 `scripts/final-video-timeline.test.ts`。不要保留转发空壳，避免两套时间线语义并存。

---

## 3. 唯一数据契约

以下字段名是后续任务的唯一真相。实现时可以拆文件，但不能改名。

### 3.1 PackageConfig

```ts
export interface PackageCommonConfig {
  outputName: string;
  width: number;
  height: number;
  fps: number;
  targetDurationSec: number;
  durationTolerancePct: number;
  maxClipSeconds: number;
  bgm: BgmConfig | null;
  cover: CoverConfig;
  subtitle: SubtitleStyle;
}

export type PackageConfig =
  | (PackageCommonConfig & {
      mode: 'narration';
      narration: {
        mode: 'tts';
        providerId: string;
        voice: string;
        speed: number;
      };
    })
  | (PackageCommonConfig & {
      mode: 'bgm-only';
      narration: { mode: 'none' };
    });
```

兼容规则：旧 JSON 没有顶层 `mode` 时，`narration.mode === 'tts'` 映射为 `narration`，否则映射为 `bgm-only`。默认值：目标 15 秒、容差 0.2、单画面 4 秒。

草稿还保存工作流使用的 provider 选择；渲染外观与远程调用配置不能混在一个匿名对象中：

```ts
export interface FinalVideoWorkflowConfig {
  packageConfig: PackageConfig;
  narrationScriptProviderId: string;
  visionProviderId: string;
  orchestrationProviderId: string;
  selectedClipIds: string[]; // 仅 bgm-only 使用；narration 模式固定为空数组
}
```

### 3.2 草稿口播节拍

```ts
export interface NarrationDraftBeat {
  beatId: string;
  groupId: string;      // 同一自然句的 beat 共享；决定 TTS 合成单位与字幕合并单位
  index: number;        // 全局顺序
  text: string;
}

export interface NarrationBeat extends NarrationDraftBeat {
  audioPath: string;    // 所属 group 的整句音频；同 group 的多个 beat 指向同一文件
  durationSec: number;  // <= maxClipSeconds，由 group 真实时长按固定时间窗口切得
  startSec: number;     // 全局内容时间轴起点，不含片头，从 0 累计
}
```

`durationSec` 不允许可选——没有真实时长时只能使用 `NarrationDraftBeat`，不能调用 solver。**音频按 `groupId` 整句合成，绝不按 beat 逐个合成或切开重合成**；beat 仅是该整句音频上的时间片，`buildNarrationTrack` 按 group 去重后顺次拼接。

### 3.3 素材池

```ts
export interface ClipPoolItem {
  clipId: string;              // video_jobs.id
  shotId: string;
  shotIndex: number;
  videoPath: string;
  clipDurationSec: number;     // ffprobe 实测
  sourceImageId: string;
  sourceImagePath: string;
  visualDescription: string;
  descriptionProviderId: string | null;
  descriptionModel: string | null;
}
```

候选策略固定：每个 shot 只取最新一个 `succeeded + localVideoPath 存在` 的 video job，按 `shotIndex` 排序。不要把同一 shot 的所有历史重试结果同时放入 MVP 候选池。

### 3.4 编排

```ts
export interface ArrangementAssignment {
  assignmentId: string;
  clipId: string;
  beatIds: string[]; // 连续、升序、至少一个
}

export interface ArrangementGap {
  beatId: string;
  reason: string;
}

export interface ArrangementPlan {
  assignments: ArrangementAssignment[]; // 数组顺序就是播放顺序，不再保存 order
  gaps: ArrangementGap[];
}
```

验证不变量：

- 每个 beat 必须且只能出现在一个 assignment 或一个 gap。
- assignments 中 beat 顺序整体单调，不能倒序、交叉或跳回。
- 每个 assignment 的 beat 必须在全局顺序中连续。
- 正常 assignment 不得复用 clip。
- assignment 的 beat 总时长不得超过 `maxClipSeconds`。
- 所有 clipId、beatId 必须存在。
- `reason` trim 后不能为空，最长 200 字。

LLM 输出只允许 `{ assignments, gaps }`，多余字段直接丢弃；非法结果不写库，先产生 warning，再使用确定性 fallback。

### 3.5 Timeline 与 Issue

```ts
export type TimelineIssueCode =
  | 'target_duration_out_of_tolerance'
  | 'arrangement_invalid'
  | 'arrangement_fallback_used'
  | 'visual_gap'
  | 'clip_missing'
  | 'clip_short_borrowed_forward'
  | 'last_clip_frozen'
  | 'last_clip_exceeds_max_after_fallback';

export interface TimelineIssue {
  code: TimelineIssueCode;
  severity: 'warning' | 'error';
  message: string;
  beatIds: string[];
  clipId: string | null;
}

export interface TimelineSegment {
  order: number;
  clipId: string;
  clipPath: string;
  intendedBeatIds: string[];
  coveredBeatIds: string[];
  gapBeatIds: string[];
  clipDurationSec: number;
  mediaDurationSec: number;    // trim 后、pad 前
  trimEndToSec: number | null;
  padStopSec: number;
  segmentDurationSec: number;  // 必须等于 mediaDurationSec + padStopSec
  startSec: number;            // 含片头偏移
}

export interface TimelineResult {
  segments: TimelineSegment[];
  issues: TimelineIssue[];
  contentDurationSec: number;
  totalDurationSec: number;
}
```

### 3.6 草稿与 job 快照

```ts
export type FinalVideoDraftStage =
  | 'draft'
  | 'preparing'
  | 'narration-ready'
  | 'describing'
  | 'arranging'
  | 'review'
  | 'failed';

export interface FinalVideoDraftRow {
  id: string;
  projectId: string;
  shotSetId: string;
  scriptDraftId: string | null;
  stage: FinalVideoDraftStage;
  revision: number;
  workflowConfigJson: string;
  narrationBeatsJson: string;
  clipPoolJson: string;
  arrangementJson: string;
  issuesJson: string;
  previewJobId: string | null;
  previewRevision: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}
```

`final_video_jobs` 新增以下不可变快照列：

```ts
kind: 'preview' | 'final';
draftId: string | null;
draftRevision: number | null;
narrationBeatsJson: string;
clipPoolJson: string;
arrangementJson: string;
issuesJson: string;
solverVersion: number; // 本计划固定写 2
```

store 输出的不可变快照定义为：

```ts
export interface FinalVideoJobSnapshot {
  kind: 'preview' | 'final';
  draftId: string;
  draftRevision: number;
  packageConfig: PackageConfig;
  narrationBeats: NarrationBeat[];
  clipPool: ClipPoolItem[];
  arrangement: ArrangementPlan;
  issues: TimelineIssue[];
  solverVersion: 2;
}
```

正式 job 创建后，渲染队列禁止重新查询 live `video_jobs`、live 草稿或最新脚本来改变结果。

---

## 4. 工作流与 API

### 4.1 状态流

```text
POST create draft
  draft
    └─ POST prepare
         preparing
           ├─ narration-ready        narration 模式
           └─ review                 bgm-only 模式

narration-ready
  └─ POST describe
       describing → narration-ready
  └─ POST arrange
       arranging → review

review
  ├─ PATCH arrangement/config (revision + 1，旧 preview 失效)
  ├─ POST preview → 创建 kind=preview job
  └─ POST render  → 创建 kind=final job

任何远程/文件错误 → failed；重新执行对应动作可恢复，不删除已有成功快照。
```

### 4.2 路由契约

| 方法 | 路径 | 请求 | 成功结果 |
|---|---|---|---|
| POST | `/api/projects/[id]/final-video-drafts` | `{shotSetId, scriptDraftId?, workflowConfig}` | `{draft}` |
| GET | `/api/projects/[id]/final-video-drafts?shotSetId=...` | 无 | `{drafts}` |
| GET | `/api/final-video-drafts/[id]` | 无 | `{draft}`，JSON 字段已解析 |
| PATCH | `/api/final-video-drafts/[id]` | `{revision, workflowConfig?, arrangement?}` | `{draft}` |
| DELETE | `/api/final-video-drafts/[id]` | 无 | `{success:true}` |
| POST | `/api/final-video-drafts/[id]/prepare` | `{revision}` | `{draft}` |
| POST | `/api/final-video-drafts/[id]/describe` | `{revision, providerId}` | `{draft}` |
| POST | `/api/final-video-drafts/[id]/arrange` | `{revision, providerId}` | `{draft}` |
| POST | `/api/final-video-drafts/[id]/preview` | `{revision}` | `{jobId}` |
| POST | `/api/final-video-drafts/[id]/render` | `{revision}` | `{jobId}` |

所有写操作使用 SQL `... WHERE id = ? AND revision = ?`。影响行数为 0 时返回 HTTP 409：

```json
{ "error": "stale_revision", "message": "草稿已在别处更新，请刷新后重试" }
```

### 4.3 失效规则

| 变化 | 清空/失效 |
|---|---|
| 口播文本、目标时长、片头时长、TTS provider/voice/speed | narration、arrangement、issues、preview |
| shotSetId 或素材池刷新 | clipPool、arrangement、issues、preview |
| vision provider/model 或源图变化 | 对应 description、arrangement、preview |
| arrangement 编辑 | timeline preview |
| 纯渲染外观配置（封面样式、字幕样式、BGM、分辨率） | preview；不重做 TTS/视觉/编排 |

---

## 5. Timeline Solver 精确规则

函数签名：

```ts
export function solveTimeline(input: {
  plan: ArrangementPlan;
  beats: NarrationBeat[];
  clips: ClipPoolItem[];
  introDurationSec: number;
  targetDurationSec: number;
  durationTolerancePct: number;
  maxClipSeconds: number;
  fps: number;
}): TimelineResult;
```

### 5.1 前置条件

1. beats 按 index 连续排序，`beatId` 唯一，`durationSec > 0`。
2. 至少有一个 clip；否则抛出 `no_visual_source`，API 返回 400。
3. 先运行 `validateArrangement`；solver 不接受未校验 plan。
4. `rawNarrationDurationSec = Σ beat.durationSec`。
5. 口播总时长、`rawNarrationDurationSec * fps` 必须有限，所需帧数不得超过 `Number.MAX_SAFE_INTEGER`；否则抛 `invalid_timeline_input`，禁止进入帧增减循环。
6. 为保证绝不截短口播且不无故多出整帧，取“满足 `frames / fps >= rawNarrationDurationSec` 的最小整数 frames”：先算 `contentFrames = ceil(rawNarrationDurationSec * fps)`；若 `(contentFrames - 1) / fps >= rawNarrationDurationSec`，则递减，直到再减一帧会变短；最后若 `contentFrames / fps < rawNarrationDurationSec`，再递增到不短。`contentDurationSec = contentFrames / fps`。此处禁止在 `ceil` 前减 epsilon。
7. `totalDurationSec = introDurationSec + contentDurationSec`。
8. 除最后一段外，segment 边界量化到 `1 / fps`；最后一段吸收剩余帧，使所有 segment 时长之和精确等于 frame-safe content duration。

### 5.2 主循环

先计算每个 beat 在内容时间轴上的 `[startSec, endSec]`。遍历 `assignments`；数组顺序是唯一播放顺序。

对第 i 个 assignment：

1. `targetEnd = 最后一个 intended beat 的 endSec`。
2. `wanted = max(0, targetEnd - cursor)`。这里的 cursor 不含片头。
3. `mediaDuration = min(wanted, clip.clipDurationSec, maxClipSeconds)`。
4. 若 `clipDurationSec >= mediaDuration`，设置 `trimEndToSec = mediaDuration`；否则为 null。
5. 本段先设置 `padStopSec = 0`，`segmentDurationSec = mediaDuration`。
6. `coveredBeatIds` 是与 `[cursor, cursor + mediaDuration]` 相交的全部 beat。
7. `gapBeatIds` 是 coveredBeatIds 中属于 `plan.gaps` 的 beat。
8. cursor 增加 segmentDurationSec。
9. 若 `cursor < targetEnd` 且后面还有 assignment，不定格；写 `clip_short_borrowed_forward`，让下一 assignment 从当前 cursor 提前接入。
10. 若 `cursor < targetEnd` 且没有后续 assignment，进入 5.3 末段兜底。

### 5.3 末段与尾部 gap 兜底

遍历完 assignments 后，如果 `cursor < contentDurationSec`：

1. 使用最后一个 segment 对应的 clip。
2. 先吃该 clip 尚未使用的物理时长，但整个正常 media display 不超过 `maxClipSeconds`。
3. 仍不足的秒数写入 `padStopSec`。
4. 重新计算：`segmentDurationSec = mediaDurationSec + padStopSec`。
5. 写 `last_clip_frozen`；如果最终 segmentDurationSec 超过 maxClipSeconds，再写 `last_clip_exceeds_max_after_fallback`。
6. 若 plan 没有 assignment，则使用候选池第一条 clip 创建一个全长 filler，并对全部 beat 写 `visual_gap`。

### 5.4 总时长与容差

- solver 的视频内容时长必须始终覆盖真实口播总时长；不得因为 clip 短或帧舍入而缩短成片，允许的额外尾长严格小于 `1 / fps`。
- 若 `abs(totalDurationSec - targetDurationSec) / targetDurationSec > durationTolerancePct`，写 `target_duration_out_of_tolerance` warning。
- warning 不阻止预览和正式渲染；error 阻止创建 job。

### 5.5 FFmpeg 对应规则

- `trimEndToSec !== null`：`trim=duration=<value>,setpts=PTS-STARTPTS`。
- `padStopSec > 0`：在 trim/原视频之后追加 `tpad=stop_mode=clone:stop_duration=<value>`。
- `segmentDurationSec` 必须等于 media + pad，禁止再从 clipDuration 反推 pad。
- concat 前每路都执行 scale/crop/setsar/fps/format。
- 输出 `-t` 使用 solver 的 `totalDurationSec`。
- 字幕时间轴按自然句生成（合并同 `groupId` 的 beat），不来自视频 segment。

---

## 6. 数据库结构

### 6.1 final_video_drafts

```sql
CREATE TABLE IF NOT EXISTS final_video_drafts (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  shotSetId TEXT NOT NULL,
  scriptDraftId TEXT,
  stage TEXT NOT NULL DEFAULT 'draft'
    CHECK(stage IN ('draft','preparing','narration-ready','describing','arranging','review','failed')),
  revision INTEGER NOT NULL DEFAULT 0,
  workflowConfigJson TEXT NOT NULL DEFAULT '{}',
  narrationBeatsJson TEXT NOT NULL DEFAULT '[]',
  clipPoolJson TEXT NOT NULL DEFAULT '[]',
  arrangementJson TEXT NOT NULL DEFAULT '{"assignments":[],"gaps":[]}',
  issuesJson TEXT NOT NULL DEFAULT '[]',
  previewJobId TEXT,
  previewRevision INTEGER,
  errorMessage TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (shotSetId) REFERENCES shot_sets(id) ON DELETE CASCADE,
  FOREIGN KEY (scriptDraftId) REFERENCES script_drafts(id) ON DELETE SET NULL,
  FOREIGN KEY (previewJobId) REFERENCES final_video_jobs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_final_video_drafts_project ON final_video_drafts(projectId);
CREATE INDEX IF NOT EXISTS idx_final_video_drafts_shot_set ON final_video_drafts(shotSetId);
```

### 6.2 clip_visual_descriptions

```sql
CREATE TABLE IF NOT EXISTS clip_visual_descriptions (
  id TEXT PRIMARY KEY,
  imageAssetId TEXT NOT NULL,
  description TEXT NOT NULL,
  providerId TEXT NOT NULL,
  model TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (imageAssetId) REFERENCES image_assets(id) ON DELETE CASCADE,
  UNIQUE(imageAssetId, providerId, model)
);
```

### 6.3 final_video_jobs 新列

主 schema 与 `CORE_DB_MIGRATIONS` 都要加入：

```sql
ALTER TABLE final_video_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'final';
ALTER TABLE final_video_jobs ADD COLUMN draftId TEXT;
ALTER TABLE final_video_jobs ADD COLUMN draftRevision INTEGER;
ALTER TABLE final_video_jobs ADD COLUMN narrationBeatsJson TEXT NOT NULL DEFAULT '[]';
ALTER TABLE final_video_jobs ADD COLUMN clipPoolJson TEXT NOT NULL DEFAULT '[]';
ALTER TABLE final_video_jobs ADD COLUMN arrangementJson TEXT NOT NULL DEFAULT '{"assignments":[],"gaps":[]}';
ALTER TABLE final_video_jobs ADD COLUMN issuesJson TEXT NOT NULL DEFAULT '[]';
ALTER TABLE final_video_jobs ADD COLUMN solverVersion INTEGER NOT NULL DEFAULT 1;
```

SQLite 不能给已有表的新增列补 FOREIGN KEY/CHECK；运行时 parser 必须校验 `kind` 和 snapshot JSON。新安装主 schema 中写完整约束，老安装通过 migration 获得兼容列。

---

## 7. 分阶段实施任务

> 依赖顺序固定：Phase 0 → A → B → C → D → E → F → G。不要并行修改共享类型、数据库 schema 或 `FinalVideoPanel.tsx`。

### Phase 0 — 工作流地基与不可变快照

#### Task 0.1：数据库与类型

**Files:**
- Modify: `lib/db.ts`
- Modify: `lib/db-migrations.ts`
- Modify: `lib/final-video/types.ts`
- Modify: `lib/final-video/timeline.ts`（仅把旧类型引用改为 `LegacyTimelineSegment`）
- Modify: `lib/final-video/tts.ts`（仅把旧类型引用改为 `LegacyTimelineSegment`）
- Modify: `lib/final-video/ffmpeg-graph.ts`（仅把旧类型引用改为 `LegacyTimelineSegment`）
- Modify: `app/api/projects/[id]/final-videos/route.ts`（仅宽化旧 invalid-mode guard 的局部类型，保持现有 400 行为）
- Modify: `scripts/db-migrations.test.ts`
- Create: `scripts/final-video-types.test.ts`

**Produces:** §3 和 §6 的全部类型、默认值、运行时 parser、数据库表与迁移。

- [ ] 在测试中创建旧版 schema，运行 `CORE_DB_MIGRATIONS`，断言新列存在且旧 final job 行仍可读取。
- [ ] 为 `mergePackageConfig` 写旧 JSON 映射测试，覆盖旧 `narration.mode=tts` 和 `none`。
- [ ] 实现主 schema、迁移、类型和 parser；parser 对损坏 JSON 或已出现但类型/枚举非法的字段返回明确错误，不静默使用默认值或空对象；旧 JSON 缺少新版字段时仍按兼容默认补齐。
- [ ] 把现有旧时间线结构命名为 `LegacyTimelineSegment`，仅更新三个旧消费者的类型引用；新版 `TimelineSegment` 保持 §3.5 契约。旧 timeline 与 legacy 类型保留到 E1 一次性切换 render queue 后删除。
- [ ] 旧 final-video POST 的配置校验错误必须继续返回 HTTP 400；在 `types.ts` 提供 typed request-validation result helper，路由在创建 job 前消费它，并在类型测试中覆盖非法 mode。
- [ ] 运行：`node scripts/db-migrations.test.ts && node scripts/final-video-types.test.ts && npx tsc --noEmit`。
- [ ] 期望：两个脚本都打印 `passed`。
- [ ] 提交：`git commit -m "feat(final-video): add draft workflow schema and contracts"`。

#### Task 0.2：草稿 store 与乐观锁

**Files:**
- Create: `lib/final-video/draft-store.ts`
- Create: `scripts/final-video-draft-store.test.ts`

**Produces:**

```ts
createFinalVideoDraft(input: {
  projectId: string;
  shotSetId: string;
  scriptDraftId: string | null;
  workflowConfig: FinalVideoWorkflowConfig;
}): FinalVideoDraftRow;
getFinalVideoDraft(id: string): FinalVideoDraftRow | null;
listFinalVideoDrafts(projectId: string, shotSetId?: string): FinalVideoDraftRow[];
updateFinalVideoDraft(
  id: string,
  expectedRevision: number,
  patch: Partial<Pick<FinalVideoDraftRow,
    'stage' | 'workflowConfigJson' | 'narrationBeatsJson' | 'clipPoolJson' |
    'arrangementJson' | 'issuesJson' | 'previewJobId' | 'previewRevision' | 'errorMessage'
  >>
): FinalVideoDraftRow;
deleteFinalVideoDraft(id: string): void;
snapshotDraftForJob(draftId: string, expectedRevision: number, kind: 'preview' | 'final'): FinalVideoJobSnapshot;
```

- [ ] 测试 create/get/list、revision 从 0 递增、旧 revision 更新抛 `stale_revision`。
- [ ] 测试 snapshot 深拷贝 JSON；草稿后续修改不能改变已生成 snapshot。
- [ ] 实现 store，所有多字段更新放在一个 SQLite transaction 中。
- [ ] 运行：`node scripts/final-video-draft-store.test.ts`。
- [ ] 期望：打印 `final-video-draft-store tests passed`。
- [ ] 提交：`git commit -m "feat(final-video): add versioned draft store"`。

#### Task 0.3：草稿基础 API

**Files:**
- Create: `app/api/projects/[id]/final-video-drafts/route.ts`
- Create: `app/api/final-video-drafts/[id]/route.ts`
- Create: `lib/final-video/arrangement.ts`（本任务先实现语义 validator；fallback 留在 Task A1）
- Create: `scripts/final-video-draft-api.test.ts`

**Consumes:** Task 0.2 store。

- [ ] 测试项目/shot set/script draft 归属校验、404、409 stale revision、DELETE。
- [ ] 实现 §4.2 的 create/list/get/PATCH/DELETE；PATCH 只允许 workflowConfig 和 arrangement 白名单字段。
- [ ] narration 模式创建时必须校验 scriptDraftId 归属当前项目；bgm-only 模式允许 scriptDraftId 为 null。
- [ ] PATCH 根据 §4.3 清空下游快照并增加 revision。
- [ ] arrangement PATCH 在写库前用共享 `validateArrangement` 强制 §3.4 全部语义不变量；非法返回 400。Task A1 继续补全独立测试矩阵和 fallback。
- [ ] `fps` 或 `durationTolerancePct` 变化只清 issues 与 preview，保留 narration、clipPool 和 arrangement。
- [ ] 运行：`node scripts/final-video-draft-api.test.ts`。
- [ ] 期望：打印 `final-video-draft-api tests passed`。
- [ ] 提交：`git commit -m "feat(final-video): expose draft workflow API"`。

**Phase 0 gate:**

```bash
node scripts/db-migrations.test.ts
node scripts/final-video-types.test.ts
node scripts/final-video-draft-store.test.ts
node scripts/final-video-draft-api.test.ts
npx tsc --noEmit
npm run lint
```

---

### Phase A — L0 确定性时间线与渲染图

#### Task A1：严格编排校验与 fallback

**Files:**
- Modify: `lib/final-video/arrangement.ts`
- Modify: `app/api/final-video-drafts/[id]/route.ts`（仅切换到 throwing compatibility wrapper，保持 PATCH 400 行为）
- Create: `scripts/final-video-arrangement.test.ts`

**Produces:**

```ts
validateArrangement(plan, beats, clips, maxClipSeconds): { ok: true; plan: ArrangementPlan } | { ok: false; issues: TimelineIssue[] };
buildFallbackArrangement(beats, clips, maxClipSeconds): ArrangementPlan;
```

- [ ] 测试未知 ID、重复 clip、重复 beat、beat 缺失、倒序、非连续、超过 4 秒。
- [ ] 测试 fallback 按 shotIndex 顺序填入尽可能多的连续 beat，clip 用完后剩余 beat 全部进入 gaps。
- [ ] 实现校验与 fallback；不要在此模块调用数据库或 provider。
- [ ] 运行：`node scripts/final-video-arrangement.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): validate arrangement plans"`。

#### Task A2：Timeline Solver

**Files:**
- Create: `lib/final-video/solve-timeline.ts`
- Create: `scripts/final-video-solve.test.ts`
- Keep unchanged: `lib/final-video/timeline.ts`、`scripts/final-video-timeline.test.ts`（旧 render queue 仍使用；E1 切换后删除）

**Consumes:** §3.2–§3.5、§5、Task A1 已校验 plan。

- [ ] 先写失败测试：够长裁尾、短片提前切下一条、末段定格、尾部 gap、全 gap、intro、容差 warning、30fps 舍入、segment=media+pad。
- [ ] 实现 `solveTimeline`，严格按照 §5；禁止读取文件和数据库。
- [ ] 测试每个结果都满足 `sum(segmentDurationSec) === contentDurationSec`；contentDuration 覆盖真实口播且额外尾长 `< 1/fps`。
- [ ] 运行：`node scripts/final-video-solve.test.ts`。
- [ ] 期望：打印 `final-video-solve tests passed`。
- [ ] 提交：`git commit -m "feat(final-video): solve narration-led timelines"`。

#### Task A3：字幕改为口播自然句时间轴

**Files:**
- Modify: `lib/final-video/subtitles.ts`
- Modify: `scripts/final-video-subtitles.test.ts`

**Produces:**

```ts
buildNarrationAss(beats: NarrationBeat[], introDurationSec: number, style: SubtitleStyle, width: number, height: number): string;
```

- [ ] 测试字幕**按 `groupId` 合并**：一条字幕 = 一整句，start 为 `intro + 该 group 首 beat.startSec`，end 为 `intro + 该 group 末 beat.startSec + 末 beat.durationSec`，text 为该 group 各 beat.text 顺序拼接（还原整句）；空文本跳过；字幕不随画面 beat 切分而分屏。
- [ ] 新增按 group 合并的 `buildNarrationAss`；暂时保留现有 `buildAss(AssSegment[])` 与旧测试供 render queue 使用，不改变旧行为。E1 切换 render queue 后再删除 legacy helper。
- [ ] 运行：`node scripts/final-video-subtitles.test.ts`。
- [ ] 提交：`git commit -m "refactor(final-video): drive subtitles from narration beats"`。

#### Task A4：FFmpeg trim/pad

**Files:**
- Modify: `lib/final-video/ffmpeg-graph.ts`
- Modify: `scripts/final-video-graph.test.ts`
- Modify: `scripts/final-video-e2e.test.ts`

- [ ] 图测试分别断言 trim-only、pad-only、trim+pad 兜底、无音频、口播+BGM ducking。
- [ ] 新增 `buildSolvedRenderArgs`，从 v2 segment 显式读取 `trimEndToSec` 和 `padStopSec`；暂时保留现有 `buildRenderArgs(LegacyTimelineSegment[])` 与旧测试供 render queue 使用，不改变旧行为。E1 切换后删除 legacy helper。
- [ ] E2E 使用两条本地测试视频，真实 ffprobe 输出时长与 solver total 偏差不超过 `max(0.1s, 2/fps)`。
- [ ] 运行：`node scripts/final-video-graph.test.ts && node scripts/final-video-e2e.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): trim and pad solved segments"`。

**Phase A gate:**

```bash
node scripts/final-video-arrangement.test.ts
node scripts/final-video-solve.test.ts
node scripts/final-video-subtitles.test.ts
node scripts/final-video-graph.test.ts
node scripts/final-video-e2e.test.ts
npm run lint
```

---

### Phase B — 口播节拍、TTS 与素材池准备

#### Task B1：成片专用口播节拍生成

**Files:**
- Create: `lib/final-video/narration-script.ts`
- Modify: `lib/script-providers/index.ts`
- Modify: `lib/script-providers/openai-compatible.ts`
- Modify: `lib/script-providers/gemini.ts`
- Create: `scripts/final-video-narration-script.test.ts`

**Produces:**

```ts
generateNarrationDraftBeats(input: {
  sourceText: string;
  targetContentSec: number;
  providerId: string;
}): Promise<NarrationDraftBeat[]>;
```

- [ ] 提供通用 `completeJson` 能力，复用现有 provider 配置，不复制 API key 解析代码。
- [ ] prompt 要求只输出 `{sentences:[{text}]}` 的自然短句（每句尽量短，利于画面切换）；服务端为每句生成 `beatId`（初始 `beatId === groupId`）与 `index`，不信任模型 ID。超长句不在此切分，交 B2 按真实时长在时间轴上切。
- [ ] 目标内容秒数固定为 `max(1, targetDurationSec - introDurationSec)`。
- [ ] 测试损坏 JSON、空列表、空 text；过长句的切分不在此测（属于 B2 的时间轴切片）。
- [ ] 运行：`node scripts/final-video-narration-script.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): generate target-length narration beats"`。

#### Task B2：TTS 按自然句合成，超长句在时间轴上切 beat

**Files:**
- Modify: `lib/final-video/tts.ts`
- Create: `scripts/final-video-tts-beats.test.ts`

**Produces:**

```ts
synthesizeNarrationBeats(input: {
  draftId: string;
  beats: NarrationDraftBeat[];
  providerId: string;
  voice: string;
  speed: number;
  maxClipSeconds: number;
}): Promise<NarrationBeat[]>;
buildNarrationTrack(input: { beats: NarrationBeat[]; introDurationSec: number; workDir: string }): Promise<string>;
```

- [ ] 测试合成顺序、startSec 累加、片头静音、provider/voice/speed 透传；`buildNarrationTrack` 按 `groupId` 去重后顺次拼接整句音频（同 group 多 beat 只拼一次）。
- [ ] 按 `groupId` 分组，每句**整段合成一次** TTS（绝不按 beat 逐个合成、绝不切开重合成）。拿到整句真实时长后：≤ maxClipSeconds 的句作为单个 beat；> maxClipSeconds 的句按连续时间窗口切分，依次取 `durationSec = min(maxClipSeconds, remainingDurationSec)`，直到 remaining 为 0。文字按各窗口累计时间占整句时长的比例切分，并可吸附到附近标点；吸附文字边界不得改变窗口 duration。测试必须覆盖 8.1 秒句子切为 4.0/4.0/0.1 秒、总和仍为 8.1 秒、三个 beat 共用同一 audioPath。
- [ ] 音频文件保存在 `storage/final-video-drafts/<draftId>/narration/`；草稿删除时清理。
- [ ] 运行：`node scripts/final-video-tts-beats.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): synthesize timed narration beats"`。

#### Task B3：构建素材池

**Files:**
- Create: `lib/final-video/clip-pool.ts`
- Create: `scripts/final-video-clip-pool.test.ts`

- [ ] 测试每 shot 只取最新成功任务、缺文件跳过、按 shotIndex 排序、ffprobe 真实时长。
- [ ] 源图固定使用该 video job 的 `sourceImageId`；不存在时该 clip 不进入池并产生 `clip_missing`。
- [ ] 实现 `buildClipPool(shotSetId): Promise<{clips, issues}>`。
- [ ] 运行：`node scripts/final-video-clip-pool.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): build deterministic clip pools"`。

#### Task B4：prepare API

**Files:**
- Create: `lib/final-video/prepare-draft.ts`
- Create: `app/api/final-video-drafts/[id]/prepare/route.ts`
- Create: `scripts/final-video-prepare.test.ts`

- [ ] narration 模式：生成/复用 draft beats → TTS → clip pool → stage `narration-ready`。
- [ ] narration 模式若草稿没有 scriptDraftId，prepare 返回 400；bgm-only 不读取脚本。
- [ ] `sourceText` 固定读取所选 `script_drafts.outputJson.fullScript`；为空时按 `shots[].voiceover` 顺序拼接；两者都为空时返回 400。
- [ ] 口播改写 provider 固定读取 `workflowConfig.narrationScriptProviderId`，TTS provider/voice/speed 固定读取 `workflowConfig.packageConfig.narration`。
- [ ] bgm-only 模式：只构建 clip pool → 生成空 narration → stage `review`。
- [ ] 实际总时长越界时写 warning，不截音频，不失败。
- [ ] 同一 revision 重试时复用已完成的整句（group）音频，避免重复付费。
- [ ] 运行：`node scripts/final-video-prepare.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): prepare narration and clip snapshots"`。

**Phase B gate:**

```bash
node scripts/final-video-narration-script.test.ts
node scripts/final-video-tts-beats.test.ts
node scripts/final-video-clip-pool.test.ts
node scripts/final-video-prepare.test.ts
npm run lint
```

---

### Phase C — 源图视觉识别

#### Task C1：视觉调用与缓存

**Files:**
- Create: `lib/final-video/vision.ts`
- Modify: `lib/db.ts`
- Modify: `lib/db-migrations.ts`
- Modify: `lib/script-providers/openai-compatible.ts`
- Modify: `lib/script-providers/gemini.ts`
- Modify: `lib/script-providers/types.ts`
- Modify: `lib/script-providers/config.ts`
- Modify: `lib/script-providers/store.ts`
- Modify: `app/settings/page.tsx`
- Modify: `app/api/providers/script/route.ts`
- Modify: `app/api/providers/script/[id]/route.ts`
- Modify: `scripts/db-migrations.test.ts`
- Create: `scripts/final-video-vision.test.ts`

**Decision:** 视觉识别复用现有 `script_providers` 凭据，新增 `supportsVision` 布尔能力，不新增第五类 provider 表。设置页脚本供应商表单增加“支持图片理解”开关。

- [ ] migration/main schema 给 `script_providers` 加 `supportsVision INTEGER NOT NULL DEFAULT 0`。
- [ ] 实现 OpenAI-compatible 图片 content 和 native Gemini inlineData 两个 adapter。
- [ ] 图片读取前验证路径位于 data root；按 MIME 转 base64，单图超过 4MB 时用项目现有 `sharp` 依赖缩放到最长边 1600px。
- [ ] 缓存键固定为 `(imageAssetId, providerId, model)`；普通运行命中即跳过，显式 `force=true` 才覆盖。
- [ ] 远程调用并发固定 2，每次超时 90 秒；单图失败记录 warning，其他图片继续。
- [ ] 运行：`node scripts/db-migrations.test.ts && node scripts/final-video-vision.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): describe clip source images"`。

#### Task C2：describe API

**Files:**
- Create: `app/api/final-video-drafts/[id]/describe/route.ts`
- Create: `scripts/final-video-describe-api.test.ts`

- [ ] 请求只接受 supportsVision 且 configured 的 provider。
- [ ] stage 临时设为 `describing`；成功后回 `narration-ready`，失败回 `failed` 并保留已成功缓存。
- [ ] 写回 clipPool 每条 description/provider/model，revision 增加，arrangement/preview 失效。
- [ ] 运行：`node scripts/final-video-describe-api.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): expose clip description workflow"`。

**Phase C gate:**

```bash
node scripts/db-migrations.test.ts
node scripts/final-video-vision.test.ts
node scripts/final-video-describe-api.test.ts
npm run lint
```

---

### Phase D — AI 编排与确定性兜底

#### Task D1：LLM 编排

**Files:**
- Create: `lib/final-video/orchestrate.ts`
- Create: `scripts/final-video-orchestrate.test.ts`

**Produces:**

```ts
buildArrangement(input: {
  beats: NarrationBeat[];
  clips: ClipPoolItem[];
  maxClipSeconds: number;
  providerId: string;
}): Promise<{ plan: ArrangementPlan; issues: TimelineIssue[] }>;
```

- [ ] prompt 只发送 beatId/text/duration 和 clipId/description/shotIndex，不发送绝对文件路径。
- [ ] LLM 原始 JSON 先 parser，再 `validateArrangement`；失败时使用 fallback 并写 `arrangement_fallback_used`。
- [ ] 未描述 clip 不交给 LLM；如果全部未描述，直接 fallback，不调用模型。
- [ ] 测试合法输出、markdown fence、未知 ID、重复、乱序、缺覆盖、provider error、全部未描述。
- [ ] 运行：`node scripts/final-video-orchestrate.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): orchestrate clips against narration"`。

#### Task D2：arrange API

**Files:**
- Create: `app/api/final-video-drafts/[id]/arrange/route.ts`
- Create: `scripts/final-video-arrange-api.test.ts`

- [ ] 只允许 narration-ready/review 草稿执行；要求 beats 和 clipPool 非空。
- [ ] stage `arranging` → `review`；写 arrangement/issues，revision 增加，preview 失效。
- [ ] 模型失败也返回 review 草稿和 fallback warning，不返回 500；只有输入/数据库错误返回失败。
- [ ] 运行：`node scripts/final-video-arrange-api.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): expose arrangement workflow"`。

**Phase D gate:**

```bash
node scripts/final-video-arrangement.test.ts
node scripts/final-video-orchestrate.test.ts
node scripts/final-video-arrange-api.test.ts
npm run lint
```

---

### Phase E — 不可变 preview/final job 与审核 UI

#### Task E1：渲染队列只消费快照

**Files:**
- Modify: `lib/final-video/render-queue.ts`
- Modify: `app/api/projects/[id]/final-videos/route.ts`
- Modify: `app/api/final-video-jobs/[id]/route.ts`
- Modify: `app/api/final-video-jobs/[id]/retry/route.ts`
- Modify: `scripts/project-final-status.test.ts`
- Create: `scripts/final-video-render-snapshot.test.ts`

- [ ] render queue 从 job 的 narration/clipPool/arrangement/package snapshot 调 solver；禁止查询最新 script/video jobs。
- [ ] preview job 输出固定最大宽 540、CRF 28、preset ultrafast；final 使用用户配置。
- [ ] GET 项目成片列表默认只返回 `kind='final'`；draft API 单独读取 preview job。
- [ ] 旧 `POST /api/projects/[id]/final-videos` 返回 HTTP 409：`{error:'draft_workflow_required'}`，不再绕过人工审核直接创建 job。
- [ ] 旧 `solverVersion=1` 成功 job 仍展示；旧失败 job retry 返回 409 和“请新建成片草稿”。
- [ ] 恢复 running job 时复用 job 目录内口播音频，不重做 TTS/视觉/LLM。
- [ ] manifest schemaVersion 改 2，包含 draftRevision、beats、arrangement、issues、solverVersion。
- [ ] 运行：`node scripts/final-video-render-snapshot.test.ts && node scripts/project-final-status.test.ts`。
- [ ] 提交：`git commit -m "refactor(final-video): render immutable draft snapshots"`。

#### Task E2：preview/render API

**Files:**
- Create: `app/api/final-video-drafts/[id]/preview/route.ts`
- Create: `app/api/final-video-drafts/[id]/render/route.ts`
- Modify: `app/api/projects/[id]/final-videos/preview/route.ts`
- Create: `scripts/final-video-submit-api.test.ts`

- [ ] preview/render 都要求 `stage='review'` 且 expected revision 相同。
- [ ] 创建 job 时复制草稿 JSON，并把 narration 音频复制到 job work dir；插入完成后才启动队列。
- [ ] preview job 成功后只在 `draft.revision === job.draftRevision` 时写回 previewJobId；旧 preview 不覆盖新草稿。
- [ ] 旧 GET preview 路由改成返回兼容提示和当前草稿摘要，不再现场计算旧 timeline。
- [ ] 运行：`node scripts/final-video-submit-api.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): submit versioned preview and final jobs"`。

#### Task E3：审核 UI

**Files:**
- Modify: `components/FinalVideoPanel.tsx`
- Create: `components/final-video/ArrangementEditor.tsx`
- Create: `components/final-video/ClipPicker.tsx`
- Create: `components/final-video/NarrationTimeline.tsx`
- Create: `scripts/final-video-ui-contract.test.mjs`

- [ ] 面板流程固定显示：创建草稿 → 准备口播 → 识别画面 → AI 编排 → 审核 → 预览 → 正式渲染。
- [ ] 任何付费按钮点击前显示 provider 名称；进入 Tab 不自动调用。
- [ ] ArrangementEditor 按 beat 顺序展示每个画面槽（beat 文本、时长、clip 缩略图、description、gap 红标）；此处 beat 文本是画面操作单位，与成片按整句烧录的字幕不同。
- [ ] 支持换片、移动 assignment 顺序、将 gap 分配给 clip；每次 PATCH 携带 revision。
- [ ] 收到 409 时重新 GET，并提示“草稿已更新”；不静默覆盖。
- [ ] preview 轮询 job；只展示 previewRevision 等于当前 draft revision 的视频。
- [ ] 保留现有 titleTouchedRef 行为，异步草稿/预览返回不能覆盖用户编辑过的封面标题。
- [ ] 正式 job 列表、下载、删除保持现有行为。
- [ ] 运行：`node scripts/final-video-ui-contract.test.mjs && npm run lint && npm run build`。
- [ ] 提交：`git commit -m "feat(final-video): add arrangement review workflow"`。

**Phase E gate:**

```bash
node scripts/final-video-render-snapshot.test.ts
node scripts/final-video-submit-api.test.ts
node scripts/final-video-ui-contract.test.mjs
node scripts/final-video-e2e.test.ts
npm run lint
npm run build
```

---

### Phase F — 纯 BGM 模式

#### Task F1：BGM-only solver 输入与 UI

**Files:**
- Create: `lib/final-video/solve-bgm-timeline.ts`
- Create: `scripts/final-video-bgm-solve.test.ts`
- Modify: `components/FinalVideoPanel.tsx`
- Modify: `components/final-video/ArrangementEditor.tsx`

**Produces:**

```ts
solveBgmTimeline(input: {
  selectedClipIds: string[];
  clips: ClipPoolItem[];
  introDurationSec: number;
  targetDurationSec: number;
  maxClipSeconds: number;
  fps: number;
}): TimelineResult;
```

- [ ] 顺次使用用户选择的 clip，每条最多 4 秒；目标包含片头；末段裁齐，素材不足才定格。
- [ ] bgm-only 草稿跳过 narration/describe/arrange，prepare 后直接 review。
- [ ] UI 隐藏 TTS、视觉识别、AI 编排，显示多选 clip 和目标时长。
- [ ] BGM 在 `totalDurationSec - 1.5` 开始淡出。
- [ ] 运行：`node scripts/final-video-bgm-solve.test.ts && node scripts/final-video-e2e.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): add bgm-only timeline mode"`。

**Phase F gate:**

```bash
node scripts/final-video-bgm-solve.test.ts
node scripts/final-video-e2e.test.ts
npm run lint
```

---

### Phase G — 导出、清理、兼容与最终验收

#### Task G1：导出与生命周期清理

**Files:**
- Modify: `app/api/projects/[id]/creative-package/route.ts`
- Modify: `app/api/final-video-jobs/[id]/route.ts`
- Modify: `app/api/final-video-drafts/[id]/route.ts`
- Create: `scripts/final-video-export.test.ts`

- [ ] ZIP 只收录 kind=final 且 succeeded 的视频、封面、schema v2 manifest。
- [ ] 删除 draft 清理 `storage/final-video-drafts/<id>` 和未使用 preview job；不删除正式 job。
- [ ] 删除 preview job 清理其目录并清空匹配的 draft.previewJobId。
- [ ] 所有删除路径先 `path.resolve` 并验证位于 storage root。
- [ ] 运行：`node scripts/final-video-export.test.ts`。
- [ ] 提交：`git commit -m "feat(final-video): export and clean workflow artifacts"`。

#### Task G2：全量回归与正式应用门禁

- [ ] 运行全部目标测试：

```bash
node scripts/db-migrations.test.ts
node scripts/final-video-types.test.ts
node scripts/final-video-draft-store.test.ts
node scripts/final-video-draft-api.test.ts
node scripts/final-video-arrangement.test.ts
node scripts/final-video-solve.test.ts
node scripts/final-video-subtitles.test.ts
node scripts/final-video-graph.test.ts
node scripts/final-video-narration-script.test.ts
node scripts/final-video-tts-beats.test.ts
node scripts/final-video-clip-pool.test.ts
node scripts/final-video-prepare.test.ts
node scripts/final-video-vision.test.ts
node scripts/final-video-describe-api.test.ts
node scripts/final-video-orchestrate.test.ts
node scripts/final-video-arrange-api.test.ts
node scripts/final-video-render-snapshot.test.ts
node scripts/final-video-submit-api.test.ts
node scripts/final-video-bgm-solve.test.ts
node scripts/final-video-export.test.ts
node scripts/final-video-e2e.test.ts
node scripts/project-final-status.test.ts
node scripts/final-video-ui-contract.test.mjs
npm run lint
npm run build
```

- [ ] 期望：所有脚本退出码 0；lint 无 error；build 成功。Turbopack 的已知 NFT warning 可以记录，但不能把新 error 当 warning 忽略。
- [ ] 用真实项目完成 §8 两条手工验收线路。
- [ ] 提交：`git commit -m "test(final-video): verify orchestration workflow"`。

---

## 8. 手工验收

### 8.1 口播模式

1. 准备一个包含 8–9 个分镜、每个分镜有成功 5 秒视频的项目。
2. 在成片 Tab 创建目标 15 秒、片头 1 秒的 narration 草稿。
3. 点击准备口播；确认每句有整段自然音频、每个 beat 有真实时长与 startSec，内容目标接近 14 秒。
4. 点击识别画面；确认每个 clip 显示实际源图描述，重复点击命中缓存。
5. 点击 AI 编排；确认约 4–5 个 assignment，非法 LLM 输出时仍得到 fallback 和 warning。
6. 手动换一条 clip、移动一个 assignment、处理一个 gap；刷新页面后改动仍在。
7. 点击预览；预览完成前修改编排，旧预览不得覆盖新 revision。
8. 再次预览，确认字幕按整句显示（不随画面切分而分屏）、画面只裁尾、短片提前切换、最后必要时才定格。
9. 正式渲染；实际时长在目标 12–18 秒内，或明确显示越界 warning。
10. 下载创作包，确认 final mp4、cover 和 schema v2 manifest 都在 ZIP 中。

### 8.2 纯 BGM 模式

1. 创建 bgm-only 草稿，目标 20 秒、片头 0 秒。
2. prepare 后直接进入 review，不出现 TTS、视觉识别和 AI 编排按钮。
3. 选择 5 条视频并调整顺序。
4. 预览和正式渲染均约 20 秒，每个正常画面不超过 4 秒，末尾 BGM 淡出。

---

## 9. 完成定义

只有同时满足以下条件才算完成：

- 口播、视觉、编排、预览和正式渲染按草稿 revision 串起来。
- 正式 job 是不可变快照，重试不重复调用 TTS/视觉/LLM。
- solver 没有数据库、网络或文件依赖，测试覆盖所有分支。
- 视频内容总时长始终覆盖真实口播总时长且额外尾长少于一帧；片头只在总时长中加一次。
- 口播按自然句整段合成、绝不为画面切分而重合成音频；长句通过时间轴上的 beat 切片跨画面、字幕仍按整句显示；不存在一个 beat 被两个 assignment 重复引用。
- gaps、fallback、末段定格和目标越界都以结构化 issue 出现在 UI 与 manifest。
- 旧成功成片仍能展示、下载和导出。
- 两条手工验收通过，所有 §7 Phase G 命令通过。
