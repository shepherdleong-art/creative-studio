import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { getBatchWorkspace } from '../lib/batch-production/batch-workspace.ts';
import { resolveCoverContractHash, resolveFullRenderContractHash } from '../lib/batch-production/cover-contract.ts';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchTask } from '../lib/batch-production/tasks.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-workspace-'));
try {
  let queryCount = 0;
  let countQueries = false;
  const db = new Database(path.join(root, 'workspace.db'), {
    verbose() { if (countQueries) queryCount += 1; },
  });
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
    review: { decision: 'approved', decidedAt: now },
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

  const insertTask = db.prepare(`INSERT INTO batch_tasks (id,projectId,batchId,workType,targetKind,targetId,status,expectedState,progressJson,attemptCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,'{}',?,?,?)`);
  // plan1:独立封面任务成功(封面墙/可检查的事实来源);requestKey 必须与
  // 当前封面契约哈希一致,workspace 才认它作封面事实(封面 A→B→A 语义)。
  const ov1CoverContractHash = resolveCoverContractHash(db, 'ov1');
  insertTask.run('cover1-task','p1','b1','render','output_version_cover','ov1','succeeded','running',1,now,now);
  db.prepare(`UPDATE batch_tasks SET requestKey = ? WHERE id = 'cover1-task'`).run(`cover:ov1:${ov1CoverContractHash}`);
  db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,resultJson,startedAt,finishedAt,createdAt) VALUES ('cover1-attempt','cover1-task',1,'succeeded','{}',?,?,?,?)`).run(
    JSON.stringify({
      projectId: 'p1', batchId: 'b1', batchVersionId: 'bv1', planId: 'plan1',
      outputVersionId: 'ov1', planSeq: 1, outputVersionNumber: 1,
      coverRelativePath: 'batch-renders/ov1/cover.jpg', coverChecksum: 'sha256:cover-candidate',
    }),
    now, now, now,
  );
  // plan1:整片渲染任务(导出阶段产物)与当前契约一致 → 正式成片新鲜
  const ov1ContractHash = resolveFullRenderContractHash(db, 'ov1');
  insertTask.run('full1-task','p1','b1','render','output_version','ov1','succeeded','running',1,now,now);
  db.prepare(`
    UPDATE batch_tasks SET requestKey = ? WHERE id = 'full1-task'
  `).run(`render:ov1:${ov1ContractHash}`);
  db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,resultJson,startedAt,finishedAt,createdAt) VALUES ('full1-attempt','full1-task',1,'succeeded','{}',?,?,?,?)`).run(
    JSON.stringify({
      outputVersionId: 'ov1', audioMode: 'narration', productionReady: true, durationUs: 2_000_000,
      videoRelativePath: 'batch-renders/ov1/video.mp4', coverRelativePath: 'batch-renders/ov1/cover.jpg',
      videoChecksum: 'sha256:video1', coverChecksum: 'sha256:cover1',
      editRevision: 0, coverTimeUs: 3_000_000, subtitleCues: [],
    }),
    now, now, now,
  );
  // plan2:封面任务失败(可重试),且无整片任务
  insertTask.run('cover2-task','p1','b1','render','output_version_cover','ov2','failed','running',1,now,now);
  db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,errorCode,errorMessage,startedAt,finishedAt,createdAt) VALUES ('cover2-attempt','cover2-task',1,'failed','{}','render_failed','封面编码失败',?,?,?)`).run(now,now,now);
  // plan3:封面任务排队中 → 处理中,不被误标成「等待渲染」
  insertTask.run('cover3-task','p1','b1','render','output_version_cover','ov3','queued','running',0,now,now);
  // plan4:旧正式产物(ov4-old),当前版本已换到 ov4-new → formalOutdated
  insertTask.run('full4-task','p1','b1','render','output_version','ov4-old','succeeded','running',1,now,now);
  db.prepare(`UPDATE batch_tasks SET requestKey = ? WHERE id = 'full4-task'`).run(`render:ov4-old:legacy-fixture-key`);
  db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,resultJson,startedAt,finishedAt,createdAt) VALUES ('full4-attempt','full4-task',1,'succeeded','{}',?,?,?,?)`).run(
    JSON.stringify({
      outputVersionId: 'ov4-old', audioMode: 'narration', productionReady: true, durationUs: 2_000_000,
      videoRelativePath: 'batch-renders/ov4-old/video.mp4', coverRelativePath: 'batch-renders/ov4-old/cover.jpg',
      videoChecksum: 'sha256:video4', coverChecksum: 'sha256:cover4',
      editRevision: 0, coverTimeUs: 0, subtitleCues: [],
    }),
    now, now, now,
  );

  const insertArtifact = db.prepare(`INSERT INTO batch_artifacts (id,projectId,batchId,batchVersionId,outputPlanId,outputVersionId,kind,relativePath,checksum,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insertArtifact.run('video1','p1','b1','bv1','plan1','ov1','video','storage/batch/video1.mp4','sha256:video1',now);
  insertArtifact.run('cover1','p1','b1','bv1','plan1','ov1','cover','storage/batch/video1-封面.jpg','sha256:cover1',now);
  insertArtifact.run('video4-old','p1','b1','bv1','plan4','ov4-old','video','storage/batch/video4.mp4','sha256:video4',now);
  insertArtifact.run('cover4-old','p1','b1','bv1','plan4','ov4-old','cover','storage/batch/video4-封面.jpg','sha256:cover4',now);

  const view = getBatchWorkspace(db, 'p1', 'b1');
  assert.equal(view.cards.length, 4);
  // 状态口径互不混淆:封面/审核/导出/正式成片各自独立表达。
  const card1 = view.cards.find(({ planId }) => planId === 'plan1')!;
  assert.equal(card1.status, 'completed');
  assert.equal(card1.reviewable, true);
  assert.equal(card1.approvable, true, '口播+封面就绪才允许通过');
  assert.equal(card1.approved, true);
  assert.equal(card1.exportEligible, true);
  assert.equal(card1.coverStatus, 'succeeded');
  assert.equal(card1.coverAttemptId, 'cover1-attempt');
  assert.equal(card1.formalOutdated, false, 'artifact 与当前完整渲染契约一致时不得标记过期');
  assert.equal(card1.exportStatus, 'exported');
  assert.equal(card1.currentFormalArtifact?.video.id, 'video1');
  assert.equal(card1.currentFormalArtifact?.cover?.id, 'cover1');
  assert.deepEqual(card1.coverRange, {
    assetId: 'cover-pool-asset', startUs: 0, endUs: 9_000_000, currentUs: 3_000_000,
  }, '封面素材不在时间线 clips 中时仍应使用冻结素材的完整时长');
  const card2 = view.cards.find(({ planId }) => planId === 'plan2')!;
  assert.equal(card2.status, 'retryable_failed', '封面失败必须可重试,不能被口播未就绪遮蔽');
  assert.equal(card2.coverStatus, 'failed');
  assert.equal(card2.approvable, false);
  assert.equal(card2.coverRange, null, '封面素材不在冻结池时必须显式返回不可用');
  const card3 = view.cards.find(({ planId }) => planId === 'plan3')!;
  assert.equal(card3.status, 'processing', '封面排队中显示处理中,不再永远 waiting');
  assert.equal(card3.coverStatus, 'queued');
  assert.equal(card3.approvable, false);
  const card4 = view.cards.find(({ planId }) => planId === 'plan4')!;
  assert.equal(card4.status, 'needs_attention', '新版没有封面/渲染时不能隐藏旧正式产物');
  assert.equal(card4.formalOutdated, true, '当前版本已换,旧 artifact 必须标记过期');
  assert.equal(card4.currentFormalArtifact?.video.id, 'video4-old', '返工期间旧正式成片仍返回');
  assert.equal(card4.approvable, false);
  assert.equal(card4.exportEligible, false);
  assert.deepEqual(view.counts, { total: 4, reviewable: 4, approvable: 1, approved: 1, processing: 1, needsAttention: 1, failed: 1 });

  // 正式视频与封面必须成对匹配同一次成功渲染；封面指纹不符时不能仍称已导出。
  db.prepare(`UPDATE batch_artifacts SET checksum = 'sha256:wrong-cover' WHERE id = 'cover1'`).run();
  const mismatchedFormalPairView = getBatchWorkspace(db, 'p1', 'b1');
  const mismatchedFormalPairCard = mismatchedFormalPairView.cards.find(({ planId }) => planId === 'plan1');
  assert.equal(mismatchedFormalPairCard?.formalOutdated, true, '配套封面指纹不符时正式产物必须过期');
  assert.equal(mismatchedFormalPairCard?.exportStatus, 'not_exported', '封面不匹配时不得显示已导出');
  db.prepare(`UPDATE batch_artifacts SET checksum = 'sha256:cover1' WHERE id = 'cover1'`).run();

  // 返工:ov1 编辑后(契约变化)旧正式成片仍返回,但 formalOutdated=true。
  const originalOv1ArrangementJson = (db.prepare(`SELECT arrangementJson FROM batch_output_versions WHERE id = 'ov1'`).get() as { arrangementJson: string }).arrangementJson;
  const editedOv1Arrangement = JSON.parse(originalOv1ArrangementJson) as Record<string, unknown>;
  editedOv1Arrangement.editRevision = 1;
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = 'ov1'`).run(JSON.stringify(editedOv1Arrangement));
  const staleFailedFullTaskId = createBatchTask(db, 'p1', {
    batchId: 'b1',
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov1',
    requestKey: `render:ov1:rnd_${'0'.repeat(32)}`,
    now: () => new Date('2026-08-04T11:00:00.000Z'),
  });
  db.prepare(`UPDATE batch_tasks SET status = 'failed', expectedState = 'stopped' WHERE id = ?`).run(staleFailedFullTaskId);
  const editedView = getBatchWorkspace(db, 'p1', 'b1');
  assert.equal(editedView.cards.find(({ planId }) => planId === 'plan1')?.formalOutdated, true, '编辑后当前正式成片必须标记过期');
  assert.equal(editedView.cards.find(({ planId }) => planId === 'plan1')?.currentFormalArtifact?.video.id, 'video1', '返工期间仍返回旧正式成片');
  assert.equal(editedView.cards.find(({ planId }) => planId === 'plan1')?.status, 'needs_attention', '当前修改尚未导出');
  assert.equal(editedView.cards.find(({ planId }) => planId === 'plan1')?.fullRenderTask, null, '旧契约失败任务不得冒充当前契约任务');
  assert.equal(editedView.cards.find(({ planId }) => planId === 'plan1')?.exportStatus, 'not_exported', '当前契约尚未建任务时应显示未导出而非失败');
  db.prepare(`DELETE FROM batch_tasks WHERE id = ?`).run(staleFailedFullTaskId);
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = 'ov1'`).run(originalOv1ArrangementJson);

  // 老批次兼容:发布任务没有契约哈希时,回落到修订号+封面时间点比对。
  db.prepare(`UPDATE batch_tasks SET requestKey = ? WHERE id = 'full1-task'`).run(`render:ov1:legacy-key`);
  const legacyView = getBatchWorkspace(db, 'p1', 'b1');
  assert.equal(legacyView.cards.find(({ planId }) => planId === 'plan1')?.formalOutdated, false, '旧任务按修订号+封面时间点仍可判断新鲜');
  db.prepare(`UPDATE batch_tasks SET requestKey = ? WHERE id = 'full1-task'`).run(`render:ov1:${ov1ContractHash}`);

  // 封面 A→B→A:workspace 必须按当前契约选封面任务,不能展示较新的 B 任务
  // 或它的失败状态;切回 A 时旧 A 任务的事实(成功)恢复展示。
  {
    const currentA = JSON.parse((db.prepare(`SELECT arrangementJson FROM batch_output_versions WHERE id = 'ov1'`).get() as { arrangementJson: string }).arrangementJson) as Record<string, unknown>;
    // B:改封面时间点 → 新契约;旧 A 任务保持自己的 A requestKey(真实链路),
    // 另建一条新的、更晚的失败 B 任务。
    const arrangementB = { ...currentA, cover: { assetId: (currentA.cover as { assetId?: string } | undefined)?.assetId ?? 'cover-pool-asset', timeUs: 4_000_000 } } as Record<string, unknown>;
    db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = 'ov1'`).run(JSON.stringify(arrangementB));
    const hashB = resolveCoverContractHash(db, 'ov1');
    const bCoverTaskId = createBatchTask(db, 'p1', {
      batchId: 'b1',
      workType: 'render',
      targetKind: 'output_version_cover',
      targetId: 'ov1',
      requestKey: `cover:ov1:${hashB}`,
      now: () => new Date('2026-08-04T12:00:00.000Z'),
    });
    db.prepare(`UPDATE batch_tasks SET status = 'failed', expectedState = 'stopped' WHERE id = ?`).run(bCoverTaskId);
    db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,resultJson,errorCode,errorMessage,startedAt,finishedAt,createdAt) VALUES ('coverB-attempt',?,1,'failed','{}',NULL,'render_failed','B 封面失败','2026-08-04T12:00:00.000Z','2026-08-04T12:00:01.000Z','2026-08-04T12:00:00.000Z')`).run(bCoverTaskId);
    const viewB = getBatchWorkspace(db, 'p1', 'b1');
    assert.equal(viewB.cards.find(({ planId }) => planId === 'plan1')?.coverStatus, 'failed', '当前契约是 B 时必须展示 B 任务失败状态');
    assert.equal(viewB.cards.find(({ planId }) => planId === 'plan1')?.coverAttemptId, null, 'B 失败时没有成功封面尝试');
    // A:封面时间点改回去
    db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = 'ov1'`).run(originalOv1ArrangementJson);
    const viewA = getBatchWorkspace(db, 'p1', 'b1');
    assert.equal(viewA.cards.find(({ planId }) => planId === 'plan1')?.coverStatus, 'succeeded', '切回 A 时必须展示旧 A 任务的成功状态,而非较新的 B 失败');
    assert.equal(viewA.cards.find(({ planId }) => planId === 'plan1')?.coverAttemptId, 'cover1-attempt', '切回 A 时封面来源必须是旧 A 任务的成功尝试');
  }

  // 当前封面契约损坏时必须 fail closed：不能回退到最近任意独立封面任务。
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = '{' WHERE id = 'ov1'`).run();
  const unverifiableCoverView = getBatchWorkspace(db, 'p1', 'b1');
  const unverifiableCoverCard = unverifiableCoverView.cards.find(({ planId }) => planId === 'plan1');
  assert.equal(unverifiableCoverCard?.coverStatus, 'missing', '契约不可解析时不得猜测最近封面任务');
  assert.equal(unverifiableCoverCard?.coverAttemptId, null, '契约不可解析时不得暴露任意封面尝试');
  assert.equal(unverifiableCoverCard?.approvable, false, '无法证明封面身份时不得进入审核通过门禁');
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = 'ov1'`).run(originalOv1ArrangementJson);

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
  assert.equal(blockedReallocationView.cards.find(({ planId }) => planId === 'plan1')?.status, 'needs_attention', '阻塞重分配必须覆盖旧 completed 展示并保留旧产物');
  assert.deepEqual(blockedReallocationView.cards.find(({ planId }) => planId === 'plan1')?.blockers, ['locked-conflict:segment-1']);
  assert.throws(() => getBatchWorkspace(db, 'p2', 'b1'), /不存在/);
  db.exec(`
    CREATE TABLE shot_sets (id TEXT, projectId TEXT);
    CREATE TABLE shots (id TEXT, shotSetId TEXT, sourceImageId TEXT);
    CREATE TABLE video_jobs (id TEXT, shotId TEXT);
    INSERT INTO shot_sets VALUES ('set-a', 'p1'), ('set-b', 'p1');
    INSERT INTO shots VALUES ('shot-a', 'set-a', 'original'), ('shot-b', 'set-b', 'original');
    INSERT INTO video_jobs VALUES ('job-a', 'shot-a'), ('job-b', 'shot-b');
  `);
  for (const [id, assetId, jobId] of [['source-a', 'timeline-asset', 'job-a'], ['source-b', 'outside-pool-asset', 'job-b']]) {
    db.prepare(`INSERT INTO batch_asset_sources (id,assetId,sourceKind,locationJson,health,createdAt)
      VALUES (?,?,'module4',?,'healthy',?)`).run(id, assetId, JSON.stringify({ videoJobId: jobId }), now);
  }
  db.prepare(`UPDATE batch_production_versions SET currentAllocationRunId = NULL WHERE id = 'bv1'`).run();
  const sourceConflictArrangement = JSON.parse(originalOv1ArrangementJson);
  sourceConflictArrangement.clips.push({ ...sourceConflictArrangement.clips[0], clipId: 'same-source', assetId: 'outside-pool-asset', timelineStartUs: 2_000_000, timelineEndUs: 4_000_000 });
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = 'ov1'`).run(JSON.stringify(sourceConflictArrangement));
  const sourceConflictCard = getBatchWorkspace(db, 'p1', 'b1').cards.find(card => card.planId === 'plan1')!;
  assert.equal(sourceConflictCard.approved, true, '同源提醒不影响既有审核');
  assert.equal(sourceConflictCard.approvable, true, '同源提醒不影响确认');
  assert.equal(sourceConflictCard.exportEligible, true, '同源提醒不阻止导出');
  assert.ok(sourceConflictCard.sourceWarnings?.some(message => message.includes('同源图')));
  assert.deepEqual(new Set(sourceConflictCard.sourceConflictAssetIds), new Set(['timeline-asset', 'outside-pool-asset']));
  assert.equal(sourceConflictCard.sourceConflictGroups?.[0].key, 'image:p1:original');
  assert.deepEqual(new Set(sourceConflictCard.sourceConflictGroups?.[0].assetIds), new Set(sourceConflictCard.sourceConflictAssetIds));
  assert.equal(sourceConflictCard.blockers.length, 0);
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = 'ov1'`).run(originalOv1ArrangementJson);
  assert.deepEqual(getBatchWorkspace(db, 'p1', 'b1').cards.find(card => card.planId === 'plan1')!.sourceConflictAssetIds, []);
  assert.equal(getBatchWorkspace(db, 'p1', 'b1').cards.find(card => card.planId === 'plan1')!.sourceWarnings?.length, 0,
    '冲突解除后，实时检查不保留过期警告');

  // 老批次整片任务回退:较新的 failed 任务没有成功尝试时，JOIN 语义应跳过它，
  // 继续找更早的、确实有成功尝试的任务；不能因为最新任务失败就丢失封面与
  // productionReady 的兼容事实。
  {
    const legacyNow = '2026-08-06T10:00:00.000Z';
    db.prepare(`INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, controlState, createdAt, updatedAt) VALUES ('b-legacy','p1','老批次回退','running','bv-legacy','{}','running',?,?)`).run(legacyNow, legacyNow);
    db.prepare(`INSERT INTO batch_production_versions (id,batchId,versionNumber,copyCount,defaultsJson,inputState,frozenAt,createdAt) VALUES ('bv-legacy','b-legacy',1,1,'{}','frozen',?,?)`).run(legacyNow, legacyNow);
    db.prepare(`INSERT INTO batch_script_snapshots (id,batchVersionId,sourceScriptId,title,bodyText,sourceVersion,copyCount,createdAt) VALUES ('ss-legacy','bv-legacy','s1','脚本标题','正文','v1',1,?)`).run(legacyNow);
    db.prepare(`INSERT INTO batch_output_plans (id,batchVersionId,scriptSnapshotId,seq,planJson,currentVersionId,currentArtifactId,createdAt) VALUES ('lplan1','bv-legacy','ss-legacy',1,'{}','lov1',NULL,?)`).run(legacyNow);
    db.prepare(`INSERT INTO batch_output_versions (id,planId,versionNumber,arrangementJson,createdAt) VALUES ('lov1','lplan1',1,?,?)`).run(JSON.stringify({
      productionReady: false,
      clips: [{
        clipId: 'legacy-clip', assetId: 'timeline-asset', sourceStartUs: 0,
        sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000,
      }],
      cover: { assetId: 'timeline-asset', timeUs: 0 },
      warnings: [], blockers: [],
    }), legacyNow);
    // 更早的一条成功任务(封面/生产就绪事实) + 更新的一条 failed 任务(无成功尝试)。
    insertTask.run('legacy-full-old','p1','b-legacy','render','output_version','lov1','succeeded','running',1,'2026-08-06T10:00:00.000Z','2026-08-06T10:00:00.000Z');
    db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,resultJson,startedAt,finishedAt,createdAt) VALUES ('legacy-old-attempt','legacy-full-old',1,'succeeded','{}',?,?,?,?)`).run(
      JSON.stringify({
        outputVersionId: 'lov1', productionReady: true,
        coverRelativePath: 'batch-renders/lov1/cover.jpg',
        videoChecksum: 'sha256:legacy-video', coverChecksum: 'sha256:legacy-cover',
        editRevision: 0, coverTimeUs: 0, subtitleCues: [],
      }),
      '2026-08-06T10:00:00.000Z', '2026-08-06T10:00:01.000Z', '2026-08-06T10:00:00.000Z',
    );
    insertTask.run('legacy-full-new','p1','b-legacy','render','output_version','lov1','failed','running',1,'2026-08-06T11:00:00.000Z','2026-08-06T11:00:01.000Z');
    db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,errorCode,errorMessage,startedAt,finishedAt,createdAt) VALUES ('legacy-new-attempt','legacy-full-new',1,'failed','{}','render_failed','新一轮失败','2026-08-06T11:00:00.000Z','2026-08-06T11:00:01.000Z','2026-08-06T11:00:00.000Z')`).run();

    const legacyCard = getBatchWorkspace(db, 'p1', 'b-legacy').cards.find(card => card.planId === 'lplan1')!;
    assert.equal(legacyCard.coverStatus, 'succeeded', '最新任务失败不得遮蔽更早的成功整片尝试');
    assert.equal(legacyCard.coverAttemptId, 'legacy-old-attempt', '封面回落必须使用更早的成功尝试');
    assert.equal(legacyCard.productionReady, true, 'productionReady 兼容事实必须来自更早的成功尝试');
    assert.equal(legacyCard.approvable, true);
  }

  // ---- 工作区规模 / SQL 预算回归 ----
  // 按批次集中取数后,1/25/100 卡的 SQL 条数必须基本恒定,不能为每张卡
  // 追加一套查询;带历史正式产物的大批次还要保持契约/新鲜度语义。
  {
    const scaleNow = '2026-08-05T10:00:00.000Z';
    db.prepare(`INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, controlState, createdAt, updatedAt) VALUES ('b-scale','p1','规模批次','running','bv-scale','{}','running',?,?)`).run(scaleNow, scaleNow);
    db.prepare(`INSERT INTO batch_production_versions (id,batchId,versionNumber,copyCount,defaultsJson,inputState,frozenAt,createdAt) VALUES ('bv-scale','b-scale',1,100,'{}','frozen',?,?)`).run(scaleNow, scaleNow);
    db.prepare(`INSERT INTO batch_script_snapshots (id,batchVersionId,sourceScriptId,title,bodyText,sourceVersion,copyCount,createdAt) VALUES ('ss-scale','bv-scale','s1','脚本标题','正文','v1',100,?)`).run(scaleNow);
    db.prepare(`INSERT INTO batch_asset_pool_items (id,batchVersionId,assetId,analysisId,selectionState,createdAt) VALUES ('pool-scale','bv-scale','timeline-asset','analysis-timeline','selected',?)`).run(scaleNow);

    const scaleArrangement = JSON.stringify({
      productionReady: true,
      editRevision: 0,
      clips: [{
        clipId: 'clip-scale', assetId: 'timeline-asset', sourceStartUs: 500_000,
        sourceEndUs: 2_500_000, timelineStartUs: 0, timelineEndUs: 2_000_000,
      }],
      cover: { assetId: 'timeline-asset', timeUs: 0 },
      warnings: [], blockers: [],
    });
    const insertScalePlan = db.prepare(`INSERT INTO batch_output_plans (id,batchVersionId,scriptSnapshotId,seq,planJson,currentVersionId,currentArtifactId,createdAt) VALUES (?, 'bv-scale','ss-scale',?, '{}', ?, ?, ?)`);
    const insertScaleVersion = db.prepare(`INSERT INTO batch_output_versions (id,planId,versionNumber,arrangementJson,createdAt) VALUES (?,?,1,?,?)`);
    const insertScaleArtifact = db.prepare(`INSERT INTO batch_artifacts (id,projectId,batchId,batchVersionId,outputPlanId,outputVersionId,kind,relativePath,checksum,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insertScaleTask = db.prepare(`INSERT INTO batch_tasks (id,projectId,batchId,workType,targetKind,targetId,status,expectedState,requestKey,progressJson,attemptCount,createdAt,updatedAt) VALUES (?, 'p1','b-scale','render','output_version',?,'succeeded','running',NULL,'{}',1,?,?)`);
    const insertScaleAttempt = db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,resultJson,startedAt,finishedAt,createdAt) VALUES (?,?,1,'succeeded','{}',?,?,?,?)`);

    let inserted = 0;
    const addScaleCards = (target: number) => {
      db.transaction(() => {
        while (inserted < target) {
          inserted += 1;
          const index = inserted;
          const planId = `sp-${index}`;
          const versionId = `sv-${index}`;
          const videoId = `sv-video-${index}`;
          insertScalePlan.run(planId, index, versionId, videoId, scaleNow);
          insertScaleVersion.run(versionId, planId, scaleArrangement, scaleNow);
          insertScaleArtifact.run(videoId, 'p1', 'b-scale', 'bv-scale', planId, versionId, 'video', `storage/batch/scale-${index}.mp4`, `sha256:sv-video-${index}`, scaleNow);
          insertScaleArtifact.run(`sv-cover-${index}`, 'p1', 'b-scale', 'bv-scale', planId, versionId, 'cover', `storage/batch/scale-${index}-封面.jpg`, `sha256:sv-cover-${index}`, scaleNow);
          insertScaleTask.run(`sv-task-${index}`, versionId, scaleNow, scaleNow);
          insertScaleAttempt.run(`sv-attempt-${index}`, `sv-task-${index}`, JSON.stringify({
            outputVersionId: versionId,
            audioMode: 'narration',
            productionReady: true,
            durationUs: 2_000_000,
            videoRelativePath: `batch-renders/${versionId}/video.mp4`,
            coverRelativePath: `batch-renders/${versionId}/cover.jpg`,
            videoChecksum: `sha256:sv-video-${index}`,
            coverChecksum: `sha256:sv-cover-${index}`,
            editRevision: 0,
            coverTimeUs: 0,
            subtitleCues: [],
          }), scaleNow, scaleNow, scaleNow);
        }
      })();
    };

    const measureWorkspace = (targetBatchId: string) => {
      queryCount = 0;
      countQueries = true;
      const startedAt = performance.now();
      try {
        const measured = getBatchWorkspace(db, 'p1', targetBatchId);
        return { view: measured, ms: performance.now() - startedAt, sql: queryCount };
      } finally {
        countQueries = false;
      }
    };

    const scaleResults: Array<{ cards: number; medianMs: number; p95Ms: number; maxSql: number }> = [];
    for (const cards of [1, 25, 100]) {
      addScaleCards(cards);
      const samples: Array<{ ms: number; sql: number }> = [];
      for (let sample = 0; sample < 7; sample += 1) {
        const measured = measureWorkspace('b-scale');
        assert.equal(measured.view.cards.length, cards);
        assert.ok(measured.view.cards.every(card => card.formalOutdated === false), '成对正式产物与当前契约一致时不得标记过期');
        samples.push({ ms: measured.ms, sql: measured.sql });
      }
      const sortedMs = samples.map(({ ms }) => ms).sort((a, b) => a - b);
      const p95Index = Math.min(sortedMs.length - 1, Math.ceil(sortedMs.length * 0.95) - 1);
      scaleResults.push({
        cards,
        medianMs: Number(sortedMs[Math.floor(sortedMs.length / 2)].toFixed(3)),
        p95Ms: Number(sortedMs[p95Index].toFixed(3)),
        maxSql: Math.max(...samples.map(({ sql }) => sql)),
      });
    }
    const cardOne = scaleResults[0];
    const cardHundred = scaleResults[2];
    assert.ok(cardHundred.maxSql <= 100, `100 卡工作区关联读取必须 ≤100 条 SQL,实际 ${cardHundred.maxSql}`);
    assert.ok(
      cardHundred.maxSql <= cardOne.maxSql + 20,
      `SQL 条数不能随卡片数线性增长:1 卡 ${cardOne.maxSql},100 卡 ${cardHundred.maxSql}`,
    );
    // 耗时只作看门狗:共享机器/CI 抖动不应让聚合语义回归检测误报;
    // SQL 条数与非线性增长断言仍保持严格。
    assert.ok(cardHundred.medianMs < 2000, `100 卡工作区中位耗时回归:${cardHundred.medianMs}ms`);

    // 封面素材不在冻结池内:契约解析会回落素材分析,该查询必须也按批次预加载,
    // 否则每张卡多一条 SQL,100 卡会超出预算。
    {
      const outsideNow = '2026-08-05T12:00:00.000Z';
      db.prepare(`INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, controlState, createdAt, updatedAt) VALUES ('b-scale-outside','p1','池外封面批次','running','bv-scale-outside','{}','running',?,?)`).run(outsideNow, outsideNow);
      db.prepare(`INSERT INTO batch_production_versions (id,batchId,versionNumber,copyCount,defaultsJson,inputState,frozenAt,createdAt) VALUES ('bv-scale-outside','b-scale-outside',1,100,'{}','frozen',?,?)`).run(outsideNow, outsideNow);
      db.prepare(`INSERT INTO batch_script_snapshots (id,batchVersionId,sourceScriptId,title,bodyText,sourceVersion,copyCount,createdAt) VALUES ('ss-scale-outside','bv-scale-outside','s1','脚本标题','正文','v1',100,?)`).run(outsideNow);
      const outsideArrangement = JSON.stringify({
        productionReady: false,
        clips: [{
          clipId: 'outside-clip', assetId: 'timeline-asset', sourceStartUs: 0,
          sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000,
        }],
        cover: { assetId: 'outside-pool-asset', timeUs: 0 },
        warnings: [], blockers: [],
      });
      const insertOutsidePlan = db.prepare(`INSERT INTO batch_output_plans (id,batchVersionId,scriptSnapshotId,seq,planJson,currentVersionId,currentArtifactId,createdAt) VALUES (?,'bv-scale-outside','ss-scale-outside',?,'{}',?,NULL,?)`);
      const insertOutsideVersion = db.prepare(`INSERT INTO batch_output_versions (id,planId,versionNumber,arrangementJson,createdAt) VALUES (?,?,1,?,?)`);
      let outsideInserted = 0;
      const addOutsideCards = (target: number) => {
        db.transaction(() => {
          while (outsideInserted < target) {
            outsideInserted += 1;
            insertOutsidePlan.run(`op-${outsideInserted}`, outsideInserted, `ov-out-${outsideInserted}`, outsideNow);
            insertOutsideVersion.run(`ov-out-${outsideInserted}`, `op-${outsideInserted}`, outsideArrangement, outsideNow);
          }
        })();
      };
      const outsideSql: number[] = [];
      for (const cards of [1, 100]) {
        addOutsideCards(cards);
        let maxSql = 0;
        for (let sample = 0; sample < 5; sample += 1) {
          const measured = measureWorkspace('b-scale-outside');
          assert.equal(measured.view.cards.length, cards);
          assert.ok(measured.view.cards.every(card => card.coverRange === null), '池外封面素材必须显式返回不可用范围');
          maxSql = Math.max(maxSql, measured.sql);
        }
        outsideSql.push(maxSql);
      }
      assert.ok(outsideSql[1] <= 100, `池外封面 100 卡关联读取必须 ≤100 条 SQL,实际 ${outsideSql[1]}`);
      assert.ok(
        outsideSql[1] <= outsideSql[0] + 20,
        `池外封面 SQL 条数不能随卡片数线性增长:1 卡 ${outsideSql[0]},100 卡 ${outsideSql[1]}`,
      );
      console.log('workspace outside-pool samples', JSON.stringify({ one: outsideSql[0], hundred: outsideSql[1] }));
    }

    console.log('workspace scale samples', JSON.stringify(scaleResults));
  }

  db.close();
  console.log('batch workspace aggregation tests passed');
} finally {
  // 断言失败时数据库可能仍被占用;清理失败不能掩盖真正的失败原因。
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}
