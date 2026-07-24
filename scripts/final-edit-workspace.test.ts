import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FinalEditVariantView } from '../lib/final-edit/types.ts';

const {
  createFinalEditWorkspace,
  FinalEditError,
  MIXCUT_PREPARE_PHASE_RANGES,
} = await import('../lib/final-edit/workspace.ts');
const { initFinalEditSchema } = await import('../lib/final-edit/schema.ts');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-final-edit-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(path.join(storageRoot, 'videos'), { recursive: true });

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, finalEditAutoUseLimit INTEGER DEFAULT 2);
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

db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '沙发')`).run();
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
  platform: '小红书', tone: '温柔', targetDurationSec: 15, template: '种草', shotSetId: 'set-a',
  sellingPointMap: [], droppedShots: [], fullScript: '第一段第二段',
  segments: [
    { id: 'seg-1', shotId: 's1', imageAssetId: 'img-s1', narration: '第一段', subtitle: '第一段', rationale: '' },
    { id: 'seg-2', shotId: 's2', imageAssetId: 'img-s2', narration: '第二段', subtitle: '第二段', rationale: '' },
  ],
};
db.prepare(`INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson) VALUES ('script-1', 'p1', 'fake', 'fake', '{}', ?)`).run(JSON.stringify(script));

const synthesizedNarrations: string[][] = [];
const warmedPreviewPaths: string[] = [];
let semanticScoreCalls = 0;
const analysisFailures = new Set<string>();
let degradeAlignment = false;
let analyzeVideoCalls = 0;
let failPreview = false;
let failSemanticScore = false;
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
  synthesize: async ({ segments }) => {
    synthesizedNarrations.push(segments.map((segment) => segment.narration));
    return ({
    relativePath: 'final-edits/test/narration.wav',
    durationUs: 18_500_000,
    segmentTimings: segments.map((segment, index) => ({
      segmentId: segment.segmentId,
      startUs: Math.round(index * 18_500_000 / segments.length),
      endUs: Math.round((index + 1) * 18_500_000 / segments.length),
    })),
    wordTimings: segments.map((segment, index) => ({
      text: segment.narration,
      startUs: Math.round(index * 18_500_000 / segments.length),
      endUs: Math.round((index + 1) * 18_500_000 / segments.length),
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
await workspace.start(fallbackInput);
assert.equal(semanticScoreCalls, fallbackCallsBefore + 1, '有效的 fallback 矩阵也必须缓存，重复输入不得再次调用 LLM');
failSemanticScore = false;
assert.deepEqual(MIXCUT_PREPARE_PHASE_RANGES, {
  analyzing: [0, 0.3], synthesizing: [0.3, 0.55], matching: [0.55, 0.8], previewing: [0.8, 1],
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

db.prepare(`INSERT INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, format, status, scannedAt) VALUES ('missing-bgm', 'bgm/missing.mp3', 'missing-bgm-fingerprint', 10000000, 'mp3', 'ready', datetime('now'))`).run();
const withBgm = workspace.apply({ scope: 'variant', variantId: first.id, expectedRevision: restored.view.revision, type: 'set_bgm', trackId: 'missing-bgm' }).view as FinalEditVariantView;
db.prepare(`UPDATE final_edit_bgm_tracks SET status='failed' WHERE id='missing-bgm'`).run();
db.prepare(`INSERT INTO final_edit_overlay_bundles (id, groupId, outputPreset, groupRevision, specHash, manifestJson, relativeDir, status, createdAt) VALUES ('bundle-for-bgm-check', ?, '3x4', ?, 'bgm-check', '{}', 'final-edits/test/overlays', 'ready', datetime('now'))`).run(group.id, group.revision);
await assert.rejects(
  workspace.enqueueRender({ groupId: group.id, variantId: first.id, expectedGroupRevision: group.revision, expectedVariantRevision: withBgm.revision, overlayBundleId: 'bundle-for-bgm-check' }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'bgm_missing',
);

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
const swapped = workspace.apply({
  scope: 'variant', variantId: commandVariant.id, expectedRevision: commandVariant.revision,
  type: 'swap_clips', leftClipId: leftClip.id, rightClipId: rightClip.id,
}).view as FinalEditVariantView;
assert.equal(swapped.timeline.clips.find((clip) => clip.id === leftClip.id)?.timelineInFrame, rightClip.timelineInFrame);
assert.equal(swapped.timeline.clips.find((clip) => clip.id === rightClip.id)?.timelineInFrame, leftClip.timelineInFrame);

const framedCover = workspace.apply({
  scope: 'variant', variantId: swapped.id, expectedRevision: swapped.revision,
  type: 'set_cover_framing', scale: 1.25, offsetX: 0.2, offsetY: -0.15,
}).view as FinalEditVariantView;
assert.deepEqual(framedCover.cover.framing, { scale: 1.25, offsetX: 0.2, offsetY: -0.15 });

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

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('final-edit workspace tests passed');
