# 批量生产两处改进：导出「打开文件夹」修复 + 检查成片片段编辑（执行文档）

> 本文是 2026-08-24 会话的已批准执行计划留底，先写文档后执行；执行中如有实现偏差，回头同步本文。
> 需求来源：用户反馈——① 导出成片里「打开文件夹」点了打不开；② 检查成片看不到素材哪些用过/哪些从来没用，
> 且缺少单条混剪那样的片段截取与替换编辑能力。
> 已确认的取舍：编辑后**即改即看的实时预览**（客户端合成，不等重渲染）；素材标记按**全批次维度**
> （本片已用 / 其他成片已用 / 从未使用）；「打开文件夹」问题发生在**桌面安装版**。

## 背景与结论

**问题 1（打开文件夹打不开）**：桌面安装版（Electron 壳，`window.desktopBridge` 存在）。当前链路是前端
POST `/api/batch-production/batches/[id]/exports/reveal`，服务端从隐藏控制台的 Node 子进程
`spawn('explorer.exe', [dir])`（`app/api/batch-production/batches/[id]/exports/reveal/route.ts`）：
在 `spawn` 事件即返回成功，资源管理器窗口可能不前台弹出；成功时前端零反馈，失败时错误条渲染在主面板
顶部（`BatchPreparationPanel.tsx` 顶部错误区），第 4 步里看不到。修法：Electron 主进程新增
`shell.openPath` IPC（前台打开、失败有错误串），前端优先走 IPC，原服务端 spawn 留作兜底；按钮附近加
成功/失败反馈。

**问题 2（检查成片看不到素材使用情况、无片段级编辑）**：数据基础齐全——
`batch_output_versions.arrangementJson.clips[]` 保存每条片段的
`assetId / sourceStartUs / sourceEndUs / timelineStartUs / timelineEndUs`
（`lib/batch-production/allocator.ts`）；素材代理预览/缩略图端点已存在；「换封面」是
"就地改 arrangement + 重渲染同版本"的现成先例（`lib/batch-production/phase-e.ts`
`scheduleRenderAfterCoverChange`）。

范围限定（与单条 TrimEditor 语义一致）：**只做等长 trim（拖动换入点、时长不变）+ 等长 replace
（整段换素材）**；不做插入/删除/缺口——批量时间线必须首尾相接（`batch-renderer.ts` 连续性校验），
且总长与口播/字幕对齐绑定，变长会全线错位。

---

## 问题 1：导出「打开文件夹」

1. `desktop/bridge-types.ts`：`DesktopBridge` 加
   `openFolder(relativePath: string): Promise<{ opened: boolean; message?: string }>`。
2. `desktop/ipc.ts`：`CHANNELS` 加 `openFolder: 'desktop:open-folder'`，`DesktopIpcHandlers` 加签名，
   `registerIpcHandlers` 注册（沿用 `protectedHandler` 同源校验）。
3. `desktop/preload.ts`：暴露 `openFolder`（常量通道名，与现有写法一致）。
4. `desktop/main.ts`：实现 handler——`boot()` 已算出的 dataRoot 存入模块级变量；handler 内拒绝绝对路径
   与 `..`，`path.resolve(dataRoot, relativePath)` 后断言仍位于 dataRoot 之内，再
   `shell.openPath(absolute)`（返回空串=成功，否则错误串 → `{ opened: false, message }`）。
   `createDesktopIpcHandlers` 需要拿到 dataRoot（加参数或在模块级读取）。
5. `components/batch-production/BatchPreparationPanel.tsx` `revealFolder()`：
   - 有 `window.desktopBridge?.openFolder` → 传相对路径 `storage/projects/<exportDirName>/成片`
     （exportDirName 来自 workspace/`folderRelativePath` 状态），按返回显示反馈；
   - 无 bridge → 走原 POST reveal 兜底；
   - 两种路径都把结果写入新的 `revealFeedback: { kind: 'ok' | 'error'; message: string } | null` 状态。
6. `components/batch-production/BatchStepExport.tsx`：新增 `revealFeedback` prop，在「打开文件夹」按钮旁
   渲染成功（"已请求系统打开文件夹"）或失败（服务端/bridge 返回的 message）文案，替代现在错误只在
   面板顶部的做法。
7. 测试：检查 `scripts/standalone-desktop-boundary.test.mjs` 是否断言 desktop 源文件/channel 清单，
   按需同步；主进程 handler 的 containment 逻辑若抽成纯函数可加小测试（视边界测试现状决定，不强行
   新增框架）。

## 问题 2：检查成片 — 素材使用可见性 + 片段编辑（实时预览）

### 后端（`lib/batch-production/` 红线不变：服务端不依赖 `final-edit/`）

