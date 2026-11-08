import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { resolveFullRenderContractHash, resolveCoverContractHash } from '../lib/batch-production/cover-contract.ts';
import { createBatchTask } from '../lib/batch-production/tasks.ts';
import {
  BATCH_NO_EXPORTED_FILMS_MESSAGE,
  buildBatchDownloadManifest,
  normalizeBatchDownloadScope,
  resolveBatchDownloadFiles,
} from '../lib/batch-production/download-manifest.ts';
import { BatchDomainError } from '../lib/batch-production/errors.ts';

/**
 * 11 号票 · 接口级验收：「本批次可下载文件清单」只含当前正式产物、按选项筛、
 * 修改未导出给上一版；ZIP 与清单共用同一个 builder（内容一致的结构性保证）。
 *
 * 这里用临时 SQLite + 真实 batch 迁移流，不启动 HTTP 服务；
 * 越权与 ZIP 路由的身份检查在 `batch-export-downloads-route.test.mjs` 里验。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-download-manifest-'));
const storageRoot = path.join(root, 'storage');
let db = null;

function writeArtifactFile(relativePath, bytes) {
  const absolute = path.join(storageRoot, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
  return { relativePath: relativePath.split(path.sep).join('/'), byteSize: bytes.length };
}

function sha256Of(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const now = '2026-11-08T02:00:00.000Z';

try {
  db = new Database(path.join(root, 'manifest.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, productCode TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT '', exportDirName TEXT NOT NULL DEFAULT '');
    INSERT INTO projects (id, name, productCode, createdAt, exportDirName) VALUES ('p1', '验收项目', 'ACC-1', '2026-11-01T00:00:00.000Z', 'ACC-1-20261101');`);
  assert.notEqual((await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') })).state, 'compatibility_only');

  db.prepare(`INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, controlState, createdAt, updatedAt)
    VALUES ('b1','p1','批次一','running','bv1','{}','running',?,?)`).run(now, now);
  db.prepare(`INSERT INTO batch_production_versions (id,batchId,versionNumber,copyCount,defaultsJson,inputState,frozenAt,createdAt)
    VALUES ('bv1','b1',1,4,'{}','frozen',?,?)`).run(now, now);
  db.prepare(`INSERT INTO batch_scripts (id,projectId,sourceKind,sourceId,title,bodyText,sourceVersion,createdAt,updatedAt)
    VALUES ('s1','p1','script_draft','src1','脚本一','正文','v1',?,?)`).run(now, now);
  db.prepare(`INSERT INTO batch_script_snapshots (id,batchVersionId,sourceScriptId,title,bodyText,sourceVersion,copyCount,createdAt)
    VALUES ('ss1','bv1','s1','脚本一','正文','v1',4,?)`).run(now);

  const insertPlan = db.prepare(`INSERT INTO batch_output_plans (id,batchVersionId,scriptSnapshotId,seq,planJson,currentVersionId,currentArtifactId,createdAt)
    VALUES (?,?,?,?,'{}',?,?,?)`);
  const insertVersion = db.prepare(`INSERT INTO batch_output_versions (id,planId,versionNumber,arrangementJson,createdAt) VALUES (?,?,?,?,?)`);
  const insertArtifact = db.prepare(`INSERT INTO batch_artifacts (id,projectId,batchId,batchVersionId,outputPlanId,outputVersionId,kind,relativePath,checksum,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  // 01 =「已导出」，02 =「改过但还没重新导出」，03 =「从没导出」，04 =「渲染失败」。
  insertPlan.run('plan-exported', 'bv1', 'ss1', 1, 'ov-exported', 'video-exported', now);
  insertPlan.run('plan-reworked', 'bv1', 'ss1', 2, 'ov-reworked', 'video-reworked', now);
  insertPlan.run('plan-never', 'bv1', 'ss1', 3, 'ov-never', null, now);
  insertPlan.run('plan-failed', 'bv1', 'ss1', 4, 'ov-failed', null, now);

  // 封面契约要求真实安排（clips + cover 指向已分析的池内素材），否则无法证明产物新鲜。
  db.prepare(`INSERT INTO batch_assets (id,projectId,sourceKind,locationJson,contentFingerprint,mediaKind,mediaJson,status,currentAnalysisId,createdAt,updatedAt)
    VALUES ('asset-a','p1','managed','{}','sha256:asset-a','video',?, 'online','analysis-a',?,?)`)
    .run(JSON.stringify({ durationSec: 6 }), now, now);
  db.prepare(`INSERT INTO batch_asset_analysis (id,assetId,analyzerVersion,providerId,model,analysisJson,status,analyzedAt,createdAt)
    VALUES ('analysis-a','asset-a','fixture','fixture','fixture',?, 'ready',?,?)`)
    .run(JSON.stringify({ durationUs: 6_000_000 }), now, now);
  db.prepare(`INSERT INTO batch_asset_pool_items (id,batchVersionId,assetId,analysisId,selectionState,createdAt)
    VALUES ('pool-a','bv1','asset-a','analysis-a','selected',?)`).run(now);
  const arrangement = {
    productionReady: true,
    preset: '3:4',
    editRevision: 0,
    clips: [{
      clipId: 'clip-1', assetId: 'asset-a', sourceStartUs: 0,
      sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000,
    }],
    cover: { assetId: 'asset-a', timeUs: 0 },
  };
  insertVersion.run('ov-exported', 'plan-exported', 1, JSON.stringify(arrangement), now);
  insertVersion.run('ov-reworked-old', 'plan-reworked', 1, JSON.stringify(arrangement), now);
  insertVersion.run('ov-reworked', 'plan-reworked', 2, JSON.stringify(arrangement), now);
  insertVersion.run('ov-never', 'plan-never', 1, JSON.stringify(arrangement), now);
  insertVersion.run('ov-failed', 'plan-failed', 1, JSON.stringify(arrangement), now);

  // 已导出的正式产物（视频 + 配对封面，同一导出对）。
  const exportedVideo = writeArtifactFile('projects/ACC-1-20261101/成片/ACC-1-01.mp4', Buffer.alloc(4096, 1));
  const exportedCover = writeArtifactFile('projects/ACC-1-20261101/成片/ACC-1-01-封面.jpg', Buffer.alloc(1024, 2));
  insertArtifact.run('video-exported', 'p1', 'b1', 'bv1', 'plan-exported', 'ov-exported', 'video',
    exportedVideo.relativePath, sha256Of(Buffer.alloc(4096, 1)), now);
  insertArtifact.run('cover-exported', 'p1', 'b1', 'bv1', 'plan-exported', 'ov-exported', 'cover',
    exportedCover.relativePath, sha256Of(Buffer.alloc(1024, 2)), now);

  // 修改未导出：旧版本的正式产物仍是「上一版」。
  const reworkedVideo = writeArtifactFile('projects/ACC-1-20261101/成片/ACC-1-02.mp4', Buffer.alloc(2048, 3));
  const reworkedCover = writeArtifactFile('projects/ACC-1-20261101/成片/ACC-1-02-封面.jpg', Buffer.alloc(512, 4));
  insertArtifact.run('video-reworked', 'p1', 'b1', 'bv1', 'plan-reworked', 'ov-reworked-old', 'video',
    reworkedVideo.relativePath, sha256Of(Buffer.alloc(2048, 3)), now);
  insertArtifact.run('cover-reworked', 'p1', 'b1', 'bv1', 'plan-reworked', 'ov-reworked-old', 'cover',
    reworkedCover.relativePath, sha256Of(Buffer.alloc(512, 4)), now);

  /** 造一次「成功的完整渲染」让正式产物对该版本保持新鲜。 */
  function markFresh(planId, outputVersionId, artifacts) {
    const coverContractHash = resolveCoverContractHash(db, outputVersionId);
    createBatchTask(db, 'p1', {
      batchId: 'b1', workType: 'render', targetKind: 'output_version_cover', targetId: outputVersionId,
      requestKey: `cover:${outputVersionId}:${coverContractHash}`,
    });
    const taskId = createBatchTask(db, 'p1', {
      batchId: 'b1', workType: 'render', targetKind: 'output_version', targetId: outputVersionId,
      requestKey: `render:${outputVersionId}:${resolveFullRenderContractHash(db, outputVersionId)}`,
    });
    db.prepare(`UPDATE batch_tasks SET status='succeeded', attemptCount=1 WHERE id=?`).run(taskId);
    db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,resultJson,startedAt,finishedAt,createdAt)
      VALUES (?,?,1,'succeeded','{}',?,?,?,?)`).run(
      `attempt-${outputVersionId}`, taskId,
      JSON.stringify({
        projectId: 'p1', batchId: 'b1', batchVersionId: 'bv1', planId, outputVersionId,
        planSeq: 1, outputVersionNumber: 1, audioMode: 'narration', productionReady: true,
        videoChecksum: artifacts.videoChecksum, coverChecksum: artifacts.coverChecksum,
        videoRelativePath: artifacts.video, coverRelativePath: artifacts.cover,
      }),
      now, now, now,
    );
  }

  // 只有 ov-exported 是新鲜的；ov-reworked 故意没有新契约的成功渲染 → formalOutdated。
  markFresh('plan-exported', 'ov-exported', {
    video: exportedVideo.relativePath, cover: exportedCover.relativePath,
    videoChecksum: sha256Of(Buffer.alloc(4096, 1)), coverChecksum: sha256Of(Buffer.alloc(1024, 2)),
  });
  // 04「失败」：一条失败的整片渲染任务（不应产生任何可下载项）。
  const failedTaskId = createBatchTask(db, 'p1', {
    batchId: 'b1', workType: 'render', targetKind: 'output_version', targetId: 'ov-failed',
    requestKey: `render:ov-failed:${resolveFullRenderContractHash(db, 'ov-failed')}`,
  });
  db.prepare(`UPDATE batch_tasks SET status='failed' WHERE id=?`).run(failedTaskId);

  // ---- 断言 1：清单只含当前正式产物，且「修改未导出」给上一版 ----
  const both = buildBatchDownloadManifest(db, 'p1', 'b1', { storageRoot });
  assert.equal(both.scope, 'both');
  assert.equal(both.exportDirName, 'ACC-1-20261101', '下载目录按项目导出身份分目录');
  assert.deepEqual(
    both.items.map((item) => `${item.planId}:${item.kind}`).sort(),
    ['plan-exported:cover', 'plan-exported:video', 'plan-reworked:cover', 'plan-reworked:video'],
    '从没导出与渲染失败的成片不得出现在清单里',
  );
  assert.equal(both.items.every((item) => item.byteSize > 0), true, '每项必须带大小');
  const exportedItem = both.items.find((item) => item.planId === 'plan-exported' && item.kind === 'video');
  assert.equal(exportedItem.outdated, false);
  assert.equal(exportedItem.outputVersionNumber, 1);
  assert.equal(exportedItem.byteSize, 4096);
  const reworkedItem = both.items.find((item) => item.planId === 'plan-reworked' && item.kind === 'video');
  assert.equal(reworkedItem.outdated, true, '修改未重新导出的必须是上一版正式产物且标 outdated');
  assert.equal(reworkedItem.outputVersionNumber, 1, '上一版是 v1，不是当前 v2');
  assert.equal(reworkedItem.byteSize, 2048);
  assert.match(reworkedItem.sha256, /^[a-f0-9]{64}$/, 'sha256 必须是裸 hex 供轻客户端校验');
  assert.equal(exportedItem.relativeName.endsWith('ACC-1-01.mp4'), true);
  assert.match(exportedItem.relativeName, /^ACC-1-20261101\/01-v1\//, '按项目与导出版本分目录');
  assert.equal(both.totalBytes, 4096 + 1024 + 2048 + 512);

  // ---- 断言 2：按选项筛 ----
  const videoOnly = buildBatchDownloadManifest(db, 'p1', 'b1', { scope: 'video', storageRoot });
  assert.deepEqual(videoOnly.items.map((item) => item.kind), ['video', 'video']);
  assert.equal(videoOnly.totalBytes, 4096 + 2048);
  const coverOnly = buildBatchDownloadManifest(db, 'p1', 'b1', { scope: 'cover', storageRoot });
  assert.deepEqual(coverOnly.items.map((item) => item.kind), ['cover', 'cover']);
  assert.equal(coverOnly.totalBytes, 1024 + 512);
  assert.throws(() => normalizeBatchDownloadScope('everything'), BatchDomainError);

  // ---- 断言 3：ZIP 与清单一致（同一 builder → 文件名/字节数与清单逐项相等） ----
  for (const scope of ['both', 'video', 'cover']) {
    const manifest = buildBatchDownloadManifest(db, 'p1', 'b1', { scope, storageRoot });
    const packed = resolveBatchDownloadFiles(db, 'p1', 'b1', { scope, storageRoot });
    assert.deepEqual(
      packed.files.map((file) => file.filename).sort(),
      manifest.items.map((item) => item.relativeName).sort(),
      `ZIP（${scope}）的文件名必须与清单逐项一致`,
    );
    for (const item of manifest.items) {
      const file = packed.files.find((entry) => entry.filename === item.relativeName);
      assert.ok(file, `ZIP 缺清单项 ${item.relativeName}`);
      assert.equal(fs.statSync(file.absolutePath).size, item.byteSize,
        `ZIP 项 ${item.relativeName} 的实际字节数必须等于清单大小`);
    }
  }

  // ---- 断言 4：没有可下载成片时清单为空（路由据此提示「还没有导出过的成片」） ----
  db.prepare(`UPDATE batch_output_plans SET currentArtifactId = NULL`).run();
  const empty = buildBatchDownloadManifest(db, 'p1', 'b1', { storageRoot });
  assert.deepEqual(empty.items, [], '没有当前正式产物时清单必须为空');
  assert.equal(empty.totalBytes, 0);
  assert.equal(BATCH_NO_EXPORTED_FILMS_MESSAGE, '还没有导出过的成片');

  console.log('batch download manifest tests passed');
} finally {
  try { db?.close(); } catch { /* 已关闭 */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
