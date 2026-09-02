import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync('components/batch-production/BatchPreparationPanel.tsx', 'utf8');
const materials = fs.readFileSync('components/batch-production/BatchStepMaterials.tsx', 'utf8');
const review = fs.readFileSync('components/batch-production/BatchStepReview.tsx', 'utf8');
const exportStep = fs.readFileSync('components/batch-production/BatchStepExport.tsx', 'utf8');
const bootstrap = fs.readFileSync('lib/batch-production/bootstrap.ts', 'utf8');
const startRoute = fs.readFileSync('app/api/batch-production/batches/[id]/start/route.ts', 'utf8');
const workspaceRoute = fs.readFileSync('app/api/batch-production/batches/[id]/workspace/route.ts', 'utf8');
const exportRoute = fs.readFileSync('app/api/batch-production/batches/[id]/exports/route.ts', 'utf8');
const exclusionRoute = fs.readFileSync('app/api/batch-production/batches/[id]/assets/[assetId]/exclusion/route.ts', 'utf8');
const outputEditor = fs.readFileSync('components/batch-production/BatchOutputEditor.tsx', 'utf8');
const coverEditor = fs.readFileSync('components/batch-production/BatchCoverEditorDrawer.tsx', 'utf8');
const coverPreview = fs.readFileSync('components/batch-production/BatchCoverDraftPreview.tsx', 'utf8');
const batchTimelinePreview = fs.readFileSync('components/batch-production/BatchTimelinePreview.tsx', 'utf8');
const batchTextStyle = fs.readFileSync('components/batch-production/BatchTextStyleEditor.tsx', 'utf8');
const batchPreviewCss = fs.readFileSync('components/batch-production/batch-preview.module.css', 'utf8');
const batchTimeline = fs.readFileSync('components/batch-production/BatchTimeline.tsx', 'utf8');
const clipsRoute = fs.readFileSync('app/api/batch-production/batches/[id]/outputs/[planId]/clips/route.ts', 'utf8');
const timelineCss = fs.readFileSync('components/mixcut/mixcut-content.module.css', 'utf8');