8. 新建 `lib/batch-production/output-arrangement.ts`：
   - `getBatchOutputArrangementView(db, projectId, batchId, planId)`：读 plan 当前版本的
     `arrangementJson`，组装编辑器视图：
     - `clips[]`：`{ clipId, segmentId, assetId, sourceStartUs, sourceEndUs, timelineStartUs,
       timelineEndUs, locked }`；
     - `narration { audioRelativePath, durationUs }`、`subtitleCues[]`（`arrangement.subtitle.cues`）、
       `cover`（候选封面 URL）、`bgm { trackId, gainDb, fadeInSec, fadeOutSec }`
       （`arrangement.music.trackId` + `resolveBatchBgmParams`，见 `batch-renderer.ts`）；
     - `poolAssets[]`：冻结池 `batch_asset_pool_items` 联接素材信息 → `{ assetId, displayName,
       durationSec, contentFingerprint, thumbnailUrl, previewUrl, excluded, usedByPlanIds }`；
       `usedByPlanIds` 由本批次版本全部 plan 当前 arrangement 的 clips ∪ cover 聚合（全批次维度使用标记
       的数据源）；`previewUrl` 用代理预览端点
       `/api/batch-production/preview/[assetId]?projectId&batchId&batchVersionId`（LUT 已烧入，色彩与
       正式渲染一致）；
     - `editable`（批次 frozen 且非 stopped、当前版本存在）与 `editRevision`。
   - `applyBatchOutputClipEdit(db, projectId, batchId, planId, edit)`，
     `edit = { type:'trim', clipId, sourceStartUs, sourceEndUs } | { type:'replace', clipId, assetId }`：
     - 门禁仿 `phase-e.ts` reallocate：批次 frozen、非 stopped、plan 属于当前版本；
     - trim：新区间长度与原片段等长（允许 24fps 帧取整误差，服务端规整到原长度）、不越素材时长；
     - replace：目标素材在冻结池、不在 `batch_asset_exclusions`、指纹一致、时长 ≥ 片段长度；窗口从 0 起
       （用户可再用截取调入点）；
     - 单事务写回 `arrangementJson`：改 clip、`editRevision = (editRevision ?? 0) + 1`、删除 `$.review`
       （画面变了必须重新审核，与发布门禁对齐）。
9. `lib/batch-production/phase-e.ts`：`renderRequestKey` 追加 `:edit:{editRevision}`（缺省 0；否则就地改
   clips 后同 key 命中既有 succeeded 任务、重渲染被去重跳过）；新增 `scheduleRenderAfterClipEdit(...)`，
   函数体与 `scheduleRenderAfterCoverChange` 同型。
10. 路由：
    - 新建 `app/api/batch-production/batches/[id]/outputs/[planId]/arrangement/route.ts`
      （GET → 编辑器视图；`assertBatchApiReady` + projectId 校验，沿用 `../../../../response` 工具）。
    - 新建 `app/api/batch-production/batches/[id]/outputs/[planId]/clips/route.ts`（POST →
      `applyBatchOutputClipEdit` + `scheduleRenderAfterClipEdit` + `ensureBatchSchedulerStarted`，
      仿 cover route 结构）。
    - `app/api/batch-production/batches/[id]/outputs/[planId]/media/route.ts` 扩展 `kind=narration`：
      从 arrangement 读口播 wav 相对路径，`resolveStoragePath`/symlink 校验后复用文件内 `serveMedia`
      流式输出（实时预览的口播音频源）。

### 前端

11. 新建 `components/batch-production/BatchTimelinePreview.tsx`：批量专用实时预览（**路线 B**：不碰共享的
    `FinalEditPreview`——它口播 URL 硬编码 final-edit 路由且要伪造大 group 对象）。复用
    `components/final-edit/preview-playback.ts` 已导出的纯函数：`getVideoSlotPlan` /
    `expectedVideoTimeSec` / `paintDecodedVideoFrame` / `previewAudioLevelsAtTime`。
    - 双 `<video>` slot 轮播按片段源区间播放（src = 素材代理预览 URL）；片头 20/24 秒显示封面图
      （标题已烧进封面，无需画字）；
    - 字幕 canvas 叠加：按 `batch-renderer.ts` 字幕参数自绘单行文本（fontSize=max(34, width×竖 0.055/
      横 0.042)、baseline 86%、描边 9%、字重 600）；
    - 口播 `<audio>`（`kind=narration` URL，片头结束后起播）；BGM `<audio loop>` 走现有
      `/api/final-edit-bgm/[trackId]/file`；
    - 播放/暂停、进度条 seek；props 为批量形状，不引入 final-edit 类型包袱。
