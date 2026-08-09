import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FinalEditVariantView } from '../lib/final-edit/types.ts';
import { releaseReservedExportTarget, type ReservedProjectExportTarget } from '../lib/final-edit/export-naming.ts';

const {
  createFinalEditWorkspace,
  FinalEditError,
  MIXCUT_PREPARE_PHASE_RANGES,
  buildAlignedSubtitleCues,
} = await import('../lib/final-edit/workspace.ts');
const { initFinalEditSchema } = await import('../lib/final-edit/schema.ts');

const automaticCueFixture = buildAlignedSubtitleCues({
  version: 2, source: 'module3', sourceDraftId: 'fixture', sourceScriptUpdatedAt: null,
  sourceScriptVersion: 3, title: '字幕参数', targetDurationSec: 15, shotSetId: 'set-a',
  sourceNarrationText: '', sourceSegments: [], editedNarrationText: '', scriptSyncState: 'synced',
  fullScript: '厚度3.5cm，提升20%，靠背112°，适配9:16画幅。',
  segments: [{ id: 'parameter-segment', shotId: '', narration: '厚度3.5cm，提升20%，靠背112°，适配9:16画幅。', subtitle: '模型字幕不可信！' }],
}, {
  relativePath: 'fixture.wav', durationUs: 4_000_000,
  segmentTimings: [{ segmentId: 'parameter-segment', startUs: 0, endUs: 4_000_000 }],
  wordTimings: [{ text: '厚度3.5cm，提升20%，靠背112°，适配9:16画幅。', startUs: 0, endUs: 4_000_000 }],
});
assert.deepEqual(automaticCueFixture.map((cue) => cue.text), ['厚度3.5cm', '提升20%', '靠背112°', '适配9:16画幅']);
assert.ok(automaticCueFixture.every((cue) => cue.textSource === 'script' && !/[，。！？；、,.!?;\s]$/u.test(cue.text)));

const alignedBoundaryFixture = buildAlignedSubtitleCues({
  version: 2, source: 'module3', sourceDraftId: 'fixture', sourceScriptUpdatedAt: null,
  sourceScriptVersion: 3, title: '词级边界', targetDurationSec: 15, shotSetId: 'set-a',
  sourceNarrationText: '', sourceSegments: [], editedNarrationText: '', scriptSyncState: 'synced',
  fullScript: '第一句很慢，第二句很快。',
  segments: [{ id: 'word-boundary-segment', shotId: '', narration: '第一句很慢，第二句很快。', subtitle: '' }],
}, {
  relativePath: 'fixture.wav', durationUs: 4_000_000,
  segmentTimings: [{ segmentId: 'word-boundary-segment', startUs: 0, endUs: 4_000_000 }],
  wordTimings: [
    { text: '第一句很慢，', startUs: 0, endUs: 3_000_000 },
    { text: '第二句很快。', startUs: 3_000_000, endUs: 4_000_000 },
  ],
});
assert.deepEqual(alignedBoundaryFixture.map((cue) => [cue.text, cue.startUs, cue.endUs]), [
  ['第一句很慢', 0, 3_000_000],
  ['第二句很快', 3_000_000, 4_000_000],
], '非降级字幕必须使用词级对齐边界，而不是按字符比例平分');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-final-edit-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(path.join(storageRoot, 'videos'), { recursive: true });

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
    productCode TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL,
    exportDirName TEXT NOT NULL DEFAULT '',
    finalEditAutoUseLimit INTEGER DEFAULT 2
  );
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE shots (
    id TEXT PRIMARY KEY, shotSetId TEXT NOT NULL, indexNum INTEGER NOT NULL,
    sourceImageId TEXT NOT NULL, latestGeneratedImageId TEXT
  );
  CREATE TABLE image_assets (
    id TEXT PRIMARY KEY, projectId TEXT, filename TEXT NOT NULL, path TEXT NOT NULL,
    mimeType TEXT NOT NULL DEFAULT 'image/png'
  );
  CREATE TABLE script_drafts (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT NOT NULL, inputSnapshot TEXT NOT NULL, outputJson TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, shotSetId TEXT, shotId TEXT,
    status TEXT NOT NULL, localVideoPath TEXT, filename TEXT, durationSec INTEGER,
    prompt TEXT NOT NULL DEFAULT ''
  );
`);
initFinalEditSchema(db);

db.prepare(`INSERT INTO projects (id, name, model, productCode, createdAt) VALUES ('p1', '沙发任务', 'gpt-image-2-not-product-code', 'SF-A1', '2026-07-23 16:00:00')`).run();
db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('set-a', 'p1', '客厅'), ('set-b', 'p1', '卧室')`).run();
for (const [id, setId, index] of [['s1', 'set-a', 1], ['s2', 'set-a', 2], ['s3', 'set-b', 1]] as const) {
  const imagePath = path.join(storageRoot, `${id}.png`);
  fs.writeFileSync(imagePath, 'image');
  db.prepare(`INSERT INTO image_assets (id, projectId, filename, path) VALUES (?, 'p1', ?, ?)`).run(`img-${id}`, `${id}.png`, imagePath);
  db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, latestGeneratedImageId) VALUES (?, ?, ?, ?, ?)`).run(id, setId, index, `img-${id}`, `img-${id}`);
}
for (const [id, setId, shotId] of [['v1', 'set-a', 's1'], ['v2', 'set-a', 's2'], ['foreign', 'set-b', 's3']] as const) {
  const file = path.join(storageRoot, 'videos', `${id}.mp4`);
  fs.writeFileSync(file, `video-${id}`);
  db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, shotId, status, localVideoPath, filename, durationSec) VALUES (?, 'p1', ?, ?, 'succeeded', ?, ?, 12)`).run(id, setId, shotId, file, `${id}.mp4`);
}

const script = {
  version: 2,
  title: '温柔包裹，慢享生活',
  coverTitleParts: { primary: '温柔包裹', secondary: '慢享生活' },
  platform: '小红书', tone: '温柔', targetDurationSec: 20, template: '种草', shotSetId: 'set-a',
  sellingPointMap: [], droppedShots: [], fullScript: '第一段第二段',
  segments: [
    { id: 'seg-1', shotId: 's1', imageAssetId: 'img-s1', narration: '第一段', subtitle: '第一段', rationale: '' },
    { id: 'seg-2', shotId: 's2', imageAssetId: 'img-s2', narration: '第二段', subtitle: '第二段', rationale: '' },
  ],
};
db.prepare(`INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson) VALUES ('script-1', 'p1', 'fake', 'fake', '{}', ?)`).run(JSON.stringify(script));

