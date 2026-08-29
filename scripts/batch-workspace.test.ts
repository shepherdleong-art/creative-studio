import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getBatchWorkspace } from '../lib/batch-production/batch-workspace.ts';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-workspace-'));
try {
  const db = new Database(path.join(root, 'workspace.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, productCode TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT '', exportDirName TEXT NOT NULL DEFAULT ''); INSERT INTO projects (id, name) VALUES ('p1', '项目一'), ('p2', '项目二');`);
  const ready = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') });
  assert.notEqual(ready.state, 'compatibility_only');
  const now = '2026-08-03T10:00:00.000Z';
  db.prepare(`INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, controlState, createdAt, updatedAt) VALUES ('b1','p1','批次一','running','bv1','{}','running',?,?)`).run(now, now);
  db.prepare(`INSERT INTO batch_production_versions (id,batchId,versionNumber,copyCount,defaultsJson,inputState,frozenAt,createdAt) VALUES ('bv1','b1',1,4,'{}','frozen',?,?)`).run(now, now);
  db.prepare(`INSERT INTO batch_scripts (id,projectId,sourceKind,sourceId,title,bodyText,sourceVersion,createdAt,updatedAt) VALUES ('s1','p1','script_draft','src1','脚本标题','正文','v1',?,?)`).run(now, now);
  db.prepare(`INSERT INTO batch_script_snapshots (id,batchVersionId,sourceScriptId,title,bodyText,sourceVersion,copyCount,createdAt) VALUES ('ss1','bv1','s1','脚本标题','正文','v1',4,?)`).run(now);

  const insertPlan = db.prepare(`INSERT INTO batch_output_plans (id,batchVersionId,scriptSnapshotId,seq,planJson,currentVersionId,currentArtifactId,createdAt) VALUES (?,?,?,?, '{}',?,?,?)`);
  const insertVersion = db.prepare(`INSERT INTO batch_output_versions (id,planId,versionNumber,arrangementJson,createdAt) VALUES (?,?,?,?,?)`);
  insertPlan.run('plan1','bv1','ss1',1,'ov1','video1',now);
  insertVersion.run('ov1','plan1',1,JSON.stringify({ productionReady: true, warnings: [], blockers: [] }),now);
  insertPlan.run('plan2','bv1','ss1',2,'ov2',null,now);
  insertVersion.run('ov2','plan2',1,JSON.stringify({ productionReady: false, warnings: [], blockers: [] }),now);
  insertPlan.run('plan3','bv1','ss1',3,'ov3',null,now);
  insertVersion.run('ov3','plan3',1,JSON.stringify({ productionReady: true, warnings: ['素材区间被迫复用'], blockers: [] }),now);
  insertPlan.run('plan4','bv1','ss1',4,'ov4-new','video4-old',now);
  insertVersion.run('ov4-old','plan4',1,JSON.stringify({ productionReady: true }),now);
  insertVersion.run('ov4-new','plan4',2,JSON.stringify({ productionReady: true }),now);

  const insertAsset = db.prepare(`
    INSERT INTO batch_assets
      (id,projectId,sourceKind,locationJson,contentFingerprint,mediaKind,mediaJson,status,currentAnalysisId,createdAt,updatedAt)
    VALUES (?,?, 'managed', '{}', ?, 'video', ?, 'online', ?, ?, ?)
  `);
  const insertAnalysis = db.prepare(`
    INSERT INTO batch_asset_analysis
      (id,assetId,analyzerVersion,providerId,model,analysisJson,status,analyzedAt,createdAt)
    VALUES (?,?, 'fixture', 'fixture', 'fixture', ?, 'ready', ?, ?)
  `);
  const insertPoolItem = db.prepare(`
    INSERT INTO batch_asset_pool_items (id,batchVersionId,assetId,analysisId,selectionState,createdAt)
    VALUES (?,?,? ,?,'selected',?)
  `);
  insertAsset.run('timeline-asset','p1','sha256:timeline-asset',JSON.stringify({ durationSec: 4 }),null,now,now);
  insertAsset.run('cover-pool-asset','p1','sha256:cover-pool-asset',JSON.stringify({ durationSec: 9 }),null,now,now);
  insertAsset.run('outside-pool-asset','p1','sha256:outside-pool-asset',JSON.stringify({ durationSec: 12 }),null,now,now);
  insertAnalysis.run('analysis-timeline','timeline-asset',JSON.stringify({ durationUs: 4_000_000 }),now,now);
  insertAnalysis.run('analysis-cover','cover-pool-asset',JSON.stringify({ durationUs: 9_000_000 }),now,now);
  insertAnalysis.run('analysis-outside','outside-pool-asset',JSON.stringify({ durationUs: 12_000_000 }),now,now);
  insertPoolItem.run('pool-timeline','bv1','timeline-asset','analysis-timeline',now);
  insertPoolItem.run('pool-cover','bv1','cover-pool-asset','analysis-cover',now);
  db.prepare(`UPDATE batch_assets SET currentAnalysisId = ? WHERE id = ?`).run('analysis-timeline','timeline-asset');
  db.prepare(`UPDATE batch_assets SET currentAnalysisId = ? WHERE id = ?`).run('analysis-cover','cover-pool-asset');

  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = 'ov1'`).run(JSON.stringify({
    productionReady: true,
    clips: [{
      clipId: 'clip-1', assetId: 'timeline-asset', sourceStartUs: 500_000,
      sourceEndUs: 2_500_000, timelineStartUs: 0, timelineEndUs: 2_000_000,
    }],
    cover: { assetId: 'cover-pool-asset', timeUs: 3_000_000 },
    warnings: [], blockers: [],
  }));
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = 'ov2'`).run(JSON.stringify({
    productionReady: false,
    clips: [{
      clipId: 'clip-2', assetId: 'timeline-asset', sourceStartUs: 0,
      sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000,
    }],
    cover: { assetId: 'outside-pool-asset', timeUs: 1_000_000 },
    warnings: [], blockers: [],
  }));

  const insertTask = db.prepare(`INSERT INTO batch_tasks (id,projectId,batchId,workType,targetKind,targetId,status,expectedState,progressJson,attemptCount,createdAt,updatedAt) VALUES (?,?,?,'render','output_version',?,?,?,?,?,?,?)`);
  insertTask.run('task2','p1','b1','ov2','failed','running','{}',1,now,now);
  db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,errorCode,errorMessage,startedAt,finishedAt,createdAt) VALUES ('attempt2','task2',1,'failed','{}','render_failed','编码失败',?,?,?)`).run(now,now,now);
  insertTask.run('task1','p1','b1','ov1','succeeded','running','{}',1,now,now);
  db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,resultJson,startedAt,finishedAt,createdAt) VALUES ('attempt1','task1',1,'succeeded','{}',?,?,?,?)`).run(
    JSON.stringify({
      outputVersionId: 'ov1', audioMode: 'narration', productionReady: true, durationUs: 2_000_000,
      videoRelativePath: 'batch-renders/ov1/video.mp4', coverRelativePath: 'batch-renders/ov1/cover.jpg',
      editRevision: 0, subtitleCues: [],
    }),
    now, now, now,
  );
  insertTask.run('task3','p1','b1','ov3','queued','running','{}',0,now,now);
  insertTask.run('task4','p1','b1','ov4-new','failed','running','{}',1,now,now);
  db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,errorCode,errorMessage,startedAt,finishedAt,createdAt) VALUES ('attempt4','task4',1,'failed','{}','render_failed','新版失败',?,?,?)`).run(now,now,now);

  const insertArtifact = db.prepare(`INSERT INTO batch_artifacts (id,projectId,batchId,batchVersionId,outputPlanId,outputVersionId,kind,relativePath,checksum,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insertArtifact.run('video1','p1','b1','bv1','plan1','ov1','video','storage/batch/video1.mp4','sha256:video1',now);
  insertArtifact.run('cover1','p1','b1','bv1','plan1','ov1','cover','storage/batch/video1.jpg','sha256:cover1',now);
  insertArtifact.run('video4-old','p1','b1','bv1','plan4','ov4-old','video','storage/batch/video4.mp4','sha256:video4',now);
  insertArtifact.run('cover4-old','p1','b1','bv1','plan4','ov4-old','cover','storage/batch/video4.jpg','sha256:cover4',now);

  const view = getBatchWorkspace(db, 'p1', 'b1');
  assert.equal(view.cards.length, 4);
  assert.equal(view.cards[0]?.status, 'completed');
  assert.equal(view.cards[0]?.exportable, true);
  assert.equal(view.cards[0]?.currentCover?.id, 'cover1');
  assert.equal(view.cards[0]?.candidate?.editRevision, 0);
  assert.equal(view.cards[0]?.renderStale, false, '候选与当前 arrangement revision 一致时不得标记 stale');
  assert.deepEqual(view.cards[0]?.coverRange, {
    assetId: 'cover-pool-asset', startUs: 0, endUs: 9_000_000, currentUs: 3_000_000,
  }, '封面素材不在时间线 clips 中时仍应使用冻结素材的完整时长');
  assert.equal(view.cards[1]?.status, 'retryable_failed', '静音条件不得遮蔽可重试的渲染失败');
  assert.equal(view.cards[1]?.coverRange, null, '封面素材不在冻结池时必须显式返回不可用');
  assert.equal(view.cards[2]?.status, 'needs_attention', '非阻塞差异提醒优先显示需处理');
  assert.equal(view.cards[3]?.status, 'needs_attention', '新版失败不能隐藏旧正式产物');
  assert.equal(view.cards[3]?.exportable, true);
  assert.match(view.cards[3]?.nextAction ?? '', /旧版仍可/);
  assert.deepEqual(view.counts, { total: 4, exportable: 2, publishable: 1, approved: 0, processing: 0, needsAttention: 2, failed: 1 });
  assert.equal(view.phase, 'review');
  db.prepare(`
    INSERT INTO batch_allocation_runs
      (id,batchVersionId,ruleVersion,seed,inputFingerprint,status,resultJson,createdAt)
    VALUES ('run-blocked','bv1','rules-v1','reallocate','sha256:blocked','partial',?,?)
  `).run(JSON.stringify({
    outputs: [{
      planId: 'plan1',
      status: 'blocked',
      warnings: [],
      blockers: ['locked-conflict:segment-1'],
      arrangement: { warnings: [], blockers: ['locked-conflict:segment-1'] },
    }],
  }), '2026-08-03T10:01:00.000Z');
  db.prepare(`UPDATE batch_production_versions SET currentAllocationRunId = 'run-blocked' WHERE id = 'bv1'`).run();
  const blockedReallocationView = getBatchWorkspace(db, 'p1', 'b1');
  assert.equal(blockedReallocationView.cards[0]?.status, 'needs_attention', '阻塞重分配必须覆盖旧 completed 展示并保留旧产物');
  assert.equal(blockedReallocationView.cards[0]?.exportable, true);
  assert.deepEqual(blockedReallocationView.cards[0]?.blockers, ['locked-conflict:segment-1']);
  assert.throws(() => getBatchWorkspace(db, 'p2', 'b1'), /不存在/);
  db.close();
  console.log('batch workspace aggregation tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
