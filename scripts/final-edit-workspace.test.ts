import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FinalEditVariantView } from '../lib/final-edit/types.ts';

const {
  createFinalEditWorkspace,
  FinalEditError,
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

const workspace = createFinalEditWorkspace({
  db,
  storageRoot,
  runJobsInline: true,
  probeVideo: async () => ({ durationUs: 12_000_000, width: 720, height: 960, fps: 24 }),
  analyzeVideo: async ({ videoJobId }) => ({
    summary: videoJobId === 'v1' ? '沙发全景' : '面料细节',
    sellingPoints: [], semanticTags: [], usableRanges: [{ startUs: 0, endUs: 12_000_000, qualityScore: 1 }],
    qualityIssues: [], coverFrameTimesUs: [1_000_000],
  }),
  estimateAnalysisCost: ({ requestCount }) => requestCount * 0.1,
  synthesize: async () => ({
    relativePath: 'final-edits/test/narration.wav',
    durationUs: 18_500_000,
    segmentTimings: [
      { segmentId: 'seg-1', startUs: 0, endUs: 9_000_000 },
      { segmentId: 'seg-2', startUs: 9_000_000, endUs: 18_500_000 },
    ],
    wordTimings: [{ text: '第一段', startUs: 0, endUs: 9_000_000 }, { text: '第二段', startUs: 9_000_000, endUs: 18_500_000 }],
  }),
});

const capacity = await workspace.preflight({ projectId: 'p1', scriptDraftId: 'script-1', count: 2, outputPreset: '3x4' });
assert.equal(capacity.assetCount, 2);
assert.deepEqual(capacity.videoJobIds.sort(), ['v1', 'v2']);
assert.ok(!capacity.videoJobIds.includes('foreign'));

const job = await workspace.start({
  projectId: 'p1', scriptDraftId: 'script-1', count: 2, outputPreset: '3x4',
  providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision',
});
assert.equal(job.status, 'succeeded');
assert.equal((db.prepare(`SELECT estimatedCost FROM final_edit_jobs WHERE id=?`).get(job.id) as { estimatedCost: number }).estimatedCost, 0.2);

const group = workspace.load(job.groupId);
assert.equal(group.status, 'ready');
assert.equal(group.narrationDurationUs, 18_500_000);
assert.equal(group.totalDurationUs, 19_333_333);
assert.equal(group.variants.length, 2);
assert.equal(group.assets.length, 2);
assert.ok(group.assets.every((asset) => asset.shotSetId === 'set-a'));
assert.ok(group.variants.every((variant) => variant.timeline.clips.every((clip) => clip.videoJobId !== 'foreign')));

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
await workspace.start({ projectId: 'p1', scriptDraftId: 'script-1', count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision' });
assert.equal(workspace.load(group.id).subtitleCues[0].text, '人工字幕不可覆盖');

const duplicateCover = workspace.apply({
  scope: 'variant', variantId: group.variants[1].id, expectedRevision: group.variants[1].revision,
  type: 'set_cover', coverKey: group.variants[0].cover.coverKey!,
}).view as FinalEditVariantView;
assert.ok(duplicateCover.issues.some((issue) => issue.code === 'duplicate_cover' && issue.severity === 'blocking'));
db.prepare(`INSERT INTO final_edit_proposals (id, variantId, baseRevision, kind, proposalJson, issuesJson, status, createdAt) VALUES ('stale-proposal', ?, ?, 'fill_gap', ?, '[]', 'ready', datetime('now'))`).run(duplicateCover.id, duplicateCover.revision, JSON.stringify({ timeline: duplicateCover.timeline }));
const changedAfterProposal = workspace.apply({ scope: 'variant', variantId: duplicateCover.id, expectedRevision: duplicateCover.revision, type: 'set_bgm_gain', gainDb: -20 }).view as FinalEditVariantView;
assert.throws(() => workspace.apply({ scope: 'variant', variantId: duplicateCover.id, expectedRevision: changedAfterProposal.revision, type: 'apply_proposal', proposalId: 'stale-proposal' }), (error: unknown) => error instanceof FinalEditError && error.code === 'proposal_stale');

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('final-edit workspace tests passed');