const synthesizedNarrations: string[][] = [];
let synthesizedDurationUs = 18_500_000;
const warmedPreviewPaths: string[] = [];
let semanticScoreCalls = 0;
const analysisFailures = new Set<string>();
let degradeAlignment = false;
let analyzeVideoCalls = 0;
let failPreview = false;
let failSemanticScore = false;
const semanticLogs: Array<{ level: string; message: string; attempt: number }> = [];
const workspace = createFinalEditWorkspace({
  db,
  storageRoot,
  runJobsInline: true,
  probeVideo: async () => ({ durationUs: 12_000_000, width: 720, height: 960, fps: 24 }),
  analyzeVideo: async ({ videoJobId }) => {
    analyzeVideoCalls += 1;
    if (analysisFailures.has(videoJobId)) throw new Error('模拟素材分析失败');
    return {
      summary: videoJobId === 'v1' ? '沙发全景' : '面料细节',
      sellingPoints: [], semanticTags: [], usableRanges: [{ startUs: 0, endUs: 12_000_000, qualityScore: 1 }],
      qualityIssues: [], coverFrameTimesUs: [1_000_000],
    };
  },
  scoreSemanticMatrix: async () => {
    semanticScoreCalls += 1;
    if (failSemanticScore) throw new Error('模拟语义评分失败');
    return { score_matrix: [[0.95, 0.4], [0.4, 0.95]], hook_scores: [0.8, 0.2] };
  },
  semanticRetrySleep: async () => undefined,
  log: ({ level, message, attempt }) => semanticLogs.push({ level, message, attempt }),
  materializeCoverFrame: async ({ cacheKey }) => {
    if (cacheKey.includes('v2')) throw new Error('模拟末帧封面抽取失败');
  },
  warmPreview: async ({ relativePath }) => {
    if (failPreview) throw new Error('模拟低清预览失败');
    const absolutePath = path.join(storageRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    if (!fs.existsSync(absolutePath)) fs.writeFileSync(absolutePath, 'low-resolution-preview');
    warmedPreviewPaths.push(relativePath);
    return { relativePath };
  },
  estimateAnalysisCost: ({ requestCount }) => requestCount * 0.1,
  fitNarrationDuration: async ({ script }) => {
    return {
      editedNarrationText: script.segments
        .map((segment, index) => `贴合后的第${index + 1}段口播`)
        .join('\n'),
    };
  },
  synthesize: async ({ segments }) => {
    synthesizedNarrations.push(segments.map((segment) => segment.narration));
    return ({
    relativePath: 'final-edits/test/narration.wav',
    durationUs: synthesizedDurationUs,
    segmentTimings: segments.map((segment, index) => ({
      segmentId: segment.segmentId,
      startUs: Math.round(index * synthesizedDurationUs / segments.length),
      endUs: Math.round((index + 1) * synthesizedDurationUs / segments.length),
    })),
    wordTimings: segments.map((segment, index) => ({
      text: segment.narration,
      startUs: Math.round(index * synthesizedDurationUs / segments.length),
      endUs: Math.round((index + 1) * synthesizedDurationUs / segments.length),
    })),
    alignmentDegradedSegmentIds: degradeAlignment ? segments.map((segment) => segment.segmentId) : [],
  }); },
});

const capacity = await workspace.preflight({ projectId: 'p1', scriptDraftId: 'script-1', count: 2, outputPreset: '3x4' });
assert.equal(capacity.assetCount, 2);
assert.deepEqual(capacity.videoJobIds.sort(), ['v1', 'v2']);
assert.ok(!capacity.videoJobIds.includes('foreign'));
const pricedCapacity = await workspace.preflight({ projectId: 'p1', scriptDraftId: 'script-1', count: 2, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision' });
assert.equal(pricedCapacity.estimatedCost, 0.2);
assert.equal(pricedCapacity.costCurrency, 'CNY');

const job = await workspace.start({
  projectId: 'p1', scriptDraftId: 'script-1', count: 2, outputPreset: '3x4',
  providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision',
});
assert.equal(job.status, 'succeeded');
assert.equal((db.prepare(`SELECT estimatedCost FROM final_edit_jobs WHERE id=?`).get(job.id) as { estimatedCost: number }).estimatedCost, 0.2);
assert.equal(semanticScoreCalls, 1, '一次 prepare 只能生成一次句段 × 场景语义矩阵');

const group = workspace.load(job.groupId);
assert.equal(group.status, 'ready');
assert.equal(group.narrationDurationUs, 18_500_000);
assert.equal(group.totalDurationUs, 19_333_333);
assert.equal(group.variants.length, 2);
assert.equal(group.assets.length, 2);
assert.ok(group.assets.every((asset) => asset.shotSetId === 'set-a'));
assert.ok(group.assets.every((asset) => asset.thumbnailUrl.includes('/thumbnail')));
assert.ok(group.coverCandidates.some((candidate) => candidate.coverKey.startsWith('video:')));
assert.ok(group.variants.every((variant) => variant.timeline.clips.every((clip) => clip.videoJobId !== 'foreign')));
assert.equal(warmedPreviewPaths.length, 2, 'previewing 必须调用真实预览预热 seam');
assert.ok(group.variants.every((variant) => variant.previewUrl?.includes('/api/videos/final-edits/previews/prepare/')));
const repeatJob = await workspace.start({
  projectId: 'p1', scriptDraftId: 'script-1', count: 1, outputPreset: '3x4',
  providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision',
});
const repeatGroup = workspace.load(repeatJob.groupId);
assert.equal(semanticScoreCalls, 1, '素材与脚本不变时必须命中语义矩阵缓存，零 LLM 调用');
assert.deepEqual(repeatGroup.variants[0].timeline, group.variants[0].timeline, '相同输入必须得到完全相同的时间线和 clip ID');
assert.equal(repeatGroup.variants[0].previewUrl, group.variants[0].previewUrl, '相同输入和口播内容必须复用同一个低清预览缓存');
db.prepare(`UPDATE final_edit_semantic_matrix_cache SET semanticScoresJson='[]'`).run();
await workspace.start({
  projectId: 'p1', scriptDraftId: 'script-1', count: 1, outputPreset: '3x4',
  providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision',
});
assert.equal(semanticScoreCalls, 2, '损坏的矩阵缓存必须视为 miss 并重新评分');
analysisFailures.add('v1');
db.prepare(`UPDATE final_edit_asset_analysis SET analyzerVersion='stale' WHERE videoJobId='v1'`).run();
const previewsBeforeDegradedPrepare = warmedPreviewPaths.length;
const degradedJob = await workspace.start({
  projectId: 'p1', scriptDraftId: 'script-1', selectedMaterialKeys: ['module4:v1'], count: 1, outputPreset: '3x4',
  providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision',
});
const degradedGroup = workspace.load(degradedJob.groupId);
assert.equal(degradedJob.status, 'succeeded', '素材分析失败仍应保留可修复的 partial 草稿');
assert.equal(degradedGroup.status, 'partial');
assert.ok(degradedGroup.variants[0].issues.some((issue) => issue.code === 'asset_analysis_failed'));
assert.ok(degradedGroup.variants[0].issues.some((issue) => issue.code === 'material_gap' && issue.severity === 'blocking'));
assert.equal(warmedPreviewPaths.length, previewsBeforeDegradedPrepare, '零 clip 的 partial 草稿不得调用预览渲染器');
assert.equal(degradedGroup.variants[0].previewUrl, null);
analysisFailures.clear();
db.prepare(`UPDATE final_edit_asset_analysis SET analyzerVersion='stale' WHERE videoJobId='v1'`).run();
degradeAlignment = true;
const alignmentDegradedJob = await workspace.start({
  projectId: 'p1', scriptDraftId: 'script-1', selectedMaterialKeys: ['module4:v1'], count: 1, outputPreset: '3x4',
  providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision',
});
const alignmentDegradedGroup = workspace.load(alignmentDegradedJob.groupId);
assert.ok(alignmentDegradedGroup.variants[0].issues.some((issue) => issue.code === 'alignment_degraded' && issue.severity === 'warning'));
assert.ok(alignmentDegradedGroup.subtitleCues.every((cue) => cue.timingSource === 'proportional'));
degradeAlignment = false;
db.prepare(`UPDATE final_edit_asset_analysis SET generatedJson='{}', status='succeeded', analyzerVersion='2' WHERE videoJobId='v1'`).run();
const analyzeCallsBeforeCorruptCache = analyzeVideoCalls;
await workspace.start({
  projectId: 'p1', scriptDraftId: 'script-1', selectedMaterialKeys: ['module4:v1'], count: 1, outputPreset: '3x4',
  providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision',
});
assert.equal(analyzeVideoCalls, analyzeCallsBeforeCorruptCache + 1, '损坏的视频分析缓存必须重新分析，不能作为成功结果继续');
failPreview = true;
const previewFailedJob = await workspace.start({
  projectId: 'p1', scriptDraftId: 'script-1', count: 1, outputPreset: '3x4',
  providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision',
});
const previewFailedGroup = workspace.load(previewFailedJob.groupId);
assert.equal(previewFailedJob.status, 'succeeded', '预览失败必须保留已经生成的时间线');
assert.ok(previewFailedGroup.variants[0].timeline.clips.length > 0);
assert.equal(previewFailedGroup.variants[0].previewUrl, null);
assert.ok(previewFailedGroup.variants[0].issues.some((issue) => issue.code === 'preview_failed'));
failPreview = false;
failSemanticScore = true;
const fallbackCallsBefore = semanticScoreCalls;
const fallbackInput = {
  projectId: 'p1', scriptDraftId: 'script-1', editedNarrationText: '缓存失败第一句。\n缓存失败第二句。', count: 1 as const, outputPreset: '3x4' as const,
  providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision',
};
const semanticFallbackJob = await workspace.start(fallbackInput);
assert.ok(workspace.load(semanticFallbackJob.groupId).variants[0].issues.some((issue) => issue.code === 'semantic_fallback'));
assert.ok(semanticLogs.some((entry) => entry.level === 'error' && entry.message.includes('关键词匹配')), '语义降级必须写入可定位的错误日志');
await workspace.start(fallbackInput);
assert.equal(semanticScoreCalls, fallbackCallsBefore + 2, 'fallback 矩阵不得写入缓存，相同输入必须重试 LLM 而不是永久绑定降级结果');
failSemanticScore = false;
await workspace.start(fallbackInput);
assert.equal(semanticScoreCalls, fallbackCallsBefore + 3, 'LLM 恢复后必须重新评分并写入缓存（自愈）');
await workspace.start(fallbackInput);
assert.equal(semanticScoreCalls, fallbackCallsBefore + 3, '自愈后的成功矩阵必须命中缓存，零 LLM 调用');

const durationGateScript = {
  version: 3,
  title: '真实时长闸门',
  coverTitleParts: { primary: '真实时长', secondary: '闸门测试', source: 'system_split' },
  targetDurationSec: 15,
  shotSetId: 'set-a',
  fullScript: '第一段真实口播。第二段真实口播。',
  segments: [
    { id: 'duration-seg-1', narration: '第一段真实口播。', subtitle: '不采信模型字幕', sellingPointRefs: ['舒适'], visualIntent: '沙发全景', visualKeywords: ['沙发'] },
    { id: 'duration-seg-2', narration: '第二段真实口播。', subtitle: '仍不采信模型字幕', sellingPointRefs: ['面料'], visualIntent: '面料细节', visualKeywords: ['面料'] },
  ],
};
db.prepare(`INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson) VALUES ('script-duration-v3', 'p1', 'fake', 'fake', '{}', ?)`).run(JSON.stringify(durationGateScript));
const durationStartInput = {
  projectId: 'p1', scriptDraftId: 'script-duration-v3', count: 1 as const, outputPreset: '3x4' as const,
  providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision',
};

synthesizedDurationUs = 14_566_667;
const withinToleranceJob = await workspace.start(durationStartInput);
assert.equal(withinToleranceJob.status, 'succeeded', '15.4 秒总时长应落在 15 秒目标的容差内');
assert.equal(workspace.load(withinToleranceJob.groupId).durationGate?.status, 'within_tolerance');

synthesizedDurationUs = 15_366_667;
const slightlyLongJob = await workspace.start(durationStartInput);
assert.equal(slightlyLongJob.status, 'succeeded', '16.2 秒总时长只能记录提醒，不得暂停任务');
const slightlyLongGroup = workspace.load(slightlyLongJob.groupId);
assert.notEqual(slightlyLongGroup.status, 'needs_input');
assert.equal(slightlyLongGroup.phase, 'ready');
assert.equal(slightlyLongGroup.durationGate?.status, 'accepted_actual');
assert.equal(slightlyLongGroup.durationGate?.reason, 'too_long');
assert.equal(slightlyLongGroup.variants.length, 1, '真实时长超出建议后仍必须继续生成 variant');
assert.ok(slightlyLongGroup.subtitleCues.length > 0, '真实 TTS 字幕必须正常持久化');
assert.ok(slightlyLongGroup.variants[0].issues.some((issue) => issue.code === 'duration_target_overridden' && issue.severity === 'warning'));
await workspace.resumePrepareJob(slightlyLongJob.id);
assert.equal((db.prepare(`SELECT status FROM final_edit_jobs WHERE id=?`).get(slightlyLongJob.id) as { status: string }).status, 'succeeded', '已完成任务不得被恢复逻辑重新排队');

synthesizedDurationUs = 24_766_667;
const synthesizedCountBeforeLongRun = synthesizedNarrations.length;
const farTooLongJob = await workspace.start(durationStartInput);
assert.equal(farTooLongJob.status, 'succeeded', '即使实际总时长达到 25.6 秒也必须直接继续');
const farTooLongGroup = workspace.load(farTooLongJob.groupId);
assert.equal(synthesizedNarrations.length, synthesizedCountBeforeLongRun + 1, '超时后不得为了确认流程重复合成 TTS');
assert.equal(farTooLongGroup.durationGate?.status, 'accepted_actual');
assert.equal(farTooLongGroup.durationGate?.reason, 'too_long');
assert.ok(farTooLongGroup.variants[0].issues.some((issue) => issue.code === 'duration_target_overridden' && issue.message.includes('自动按实际时长继续')));
synthesizedDurationUs = 18_500_000;

assert.deepEqual(MIXCUT_PREPARE_PHASE_RANGES, {
  analyzing: [0, 0.3], synthesizing: [0.3, 0.55], duration_check: [0.55, 0.6], matching: [0.6, 0.82], previewing: [0.82, 1],
});
const schemaColumns = new Set((db.prepare(`PRAGMA table_info(final_edit_groups)`).all() as Array<{ name: string }>).map((column) => column.name));
for (const name of ['editedNarrationText', 'scriptSyncState', 'sourceScriptUpdatedAt', 'selectedMaterialKeysJson']) assert.ok(schemaColumns.has(name), `missing migration column ${name}`);
const editingDraft = workspace.ensureMixcutDraft({
  projectId: 'p1', shotSetId: 'set-a', scriptDraftId: '', editedNarrationText: '', selectedMaterialKeys: [],
  providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 0.5, analysisProviderId: 'vision',
});
assert.equal(editingDraft.status, 'editing');
assert.equal(editingDraft.script.editedNarrationText, '');
assert.deepEqual(editingDraft.script.selectedMaterialKeys, []);
assert.equal(workspace.load(editingDraft.id).id, editingDraft.id, '首次保存后刷新必须能 load 同一草稿');
const editingWithScript = workspace.apply({
  scope: 'group', groupId: editingDraft.id, expectedRevision: editingDraft.revision, type: 'set_mixcut_script_state',
  scriptDraftId: 'script-1', editedNarrationText: '草稿改写文案。', selectedMaterialKeys: ['module4:v1'],
  providerId: 'vapi-qwen3-tts', analysisProviderId: 'vision', voice: 'Cherry', speed: 2,
}).view as typeof editingDraft;
assert.equal(editingWithScript.script.sourceDraftId, 'script-1');
const foreignScript = { ...script, shotSetId: 'set-b', segments: [{ ...script.segments[0], shotId: 's3' }] };
db.prepare(`INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson) VALUES ('script-b', 'p1', 'fake', 'fake', '{}', ?)`).run(JSON.stringify(foreignScript));
assert.throws(
  () => workspace.apply({ scope: 'group', groupId: editingDraft.id, expectedRevision: editingWithScript.revision, type: 'set_mixcut_script_state', scriptDraftId: 'script-b', editedNarrationText: '跨组', selectedMaterialKeys: [], voice: 'Cherry', speed: 1 }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'script_shot_set_mismatch',
);
assert.throws(
  () => workspace.apply({ scope: 'group', groupId: editingDraft.id, expectedRevision: editingDraft.revision, type: 'set_mixcut_script_state', editedNarrationText: '旧版本覆盖', selectedMaterialKeys: [], voice: 'Cherry', speed: 1 }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'revision_conflict',
);
const draftJob = await workspace.start({ projectId: 'p1', draftGroupId: editingDraft.id, count: 1, outputPreset: '3x4', providerId: '', voice: '', speed: 1 });
const draftJobSnapshot = JSON.parse((db.prepare(`SELECT inputSnapshotJson FROM final_edit_jobs WHERE id=?`).get(draftJob.id) as { inputSnapshotJson: string }).inputSnapshotJson) as { scriptSnapshot: { editedNarrationText: string } };
assert.equal(draftJobSnapshot.scriptSnapshot.editedNarrationText, '草稿改写文案。', '从草稿生成必须固化当前快照');
const groupsBeforeInvalidProvider = Number((db.prepare(`SELECT COUNT(*) AS count FROM final_edit_groups`).get() as { count: number }).count);
await assert.rejects(
  workspace.start({ projectId: 'p1', scriptDraftId: 'script-1', count: 1, outputPreset: '3x4', providerId: 'missing-provider', voice: 'Cherry', speed: 1 }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'tts_provider_unavailable',
);
assert.equal(Number((db.prepare(`SELECT COUNT(*) AS count FROM final_edit_groups`).get() as { count: number }).count), groupsBeforeInvalidProvider, '输入/供应商校验失败不得留下孤儿 group');
await assert.rejects(
  workspace.start({ projectId: 'p1', scriptDraftId: 'script-1', shotSetId: 'set-b', editedNarrationText: '错误跨组', selectedMaterialKeys: ['module4:foreign'], count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'script_shot_set_mismatch',
);
await assert.rejects(
  workspace.start({ projectId: 'p1', scriptDraftId: 'script-1', shotSetId: 'set-a', selectedMaterialKeys: ['module4:foreign'], count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'material_not_ready',
);
for (const [id, shotSetId] of [['external-a', 'set-a'], ['external-b', 'set-b']] as const) {
  const relativePath = path.join('final-edits', 'projects', 'p1', 'groups', shotSetId, 'materials', `${id}.mp4`);
  fs.mkdirSync(path.dirname(path.join(storageRoot, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, relativePath), `video-${id}`);
  db.prepare(`INSERT INTO final_edit_external_assets (id, projectId, shotSetId, originalFilename, relativePath, mimeType, mediaKind, durationUs, width, height, fileFingerprint, status, createdAt) VALUES (?, 'p1', ?, ?, ?, 'video/mp4', 'video', 12000000, 720, 960, ?, 'ready', datetime('now'))`).run(id, shotSetId, `${id}.mp4`, relativePath, `fingerprint-${id}`);
}
await assert.rejects(
  workspace.start({ projectId: 'p1', scriptDraftId: 'script-1', shotSetId: 'set-a', selectedMaterialKeys: ['external:external-b'], count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'material_not_ready',
);
const externalJob = await workspace.start({ projectId: 'p1', scriptDraftId: 'script-1', shotSetId: 'set-a', selectedMaterialKeys: ['external:external-a'], count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision' });
const externalGroup = workspace.load(externalJob.groupId);
assert.equal(externalGroup.assets[0].videoJobId, 'external-asset-external-a');
assert.equal(externalGroup.assets[0].source, 'external');
assert.match(externalGroup.assets[0].previewUrl, /external-assets\/external-a\/media$/);
assert.ok(externalGroup.variants[0].timeline.clips.every((clip) => clip.videoJobId === 'external-asset-external-a'), '外部素材 timeline 必须能由 group assets read model 解析');

const externalARow = db.prepare(`SELECT relativePath FROM final_edit_external_assets WHERE id='external-a'`).get() as { relativePath: string };
const externalAPath = path.join(storageRoot, externalARow.relativePath);
const outsideVideoPath = path.join(root, 'outside-replacement.mp4');
fs.writeFileSync(outsideVideoPath, 'outside-owner-directory');
fs.unlinkSync(externalAPath);
fs.symlinkSync(outsideVideoPath, externalAPath);
await assert.rejects(
  workspace.start({ projectId: 'p1', scriptDraftId: 'script-1', shotSetId: 'set-a', selectedMaterialKeys: ['external:external-a'], count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'material_not_ready',
  '导入后替换成 symlink 的外部素材不得再被 prepare 读取',
);
assert.equal(workspace.load(externalJob.groupId).assets.length, 0, 'load 不得暴露已经 symlink 越界的外部素材');
db.prepare(`UPDATE final_edit_variants SET issuesJson='[]' WHERE id=?`).run(externalGroup.variants[0].id);
db.prepare(`INSERT INTO final_edit_overlay_bundles (id, groupId, outputPreset, groupRevision, specHash, manifestJson, relativeDir, status, createdAt) VALUES ('external-symlink-bundle', ?, '3x4', ?, 'external-symlink', '{}', 'final-edits/test/overlays', 'ready', datetime('now'))`).run(externalGroup.id, externalGroup.revision);
await assert.rejects(
  workspace.enqueueRender({ groupId: externalGroup.id, variantId: externalGroup.variants[0].id, expectedGroupRevision: externalGroup.revision, expectedVariantRevision: externalGroup.variants[0].revision, overlayBundleId: 'external-symlink-bundle' }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'unsafe_path',
  'render 快照不得读取已经 symlink 越界的外部素材',
);
fs.unlinkSync(externalAPath);
fs.writeFileSync(externalAPath, 'video-external-a');
const editableExternal = workspace.load(externalGroup.id);
const externalVariant = editableExternal.variants[0];
const externalClip = [...externalVariant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame)[0];
const externalAfterDelete = workspace.apply({
  scope: 'variant', variantId: externalVariant.id, expectedRevision: externalVariant.revision,
  type: 'delete_clip', clipId: externalClip.id,
}).view as FinalEditVariantView;
const externalAfterInsert = workspace.apply({
  scope: 'variant', variantId: externalAfterDelete.id, expectedRevision: externalAfterDelete.revision,
  type: 'insert_clip', videoJobId: 'external-asset-external-a', sourceFingerprint: editableExternal.assets[0].fingerprint,
  sourceInFrame: externalClip.sourceInFrame, sourceOutFrame: externalClip.sourceOutFrame,
  timelineInFrame: externalClip.timelineInFrame, timelineOutFrame: externalClip.timelineOutFrame,
}).view as FinalEditVariantView;
assert.ok(externalAfterInsert.timeline.clips.some((clip) => clip.videoJobId === 'external-asset-external-a'), '正式时间轴必须允许重新插入当前组外部素材');
assert.equal(
  workspace.load(externalGroup.id).variants[0].timeline.clips.filter((clip) => clip.videoJobId === 'external-asset-external-a').length,
  externalAfterInsert.timeline.clips.filter((clip) => clip.videoJobId === 'external-asset-external-a').length,
  '刷新后必须保留人工插入的外部素材',
);

const editedJob = await workspace.start({
  projectId: 'p1', scriptDraftId: 'script-1', shotSetId: 'set-a', editedNarrationText: '改写第一句。\n改写第二句！',
  selectedMaterialKeys: ['module4:v1'], count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1,
});
assert.deepEqual(synthesizedNarrations.at(-1), ['改写第一句。', '改写第二句！'], 'TTS 必须使用用户编辑后的任务脚本');
const editedGroup = workspace.load(editedJob.groupId);
assert.equal(editedGroup.script.syncState, 'modified');
assert.deepEqual(editedGroup.script.selectedMaterialKeys, ['module4:v1']);
assert.equal(editedGroup.script.narrationConfig.voice, 'Cherry');
db.prepare(`UPDATE final_edit_tts_providers SET apiKey='must-not-leak' WHERE id='vapi-qwen3-tts'`).run();
assert.doesNotMatch(JSON.stringify(workspace.load(editedJob.groupId)), /must-not-leak/, 'group read model 不得泄漏供应商密钥');

const storedJobSnapshot = JSON.parse((db.prepare(`SELECT inputSnapshotJson FROM final_edit_jobs WHERE id=?`).get(editedJob.id) as { inputSnapshotJson: string }).inputSnapshotJson) as { scriptSnapshot?: { editedNarrationText?: string } };
assert.equal(storedJobSnapshot.scriptSnapshot?.editedNarrationText, '改写第一句。\n改写第二句！', 'prepare job 必须保存完整不可变脚本快照');
db.prepare(`UPDATE script_drafts SET outputJson=? WHERE id='script-1'`).run(JSON.stringify({ ...script, fullScript: '上游漂移', segments: [{ ...script.segments[0], narration: '上游漂移', subtitle: '上游漂移' }] }));
db.prepare(`UPDATE final_edit_groups SET narrationAudioPath=NULL, narrationDurationUs=0, wordTimingsJson='[]', subtitleStateJson='[]' WHERE id=?`).run(editedJob.groupId);
db.prepare(`UPDATE final_edit_jobs SET status='queued', phase='analyzing', progress=0 WHERE id=?`).run(editedJob.id);
const synthCountBeforeRecovery = synthesizedNarrations.length;
await Promise.all([workspace.resumePrepareJob(editedJob.id), workspace.resumePrepareJob(editedJob.id)]);
assert.equal(synthesizedNarrations.length, synthCountBeforeRecovery + 1, '并发恢复只能原子 claim 一次');
assert.deepEqual(synthesizedNarrations.at(-1), ['改写第一句。', '改写第二句！'], '恢复任务不得重读已漂移的 script_drafts');
assert.equal((db.prepare(`SELECT attempt FROM final_edit_jobs WHERE id=?`).get(editedJob.id) as { attempt: number }).attempt, 2);
db.prepare(`UPDATE script_drafts SET outputJson=? WHERE id='script-1'`).run(JSON.stringify(script));

db.exec(`
  CREATE TEMP TRIGGER fail_prepare_success_before_commit
  BEFORE UPDATE OF status ON final_edit_jobs
  WHEN NEW.kind='prepare' AND NEW.status='succeeded'
  BEGIN
    SELECT RAISE(ABORT, 'simulated crash before prepare commit');
  END;
`);
await assert.rejects(
  workspace.start({ projectId: 'p1', scriptDraftId: 'script-1', shotSetId: 'set-a', selectedMaterialKeys: ['module4:v1'], count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 }),
  /simulated crash before prepare commit/,
);
const interruptedPrepare = db.prepare(`SELECT id, groupId, phase, progress FROM final_edit_jobs WHERE kind='prepare' AND status='failed' ORDER BY rowid DESC LIMIT 1`).get() as { id: string; groupId: string; phase: string; progress: number };
assert.equal(interruptedPrepare.phase, 'previewing', '失败状态必须保留最后一个活动阶段');
assert.ok(interruptedPrepare.progress >= 0.8);
assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM final_edit_variants WHERE groupId=?`).get(interruptedPrepare.groupId) as { count: number }).count, 0, '成功状态未提交时 variants 也必须回滚');
assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM final_edit_usage WHERE groupId=?`).get(interruptedPrepare.groupId) as { count: number }).count, 0, '成功状态未提交时 usage 也必须回滚');
db.exec(`DROP TRIGGER fail_prepare_success_before_commit`);
db.prepare(`UPDATE final_edit_jobs SET status='queued', errorCode=NULL, errorMessage=NULL, finishedAt=NULL WHERE id=?`).run(interruptedPrepare.id);
const previewsBeforeRecovery = warmedPreviewPaths.length;
const failedPreviewPath = warmedPreviewPaths.at(-1);
await workspace.resumePrepareJob(interruptedPrepare.id);
const recoveredPrepare = db.prepare(`SELECT status, phase, progress FROM final_edit_jobs WHERE id=?`).get(interruptedPrepare.id) as { status: string; phase: string; progress: number };
assert.deepEqual(recoveredPrepare, { status: 'succeeded', phase: 'succeeded', progress: 1 });
assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM final_edit_variants WHERE groupId=?`).get(interruptedPrepare.groupId) as { count: number }).count, 1, '故障窗口恢复后只能产生一份 variant');
assert.equal(warmedPreviewPaths.length, previewsBeforeRecovery + 1, '恢复会复用同一预览缓存路径');
assert.equal(warmedPreviewPaths.at(-1), failedPreviewPath, '故障恢复必须命中同一个确定性预览路径');

db.exec(`
  CREATE TEMP TRIGGER fail_changed_source_prepare_success
  BEFORE UPDATE OF status ON final_edit_jobs
  WHEN NEW.kind='prepare' AND NEW.status='succeeded'
  BEGIN
    SELECT RAISE(ABORT, 'simulated crash before changed-source commit');
  END;
`);
await assert.rejects(
  workspace.start({ projectId: 'p1', scriptDraftId: 'script-1', shotSetId: 'set-a', selectedMaterialKeys: ['module4:v1'], count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 }),
  /simulated crash before changed-source commit/,
);
const changedSourcePrepare = db.prepare(`SELECT id FROM final_edit_jobs WHERE kind='prepare' AND status='failed' ORDER BY rowid DESC LIMIT 1`).get() as { id: string };
const stalePreviewPath = warmedPreviewPaths.at(-1);
const v1Path = path.join(storageRoot, 'videos', 'v1.mp4');
const originalV1Bytes = fs.readFileSync(v1Path);
const originalV1Fingerprint = (db.prepare(`SELECT fileFingerprint FROM final_edit_asset_analysis WHERE videoJobId='v1'`).get() as { fileFingerprint: string }).fileFingerprint;
fs.writeFileSync(v1Path, 'video-v1-replaced-after-preview');
db.exec(`DROP TRIGGER fail_changed_source_prepare_success`);
db.prepare(`UPDATE final_edit_jobs SET status='queued', errorCode=NULL, errorMessage=NULL, finishedAt=NULL WHERE id=?`).run(changedSourcePrepare.id);
await workspace.resumePrepareJob(changedSourcePrepare.id);
assert.notEqual(warmedPreviewPaths.at(-1), stalePreviewPath, '源素材 fingerprint 改变后恢复不得复用旧预览缓存');
fs.writeFileSync(v1Path, originalV1Bytes);
db.prepare(`UPDATE final_edit_asset_analysis SET fileFingerprint=? WHERE videoJobId='v1'`).run(originalV1Fingerprint);

const manualJob = await workspace.start({
  projectId: 'p1', scriptDraftId: '', shotSetId: 'set-a', editedNarrationText: '手工文案。', selectedMaterialKeys: ['module4:v1'],
  count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1,
});
assert.equal(workspace.load(manualJob.groupId).script.sourceDraftId, null, '手工文案不得伪造 script_drafts 行');
const readyManualGroup = workspace.load(manualJob.groupId);
assert.throws(
  () => workspace.apply({ scope: 'group', groupId: manualJob.groupId, expectedRevision: readyManualGroup.revision, type: 'set_mixcut_script_state', editedNarrationText: '不得改写已生成组', selectedMaterialKeys: [], voice: 'Cherry', speed: 1 }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'draft_not_editable' && error.status === 409,
  '已有音频/字幕/variant 的非 editing group 不得再改脚本状态',
);
const playbackAdjustedGroup = workspace.apply({
  scope: 'group', groupId: readyManualGroup.id, expectedRevision: readyManualGroup.revision,
  type: 'set_narration_playback_rate', playbackRate: 1.3,
}).view as typeof readyManualGroup;
assert.equal(playbackAdjustedGroup.id, readyManualGroup.id, '直接调速必须更新当前成片组，不能创建新版本');
assert.equal(playbackAdjustedGroup.script.narrationConfig.speed, 1, '生成阶段的 TTS 语速必须保持不变');
assert.equal(playbackAdjustedGroup.script.narrationConfig.playbackRate, 1.3, '当前音轨播放倍速必须持久化');
assert.ok(Math.abs(playbackAdjustedGroup.totalDurationUs - (833_333 + readyManualGroup.narrationDurationUs / 1.3)) < 1, '当前成片预计时长必须随音轨播放倍速直接变化');
assert.equal(playbackAdjustedGroup.variants.length, readyManualGroup.variants.length, '直接调速不得新增或删除成片草稿');
assert.throws(
  () => workspace.apply({ scope: 'group', groupId: readyManualGroup.id, expectedRevision: playbackAdjustedGroup.revision, type: 'set_narration_playback_rate', playbackRate: 2.1 }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'invalid_narration_playback_rate',
  '音轨播放倍速仍必须限制在 0.5x～2.0x',
);
const beforeScriptCommand = workspace.load(editingDraft.id);
const scriptCommandResult = workspace.apply({ scope: 'group', groupId: editingDraft.id, expectedRevision: beforeScriptCommand.revision, type: 'set_mixcut_script_state', editedNarrationText: '手工文案已修改。', selectedMaterialKeys: ['module4:v1'], voice: 'Cherry', speed: 1.1 }).view as typeof beforeScriptCommand;
assert.equal(scriptCommandResult.script.editedNarrationText, '手工文案已修改。');
assert.throws(
  () => workspace.apply({ scope: 'group', groupId: editingDraft.id, expectedRevision: beforeScriptCommand.revision, type: 'set_mixcut_script_state', editedNarrationText: '冲突覆盖', selectedMaterialKeys: ['module4:v1'], voice: 'Cherry', speed: 1 }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'revision_conflict' && error.status === 409,
);

const first = group.variants[0];
const deleteResult = workspace.apply({
  scope: 'variant', variantId: first.id, expectedRevision: first.revision,
  type: 'delete_clip', clipId: first.timeline.clips[0].id,
});
assert.ok((deleteResult.view as FinalEditVariantView).issues.some((issue) => issue.code === 'timeline_gap' && issue.severity === 'blocking'));

assert.throws(() => workspace.apply({
  scope: 'variant', variantId: first.id, expectedRevision: first.revision,
  type: 'set_bgm_gain', gainDb: -18,
}), (error: unknown) => error instanceof FinalEditError && error.code === 'revision_conflict');

await assert.rejects(
  workspace.enqueueRender({ groupId: group.id, variantId: first.id, expectedGroupRevision: group.revision, expectedVariantRevision: deleteResult.view.revision, overlayBundleId: 'missing' }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'timeline_gap',
);

const restored = workspace.apply({ scope: 'variant', variantId: first.id, expectedRevision: deleteResult.view.revision, type: 'restore_revision', revision: 0 });
assert.equal((restored.view as FinalEditVariantView).issues.some((issue) => issue.code === 'timeline_gap'), false);

const restoredVariant = restored.view as FinalEditVariantView;
db.prepare(`UPDATE final_edit_variants SET coverJson=? WHERE id=?`).run(JSON.stringify({ ...restoredVariant.cover, coverKey: 'image:img-s1', kind: 'storyboard_image', sourceKey: undefined, sourceUrl: '/api/final-edit-groups/test/cover-candidates/image%3Aimg-s1' }), restoredVariant.id);
db.prepare(`INSERT INTO final_edit_overlay_bundles (id, groupId, outputPreset, groupRevision, specHash, manifestJson, relativeDir, status, createdAt) VALUES ('export-identity-bundle', ?, '3x4', ?, 'export-identity', '{}', 'final-edits/test/export-overlays', 'ready', datetime('now'))`).run(group.id, group.revision);
const exportReady = workspace.load(group.id);
const exportReadyVariant = exportReady.variants.find((variant) => variant.id === restoredVariant.id)!;
const renderJob = await workspace.enqueueRender({ groupId: group.id, variantId: exportReadyVariant.id, expectedGroupRevision: exportReady.revision, expectedVariantRevision: exportReadyVariant.revision, overlayBundleId: 'export-identity-bundle' });
assert.equal(renderJob.target.taskName, '沙发任务');
assert.equal(renderJob.target.productCode, 'SF-A1');
assert.equal(renderJob.target.taskDate, '20260724');
assert.equal(renderJob.target.videoFilename, '成片-SF-A1-20260724.mp4');
assert.equal(renderJob.target.displayDirectory, '工作台/沙发任务/成片/');
const renderSnapshot = JSON.parse((db.prepare(`SELECT inputSnapshotJson FROM final_edit_jobs WHERE id=?`).get(renderJob.id) as { inputSnapshotJson: string }).inputSnapshotJson) as {
  exportIdentity: { productCode: string; taskDate: string };
  exportTarget: ReservedProjectExportTarget;
};
assert.equal(renderSnapshot.exportIdentity.productCode, 'SF-A1', '不可把 projects.model 当作型号写入快照');
assert.equal(renderSnapshot.exportIdentity.taskDate, '20260724');
releaseReservedExportTarget(storageRoot, renderSnapshot.exportTarget);
db.prepare(`UPDATE projects SET productCode='' WHERE id='p1'`).run();
await assert.rejects(
  workspace.enqueueRender({ groupId: group.id, variantId: exportReadyVariant.id, expectedGroupRevision: exportReady.revision, expectedVariantRevision: exportReadyVariant.revision, overlayBundleId: 'export-identity-bundle' }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'product_code_required',
  '空型号必须在创建 render job 前阻断',
);
db.prepare(`UPDATE projects SET productCode='SF-A1' WHERE id='p1'`).run();
db.prepare(`UPDATE final_edit_variants SET coverJson=? WHERE id=?`).run(JSON.stringify(restoredVariant.cover), restoredVariant.id);

db.prepare(`INSERT INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, format, status, scannedAt) VALUES ('missing-bgm', 'bgm/missing.mp3', 'missing-bgm-fingerprint', 10000000, 'mp3', 'ready', datetime('now'))`).run();
const withBgm = workspace.apply({ scope: 'variant', variantId: first.id, expectedRevision: restored.view.revision, type: 'set_bgm', trackId: 'missing-bgm' }).view as FinalEditVariantView;
db.prepare(`UPDATE final_edit_bgm_tracks SET status='failed' WHERE id='missing-bgm'`).run();
db.prepare(`INSERT INTO final_edit_overlay_bundles (id, groupId, outputPreset, groupRevision, specHash, manifestJson, relativeDir, status, createdAt) VALUES ('bundle-for-bgm-check', ?, '3x4', ?, 'bgm-check', '{}', 'final-edits/test/overlays', 'ready', datetime('now'))`).run(group.id, group.revision);
await assert.rejects(
  workspace.enqueueRender({ groupId: group.id, variantId: first.id, expectedGroupRevision: group.revision, expectedVariantRevision: withBgm.revision, overlayBundleId: 'bundle-for-bgm-check' }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'bgm_missing',
);

db.prepare(`INSERT INTO final_edit_bgm_tracks
  (id, relativePath, fileFingerprint, durationUs, format, status, scannedAt)
  VALUES (?, ?, ?, ?, ?, 'ready', ?)`).run(
  'bgm-readable-name',
  'bgm/轻快音乐(1).mp3',
  'fingerprint-readable-name',
  12_500_000,
  'mp3',
  new Date().toISOString(),
);
const groupWithBgm = workspace.load(group.id);
assert.deepEqual(groupWithBgm.bgmTracks, [{
  id: 'bgm-readable-name',
  filename: '轻快音乐(1).mp3',
  relativePath: 'bgm/轻快音乐(1).mp3',
  durationUs: 12_500_000,
}]);

const originalPrimarySize = group.textStyles['3x4'].coverPrimary.fontSizePx;
const styleResult = workspace.apply({
  scope: 'group', groupId: group.id, expectedRevision: group.revision, type: 'set_text_style', preset: '3x4', target: 'subtitle',
  style: { ...group.textStyles['3x4'].subtitle, fontSizePx: 64 },
});
const styledGroup = styleResult.view as typeof group;
assert.equal(styledGroup.textStyles['3x4'].subtitle.fontSizePx, 64);
assert.equal(styledGroup.textStyles['3x4'].coverPrimary.fontSizePx, originalPrimarySize);

workspace.apply({ scope: 'group', groupId: group.id, expectedRevision: styledGroup.revision, type: 'set_subtitle_cue_text', cueId: styledGroup.subtitleCues[0].id, text: '人工字幕不可覆盖' });
db.prepare(`INSERT INTO final_edit_project_settings (projectId, autoUseLimit, updatedAt) VALUES ('p1', 10, datetime('now')) ON CONFLICT(projectId) DO UPDATE SET autoUseLimit=10`).run();
const regeneratedJob = await workspace.start({ projectId: 'p1', scriptDraftId: 'script-1', count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision' });
assert.notEqual(regeneratedJob.groupId, group.id, '每次生成都必须创建独立成片组，不能向旧组继续追加');
assert.equal(workspace.load(regeneratedJob.groupId).variants.length, 1, '生成数量为 1 时，新成片组必须严格只有 1 条');
assert.equal(workspace.load(group.id).variants.length, 2, '再次生成不能改变旧成片组的条数');
assert.equal(workspace.load(group.id).subtitleCues[0].text, '人工字幕不可覆盖');
const restoredAutomatic = workspace.apply({
  scope: 'group', groupId: group.id, expectedRevision: workspace.load(group.id).revision,
  type: 'restore_automatic_subtitles',
}).view as typeof group;
assert.ok(restoredAutomatic.subtitleCues.every((cue) => cue.textSource === 'script'), '只有显式恢复自动字幕才允许替换 manual Cue');

const exactTwoFrameSplitCue = {
  id: 'exact-two-frame-split', segmentId: 'seg-exact', text: '甲乙',
  startUs: 0, endUs: 83_333, textSource: 'script', timingSource: 'aligned',
};
db.prepare(`UPDATE final_edit_groups SET subtitleStateJson=? WHERE id=?`).run(JSON.stringify([exactTwoFrameSplitCue]), group.id);
const beforeExactFrameSplit = workspace.load(group.id);
const exactFrameSplitGroup = workspace.apply({
  scope: 'group', groupId: group.id, expectedRevision: beforeExactFrameSplit.revision,
  type: 'split_subtitle_cue', cueId: exactTwoFrameSplitCue.id, splitUs: 41_667, leftText: '甲', rightText: '乙',
}).view as typeof group;
assert.deepEqual(
  exactFrameSplitGroup.subtitleCues.map((cue) => [cue.text, cue.startUs, cue.endUs]),
  [['甲', 0, 41_667], ['乙', 41_667, 83_333]],
  '两帧 Cue 必须能按精确 24fps 中间帧拆分',
);
const exactRightCue = exactFrameSplitGroup.subtitleCues[1];
const exactFrameTrimmedGroup = workspace.apply({
  scope: 'group', groupId: group.id, expectedRevision: exactFrameSplitGroup.revision,
  type: 'trim_subtitle_cue', cueId: exactRightCue.id, startUs: exactRightCue.startUs, endUs: exactRightCue.endUs,
}).view as typeof group;
assert.equal(exactFrameTrimmedGroup.subtitleCues[1].endUs - exactFrameTrimmedGroup.subtitleCues[1].startUs, 41_666, '合法的相邻帧区间必须能继续修剪保存');

const halfFrameEdgeCue = { ...exactTwoFrameSplitCue, id: 'half-frame-edge', startUs: 20_833, endUs: 62_500 };
db.prepare(`UPDATE final_edit_groups SET subtitleStateJson=? WHERE id=?`).run(JSON.stringify([halfFrameEdgeCue]), group.id);
const beforeHalfFrameSplit = workspace.load(group.id);
assert.throws(
  () => workspace.apply({
    scope: 'group', groupId: group.id, expectedRevision: beforeHalfFrameSplit.revision,
    type: 'split_subtitle_cue', cueId: halfFrameEdgeCue.id, splitUs: 20_834, leftText: '甲', rightText: '乙',
  }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'subtitle_out_of_range',
  '后端不得接受实际任一侧不足一帧的非整帧切割',
);

const legacyAutomaticCues = [
  { id: 'legacy-auto', segmentId: 'seg-1', text: '柔软 承托', startUs: 0, endUs: 1_000_000, textSource: 'script', timingSource: 'aligned' },
  { id: 'manual-text', segmentId: 'seg-1', text: '人工 文本', startUs: 1_000_000, endUs: 2_000_000, textSource: 'manual', timingSource: 'aligned' },
  { id: 'manual-timing', segmentId: 'seg-2', text: '人工 时间', startUs: 2_000_000, endUs: 3_000_000, textSource: 'script', timingSource: 'manual' },
  { id: 'manual-split', segmentId: 'seg-2', text: '人工 拆分', startUs: 3_000_000, endUs: 4_000_000, textSource: 'manual', timingSource: 'manual' },
] as const;
db.prepare(`UPDATE final_edit_groups SET subtitleStateJson=? WHERE id=?`).run(JSON.stringify(legacyAutomaticCues), group.id);
const beforeSubtitleNormalization = workspace.load(group.id);
const normalizedSubtitleGroup = workspace.apply({
  scope: 'group', groupId: group.id, expectedRevision: beforeSubtitleNormalization.revision,
  type: 'normalize_automatic_subtitles',
}).view as typeof group;
assert.equal(normalizedSubtitleGroup.revision, beforeSubtitleNormalization.revision + 1, '规范化必须作为单个原子 group revision 持久化');
const normalizedAutomaticCues = normalizedSubtitleGroup.subtitleCues.filter((cue) => cue.segmentId === 'seg-1' && cue.textSource === 'script');
assert.equal(normalizedAutomaticCues[0].id, 'legacy-auto', '规范化首段必须保留原 Cue ID');
assert.match(normalizedAutomaticCues[1].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, '后续 Cue 必须使用 uuidv4');
assert.deepEqual(
  normalizedAutomaticCues.map((cue) => [cue.text, cue.startUs, cue.endUs, cue.timingSource]),
  [
    ['柔软', 0, 500_000, 'proportional'],
    ['承托', 500_000, 1_000_000, 'proportional'],
  ],
  '符合条件的历史自动 Cue 必须保留首段 ID 并按帧边界拆分',
);
for (const manualCue of legacyAutomaticCues.slice(1)) {
  assert.deepEqual(
    normalizedSubtitleGroup.subtitleCues.find((cue) => cue.id === manualCue.id),
    manualCue,
    '人工文字、人工时间及人工拆分 Cue 必须保持不变',
  );
}
assert.deepEqual(workspace.load(group.id).subtitleCues, normalizedSubtitleGroup.subtitleCues, '重新 load 后必须保留规范化结果');
const normalizationRevision = db.prepare(`SELECT commandJson FROM final_edit_revisions WHERE scopeKind='group' AND scopeId=? AND revision=?`).get(group.id, normalizedSubtitleGroup.revision) as { commandJson: string };
assert.equal(JSON.parse(normalizationRevision.commandJson).type, 'normalize_automatic_subtitles', 'revision history 必须记录原子规范化命令');

const duplicateCover = workspace.apply({
  scope: 'variant', variantId: group.variants[1].id, expectedRevision: group.variants[1].revision,
  type: 'set_cover', coverKey: group.variants[0].cover.coverKey!,
}).view as FinalEditVariantView;
assert.ok(duplicateCover.issues.some((issue) => issue.code === 'duplicate_cover' && issue.severity === 'blocking'));
db.prepare(`INSERT INTO final_edit_proposals (id, variantId, baseRevision, kind, proposalJson, issuesJson, status, createdAt) VALUES ('stale-proposal', ?, ?, 'fill_gap', ?, '[]', 'ready', datetime('now'))`).run(duplicateCover.id, duplicateCover.revision, JSON.stringify({ timeline: duplicateCover.timeline }));
const changedAfterProposal = workspace.apply({ scope: 'variant', variantId: duplicateCover.id, expectedRevision: duplicateCover.revision, type: 'set_bgm_gain', gainDb: -20 }).view as FinalEditVariantView;
assert.throws(() => workspace.apply({ scope: 'variant', variantId: duplicateCover.id, expectedRevision: changedAfterProposal.revision, type: 'apply_proposal', proposalId: 'stale-proposal' }), (error: unknown) => error instanceof FinalEditError && error.code === 'proposal_stale');

const beforeManualCommands = workspace.load(group.id);
const commandVariant = beforeManualCommands.variants.find((variant) => variant.id === first.id)!;
assert.ok(commandVariant.timeline.clips.length >= 2);
const [leftClip, rightClip] = commandVariant.timeline.clips;
assert.throws(() => workspace.apply({
  scope: 'variant', variantId: commandVariant.id, expectedRevision: commandVariant.revision,
  type: 'move_clip', clipId: rightClip.id, timelineInFrame: leftClip.timelineInFrame,
}), (error: unknown) => error instanceof FinalEditError && error.code === 'timeline_overlap', '后端必须拒绝覆盖相邻素材的移动命令');
assert.throws(() => workspace.apply({
  scope: 'variant', variantId: commandVariant.id, expectedRevision: commandVariant.revision,
  type: 'trim_clip', clipId: leftClip.id,
  sourceInFrame: leftClip.sourceInFrame,
  sourceOutFrame: leftClip.sourceInFrame + 11,
  timelineInFrame: leftClip.timelineInFrame,
  timelineOutFrame: leftClip.timelineInFrame + 11,
}), (error: unknown) => error instanceof FinalEditError && error.code === 'source_out_of_range', '后端必须拒绝短于 0.5 秒的片段');
const swapped = workspace.apply({
  scope: 'variant', variantId: commandVariant.id, expectedRevision: commandVariant.revision,
  type: 'swap_clips', leftClipId: leftClip.id, rightClipId: rightClip.id,
}).view as FinalEditVariantView;
assert.equal(swapped.timeline.clips.find((clip) => clip.id === leftClip.id)?.timelineInFrame, rightClip.timelineInFrame);
assert.equal(swapped.timeline.clips.find((clip) => clip.id === rightClip.id)?.timelineInFrame, leftClip.timelineInFrame);

const reorderedIds = [...swapped.timeline.clips]
  .sort((left, right) => left.timelineInFrame - right.timelineInFrame)
  .map((clip) => clip.id)
  .reverse();
const reordered = workspace.apply({
  scope: 'variant', variantId: swapped.id, expectedRevision: swapped.revision,
  type: 'reorder_clips', orderedClipIds: reorderedIds,
}).view as FinalEditVariantView;
assert.equal(reordered.revision, swapped.revision + 1, '任意片段排序必须只提交一个原子 revision');
assert.deepEqual(
  [...reordered.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame).map((clip) => clip.id),
  reorderedIds,
);
assert.deepEqual(
  [...workspace.load(group.id).variants.find((variant) => variant.id === reordered.id)!.timeline.clips]
    .sort((left, right) => left.timelineInFrame - right.timelineInFrame)
    .map((clip) => clip.id),
  reorderedIds,
  '刷新重新 load 后必须保留片段顺序',
);
assert.throws(() => workspace.apply({
  scope: 'variant', variantId: reordered.id, expectedRevision: reordered.revision,
  type: 'reorder_clips', orderedClipIds: [reorderedIds[0], reorderedIds[0]],
}), (error: unknown) => error instanceof FinalEditError && error.code === 'invalid_clip_order');

const framedCover = workspace.apply({
  scope: 'variant', variantId: reordered.id, expectedRevision: reordered.revision,
  type: 'set_cover_framing', scale: 1.25, offsetX: 0.2, offsetY: -0.15,
}).view as FinalEditVariantView;
assert.deepEqual(framedCover.cover.framing, { scale: 1.25, offsetX: 0.2, offsetY: -0.15 });
const fadedBgm = workspace.apply({
  scope: 'variant', variantId: framedCover.id, expectedRevision: framedCover.revision,
  type: 'set_bgm_fades', fadeInSec: 1.25, fadeOutSec: 2.5,
}).view as FinalEditVariantView;
assert.deepEqual(
  { fadeInSec: fadedBgm.bgm.fadeInSec, fadeOutSec: fadedBgm.bgm.fadeOutSec },
  { fadeInSec: 1.25, fadeOutSec: 2.5 },
);
const reloadedFades = workspace.load(group.id).variants.find((variant) => variant.id === fadedBgm.id)!.bgm;
assert.deepEqual(
  { fadeInSec: reloadedFades.fadeInSec, fadeOutSec: reloadedFades.fadeOutSec },
  { fadeInSec: 1.25, fadeOutSec: 2.5 },
  '刷新重新 load 后必须保留 BGM 淡入淡出',
);

const beforeCoverApply = workspace.load(group.id);
const coverVariant = beforeCoverApply.variants.find((variant) => variant.id === fadedBgm.id)!;
const coverSource = beforeCoverApply.assets[0];
const coverApplied = workspace.apply({
  scope: 'group', groupId: beforeCoverApply.id, expectedRevision: beforeCoverApply.revision,
  type: 'apply_cover_editor', variantId: coverVariant.id, expectedVariantRevision: coverVariant.revision,
  draft: {
    sourceKey: coverSource.videoJobId,
    frameTimeUs: 400_000,
    framing: { scale: 1.4, offsetX: 0.2, offsetY: -0.3 },
    primary: { text: '主标题\n单行', style: { ...beforeCoverApply.textStyles['3x4'].coverPrimary, italic: true, x: 0.42, stroke: { enabled: true, color: '#ff0000', widthPx: 6 } } },
    secondary: { text: '副标题', style: { ...beforeCoverApply.textStyles['3x4'].coverSecondary, italic: false, x: 0.61, stroke: { enabled: true, color: '#00ff00', widthPx: 2 } } },
  },
}).view as typeof group;
const appliedCoverVariant = coverApplied.variants.find((variant) => variant.id === coverVariant.id)!;
assert.equal(coverApplied.revision, beforeCoverApply.revision + 1, '应用封面必须只增加一次 group revision');
assert.equal(appliedCoverVariant.revision, coverVariant.revision + 1, '应用封面必须在同一事务增加一次 variant revision');
assert.equal(coverApplied.coverTitle.primary.text, '主标题单行', '标题换行必须在服务端清除');
assert.equal(coverApplied.textStyles['3x4'].coverPrimary.italic, true);
assert.equal(appliedCoverVariant.cover.sourceKey, `module4:${coverSource.videoJobId}`);
assert.equal(appliedCoverVariant.cover.frameTimeUs, 375_000, '封面时间必须落到 24fps 的确定性帧桶');
assert.deepEqual(appliedCoverVariant.cover.framing, { scale: 1.4, offsetX: 0.2, offsetY: -0.3 });
assert.deepEqual(
  appliedCoverVariant.issues.filter((issue) => !['cover_missing', 'duplicate_cover', 'high_overlap'].includes(issue.code)).map((issue) => issue.code),
  coverVariant.issues.filter((issue) => !['cover_missing', 'duplicate_cover', 'high_overlap'].includes(issue.code)).map((issue) => issue.code),
  '应用封面只能更新封面相关诊断，不得清空语义、对齐或素材警告',
);
const afterAtomicCover = workspace.load(group.id);
assert.throws(() => workspace.apply({
  scope: 'group', groupId: beforeCoverApply.id, expectedRevision: beforeCoverApply.revision,
  type: 'apply_cover_editor', variantId: coverVariant.id, expectedVariantRevision: coverVariant.revision,
  draft: {
    sourceKey: coverSource.videoJobId, frameTimeUs: 800_000, framing: { scale: 1, offsetX: 0, offsetY: 0 },
    primary: { text: '不应写入', style: beforeCoverApply.textStyles['3x4'].coverPrimary },
    secondary: { text: '不应写入', style: beforeCoverApply.textStyles['3x4'].coverSecondary },
  },
}), (error: unknown) => error instanceof FinalEditError && error.code === 'revision_conflict');
assert.deepEqual(workspace.load(group.id), afterAtomicCover, '任一 revision 过期时不得产生半写入');

const beforeSubtitleCommands = workspace.load(group.id);
const cueToReplace = beforeSubtitleCommands.subtitleCues.at(-1)!;
const withoutCue = workspace.apply({
  scope: 'group', groupId: group.id, expectedRevision: beforeSubtitleCommands.revision,
  type: 'delete_subtitle_cue', cueId: cueToReplace.id,
}).view as typeof group;
const insertedCueGroup = workspace.apply({
  scope: 'group', groupId: group.id, expectedRevision: withoutCue.revision,
  type: 'insert_subtitle_cue', segmentId: cueToReplace.segmentId, text: '补充字幕', startUs: cueToReplace.startUs, endUs: cueToReplace.endUs,
}).view as typeof group;
const insertedCue = insertedCueGroup.subtitleCues.find((cue) => cue.text === '补充字幕')!;
assert.ok(insertedCue);
const trimmedCueGroup = workspace.apply({
  scope: 'group', groupId: group.id, expectedRevision: insertedCueGroup.revision,
  type: 'trim_subtitle_cue', cueId: insertedCue.id, startUs: insertedCue.startUs + 50_000, endUs: insertedCue.endUs,
}).view as typeof group;
assert.equal(trimmedCueGroup.subtitleCues.find((cue) => cue.id === insertedCue.id)?.startUs, insertedCue.startUs + 50_000);
const resetStyleGroup = workspace.apply({
  scope: 'group', groupId: group.id, expectedRevision: trimmedCueGroup.revision,
  type: 'reset_text_style', preset: '3x4', target: 'subtitle',
}).view as typeof group;
assert.equal(resetStyleGroup.textStyles['3x4'].subtitle.fontSizePx, 56);

const beforeChangedCoverSource = workspace.load(group.id);
const changedSourceVariant = beforeChangedCoverSource.variants[0];
fs.writeFileSync(path.join(storageRoot, 'videos', 'v1.mp4'), 'video-v1-has-changed');
assert.throws(() => workspace.apply({
  scope: 'group', groupId: group.id, expectedRevision: beforeChangedCoverSource.revision,
  type: 'apply_cover_editor', variantId: changedSourceVariant.id, expectedVariantRevision: changedSourceVariant.revision,
  draft: {
    sourceKey: 'module4:v1', frameTimeUs: 500_000, framing: { scale: 1, offsetX: 0, offsetY: 0 },
    primary: { text: '文件变化后不能保存', style: beforeChangedCoverSource.textStyles['3x4'].coverPrimary },
    secondary: { text: '仍应保持原状态', style: beforeChangedCoverSource.textStyles['3x4'].coverSecondary },
  },
}), (error: unknown) => error instanceof FinalEditError && error.code === 'source_fingerprint_changed', '来源文件变化后 apply 必须复用抽帧级别的完整指纹校验');
assert.deepEqual(workspace.load(group.id), beforeChangedCoverSource, '来源文件失效时不得写入任何 group 或 variant 状态');

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('final-edit workspace tests passed');
