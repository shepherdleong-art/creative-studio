import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { materializeCoverFrame, CoverFrameError } from '../lib/final-edit/cover-frame.ts';
import { initFinalEditSchema } from '../lib/final-edit/schema.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-cover-frame-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(path.join(storageRoot, 'videos'), { recursive: true });

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, shotSetId TEXT,
    status TEXT NOT NULL, localVideoPath TEXT
  );
`);
initFinalEditSchema(db);

function insertGroup(id: string, projectId: string, shotSetId: string) {
  db.prepare(`
    INSERT INTO final_edit_groups (
      id, projectId, scriptDraftId, shotSetId, scriptSnapshotJson, narrationHash,
      narrationConfigJson, coverTitleJson, textStylesJson, status, phase, revision,
      createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, '{}', ?, '{}', '{}', '{}', 'ready', 'ready', 0, ?, ?)
  `).run(id, projectId, `draft-${id}`, shotSetId, `hash-${id}`, '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z');
}

insertGroup('group-a', 'project-a', 'set-a');
insertGroup('group-b', 'project-a', 'set-b');

const moduleVideo = path.join(storageRoot, 'videos', 'module.mp4');
await runFfmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=640x360:rate=24',
  '-pix_fmt', 'yuv420p', '-y', moduleVideo,
]);
let moduleFingerprint = crypto.createHash('sha256').update(fs.readFileSync(moduleVideo)).digest('hex');
db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, status, localVideoPath) VALUES ('video-a', 'project-a', 'set-a', 'succeeded', ?)`).run(moduleVideo);
db.prepare(`
  INSERT INTO final_edit_asset_analysis (
    videoJobId, shotSetId, fileFingerprint, providerId, model, analyzerVersion,
    status, mediaJson, generatedJson, updatedAt
  ) VALUES ('video-a', 'set-a', ?, 'test', 'test', '2', 'succeeded', ?, '{}', ?)
`).run(moduleFingerprint, JSON.stringify({ durationUs: 2_000_000, fps: 24, width: 640, height: 360 }), '2026-07-24T00:00:00.000Z');

const externalRelativePath = path.join('final-edits', 'projects', 'project-a', 'groups', 'set-a', 'materials', 'external.mp4');
const externalVideo = path.join(storageRoot, externalRelativePath);
fs.mkdirSync(path.dirname(externalVideo), { recursive: true });
fs.copyFileSync(moduleVideo, externalVideo);
const externalFingerprint = crypto.createHash('sha256').update(fs.readFileSync(externalVideo)).digest('hex');
db.prepare(`
  INSERT INTO final_edit_external_assets (
    id, projectId, shotSetId, originalFilename, relativePath, mimeType, mediaKind,
    durationUs, width, height, fileFingerprint, status, createdAt
  ) VALUES ('external-a', 'project-a', 'set-a', 'external.mp4', ?, 'video/mp4', 'video',
    2000000, 640, 360, ?, 'ready', ?)
`).run(externalRelativePath, externalFingerprint, '2026-07-24T00:00:00.000Z');
db.prepare(`
  INSERT INTO final_edit_asset_analysis (
    videoJobId, shotSetId, fileFingerprint, providerId, model, analyzerVersion,
    status, mediaJson, generatedJson, updatedAt
  ) VALUES ('external-asset-external-a', 'set-a', ?, 'test', 'test', '2', 'succeeded', ?, '{}', ?)
`).run(externalFingerprint, JSON.stringify({ durationUs: 2_000_000, fps: 24, width: 640, height: 360 }), '2026-07-24T00:00:00.000Z');

const first = await materializeCoverFrame({ db, storageRoot, groupId: 'group-a', sourceKey: 'module4:video-a', timeUs: 410_000, preset: '3x4' });
assert.ok(fs.existsSync(first.absolutePath));
assert.deepEqual(fs.readFileSync(first.absolutePath).subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]), '必须输出真实 JPEG');
assert.deepEqual(await sharp(first.absolutePath).metadata().then(({ width, height, format }) => ({ width, height, format })), { width: 640, height: 360, format: 'jpeg' }, '截帧必须保留完整源画面，裁切只由共享 framing geometry 完成');
assert.equal(first.sourceKey, 'module4:video-a');
assert.equal(first.frameTimeUs, 375_000, '截帧时间必须落到 1/24 秒桶');

const sameBucket = await materializeCoverFrame({ db, storageRoot, groupId: 'group-a', sourceKey: 'video-a', timeUs: 416_000, preset: '3x4' });
assert.equal(sameBucket.relativePath, first.relativePath, '内部兼容 sourceKey 和同一 1/24 秒桶必须复用缓存');

const landscape = await materializeCoverFrame({ db, storageRoot, groupId: 'group-a', sourceKey: 'module4:video-a', timeUs: 410_000, preset: '16x9' });
assert.notEqual(landscape.relativePath, first.relativePath, '不同输出比例不得复用缓存');
assert.deepEqual(await sharp(landscape.absolutePath).metadata().then(({ width, height }) => ({ width, height })), { width: 640, height: 360 });