12. 新建 `components/batch-production/BatchOutputEditor.tsx`：编辑面板——
    - 片段条：缩略图 + 时间区间，点击选中；选中后可用「截取」打开
      `components/mixcut/TrimEditor.tsx`（纯 UI 组件，喂映射对象：clip→`TimelineClip` 形、asset→含
      `durationUs/thumbnailUrl` 形，24fps µs↔frame 换算）；
    - 素材列：池素材缩略图/名称/时长 + 使用徽标（**本片已用** / **其他成片已用** / 未使用，来自
      `usedByPlanIds`）；已排除素材置灰不可选；选中片段后点素材 →「替换当前片段」→ POST clips；
    - 使用摘要行：「本片使用 X/Y 条素材 · 本批次还有 Z 条素材从未使用」（直接回应"哪些从来没用"）；
    - 提交成功后刷新 workspace 与 arrangement 视图，卡片进入渲染中态（现有 task progress 已能显示）。
13. `components/batch-production/BatchStepReview.tsx`：
    - 预览弹窗加「调整片段」入口，进入编辑模式（弹窗加宽，嵌入 `BatchOutputEditor` +
      `BatchTimelinePreview`）；批次已停止/未冻结或查看历史版本时只读不显示编辑入口；
    - 提醒文案人性化：把分配器已知警告码映射成中文说明——`previous-version-reused`→换一批后素材池不足
      沿用了上一版画面、`stitched-segment`→单条素材装不下句段已自动拼接多镜头、`source-overlap`→
      部分画面区间复用、`analysis-fallback`→画面分析不可用用了兜底匹配、`semantic-degraded`→语义匹配度
      较低、`opening-reused`→开头画面与其他成片重复、`cover-unavailable`→封面不可用、
      `no-legal-media`→没有可用素材（映射放在组件内常量，卡片与弹窗两处提醒渲染点共用）。
14. `components/batch-production/BatchPreparationPanel.tsx`：编辑器打开时拉取 arrangement 视图；
    `onTrimClip`/`onReplaceClip` handler（POST clips → 刷新）；busy 态复用 `phaseEBusy` 模式。

### 测试与文档

15. 新增 `scripts/batch-output-clip-edit.test.ts`（better-sqlite3 `:memory:`、无框架、沿用现有测试
    风格）：trim 等长/越界校验、replace 池成员/排除/指纹/时长校验、review 清除、editRevision 递增、
    requestKey 含 editRevision 产生新任务、stopped/draft 批次拒绝。
16. 按需同步会断言源码的契约测试：`scripts/batch-phase-e-ui-contract.test.mjs`、
    `scripts/batch-preparation-workspace.test.mjs`、`scripts/standalone-desktop-boundary.test.mjs`；
    复跑相关批量测试（phase-e / workspace / renderer 同名测试）与 `npm run lint`。
17. 文档：`docs/reference/批量生产模块.md` Phase E 段补一句片段编辑端点与实时预览组件的指针
    （AGENTS.md 本身无约定变化，不动）。

### 验证口径（诚实声明）

- 单测 + lint 必须绿；「打开文件夹」的 Electron IPC 路径在 dev 下可用 `npm run dev:desktop` 验证，
  安装版行为（explorer 前台弹出）需打包后人工验证——本计划只做代码层修复与逻辑自验。

---

## 执行结果（2026-08-24 回填）

全部完成，验证实跑通过：`scripts/batch-output-clip-edit.test.ts`（新增 12 组断言）、
`electron-shell-security` / `standalone-desktop-boundary` / `batch-phase-e-ui-contract` /
`batch-preparation-workspace` 契约测试、phase-e 编排/schema/口播门禁、batch-workspace、
batch-renderer 复跑全绿；`npx tsc --noEmit` 干净；`npm run lint` 0 error（37 条 warning 均为存量，
本次触动文件零告警）。

与原计划的偏差（均为实现层微调，未改需求口径）：

1. `desktop/main.ts` 的 dataRoot 用模块级变量（计划允许两选一）；containment 未抽纯函数，
   由 `electron-shell-security.test.mjs` 的桥接面断言锁定。
2. trim 也加了幂等短路（区间无变化不清 review、不递增 editRevision），避免误触白白重置已通过的审核。
3. `editable` 口径 = 当前版本存在 + 批次 frozen + 非 stopped，与编辑端点门禁一致。
4. `editable` 之外前端另传 `renderBusy`：渲染任务活跃时编辑控件锁定。
5. 预览 BGM 音量包络用每帧写 `audio.volume`（同 `previewAudioLevelsAtTime` 数学），
   未引入 WebAudio GainNode。
6. `outputPreset` 从面板画幅选择器传入预览（arrangement 视图不含 preset 字段）。
7. 弹窗渲染中提示文案定为中性「正在按最新画面重新渲染，完成后以新成片为准」
   （该提示在换一批画面等非编辑触发的重渲染时也会出现）。
8. `scripts/batch-render-smoke.test.ts` 在本机失败为预存环境问题（ffmpeg 渲染时长 10.83s vs
   断言 10s，模块图与本次改动无交集），未改动该测试。
9. 契约测试旧断言与新 UI 无冲突，未改动其断言。
