// 运行：node scripts/packaging-stickers-workspace.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PackagingStickerInstance } from '../lib/media-core/packaging-stickers.ts';

const { createFinalEditWorkspace, FinalEditError } = await import('../lib/final-edit/workspace.ts');
const { initFinalEditSchema } = await import('../lib/final-edit/schema.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-stickers-workspace-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(path.join(storageRoot, 'videos'), { recursive: true });
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', productCode TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, exportDirName TEXT NOT NULL DEFAULT '', finalEditAutoUseLimit INTEGER DEFAULT 2);
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE shots (id TEXT PRIMARY KEY, shotSetId TEXT NOT NULL, indexNum INTEGER NOT NULL, sourceImageId TEXT NOT NULL, latestGeneratedImageId TEXT);
  CREATE TABLE image_assets (id TEXT PRIMARY KEY, projectId TEXT, filename TEXT NOT NULL, path TEXT NOT NULL, mimeType TEXT NOT NULL DEFAULT 'image/png');
  CREATE TABLE script_drafts (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, inputSnapshot TEXT NOT NULL, outputJson TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE video_jobs (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, shotSetId TEXT, shotId TEXT, sourceImageId TEXT, templateId TEXT, status TEXT NOT NULL, localVideoPath TEXT, filename TEXT, displayName TEXT, durationSec INTEGER, createdAt TEXT, prompt TEXT NOT NULL DEFAULT '');
`);
initFinalEditSchema(db);
db.prepare(`INSERT INTO projects (id, name, productCode, createdAt) VALUES ('p1', '贴纸测试', 'ST-1', '2026-10-27 10:00:00')`).run();
db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('set-a', 'p1', '场景')`).run();
const imagePath = path.join(storageRoot, 's1.png');
fs.writeFileSync(imagePath, 'image');
db.prepare(`INSERT INTO image_assets (id, projectId, filename, path) VALUES ('img-s1', 'p1', 's1.png', ?)`).run(imagePath);
db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, latestGeneratedImageId) VALUES ('s1', 'set-a', 1, 'img-s1', 'img-s1')`).run();
const videoPath = path.join(storageRoot, 'videos', 'v1.mp4');
fs.writeFileSync(videoPath, 'video');
db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, shotId, status, localVideoPath, filename, displayName, durationSec) VALUES ('v1', 'p1', 'set-a', 's1', 'succeeded', ?, 'v1.mp4', '测试素材', 12)`).run(videoPath);
const script = {
  version: 2, title: '贴纸测试', coverTitleParts: { primary: '贴纸', secondary: '测试' },
  platform: '小红书', tone: '自然', targetDurationSec: 12, template: '种草', shotSetId: 'set-a',
  sellingPointMap: [], droppedShots: [], fullScript: '第一段',
  segments: [{ id: 'seg-1', shotId: 's1', imageAssetId: 'img-s1', narration: '第一段', subtitle: '第一段', rationale: '' }],
};
db.prepare(`INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson) VALUES ('script-1', 'p1', 'fake', 'fake', '{}', ?)`).run(JSON.stringify(script));

const workspace = createFinalEditWorkspace({
  db,
  storageRoot,
  runJobsInline: true,
  probeVideo: async () => ({ durationUs: 12_000_000, width: 720, height: 960, fps: 24 }),
  analyzeVideo: async () => ({
    summary: '测试素材', sellingPoints: [], semanticTags: [],
    usableRanges: [{ startUs: 0, endUs: 12_000_000, qualityScore: 1 }],
    qualityIssues: [], coverFrameTimesUs: [1_000_000],
  }),
  scoreSemanticMatrix: async () => ({ score_matrix: [[0.95]], hook_scores: [0.8] }),
  materializeCoverFrame: async () => undefined,
  warmPreview: async ({ relativePath }) => {
    const absolutePath = path.join(storageRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    if (!fs.existsSync(absolutePath)) fs.writeFileSync(absolutePath, 'preview');
    return { relativePath };
  },
  synthesize: async () => ({
    relativePath: 'final-edits/test/narration.wav', durationUs: 12_000_000,
    segmentTimings: [{ segmentId: 'seg-1', startUs: 0, endUs: 12_000_000 }],
    wordTimings: [{ text: '第一段', startUs: 0, endUs: 12_000_000 }],
  }),
});

const sticker: PackagingStickerInstance = {
  id: 'sticker_workspace', assetId: 'highlight', styleMode: 'follow-template', fixedStyle: null,
  startFrame: 20, endFrame: 68, centerXPct: 50, centerYPct: 40, visualWidthPct: 30,
  rotationDeg: 0, trackIndex: 0, animation: 'follow-template', origin: { kind: 'manual' },
};

try {
  const job = await workspace.start({
    projectId: 'p1', scriptDraftId: 'script-1', count: 1, outputPreset: '3x4',
    providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'vision',
  });
  assert.equal(job.status, 'succeeded');
  const group = workspace.load(job.groupId);
  const variant = group.variants[0];
  const withStickers = workspace.apply({
    scope: 'group', groupId: group.id, expectedRevision: group.revision,
    type: 'set_packaging_config', variantId: variant.id,
    config: { enabled: false, template: 'overlay-poster', varsOverrides: {}, stickers: [sticker], stickerDefaults: { animation: 'soft' } },
  }).view as typeof group;
  assert.equal(withStickers.packaging.stickers?.[0]?.id, 'sticker_workspace');
  assert.deepEqual(withStickers.packaging.stickerDefaults, { animation: 'soft' });

  const cleared = workspace.apply({
    scope: 'group', groupId: withStickers.id, expectedRevision: withStickers.revision,
    type: 'set_packaging_config', variantId: variant.id,
    config: { enabled: false, template: 'overlay-poster', varsOverrides: {}, stickers: [], stickerDefaults: { animation: 'none' } },
  }).view as typeof withStickers;
  assert.deepEqual(cleared.packaging.stickers ?? [], []);

  const restored = workspace.apply({
    scope: 'group', groupId: cleared.id, expectedRevision: cleared.revision,
    type: 'restore_packaging_revision', revision: withStickers.revision,
  }).view as typeof cleared;
  assert.equal(restored.packaging.stickers?.[0]?.id, 'sticker_workspace');
  assert.deepEqual(restored.subtitleCues, cleared.subtitleCues, '恢复包装不得改写字幕');
  assert.throws(
    () => workspace.apply({
      scope: 'group', groupId: restored.id, expectedRevision: restored.revision,
      type: 'set_packaging_config', variantId: variant.id,
      config: { enabled: false, template: 'overlay-poster', varsOverrides: {}, stickers: [{ ...sticker, endFrame: variant.timeline.bodyFrames + 21 }] },
    }),
    (error: unknown) => error instanceof FinalEditError && error.code === 'sticker_out_of_range',
  );
  console.log('贴纸 workspace 测试通过：持久化、清空、独立历史恢复和正文边界。');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