// 界面不得出现研发术语(Phase/联合分配/代理 等)与内部状态值
for (const source of [panel, materials, review, exportStep]) {
  assert.doesNotMatch(source, /Phase [A-Z]/);
  assert.doesNotMatch(source, /联合分配/);
}
// 渲染闸门(问题 3-A/B)生效后不再产出静音样片,界面不得再出现相关文案;
// 检查页提供「重试配音」与常驻「重新生成」入口。
assert.doesNotMatch(review, /无配音样片/);
assert.doesNotMatch(review, /重新渲染（带配音）/);
assert.match(review, /重新生成/);
assert.match(review, /重试配音/);
assert.doesNotMatch(panel, /静音视觉候选/);
assert.doesNotMatch(exportStep, /productionReady/);
assert.match(exportStep, /正式导出选中项/);
assert.match(review, /换一批画面/);
assert.match(review, /batch-output-preview-/);
assert.match(review, /暂停批次/);
assert.match(review, /继续批次/);
assert.match(materials, /从后续分配排除/);
assert.match(materials, /恢复参与分配/);
assert.match(bootstrap, /batchRenderExecutor/);
assert.match(bootstrap, /batchNarrationExecutor/);
assert.match(startRoute, /startOrResumePhaseE/);
assert.match(workspaceRoute, /getBatchWorkspace/);
assert.match(exportRoute, /publishSelectedBatchOutputs/);
assert.match(exclusionRoute, /updateBatchAssetExclusionAndSchedule/);
// 截取/修剪合并为一个入口:编辑器不再出现「截取」按钮与旧 TrimEditor 复用
assert.doesNotMatch(outputEditor, />截取</);
assert.doesNotMatch(outputEditor, /mixcut\/TrimEditor/);
// 时间轴替换片段卡片条:比例时间轴存在且带错位可视区与工具模式标记
assert.match(outputEditor, /BatchTimeline/);
assert.doesNotMatch(outputEditor, /口播变速/);
assert.doesNotMatch(outputEditor, /跳转到脚本步骤/);
assert.match(outputEditor, /BatchCoverDraftPreview/);
assert.match(outputEditor, /BatchCoverEditorDrawer/);
assert.match(outputEditor, /xl:grid-cols-\[minmax\(254px,280px\)_minmax\(420px,1fr\)_minmax\(300px,340px\)\]/);
assert.match(outputEditor, /aria-label="素材调整"/);
assert.match(outputEditor, /素材预览/);
assert.match(outputEditor, /预览素材/);
assert.match(outputEditor, /aria-label="成片设置"/);
assert.match(outputEditor, /data-testid="batch-output-preview-pane"/);
assert.match(outputEditor, /data-testid="batch-output-timeline-pane"/);
assert.doesNotMatch(outputEditor, /grid-rows-\[minmax\(220px,1fr\)_minmax\(188px,0\.82fr\)\]/);
assert.match(outputEditor, /h-\[clamp\(360px,58vh,560px\)\]/);
assert.match(review, /data-testid="batch-output-editor-layout"/);
assert.match(review, /min-h-0 flex-1 overflow-hidden/);
assert.match(outputEditor, /data-testid="batch-output-middle-scroll-area"/);
assert.match(outputEditor, /data-testid="batch-output-settings-scroll-area"/);
assert.match(outputEditor, /min-h-0 min-w-0 flex-1 gap-3/);
assert.match(outputEditor, /BatchTextStyleEditor/);
assert.match(outputEditor, /set_subtitle_style/);
assert.doesNotMatch(outputEditor, /view\?\.subtitleStyle\]/);
assert.match(outputEditor, /gainDb: musicDraft\.gainDb/);
assert.match(outputEditor, /fadeInSec: musicDraft\.fadeInSec/);
assert.match(outputEditor, /fadeOutSec: musicDraft\.fadeOutSec/);
// C3：曲目与参数共同组成 musicDraft，下拉只改草稿不提交，应用走原子 set_music。
assert.match(outputEditor, /trackId: musicDraft\.trackId/, 'BGM 草稿必须包含曲目');
assert.doesNotMatch(outputEditor, /set_music_track/, '曲目下拉不得再选中即提交 set_music_track');
assert.doesNotMatch(outputEditor, /set_music_params/, '新 UI 不得再分两次提交 BGM 参数');
assert.match(outputEditor, /type: 'set_music'/, '应用 BGM 更改必须提交原子 set_music 命令');
assert.match(outputEditor, /应用 BGM 更改/, '按钮文案必须是「应用 BGM 更改」');
assert.match(outputEditor, /musicDraftChanged/, '应用按钮的可用性必须覆盖全部四个字段');
assert.match(outputEditor, /resolveBgmDraftAfterViewLoad/, '草稿同步必须复用纯决策模块，不得在组件里内联第二份规则');
assert.match(outputEditor, /syncedBgmRef/, '换 plan 或服务端真值变化时 BGM 草稿必须对齐服务端真值');
assert.match(
  outputEditor,
  /onClick=\{\(\) => setMusicDraft\(\(current\) => \(\{ \.\.\.current, \.\.\.view\.batchMusicDefaults \}\)\)\}>恢复批次默认/,
  '恢复批次默认只把批次默认参数写入草稿，不得绕过应用按钮直接提交',
);
// C3：预览换源续播——fileUrl 变化时保留播放头与播放状态。
assert.match(batchTimelinePreview, /lastBgmFileUrlRef/, 'BGM 换源必须建立显式媒体同步');
// 复核 F3：「首次挂载」与「BGM 原本关闭」必须区分，否则关闭 BGM 后播放中
// 再选曲（含初始无 BGM、播放中第一次选曲）会被当成首帧跳过，音乐静默。
assert.match(batchTimelinePreview, /bgmSyncInitializedRef/, '首帧与「BGM 原本关闭」必须用独立标记区分');
assert.match(batchTimelinePreview, /playingRef\.current[\s\S]{0,600}element\.play\(\)/, '播放中换源必须按音量包络续播');
// 复核 F4：异步分支的播放头必须读 ref（陈旧闭包会 seek 落后一个加载时长）；
// loadedmetadata 监听器必须在 cleanup 中摘除，快速连换两首不得触发过期 seek/play。
assert.match(batchTimelinePreview, /const currentSec = lastDrivenSecRef\.current/, '换源续播的播放头必须读 ref，不得吃陈旧闭包');
assert.match(batchTimelinePreview, /removeEventListener\('loadedmetadata'/, '换源 loadedmetadata 监听器必须在 cleanup 中摘除');
assert.doesNotMatch(batchTimelinePreview, /bgmElement\.currentTime = 0;[\s\S]{0,80}play\(\)/, '换源续播不得把 BGM 归零后直接播放');
assert.match(outputEditor, /aria-label="成片口播音量"/);
assert.match(outputEditor, /narrationGainDb=\{narrationGainDraft\}/);
assert.match(outputEditor, /type: 'set_narration_gain'/);
assert.match(outputEditor, /NARRATION_GAIN_DB_MIN/);
assert.match(outputEditor, /NARRATION_GAIN_DB_MAX/);
assert.match(batchTimelinePreview, /narrationGainDb/);
assert.match(batchTimelinePreview, /createMediaElementSource/);
assert.match(batchTimelinePreview, /narrationGain\.gain/);
assert.match(clipsRoute, /set_narration_gain/);
assert.match(outputEditor, /aria-controls="batch-preview-panel"/);
assert.match(outputEditor, /role="tabpanel"/);
assert.match(outputEditor, /aria-labelledby=/);
assert.match(outputEditor, /ArrowLeft/);
assert.match(outputEditor, /ArrowRight/);
assert.match(coverEditor, /data-testid="batch-cover-editor-drawer"/);
assert.match(coverEditor, /封面截帧时间/);
assert.match(coverEditor, /rangeInput/);
assert.match(batchTextStyle, /rangeInput/);
assert.doesNotMatch(batchTextStyle, /sm:grid-cols-2/);
assert.doesNotMatch(batchTextStyle, /sm:grid-cols-3/);
assert.doesNotMatch(batchTextStyle, /grid-cols-\[auto_minmax\(0,1fr\)\]/);
assert.match(coverPreview, /max-w-full/);
assert.match(coverPreview, /maxWidth: 'none'/);
assert.match(coverPreview, /inset-0 h-full w-full/);
assert.match(coverPreview, /fill = false/);
assert.match(batchTimelinePreview, /BatchCoverDraftPreview/);
assert.match(batchTimelinePreview, /coverDraft/);
assert.match(batchTimelinePreview, /coverDraft\?\.asset/);
assert.doesNotMatch(coverEditor, /className="h-full max-w-none"/);
assert.match(batchTimelinePreview, /isFullscreen \? '退出全屏' : '全屏'/);
assert.match(batchTimelinePreview, /requestFullscreen/);
assert.match(batchTimelinePreview, /else if \(root\.requestFullscreen\)/);
assert.match(batchTimelinePreview, /fullscreenShell/);
assert.match(batchTimelinePreview, /fullscreenchange/);
assert.match(batchTimelinePreview, /退出全屏/);
assert.match(batchPreviewCss, /\.fullscreenShell:fullscreen/);
assert.match(batchPreviewCss, /\.fullscreenControls/);
assert.match(batchPreviewCss, /var\(--batch-preview-ratio\)/);
assert.match(batchPreviewCss, /var\(--color-media-background\)/);
assert.match(batchPreviewCss, /var\(--color-media-foreground\)/);
assert.doesNotMatch(batchPreviewCss, /#fff|rgba\(/);
assert.doesNotMatch(review, /封面素材网格/);
assert.match(batchTimeline, /batch-output-timeline/);
assert.match(batchTimeline, /planSubtitleCueSplit/);
assert.match(batchTimeline, /末帧延长/);
assert.match(batchTimeline, /超出裁掉/);
assert.match(batchTimeline, /口播（锁定）/);
assert.match(batchTimeline, /data-tool/);
assert.ok(
  (batchTimeline.match(/addEventListener\('pointercancel'/g) ?? []).length >= 3,
  '播放头、视频片段和字幕拖拽都必须清理 pointercancel',
);
// 播放头竖线回归(2026-08-24):.shell button 重置(0,1,1)会洗掉单类 .tlPlayhead(0,1,0)
// 的 background/cursor,只剩 ::before 抓手点;规则必须挂在 .tlInner 下抬到 (0,2,0)。
assert.match(timelineCss, /\.tlInner \.tlPlayhead \{/);

console.log('batch Phase E UI contract tests passed');

// 片段调整期不排重渲染(2026-08-25):每次微调排一条整片渲染要 4~7 秒,还会经
// renderBusy 把编辑器锁死。编辑一律带 deferRender,退出这一轮时 commit_render 一次性提交。
assert.match(clipsRoute, /commit_render/);
assert.match(clipsRoute, /deferRender/);
assert.match(outputEditor, /deferRender: true/);
assert.match(outputEditor, /'commit_render'/);
assert.match(outputEditor, /pagehide/);
assert.match(outputEditor, /response\.ok/);
assert.match(outputEditor, /payload\.type !== 'split'/);
assert.match(outputEditor, /inFlightEditRef/);
assert.match(outputEditor, /修改已保存，退出本轮调整后会自动重新渲染/);
assert.match(outputEditor, /立即渲染/);
assert.match(outputEditor, /btn-secondary/);
assert.match(exportStep, /renderStale/);
assert.match(exportStep, /等待重新渲染/);
assert.match(panel, /selectedUncommittedCount/);
assert.match(panel, /修改还没提交重新渲染/);
assert.match(review, /renderUncommitted/);
assert.match(exportStep, /待重新生成/);
assert.ok(
  exportStep.indexOf("!card.publishable ? '不可导出'") >= 0
    && exportStep.indexOf("!card.publishable ? '不可导出'") < exportStep.indexOf("card.renderStale ? '等待重新渲染'"),
  '导出状态必须先表达不可导出，再表达可导出候选的新鲜度',
);
assert.match(review, /渲染中，完成后才可导出/);
assert.doesNotMatch(review, /封面素材原片区间/);
assert.match(panel, /因画面已调整未导出/);
