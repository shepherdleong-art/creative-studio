import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runFfmpeg } from '../lib/ffmpeg.ts';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-opening-test-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = tempRoot;

const { BATCH_SCHEMA_MIGRATIONS } = await import('../lib/batch-production/schema.ts');
const { allocateBatch } = await import('../lib/batch-production/allocator.ts');
type FrozenBatchInput = import('../lib/batch-production/allocator.ts').FrozenBatchInput;
const { registerModule4Video, registerManagedCopy } = await import('../lib/batch-production/media-catalog.ts');

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');

// 建立核心依赖表
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE image_assets (id TEXT PRIMARY KEY, filepath TEXT NOT NULL);
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE shots (
    id TEXT PRIMARY KEY,
    shotSetId TEXT NOT NULL,
    indexNum INTEGER NOT NULL,
    sourceImageId TEXT NOT NULL
  );
  CREATE TABLE video_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL);
  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    shotSetId TEXT,
    shotId TEXT,
    sourceImageId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    durationSec INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'pending',
    localVideoPath TEXT,
    filename TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS batch_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL);
`);

for (const migration of BATCH_SCHEMA_MIGRATIONS) {
  db.exec(migration.sql);
  db.prepare(`INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (?, ?)`).run(migration.version, new Date().toISOString());
}

const projectId = 'proj-opening-test';
db.prepare(`INSERT INTO projects (id, name) VALUES (?, ?)`).run(projectId, '开场测试项目');
db.prepare(`INSERT INTO image_assets (id, filepath) VALUES ('img-1', 'test.jpg')`).run();
db.prepare(`INSERT INTO video_providers (id, name, type) VALUES ('prov-1', 'Provider 1', 'kling')`).run();
db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('set-1', ?, '分镜组1')`).run(projectId);

// 创建两个分镜：shot1 为开场（indexNum=1），shot2 为正文（indexNum=2）
db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId) VALUES ('shot-1', 'set-1', 1, 'img-1')`).run();
db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId) VALUES ('shot-2', 'set-1', 2, 'img-1')`).run();

// 写入一个真实合法的微型 mp4 视频文件到 storage
const testStorageDir = path.join(tempRoot, 'storage', 'videos');
fs.mkdirSync(testStorageDir, { recursive: true });
const dummyVideoPath = path.join(testStorageDir, 'test-dummy.mp4');
await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:duration=0.5:size=64x64:rate=12', '-pix_fmt', 'yuv420p', '-y', dummyVideoPath]);

// 插入两条已成功的 video_jobs
db.prepare(`
  INSERT INTO video_jobs (id, projectId, shotSetId, shotId, sourceImageId, providerId, model, prompt, status, localVideoPath, filename)
  VALUES ('job-1', ?, 'set-1', 'shot-1', 'img-1', 'prov-1', 'kling', 'prompt1', 'succeeded', 'videos/test-dummy.mp4', 'opening-video.mp4')
`).run(projectId);

db.prepare(`
  INSERT INTO video_jobs (id, projectId, shotSetId, shotId, sourceImageId, providerId, model, prompt, status, localVideoPath, filename)
  VALUES ('job-2', ?, 'set-1', 'shot-2', 'img-1', 'prov-1', 'kling', 'prompt2', 'succeeded', 'videos/test-dummy.mp4', 'body-video.mp4')
`).run(projectId);

console.log('✓ 1. 测试 registerModule4Video 自动按分镜序号识别角色并归库');
// 登记 job-1（开场分镜）
const reg1 = await registerModule4Video(db, { videoJobId: 'job-1' });
const asset1 = db.prepare(`SELECT mediaJson FROM batch_assets WHERE id = ?`).get(reg1.assetId) as { mediaJson: string };
const media1 = JSON.parse(asset1.mediaJson);
assert.equal(media1.role, 'opening', 'shot.indexNum===1 应自动归入 opening 角色');

// 登记 job-2（正文分镜）
const reg2 = await registerModule4Video(db, { videoJobId: 'job-2' });
const asset2 = db.prepare(`SELECT mediaJson FROM batch_assets WHERE id = ?`).get(reg2.assetId) as { mediaJson: string };
const media2 = JSON.parse(asset2.mediaJson);
assert.equal(media2.role, 'body', 'shot.indexNum!==1 应自动归入 body 角色');

// 幂等性测试：再次登记同一任务不抛错，角色保持
const reg1Again = await registerModule4Video(db, { videoJobId: 'job-1' });
assert.equal(reg1Again.assetId, reg1.assetId);

console.log('✓ 2. 测试 registerManagedCopy 导入指定角色');
const uploadDummy = path.join(tempRoot, 'upload-temp.mp4');
await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=green:duration=0.5:size=64x64:rate=12', '-pix_fmt', 'yuv420p', '-y', uploadDummy]);
const managedOpeningId = await registerManagedCopy(db, projectId, {
  sourcePath: uploadDummy,
  displayName: '手选开场.mp4',
  role: 'opening',
});
const managedAsset = db.prepare(`SELECT mediaJson FROM batch_assets WHERE id = ?`).get(managedOpeningId) as { mediaJson: string };
assert.equal(JSON.parse(managedAsset.mediaJson).role, 'opening');

