import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchProduction, getBatchProduction } from '../lib/batch-production/versions.ts';
import { createProjectScript } from '../lib/batch-production/scripts.ts';
import { createBatchSnapshot, startBatchProduction } from '../lib/batch-production/batch-flow.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchTask } from '../lib/batch-production/tasks.ts';
import { queueAssetPreparation } from '../lib/batch-production/asset-preparation.ts';
import {
  claimNextTask,
  completeTaskAttempt,
  expireStaleLeases,
  pauseBatch,
  reactivateBatchForStart,
  recoverInterruptedWork,
  renewLease,
  resumeBatch,
  retryTask,
  setBatchSchedulerDraining,
  stopBatch,
} from '../lib/batch-production/scheduler.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT,
      inputSnapshot TEXT NOT NULL,
      outputJson TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
    INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss-1', 'project-1', '分镜组A', '2026-08-02T00:00:00.000Z');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-scheduler-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-02T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // --- 准备:批次 → 快照 → 开跑 → 两个 render 任务 ---
  const scriptA = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-a',
    title: '口播A',
    bodyText: '正文A',
    sourceVersion: '2',
    now: () => new Date('2026-08-02T09:00:00.000Z'),
  });
  const asset1 = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'v1', shotSetId: 'ss-1', relativePath: 'videos/a.mp4' },
    contentFingerprint: 'sha256:aaa',
    mediaKind: 'video',
    now: () => new Date('2026-08-02T09:03:00.000Z'),
  });
  const analysis1 = createAnalysisVersion(db, {
    assetId: asset1,
    analyzerVersion: '0.1.0',
    providerId: 'p',
    model: 'm',
    now: () => new Date('2026-08-02T09:04:00.000Z'),
  });
  const assetSelections = [{ assetId: asset1, analysisId: analysis1 }];
  const batchId = createBatchProduction(db, 'project-1', '八月大促', () => new Date('2026-08-02T09:05:00.000Z'));
  const { planIds } = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 2 }],
    assetSelections,
    now: () => new Date('2026-08-02T09:10:00.000Z'),
  });
  assert.equal(planIds.length, 2);
  queueAssetPreparation(db, 'project-1', batchId, [asset1]);
  // 为两张成片各建一个 render 任务(直接造 output_version 并在任务里引用)
  const outputVersionIds: string[] = [];
  for (const planId of planIds) {
    const versionId = db.prepare(`
      INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
      VALUES (?, ?, 1, '{}', '2026-08-02T09:12:00.000Z')
    `).run(`ov-${planId}`, planId);
    void versionId;
    outputVersionIds.push(`ov-${planId}`);
  }
  const task1 = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: outputVersionIds[0]!,
    now: () => new Date('2026-08-02T09:15:00.000Z'),
  });
  const task2 = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: outputVersionIds[1]!,
    now: () => new Date('2026-08-02T09:16:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-02T09:20:00.000Z'));

  // --- 停机闸门:draining 时 claim 入口不得领取新任务 ---
  setBatchSchedulerDraining(true);
  assert.equal(claimNextTask(db, { workerId: 'draining-worker' }), null, 'draining 时不得领取新任务');
  setBatchSchedulerDraining(false);

  // --- 场景 1:两个 worker 竞争,只有一个获得租约 ---
  const claimedByWorker1 = claimNextTask(db, {
    workerId: 'worker-1',
    now: () => new Date('2026-08-02T09:30:00.000Z'),
    leaseDurationMs: 60_000,
  });
  assert.ok(claimedByWorker1, 'worker-1 必须领取到一个任务');
  const claimedByWorker2 = claimNextTask(db, {
    workerId: 'worker-2',
    now: () => new Date('2026-08-02T09:30:01.000Z'),
    leaseDurationMs: 60_000,
  });
  assert.ok(claimedByWorker2, 'worker-2 领取另一个任务');
  const third = claimNextTask(db, {
    workerId: 'worker-1',
    now: () => new Date('2026-08-02T09:30:02.000Z'),
    leaseDurationMs: 60_000,
  });
  assert.ok(third, '第三个可领取任务(snapshot 前排队的素材分析任务)');

  // 三个任务都被领取:两个 render + 一个 snapshot 前排队的 asset_prepare
  const runningTasks = db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE status = 'running'`).get() as { n: number };
  assert.equal(runningTasks.n, 3, '两个 render 任务加一个分析任务');

  // --- 场景 2:旧租约回调不能覆盖新尝试 ---
  const attempt1 = claimedByWorker1!.attempt;
  // worker-1 尝试过期(租约 09:31:00 到期,过期检查推进到到期之后)
  expireStaleLeases(db, { now: () => new Date('2026-08-02T09:31:02.000Z') });
  const attempt1After = db.prepare(`SELECT status FROM batch_task_attempts WHERE id = ?`).get(attempt1.id) as { status: string };
  assert.equal(attempt1After.status, 'interrupted', '过期尝试必须结束为 interrupted');
  const task1After = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task1) as { status: string };
  assert.equal(task1After.status, 'queued', '过期后任务必须回到可领取状态');
  // worker-2 领取 task1(新尝试)
  const reclaim = claimNextTask(db, {
    workerId: 'worker-2',
    now: () => new Date('2026-08-02T09:31:03.000Z'),
    leaseDurationMs: 60_000,
  });
  assert.equal(reclaim?.task.id, task1, '任务必须被新 worker 重新领取');
  assert.notEqual(reclaim?.attempt.id, attempt1.id, '恢复后的执行必须是新的任务尝试');
  // 旧 worker-1 的迟到回调必须被拒绝(claimedBy 不匹配)
  assert.throws(
    () => completeTaskAttempt(db, attempt1.id, {
      workerId: 'worker-1',
      status: 'succeeded',
      now: () => new Date('2026-08-02T09:31:02.000Z'),
    }),
    /租约|持有者/,
    '旧租约的迟到回调不得覆盖新尝试',
  );
  const task1StillQueuedOrRunning = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task1) as { status: string };
  assert.notEqual(task1StillQueuedOrRunning.status, 'succeeded', '迟到回调不得把任务标记成功');

  // --- 场景 3:续租与完成 ---
  assert.equal(renewLease(db, reclaim!.attempt.id, {
    workerId: 'worker-2',
    now: () => new Date('2026-08-02T09:31:30.000Z'),
    leaseDurationMs: 60_000,
  }), true, '持有者可以续租');
  // 租约边界:到期时刻即视为过期——不能续租、不能提交结果
  const expiredAt = db.prepare(`SELECT leaseExpiresAt FROM batch_task_attempts WHERE id = ?`)
    .get(reclaim!.attempt.id) as { leaseExpiresAt: string };
  const atExpiry = new Date(expiredAt.leaseExpiresAt);
  assert.equal(
    renewLease(db, reclaim!.attempt.id, {
      workerId: 'worker-2',
      now: () => atExpiry,
      leaseDurationMs: 60_000,
    }),
    false,
    '租约到期时刻不能再续租(worker 不能自行复活过期租约)',
  );
  assert.throws(
    () => completeTaskAttempt(db, reclaim!.attempt.id, {
      workerId: 'worker-2',
      status: 'succeeded',
      now: () => atExpiry,
    }),
    /租约/,
    '租约到期后即使持有者匹配也不能提交成功结果',
  );
  completeTaskAttempt(db, reclaim!.attempt.id, {
    workerId: 'worker-2',
    status: 'succeeded',
    resultJson: { artifactId: 'artifact-1' },
    progressJson: { phase: 'done', percent: 1 },
    now: () => new Date('2026-08-02T09:32:00.000Z'),
  });
  const task1Done = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task1) as { status: string };
  assert.equal(task1Done.status, 'succeeded', '成功任务必须登记为 succeeded');

  // 完成第二个任务(worker-1 领取的 attempt2 也被过期了吗?没有——worker-1 的 attempt2 租约 09:31 过期,已被 expire 处理)
  const task2Row = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task2) as { status: string };
  assert.equal(task2Row.status, 'queued', 'task2 已被过期恢复回 queued');
  const reclaim2 = claimNextTask(db, {
    workerId: 'worker-1',
    now: () => new Date('2026-08-02T09:33:00.000Z'),
    leaseDurationMs: 60_000,
  });
  assert.equal(reclaim2?.task.id, task2);
  completeTaskAttempt(db, reclaim2!.attempt.id, {
    workerId: 'worker-1',
    status: 'succeeded',
    now: () => new Date('2026-08-02T09:33:30.000Z'),
  });
  // 清空 batch1 剩余的自动分析任务,避免残留 queued 干扰后续场景
  for (;;) {
    const leftover = claimNextTask(db, {
      workerId: 'worker-1',
      now: () => new Date('2026-08-02T09:34:00.000Z'),
      leaseDurationMs: 60_000,
    });
    if (!leftover) break;
    completeTaskAttempt(db, leftover.attempt.id, {
      workerId: 'worker-1',
      status: 'succeeded',
      now: () => new Date('2026-08-02T09:34:30.000Z'),
    });
  }

  // --- 场景 4:崩溃恢复:无残留 running ---
  // 造一个 running 尝试(模拟新批次),然后 recoverInterruptedWork
  const batch2 = createBatchProduction(db, 'project-1', '批次二', () => new Date('2026-08-02T10:00:00.000Z'));
  const snapshot2 = createBatchSnapshot(db, 'project-1', batch2, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections,
    now: () => new Date('2026-08-02T10:05:00.000Z'),
  });
  queueAssetPreparation(db, 'project-1', batch2, [asset1]);
  const v2Id = db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T10:06:00.000Z')
  `).run(`ov-b2`, snapshot2.planIds[0]!);
  void v2Id;
  const task3 = createBatchTask(db, 'project-1', {
    batchId: batch2,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-b2',
    now: () => new Date('2026-08-02T10:07:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batch2, () => new Date('2026-08-02T10:08:00.000Z'));
  claimNextTask(db, { workerId: 'worker-crashed', now: () => new Date('2026-08-02T10:10:00.000Z') });
  // 应用重启:所有 running 尝试必须失效
  recoverInterruptedWork(db, { now: () => new Date('2026-08-02T10:20:00.000Z') });
  const runningCount = db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE status = 'running'`).get() as { n: number };
  assert.equal(runningCount.n, 0, '重启后不得残留 running 任务');
  const task3Row = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task3) as { status: string };
  assert.equal(task3Row.status, 'queued', '崩溃任务恢复为可领取');

  // --- 场景 5:暂停后不再领取;继续后重新领取 ---
  pauseBatch(db, 'project-1', batch2, () => new Date('2026-08-02T10:30:00.000Z'));
  const pausedClaim = claimNextTask(db, { workerId: 'worker-1', now: () => new Date('2026-08-02T10:31:00.000Z') });
  assert.equal(pausedClaim, null, '暂停批次不得领取新任务');
  resumeBatch(db, 'project-1', batch2, () => new Date('2026-08-02T10:32:00.000Z'));
  const resumedClaim = claimNextTask(db, { workerId: 'worker-1', now: () => new Date('2026-08-02T10:33:00.000Z') });
  assert.equal(resumedClaim?.task.id, task3, '继续后任务重新可领取');
  completeTaskAttempt(db, resumedClaim!.attempt.id, { workerId: 'worker-1', status: 'succeeded', now: () => new Date('2026-08-02T10:34:00.000Z') });
  // 清空 batch2 剩余任务(分析任务),避免残留 queued 干扰后续场景
  for (;;) {
    const leftover = claimNextTask(db, {
      workerId: 'worker-1',
      now: () => new Date('2026-08-02T10:35:00.000Z'),
      leaseDurationMs: 60_000,
    });
    if (!leftover) break;
    completeTaskAttempt(db, leftover.attempt.id, {
      workerId: 'worker-1',
      status: 'succeeded',
      now: () => new Date('2026-08-02T10:35:30.000Z'),
    });
  }

  // --- 场景 6:停止批次:未完成任务不再领取,成功保留 ---
  const batch3 = createBatchProduction(db, 'project-1', '批次三', () => new Date('2026-08-02T11:00:00.000Z'));
  const snapshot3 = createBatchSnapshot(db, 'project-1', batch3, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections,
    now: () => new Date('2026-08-02T11:05:00.000Z'),
  });
  queueAssetPreparation(db, 'project-1', batch3, [asset1]);
  db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T11:06:00.000Z')
  `).run(`ov-b3`, snapshot3.planIds[0]!);
  const task4 = createBatchTask(db, 'project-1', {
    batchId: batch3,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-b3',
    now: () => new Date('2026-08-02T11:07:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batch3, () => new Date('2026-08-02T11:08:00.000Z'));
  stopBatch(db, 'project-1', batch3, () => new Date('2026-08-02T11:09:00.000Z'));
  const stoppedClaim = claimNextTask(db, { workerId: 'worker-1', now: () => new Date('2026-08-02T11:10:00.000Z') });
  assert.equal(stoppedClaim, null, '停止批次不得领取新任务');
  assert.equal(
    (db.prepare(`SELECT status, expectedState FROM batch_tasks WHERE id = ?`).get(task4) as {
      status: string;
      expectedState: string;
    }).status,
    'cancelled',
    '停止后未领取任务必须进入 cancelled 终态',
  );
  assert.deepEqual(
    getBatchProduction(db, 'project-1', batch3)?.progressJson,
    { succeeded: 0, failed: 2, total: 2 },
    '停止后批次汇总必须立即反映全部未完成任务已终结',
  );

  // --- 场景 6b:停止后用户显式再开跑,批次被重新激活,新排队任务可领取 ---
  assert.throws(
    () => resumeBatch(db, 'project-1', batch3),
    /终态/,
    'resumeBatch 不允许恢复已停止批次(调度器不得擅自复活)',
  );
  reactivateBatchForStart(db, 'project-1', batch3, () => new Date('2026-08-02T11:11:00.000Z'));
  assert.equal(
    (db.prepare(`SELECT controlState FROM batch_productions WHERE id = ?`).get(batch3) as { controlState: string }).controlState,
    'running',
    '显式开跑必须把已停止批次重新激活为 running',
  );
  const taskAfterRestart = (() => {
    db.prepare(`
      INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
      VALUES (?, ?, 2, '{}', '2026-08-02T11:11:30.000Z')
    `).run(`ov-b3-restart`, snapshot3.planIds[0]!);
    return createBatchTask(db, 'project-1', {
      batchId: batch3,
      workType: 'render',
      targetKind: 'output_version',
      targetId: 'ov-b3-restart',
      now: () => new Date('2026-08-02T11:12:00.000Z'),
    });
  })();
  const restartClaim = claimNextTask(db, { workerId: 'worker-1', now: () => new Date('2026-08-02T11:13:00.000Z') });
  assert.equal(restartClaim?.task.id, taskAfterRestart, '重新激活后新排队任务必须可被领取');
  completeTaskAttempt(db, restartClaim!.attempt.id, {
    workerId: 'worker-1',
    status: 'succeeded',
    now: () => new Date('2026-08-02T11:14:00.000Z'),
  });
  // 暂停中的批次显式开跑同样恢复 running
  pauseBatch(db, 'project-1', batch3, () => new Date('2026-08-02T11:15:00.000Z'));
  reactivateBatchForStart(db, 'project-1', batch3, () => new Date('2026-08-02T11:16:00.000Z'));
  assert.equal(
    (db.prepare(`SELECT controlState FROM batch_productions WHERE id = ?`).get(batch3) as { controlState: string }).controlState,
    'running',
    '显式开跑也必须把已暂停批次恢复为 running',
  );

  // --- 场景 7:失败重试 ---
  const batch4 = createBatchProduction(db, 'project-1', '批次四', () => new Date('2026-08-02T12:00:00.000Z'));
  const snapshot4 = createBatchSnapshot(db, 'project-1', batch4, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections,
    now: () => new Date('2026-08-02T12:05:00.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T12:06:00.000Z')
  `).run(`ov-b4`, snapshot4.planIds[0]!);
  const task5 = createBatchTask(db, 'project-1', {
    batchId: batch4,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-b4',
    now: () => new Date('2026-08-02T12:07:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batch4, () => new Date('2026-08-02T12:08:00.000Z'));
  const failAttempt = claimNextTask(db, { workerId: 'worker-1', now: () => new Date('2026-08-02T12:10:00.000Z') });
  completeTaskAttempt(db, failAttempt!.attempt.id, {
    workerId: 'worker-1',
    status: 'failed',
    errorCode: 'render_error',
    errorMessage: '渲染失败',
    now: () => new Date('2026-08-02T12:11:00.000Z'),
  });
  assert.equal(
    (db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task5) as { status: string }).status,
    'failed',
  );
  retryTask(db, 'project-1', task5, () => new Date('2026-08-02T12:12:00.000Z'));
  assert.equal(
    (db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task5) as { status: string }).status,
    'queued',
    '重试后任务回到可领取状态',
  );
  const retried = claimNextTask(db, { workerId: 'worker-1', now: () => new Date('2026-08-02T12:13:00.000Z') });
  assert.equal(retried?.task.id, task5);
  const attemptCount = db.prepare(`
    SELECT COUNT(*) AS n FROM batch_task_attempts WHERE taskId = ?
  `).get(task5) as { n: number };
  assert.equal(attemptCount.n, 2, '重试只增加任务尝试,不产生新任务');

  // 已失败任务在停止批次后也必须进入终态,且不能再被重试复活。
  completeTaskAttempt(db, retried!.attempt.id, {
    workerId: 'worker-1',
    status: 'failed',
    errorCode: 'render_error',
    errorMessage: '再次失败',
    now: () => new Date('2026-08-02T12:14:00.000Z'),
  });
  stopBatch(db, 'project-1', batch4, () => new Date('2026-08-02T12:15:00.000Z'));
  assert.deepEqual(
    db.prepare(`SELECT status, expectedState FROM batch_tasks WHERE id = ?`).get(task5),
    { status: 'cancelled', expectedState: 'stopped' },
    '停止必须终结已失败但尚未完成的任务',
  );
  assert.throws(
    () => retryTask(db, 'project-1', task5, () => new Date('2026-08-02T12:16:00.000Z')),
    (error: unknown) => error instanceof Error && /停止|终态/.test(error.message),
    'stopped 批次中的失败任务不得被重试复活',
  );

  // --- 场景 8:完成回调自身也必须拒绝 stopped 后的迟到成功 ---
  const batch5 = createBatchProduction(db, 'project-1', '批次五', () => new Date('2026-08-02T13:00:00.000Z'));
  const snapshot5 = createBatchSnapshot(db, 'project-1', batch5, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections,
    now: () => new Date('2026-08-02T13:05:00.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T13:06:00.000Z')
  `).run('ov-b5', snapshot5.planIds[0]!);
  const task6 = createBatchTask(db, 'project-1', {
    batchId: batch5,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-b5',
    now: () => new Date('2026-08-02T13:07:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batch5, () => new Date('2026-08-02T13:08:00.000Z'));
  const lateAttempt = claimNextTask(db, {
    workerId: 'worker-late',
    now: () => new Date('2026-08-02T13:09:00.000Z'),
  });
  assert.equal(lateAttempt?.task.id, task6);
  stopBatch(db, 'project-1', batch5, () => new Date('2026-08-02T13:10:00.000Z'));
  assert.throws(
    () => completeTaskAttempt(db, lateAttempt!.attempt.id, {
      workerId: 'worker-late',
      status: 'succeeded',
      now: () => new Date('2026-08-02T13:11:00.000Z'),
    }),
    /停止|运行期望|控制状态/,
    '底层完成 seam 不得依赖 runner 才能拒绝停止后的迟到成功',
  );
  recoverInterruptedWork(db, { now: () => new Date('2026-08-02T13:12:00.000Z') });
  assert.deepEqual(
    db.prepare(`SELECT status, expectedState FROM batch_tasks WHERE id = ?`).get(task6),
    { status: 'cancelled', expectedState: 'stopped' },
    '启动恢复遇到 stopped 批次时必须收敛为 cancelled,不能留下 queued + stopped',
  );

  // --- 场景 9:停止后的过期租约也必须直接收敛为 cancelled ---
  const batch6 = createBatchProduction(db, 'project-1', '批次六', () => new Date('2026-08-02T14:00:00.000Z'));
  const snapshot6 = createBatchSnapshot(db, 'project-1', batch6, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections,
    now: () => new Date('2026-08-02T14:05:00.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T14:06:00.000Z')
  `).run('ov-b6', snapshot6.planIds[0]!);
  const task7 = createBatchTask(db, 'project-1', {
    batchId: batch6,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-b6',
    now: () => new Date('2026-08-02T14:07:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batch6, () => new Date('2026-08-02T14:08:00.000Z'));
  const staleStopped = claimNextTask(db, {
    workerId: 'worker-stale-stopped',
    now: () => new Date('2026-08-02T14:09:00.000Z'),
    leaseDurationMs: 1_000,
  });
  assert.equal(staleStopped?.task.id, task7);
  stopBatch(db, 'project-1', batch6, () => new Date('2026-08-02T14:09:00.500Z'));
  expireStaleLeases(db, { now: () => new Date('2026-08-02T14:09:02.000Z') });
  assert.deepEqual(
    db.prepare(`SELECT status, expectedState FROM batch_tasks WHERE id = ?`).get(task7),
    { status: 'cancelled', expectedState: 'stopped' },
    '租约回收遇到 stopped 批次时必须收敛为 cancelled 终态',
  );

  // --- 场景 10:编辑器优先——封面任务不被口播闸门阻塞,整片渲染仍被闸门保护;failed 封面可显式重试 ---
  const batch7 = createBatchProduction(db, 'project-1', '批次七', () => new Date('2026-08-02T15:00:00.000Z'));
  const snapshot7 = createBatchSnapshot(db, 'project-1', batch7, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections,
    now: () => new Date('2026-08-02T15:05:00.000Z'),
  });
  const plan7 = db.prepare(`
    SELECT id AS planId, scriptSnapshotId AS snapshotId
    FROM batch_output_plans WHERE id = ?
  `).get(snapshot7.planIds[0]!) as { planId: string; snapshotId: string };
  db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T15:06:00.000Z')
  `).run('ov-b7', plan7.planId);
  const narration7 = createBatchTask(db, 'project-1', {
    batchId: batch7,
    workType: 'narration',
    targetKind: 'script_snapshot',
    targetId: plan7.snapshotId,
    now: () => new Date('2026-08-02T15:07:00.000Z'),
  });
  const cover7 = createBatchTask(db, 'project-1', {
    batchId: batch7,
    workType: 'render',
    targetKind: 'output_version_cover',
    targetId: 'ov-b7',
    now: () => new Date('2026-08-02T15:08:00.000Z'),
  });
  const full7 = createBatchTask(db, 'project-1', {
    batchId: batch7,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-b7',
    now: () => new Date('2026-08-02T15:09:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batch7, () => new Date('2026-08-02T15:10:00.000Z'));
  // 清掉此前场景遗留的排队任务(不含场景 10 的三条),保证断言只对场景 10 生效。
  db.prepare(`
    UPDATE batch_tasks
    SET status = 'cancelled', expectedState = 'stopped', updatedAt = ?
    WHERE status = 'queued' AND id NOT IN (?, ?, ?)
  `).run('2026-08-02T15:10:30.000Z', narration7, cover7, full7);
  const claimNarration7 = claimNextTask(db, {
    workerId: 'w-narr7',
    now: () => new Date('2026-08-02T15:12:00.000Z'),
  });
  assert.equal(claimNarration7?.task.id, narration7, '口播任务本身可正常领取');
  const claimCover7 = claimNextTask(db, {
    workerId: 'w-cover7',
    now: () => new Date('2026-08-02T15:13:00.000Z'),
  });
  assert.equal(claimCover7?.task.id, cover7, '封面任务不被口播闸门阻塞');
  const claimFullBlocked = claimNextTask(db, {
    workerId: 'w-full7',
    now: () => new Date('2026-08-02T15:14:00.000Z'),
  });
  assert.equal(claimFullBlocked, null, '口播未完成时整片渲染必须被闸门挡住');
  completeTaskAttempt(db, claimNarration7!.attempt.id, {
    workerId: 'w-narr7',
    status: 'succeeded',
    now: () => new Date('2026-08-02T15:15:00.000Z'),
  });
  const claimFull7 = claimNextTask(db, {
    workerId: 'w-full7',
    now: () => new Date('2026-08-02T15:16:00.000Z'),
  });
  assert.equal(claimFull7?.task.id, full7, '口播成功后整片渲染放行');
  // failed 封面任务必须能显式重试,不能永久卡死。
  completeTaskAttempt(db, claimCover7!.attempt.id, {
    workerId: 'w-cover7',
    status: 'failed',
    errorCode: 'cover_error',
    errorMessage: '封面编码失败',
    now: () => new Date('2026-08-02T15:17:00.000Z'),
  });
  assert.equal(
    (db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(cover7) as { status: string }).status,
    'failed',
  );
  retryTask(db, 'project-1', cover7, () => new Date('2026-08-02T15:18:00.000Z'));
  assert.equal(
    (db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(cover7) as { status: string }).status,
    'queued',
    'failed 封面任务可显式重试',
  );

  db.close();
  console.log('batch scheduler tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