const portrait = await materializeCoverFrame({ db, storageRoot, groupId: 'group-a', sourceKey: 'external:external-a', timeUs: Number.POSITIVE_INFINITY, preset: '9x16' });
assert.equal(portrait.sourceKey, 'external:external-a');
assert.equal(portrait.frameTimeUs, 1_958_333, '必须 clamp 到最后一个安全帧');
assert.deepEqual(await sharp(portrait.absolutePath).metadata().then(({ width, height }) => ({ width, height })), { width: 640, height: 360 });
const externalCompat = await materializeCoverFrame({ db, storageRoot, groupId: 'group-a', sourceKey: 'external-asset-external-a', timeUs: 2_500_000, preset: '9x16' });
assert.equal(externalCompat.relativePath, portrait.relativePath, '外部素材内部兼容 key 必须归一化并 clamp 到同一缓存');

const changedVideo = path.join(root, 'changed.mp4');
await runFfmpeg([
  '-f', 'lavfi', '-i', 'color=c=blue:duration=2:size=640x360:rate=24',
  '-pix_fmt', 'yuv420p', '-y', changedVideo,
]);
fs.copyFileSync(changedVideo, moduleVideo);
moduleFingerprint = crypto.createHash('sha256').update(fs.readFileSync(moduleVideo)).digest('hex');
db.prepare(`UPDATE final_edit_asset_analysis SET fileFingerprint=? WHERE videoJobId='video-a'`).run(moduleFingerprint);
const changedFingerprint = await materializeCoverFrame({ db, storageRoot, groupId: 'group-a', sourceKey: 'module4:video-a', timeUs: 410_000, preset: '3x4' });
assert.notEqual(changedFingerprint.relativePath, first.relativePath, '源文件 fingerprint 变化必须使缓存失效');

await assert.rejects(
  materializeCoverFrame({ db, storageRoot, groupId: 'group-b', sourceKey: 'module4:video-a', timeUs: 0, preset: '3x4' }),
  (error: unknown) => error instanceof CoverFrameError && error.code === 'cover_source_not_found',
  '不得跨 shotSet 读取模块 4 素材',
);
db.prepare(`UPDATE final_edit_groups SET status='editing' WHERE id='group-a'`).run();
await assert.rejects(
  materializeCoverFrame({ db, storageRoot, groupId: 'group-a', sourceKey: 'module4:video-a', timeUs: 0, preset: '3x4' }),
  (error: unknown) => error instanceof CoverFrameError && error.code === 'cover_source_not_found',
  '只有已完成准备的成片组可以请求封面帧',
);
db.prepare(`UPDATE final_edit_groups SET status='ready' WHERE id='group-a'`).run();
db.prepare(`UPDATE video_jobs SET status='failed' WHERE id='video-a'`).run();
await assert.rejects(
  materializeCoverFrame({ db, storageRoot, groupId: 'group-a', sourceKey: 'module4:video-a', timeUs: 0, preset: '3x4' }),
  (error: unknown) => error instanceof CoverFrameError && error.code === 'cover_source_not_found',
);
db.prepare(`UPDATE video_jobs SET status='succeeded' WHERE id='video-a'`).run();

db.prepare(`UPDATE final_edit_asset_analysis SET fileFingerprint='stale' WHERE videoJobId='video-a'`).run();
await assert.rejects(
  materializeCoverFrame({ db, storageRoot, groupId: 'group-a', sourceKey: 'module4:video-a', timeUs: 0, preset: '3x4' }),
  (error: unknown) => error instanceof CoverFrameError && error.code === 'source_fingerprint_changed',
  '磁盘内容与分析指纹不一致时必须拒绝',
);
db.prepare(`UPDATE final_edit_asset_analysis SET fileFingerprint=? WHERE videoJobId='video-a'`).run(moduleFingerprint);

const outside = path.join(root, 'outside.mp4');
fs.copyFileSync(moduleVideo, outside);
db.prepare(`UPDATE video_jobs SET localVideoPath=? WHERE id='video-a'`).run(outside);
await assert.rejects(
  materializeCoverFrame({ db, storageRoot, groupId: 'group-a', sourceKey: 'video-a', timeUs: 0, preset: '3x4' }),
  (error: unknown) => error instanceof CoverFrameError && error.code === 'unsafe_path',
  '不得读取 storage 之外的路径',
);

await assert.rejects(
  materializeCoverFrame({ db, storageRoot, groupId: 'group-a', sourceKey: 'module4:video-a', timeUs: 0, preset: '1x1' as never }),
  (error: unknown) => error instanceof CoverFrameError && error.code === 'invalid_output_preset',
);

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('final-edit-cover-frame tests passed');