console.log('✓ 3. 测试 allocateBatch 分配器首镜优先从开场库分散分配');
// 准备测试数据：4 个开场素材（O1, O2, O3, O4）与 4 个正文素材（B1, B2, B3, B4）
function makeAsset(id: string, role: 'opening' | 'body', durationUs: number = 8_000_000) {
  return {
    assetId: id,
    analysisId: `an-${id}`,
    contentFingerprint: `fp-${id}`,
    sourceGroupKey: `group-${id}`,
    durationUs,
    role,
    analysisJson: {
      durationUs,
      usableRanges: [{ startUs: 0, endUs: durationUs, qualityScore: 1 }],
      scenes: [{ startUs: 0, endUs: durationUs, qualityScore: 1 }],
    },
    excluded: false,
  };
}

const inputAssets = [
  makeAsset('O1', 'opening'),
  makeAsset('O2', 'opening'),
  makeAsset('O3', 'opening'),
  makeAsset('O4', 'opening'),
  makeAsset('B1', 'body'),
  makeAsset('B2', 'body'),
  makeAsset('B3', 'body'),
  makeAsset('B4', 'body'),
];

// 4 条成片计划，每条 2 个镜头：第一镜（开场）、第二镜（正文）
const frozenInput: FrozenBatchInput = {
  batchVersionId: 'v-test',
  seed: 'test-seed-123',
  assets: inputAssets,
  plans: [
    {
      planId: 'plan-1',
      segments: [
        { id: 'p1-s1', startUs: 0, endUs: 3_000_000, text: '开场引语一' },
        { id: 'p1-s2', startUs: 3_000_000, endUs: 6_000_000, text: '正文卖点一' },
      ],
      coverAssetIds: [],
      musicTrackIds: [],
    },
    {
      planId: 'plan-2',
      segments: [
        { id: 'p2-s1', startUs: 0, endUs: 3_000_000, text: '开场引语二' },
        { id: 'p2-s2', startUs: 3_000_000, endUs: 6_000_000, text: '正文卖点二' },
      ],
      coverAssetIds: [],
      musicTrackIds: [],
    },
    {
      planId: 'plan-3',
      segments: [
        { id: 'p3-s1', startUs: 0, endUs: 3_000_000, text: '开场引语三' },
        { id: 'p3-s2', startUs: 3_000_000, endUs: 6_000_000, text: '正文卖点三' },
      ],
      coverAssetIds: [],
      musicTrackIds: [],
    },
    {
      planId: 'plan-4',
      segments: [
        { id: 'p4-s1', startUs: 0, endUs: 3_000_000, text: '开场引语四' },
        { id: 'p4-s2', startUs: 3_000_000, endUs: 6_000_000, text: '正文卖点四' },
      ],
      coverAssetIds: [],
      musicTrackIds: [],
    },
  ],
};

const allocation = allocateBatch(frozenInput);
assert.equal(allocation.status, 'completed');

const openingClips = allocation.plans.map((p) => p.arrangement.clips[0]);
console.log('分配结果首镜所用素材:', openingClips.map((c) => c.assetId));

// 验证所有首镜均取自开场素材库（O1～O4）
for (const clip of openingClips) {
  assert.ok(['O1', 'O2', 'O3', 'O4'].includes(clip.assetId), `首镜应取自开场素材库，实际取到 ${clip.assetId}`);
}

// 验证分散轮换分配：4 条成片的开场素材应互不相同（覆盖全部 4 个可用开场）
const uniqueOpenings = new Set(openingClips.map((c) => c.assetId));
assert.equal(uniqueOpenings.size, 4, '4 条成片的首镜应分散取用全部 4 个不同开场素材，避免撞车');

// 验证第二镜优先使用正文素材库（B1～B4）
const bodyClips = allocation.plans.map((p) => p.arrangement.clips[1]);
console.log('分配结果正文所用素材:', bodyClips.map((c) => c.assetId));
for (const clip of bodyClips) {
  assert.ok(['B1', 'B2', 'B3', 'B4'].includes(clip.assetId), `正文镜应优先取自正文素材库，实际取到 ${clip.assetId}`);
}

console.log('✓ 4. 测试开场库为空时的降级');
const emptyOpeningInput: FrozenBatchInput = {
  ...frozenInput,
  assets: inputAssets.filter((a) => a.role === 'body'),
};
const fallbackAllocation = allocateBatch(emptyOpeningInput);
assert.equal(fallbackAllocation.status, 'completed');
for (const plan of fallbackAllocation.plans) {
  assert.ok(['B1', 'B2', 'B3', 'B4'].includes(plan.arrangement.clips[0].assetId), '开场库为空时自然降级到正文素材');
}

console.log('✓ All opening library and allocation tests passed');
