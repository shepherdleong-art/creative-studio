import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchProduction } from '../lib/batch-production/versions.ts';
import { createProjectScript } from '../lib/batch-production/scripts.ts';
import { createBatchSnapshot, startBatchProduction } from '../lib/batch-production/batch-flow.ts';
import { createBatchTask, getBatchTask, listTaskAttempts } from '../lib/batch-production/tasks.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { resolveCoverContractHash } from '../lib/batch-production/cover-contract.ts';
import { pauseBatch, resumeBatch, stopBatch, claimNextTask, completeTaskAttempt } from '../lib/batch-production/scheduler.ts';
import {
  resetSchedulerSingletonForTests,
  runPendingOnce,
  startBatchScheduler,
  wakeBatchScheduler,
} from '../lib/batch-production/runner.ts';
import type { BatchTaskExecutor } from '../lib/batch-production/executors.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      productCode TEXT DEFAULT '',
      exportDirName TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      storeCode TEXT NOT NULL DEFAULT '',
      productSubmodel TEXT NOT NULL DEFAULT '',
      productionType TEXT NOT NULL DEFAULT '',
      editorName TEXT NOT NULL DEFAULT '',
      namingDate TEXT NOT NULL DEFAULT '',
      currentExportIdentityId TEXT
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-runner-'));

/** 受控执行器:执行挂起,由测试显式 release 或等待 abort */
function controlledExecutor(): {
  executor: BatchTaskExecutor;
  activePeak: { value: number };
  releases: Array<() => void>;
  aborts: Array<() => boolean>;
} {
  const activePeak = { value: 0 };
  let active = 0;
  const releases: Array<() => void> = [];
  const aborts: Array<() => boolean> = [];
  const executor: BatchTaskExecutor = {
    workTypes: ['render'],
    execute({ signal }) {
      return new Promise((resolve, reject) => {
        active += 1;
        if (active > activePeak.value) activePeak.value = active;
        let settled = false;
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          active -= 1;
          reject(new Error('任务已中止'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        releases.push(() => {
          if (settled) return;
          settled = true;
          active -= 1;
          signal.removeEventListener('abort', onAbort);
          resolve({ resultJson: {} });
        });
        aborts.push(() => signal.aborted);
      });
    },
  };
  return { executor, activePeak, releases, aborts };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor 超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 建立一个开跑批次并创建 n 个 render 任务 */
function setupBatch(db: Database.Database, name: string, n: number): string {
  const scriptA = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: `draft-${name}`,
    title: '口播A',
    bodyText: '正文A',
    sourceVersion: '2',
    now: () => new Date('2026-08-02T09:00:00.000Z'),
  });
  const assetId = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'v1', shotSetId: 'ss-1', relativePath: 'videos/a.mp4' },
    contentFingerprint: `sha256:${name}`,
    mediaKind: 'video',
    now: () => new Date('2026-08-02T09:03:00.000Z'),
  });
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'v0',
    providerId: 'p',
    model: 'm',
    now: () => new Date('2026-08-02T09:04:00.000Z'),
  });
  const batchId = createBatchProduction(db, 'project-1', name, () => new Date('2026-08-02T09:05:00.000Z'));
  const { planIds } = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: scriptA, copyCount: n }],
    assetSelections: [{ assetId, analysisId }],
    now: () => new Date('2026-08-02T09:10:00.000Z'),
  });
  for (let i = 0; i < n; i += 1) {
    const planId = planIds[i]!;
    db.prepare(`
      INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
      VALUES (?, ?, 1, '{}', '2026-08-02T09:12:00.000Z')
    `).run(`ov-${name}-${i}`, planId);
    db.prepare(`UPDATE batch_output_plans SET currentVersionId = ? WHERE id = ?`).run(`ov-${name}-${i}`, planId);
    createBatchTask(db, 'project-1', {
      batchId,
      workType: 'render',
      targetKind: 'output_version',
      targetId: `ov-${name}-${i}`,
      now: () => new Date('2026-08-02T09:15:00.000Z'),
    });
  }
  startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-02T09:20:00.000Z'));
  return batchId;
}

/** 只建立开跑批次与脚本快照,不预建 render 任务(按需入队场景使用)。 */
function setupBatchShell(db: Database.Database, name: string): {
  batchId: string;
  snapshotId: string;
  assetId: string;
} {
  const script = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: `draft-shell-${name}`,
    title: '口播A',
    bodyText: '正文A',
    sourceVersion: '2',
    now: () => new Date('2026-08-02T09:00:00.000Z'),
  });
  const assetId = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'v1', shotSetId: 'ss-1', relativePath: 'videos/a.mp4' },
    contentFingerprint: `sha256:shell-${name}`,
    mediaKind: 'video',
    now: () => new Date('2026-08-02T09:03:00.000Z'),
  });
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'v0',
    providerId: 'p',
    model: 'm',
    now: () => new Date('2026-08-02T09:04:00.000Z'),
  });
  const batchId = createBatchProduction(db, 'project-1', name, () => new Date('2026-08-02T09:05:00.000Z'));
  const { planIds } = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId, analysisId }],
    now: () => new Date('2026-08-02T09:10:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-02T09:20:00.000Z'));
  const plan = db.prepare(`
    SELECT scriptSnapshotId FROM batch_output_plans WHERE id = ?
  `).get(planIds[0]!) as { scriptSnapshotId: string };
  return { batchId, snapshotId: plan.scriptSnapshotId, assetId };
}

/** 隔离场景:把此前场景遗留的排队/运行任务收成终态。 */
function cancelOutstandingTasks(db: Database.Database): void {
  db.prepare(`
    UPDATE batch_tasks SET status = 'cancelled', expectedState = 'stopped'
    WHERE status IN ('queued', 'running')
  `).run();
}

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

  // --- 场景 1:受控并发池——peak ≤ concurrency,且 concurrency>1 时确实并行 ---
  const batchA = setupBatch(db, 'batch-a', 5);
  const controlled = controlledExecutor();
  const runPromise = runPendingOnce({
    db,
    workerId: 'worker-1',
    executors: [controlled.executor],
    concurrency: 2,
    progressThrottleMs: 0,
  });
  await waitFor(() => controlled.releases.length >= 2, 3000);
  assert.equal(controlled.activePeak.value, 2, 'concurrency=2 时两个任务并行执行');
  assert.ok(controlled.activePeak.value <= 2, '全局同时运行数不得超过 concurrency');
  // 逐个释放,验证不会再超过 2
  while (controlled.releases.length > 0) {
    const release = controlled.releases.shift()!;
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(controlled.activePeak.value <= 2, '释放后新领取也不能突破并发上限');
  }
  await runPromise;
  const doneTasks = db.prepare(`
    SELECT COUNT(*) AS n FROM batch_tasks WHERE batchId = ? AND status = 'succeeded'
  `).get(batchA) as { n: number };
  assert.equal(doneTasks.n, 5, '5 个 render 任务全部完成');
  const renderAttempts = db.prepare(`
    SELECT a.status FROM batch_task_attempts a
    JOIN batch_tasks t ON t.id = a.taskId
    WHERE t.batchId = ? AND t.workType = 'render'
  `).all(batchA) as Array<{ status: string }>;
  assert.ok(renderAttempts.every(({ status }) => status === 'succeeded'), '全部 render 尝试必须成功');

  // 素材分析独立占 4 位，不能把渲染并发从 2 一并抬高；取消排空两条队列。
  const mixedBatch = setupBatch(db, 'analysis-lanes', 5);
  const mixedAsset = (db.prepare('SELECT id FROM batch_assets LIMIT 1').get() as { id: string }).id;
  for (let i = 0; i < 9; i++) createBatchTask(db, 'project-1', {
    batchId: mixedBatch, workType: 'asset_prepare', targetKind: 'asset', targetId: mixedAsset,
    requestKey: `analysis-lanes-${i}`,
  });
  const renders = controlledExecutor();
  const analyses = controlledExecutor();
  analyses.executor.workTypes = ['asset_prepare'];
  const mixedStop = new AbortController();
  const mixedRun = runPendingOnce({ db, workerId: 'analysis-lanes',
    executors: [renders.executor, analyses.executor], concurrency: 2, analysisConcurrency: 4,
    signal: mixedStop.signal });
  await waitFor(() => renders.releases.length === 2 && analyses.releases.length === 4);
  analyses.releases.shift()!();
  await waitFor(() => analyses.releases.length === 4);
  assert.equal(analyses.activePeak.value, 4, '独立分析位应补位且保持 4 路');
  assert.equal(renders.activePeak.value, 2, '通用执行位不得领取分析或抬高渲染并发');
  mixedStop.abort();
  await mixedRun;
  assert(analyses.aborts.every(aborted => aborted()));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM batch_tasks WHERE batchId=? AND status='running'").get(mixedBatch) as { n: number }).n, 0);
  stopBatch(db, 'project-1', mixedBatch);

  // --- 场景 2:暂停中止运行任务,resume 后重新可领取 ---
  const batchB = setupBatch(db, 'batch-b', 2);
  const controlledB = controlledExecutor();
  const runPromiseB = runPendingOnce({
    db,
    workerId: 'worker-1',
    executors: [controlledB.executor],
    concurrency: 1,
    progressThrottleMs: 0,
  });
  await waitFor(() => controlledB.releases.length >= 1, 3000);
  pauseBatch(db, 'project-1', batchB, () => new Date('2026-08-02T10:00:00.000Z'));
  await waitFor(() => controlledB.aborts.length > 0 && controlledB.aborts[0]!(), 3000);
  await runPromiseB;
  const pausedTask = db.prepare(`
    SELECT status, expectedState FROM batch_tasks WHERE batchId = ? ORDER BY createdAt LIMIT 1
  `).get(batchB) as { status: string; expectedState: string };
  assert.equal(pausedTask.status, 'queued', '暂停中止的任务回到可继续队列');
  assert.equal(pausedTask.expectedState, 'paused', '暂停的任务标记为 paused');
  const interruptedCount = db.prepare(`
    SELECT COUNT(*) AS n FROM batch_task_attempts a
    JOIN batch_tasks t ON t.id = a.taskId
    WHERE t.batchId = ? AND a.status = 'interrupted'
  `).get(batchB) as { n: number };
  assert.equal(interruptedCount.n, 1, '被暂停的任务尝试必须记录为 interrupted');
  // resume 后重新可领取
  resumeBatch(db, 'project-1', batchB, () => new Date('2026-08-02T10:05:00.000Z'));
  const resumedClaim = claimNextTask(db, { workerId: 'worker-1', now: () => new Date('2026-08-02T10:06:00.000Z') });
  assert.ok(resumedClaim, '继续后任务重新可领取');
  assert.equal(resumedClaim!.task.batchId, batchB);
  // 把 batchB 剩余任务全部完成,避免影响后续场景的领取顺序
  let remaining: Awaited<ReturnType<typeof claimNextTask>> = resumedClaim;
  while (remaining) {
    completeTaskAttempt(db, remaining.attempt.id, {
      workerId: 'worker-1',
      status: 'succeeded',
      now: () => new Date('2026-08-02T10:07:00.000Z'),
    });
    remaining = claimNextTask(db, { workerId: 'worker-1', now: () => new Date('2026-08-02T10:08:00.000Z') });
  }

  // --- 场景 3:停止中止运行任务且不得 succeeded;stopped 是终态 ---
  const batchC = setupBatch(db, 'batch-c', 1);
  const controlledC = controlledExecutor();
  const runPromiseC = runPendingOnce({
    db,
    workerId: 'worker-1',
    executors: [controlledC.executor],
    concurrency: 1,
    progressThrottleMs: 0,
  });
  await waitFor(() => controlledC.releases.length >= 1, 3000);
  stopBatch(db, 'project-1', batchC, () => new Date('2026-08-02T11:00:00.000Z'));
  await waitFor(() => controlledC.aborts.length > 0 && controlledC.aborts[0]!(), 3000);
  await runPromiseC;
  const stoppedTask = db.prepare(`
    SELECT status, expectedState FROM batch_tasks WHERE batchId = ?
  `).get(batchC) as { status: string; expectedState: string };
  assert.equal(stoppedTask.status, 'cancelled', '停止后运行任务进入 cancelled 终态,不得 succeeded');
  assert.equal(stoppedTask.expectedState, 'stopped');
  assert.throws(
    () => resumeBatch(db, 'project-1', batchC, () => new Date('2026-08-02T11:05:00.000Z')),
    /终态/,
    'stopped 批次是终态,resume 不得复活',
  );

  // --- 场景 4:执行器忽略 abort 并迟到返回,停止后也不得发布 succeeded ---
  const batchLate = setupBatch(db, 'batch-late-success', 1);
  const lateTask = db.prepare(`
    SELECT id FROM batch_tasks
    WHERE batchId = ? AND workType = 'render'
    ORDER BY createdAt LIMIT 1
  `).get(batchLate) as { id: string };
  let lateStarted = false;
  let lateDiscarded = 0;
  let lateCommitted = 0;
  const ignoresAbortExecutor: BatchTaskExecutor = {
    workTypes: ['render'],
    async execute() {
      lateStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        commit: () => {
          lateCommitted += 1;
          // commit 内触发外部中止，runner 必须在同一事务中二次检查并回滚。
          return { resultJson: { late: true } };
        },
        discard: () => { lateDiscarded += 1; },
      };
    },
  };
  const lateRun = runPendingOnce({
    db,
    workerId: 'worker-late',
    executors: [ignoresAbortExecutor],
    concurrency: 1,
    heartbeatMs: 10,
    leaseDurationMs: 1_000,
    progressThrottleMs: 0,
  });
  await waitFor(() => lateStarted);
  stopBatch(db, 'project-1', batchLate);
  await lateRun;
  assert.equal(
    getBatchTask(db, 'project-1', lateTask.id)?.status,
    'cancelled',
    '停止后的迟到执行结果不得发布为 succeeded',
  );
  assert.equal(
    listTaskAttempts(db, lateTask.id)[0]?.status,
    'interrupted',
    '被停止的运行尝试必须保留为 interrupted',
  );
  assert.equal(lateDiscarded, 1, '调度器拒绝迟到结果时必须调用执行器候选清理钩子');
  assert.equal(lateCommitted, 0, '调度器拒绝迟到结果时不得调用同步发布钩子');

  const batchAbortInCommit = setupBatch(db, 'batch-abort-in-commit', 1);
  const abortInCommitTask = db.prepare(`
    SELECT id FROM batch_tasks WHERE batchId = ? AND workType = 'render' LIMIT 1
  `).get(batchAbortInCommit) as { id: string };
  const commitAbortController = new AbortController();
  let commitSideEffect = 0;
  const originalAbortBatchName = (db.prepare(`SELECT name FROM batch_productions WHERE id = ?`).get(batchAbortInCommit) as { name: string }).name;
  const abortInCommitExecutor: BatchTaskExecutor = {
    workTypes: ['render'],
    async execute() {
      return {
        commit: () => {
          commitSideEffect += 1;
          db.prepare(`UPDATE batch_productions SET name = '不得保留' WHERE id = ?`).run(batchAbortInCommit);
          commitAbortController.abort();
          return { resultJson: { mustRollback: true } };
        },
      };
    },
  };
  await runPendingOnce({
    db,
    workerId: 'worker-abort-in-commit',
    executors: [abortInCommitExecutor],
    concurrency: 1,
    signal: commitAbortController.signal,
    progressThrottleMs: 0,
  });
  assert.equal(commitSideEffect, 1, '测试必须进入同步发布钩子');
  assert.equal(
    getBatchTask(db, 'project-1', abortInCommitTask.id)?.status,
    'cancelled',
    '发布回调内触发外部中止后不得落 succeeded',
  );
  assert.equal(
    (db.prepare(`SELECT name FROM batch_productions WHERE id = ?`).get(batchAbortInCommit) as { name: string }).name,
    originalAbortBatchName,
    '发布回调内的数据库副作用必须随事务一起回滚',
  );

  // --- 场景 5:租约丢失不是用户暂停,任务保持可恢复运行期望 ---
  const batchLease = setupBatch(db, 'batch-lease-loss', 1);
  const leaseTask = db.prepare(`
    SELECT id FROM batch_tasks
    WHERE batchId = ? AND workType = 'render'
    ORDER BY createdAt LIMIT 1
  `).get(batchLease) as { id: string };
  let leaseExecutions = 0;
  const leaseLossExecutor: BatchTaskExecutor = {
    workTypes: ['render'],
    execute({ signal }) {
      leaseExecutions += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('租约中断')), { once: true });
        if (leaseExecutions > 1) {
          resolve({ resultJson: {} });
        }
      });
    },
  };
  await runPendingOnce({
    db,
    workerId: 'worker-lease',
    executors: [leaseLossExecutor],
    concurrency: 1,
    heartbeatMs: 80,
    leaseDurationMs: 20,
    progressThrottleMs: 0,
  });
  assert.deepEqual(
    {
      status: getBatchTask(db, 'project-1', leaseTask.id)?.status,
      expectedState: getBatchTask(db, 'project-1', leaseTask.id)?.expectedState,
      attemptStatus: listTaskAttempts(db, leaseTask.id)[0]?.status,
    },
    { status: 'queued', expectedState: 'running', attemptStatus: 'interrupted' },
    '租约丢失必须回到可领取状态,不能伪造用户暂停',
  );
  assert.equal(leaseExecutions, 1, '同一调度轮不得立即反复领取刚丢失租约的任务');
  stopBatch(db, 'project-1', batchLease);

  // --- 场景 6:重分配切换 currentVersionId 后拒绝并清理旧 render 的迟到结果 ---
  const batchSuperseded = setupBatch(db, 'batch-superseded', 1);
  const superseded = db.prepare(`
    SELECT t.id AS taskId, t.targetId, o.planId
    FROM batch_tasks t JOIN batch_output_versions o ON o.id = t.targetId
    WHERE t.batchId = ? AND t.workType = 'render'
  `).get(batchSuperseded) as { taskId: string; targetId: string; planId: string };
  let supersededStarted = false;
  let releaseSuperseded!: () => void;
  let supersededDiscarded = 0;
  const supersededExecutor: BatchTaskExecutor = {
    workTypes: ['render'],
    async execute() {
      supersededStarted = true;
      await new Promise<void>((resolve) => { releaseSuperseded = resolve; });
      return { resultJson: { stale: true }, discard: () => { supersededDiscarded += 1; } };
    },
  };
  const supersededRun = runPendingOnce({
    db, workerId: 'worker-superseded', executors: [supersededExecutor], concurrency: 1,
    heartbeatMs: 10, leaseDurationMs: 1_000, progressThrottleMs: 0,
  });
  await waitFor(() => supersededStarted);
  db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 2, '{}', '2026-08-02T12:00:00.000Z')
  `).run(`${superseded.targetId}-new`, superseded.planId);
  db.prepare(`UPDATE batch_output_plans SET currentVersionId = ? WHERE id = ?`).run(`${superseded.targetId}-new`, superseded.planId);
  releaseSuperseded();
  await supersededRun;
  assert.deepEqual(
    {
      status: getBatchTask(db, 'project-1', superseded.taskId)?.status,
      expectedState: getBatchTask(db, 'project-1', superseded.taskId)?.expectedState,
      attemptStatus: listTaskAttempts(db, superseded.taskId)[0]?.status,
      discarded: supersededDiscarded,
    },
    { status: 'cancelled', expectedState: 'stopped', attemptStatus: 'interrupted', discarded: 1 },
    '被新版本替代的 render 不得成功落账且必须清理迟到候选',
  );

  // --- 场景 6b:旧版本封面任务(output_version_cover)的晚到结果同样被丢弃并清理 ---
  const batchCoverSuperseded = setupBatch(db, 'batch-cover-superseded', 1);
  const coverRow = db.prepare(`
    SELECT t.id AS fullTaskId, t.targetId, o.planId
    FROM batch_tasks t JOIN batch_output_versions o ON o.id = t.targetId
    WHERE t.batchId = ? AND t.workType = 'render'
  `).get(batchCoverSuperseded) as { fullTaskId: string; targetId: string; planId: string };
  db.prepare(`UPDATE batch_tasks SET status = 'cancelled', expectedState = 'stopped' WHERE id = ?`).run(coverRow.fullTaskId);
  const coverTaskId = createBatchTask(db, 'project-1', {
    batchId: batchCoverSuperseded,
    workType: 'render',
    targetKind: 'output_version_cover',
    targetId: coverRow.targetId,
    now: () => new Date('2026-08-02T12:30:00.000Z'),
  });
  let coverStarted = false;
  let releaseCover!: () => void;
  let coverDiscarded = 0;
  const coverExecutor: BatchTaskExecutor = {
    workTypes: ['render'],
    async execute() {
      coverStarted = true;
      await new Promise<void>((resolve) => { releaseCover = resolve; });
      return { resultJson: { stale: true }, discard: () => { coverDiscarded += 1; } };
    },
  };
  const coverSupersededRun = runPendingOnce({
    db, workerId: 'worker-cover-superseded', executors: [coverExecutor], concurrency: 1,
    heartbeatMs: 10, leaseDurationMs: 1_000, progressThrottleMs: 0,
  });
  await waitFor(() => coverStarted);
  db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 2, '{}', '2026-08-02T12:31:00.000Z')
  `).run(`${coverRow.targetId}-new`, coverRow.planId);
  db.prepare(`UPDATE batch_output_plans SET currentVersionId = ? WHERE id = ?`).run(`${coverRow.targetId}-new`, coverRow.planId);
  releaseCover();
  await coverSupersededRun;
  assert.deepEqual(
    {
      status: getBatchTask(db, 'project-1', coverTaskId)?.status,
      expectedState: getBatchTask(db, 'project-1', coverTaskId)?.expectedState,
      attemptStatus: listTaskAttempts(db, coverTaskId)[0]?.status,
      discarded: coverDiscarded,
    },
    { status: 'cancelled', expectedState: 'stopped', attemptStatus: 'interrupted', discarded: 1 },
    '被新版本替代的封面任务不得成功落账且必须清理迟到候选',
  );

  // --- 场景 6c:同版本换封面(契约变化)后,旧封面任务的迟到结果不得落账 ---
  // 版本指针没变,只有当前封面契约变了:完成前 CAS 必须按 requestKey 契约拦截。
  const batchCoverRolling = setupBatch(db, 'batch-cover-rolling', 1);
  const rollingRow = db.prepare(`
    SELECT t.id AS fullTaskId, t.targetId, o.planId, p.batchVersionId
    FROM batch_tasks t
    JOIN batch_output_versions o ON o.id = t.targetId
    JOIN batch_output_plans p ON p.id = o.planId
    WHERE t.batchId = ? AND t.workType = 'render' AND t.targetKind = 'output_version'
  `).get(batchCoverRolling) as {
    fullTaskId: string;
    targetId: string;
    planId: string;
    batchVersionId: string;
  };
  db.prepare(`UPDATE batch_tasks SET status = 'cancelled', expectedState = 'stopped' WHERE id = ?`).run(rollingRow.fullTaskId);
  const rollingAsset = db.prepare(`SELECT assetId FROM batch_asset_pool_items WHERE batchVersionId = ? LIMIT 1`)
    .get(rollingRow.batchVersionId) as { assetId: string } | undefined;
  assert.ok(rollingAsset, 'fixture:快照必须有素材池条目');
  const writeRollingArrangement = (coverTimeUs: number): void => {
    db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`).run(
      JSON.stringify({
        preset: '3:4',
        clips: [{
          clipId: 'clip-1', assetId: rollingAsset.assetId,
          sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000,
        }],
        cover: { assetId: rollingAsset.assetId, timeUs: coverTimeUs },
      }),
      rollingRow.targetId,
    );
  };
  writeRollingArrangement(1_000_000);
  const rollingKey = `cover:${rollingRow.targetId}:${resolveCoverContractHash(db, rollingRow.targetId)}`;
  const rollingCoverTaskId = createBatchTask(db, 'project-1', {
    batchId: batchCoverRolling,
    workType: 'render',
    targetKind: 'output_version_cover',
    targetId: rollingRow.targetId,
    requestKey: rollingKey,
    now: () => new Date('2026-08-02T12:40:00.000Z'),
  });
  let rollingStarted = false;
  let releaseRolling!: () => void;
  let rollingDiscarded = 0;
  const rollingExecutor: BatchTaskExecutor = {
    workTypes: ['render'],
    async execute() {
      rollingStarted = true;
      await new Promise<void>((resolve) => { releaseRolling = resolve; });
      return { resultJson: { stale: true }, discard: () => { rollingDiscarded += 1; } };
    },
  };
  const rollingRun = runPendingOnce({
    db, workerId: 'worker-cover-rolling', executors: [rollingExecutor], concurrency: 1,
    heartbeatMs: 10, leaseDurationMs: 1_000, progressThrottleMs: 0,
  });
  await waitFor(() => rollingStarted);
  // 渲染进行中,同版本换了封面时间点:版本指针与 requestKey 都没有变,
  // 但当前封面契约已经变了——旧任务的迟到结果必须被滚动 CAS 丢弃。
  writeRollingArrangement(2_000_000);
  releaseRolling();
  await rollingRun;
  assert.deepEqual(
    {
      status: getBatchTask(db, 'project-1', rollingCoverTaskId)?.status,
      expectedState: getBatchTask(db, 'project-1', rollingCoverTaskId)?.expectedState,
      attemptStatus: listTaskAttempts(db, rollingCoverTaskId)[0]?.status,
      discarded: rollingDiscarded,
    },
    { status: 'cancelled', expectedState: 'stopped', attemptStatus: 'interrupted', discarded: 1 },
    '同版本契约变化的封面任务迟到结果不得落账且必须清理',
  );

  // --- 场景 6d:封面 A 任务若实际读取了 B 快照,即使结束前又切回 A 也不得落账 ---
  // 只比较「任务 key = 当前 key」会漏掉这个回环；还必须核对执行结果携带的
  // coverContractHash，证明产物确实来自任务声明的冻结契约。
  const batchCoverResultMismatch = setupBatch(db, 'batch-cover-result-mismatch', 1);
  const mismatchRow = db.prepare(`
    SELECT t.id AS fullTaskId, t.targetId, o.planId, p.batchVersionId
    FROM batch_tasks t
    JOIN batch_output_versions o ON o.id = t.targetId
    JOIN batch_output_plans p ON p.id = o.planId
    WHERE t.batchId = ? AND t.workType = 'render' AND t.targetKind = 'output_version'
  `).get(batchCoverResultMismatch) as {
    fullTaskId: string;
    targetId: string;
    planId: string;
    batchVersionId: string;
  };
  db.prepare(`UPDATE batch_tasks SET status = 'cancelled', expectedState = 'stopped' WHERE id = ?`).run(mismatchRow.fullTaskId);
  const mismatchAsset = db.prepare(`SELECT assetId FROM batch_asset_pool_items WHERE batchVersionId = ? LIMIT 1`)
    .get(mismatchRow.batchVersionId) as { assetId: string } | undefined;
  assert.ok(mismatchAsset, 'fixture:快照必须有素材池条目');
  const mismatchArrangement = (coverTimeUs: number): string => JSON.stringify({
    preset: '3:4',
    clips: [{
      clipId: 'clip-1', assetId: mismatchAsset.assetId,
      sourceStartUs: 0, sourceEndUs: 3_000_000, timelineStartUs: 0, timelineEndUs: 3_000_000,
    }],
    cover: { assetId: mismatchAsset.assetId, timeUs: coverTimeUs },
  });
  const arrangementA = mismatchArrangement(1_000_000);
  const arrangementB = mismatchArrangement(2_000_000);
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`).run(arrangementA, mismatchRow.targetId);
  const mismatchKeyA = `cover:${mismatchRow.targetId}:${resolveCoverContractHash(db, mismatchRow.targetId)}`;
  const mismatchCoverTaskId = createBatchTask(db, 'project-1', {
    batchId: batchCoverResultMismatch,
    workType: 'render',
    targetKind: 'output_version_cover',
    targetId: mismatchRow.targetId,
    requestKey: mismatchKeyA,
    now: () => new Date('2026-08-02T12:50:00.000Z'),
  });
  // A 任务还在队列时 arrangement 已变为 B；执行器将像真实 renderer 一样
  // 冻结它实际读到的 B 契约并把 hash 写进 resultJson。
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`).run(arrangementB, mismatchRow.targetId);
  let mismatchStarted = false;
  let releaseMismatch!: () => void;
  let mismatchDiscarded = 0;
  const mismatchExecutor: BatchTaskExecutor = {
    workTypes: ['render'],
    async execute() {
      const renderedHash = resolveCoverContractHash(db, mismatchRow.targetId);
      mismatchStarted = true;
      await new Promise<void>((resolve) => { releaseMismatch = resolve; });
      return {
        resultJson: { coverContractHash: renderedHash },
        discard: () => { mismatchDiscarded += 1; },
      };
    },
  };
  const mismatchRun = runPendingOnce({
    db, workerId: 'worker-cover-result-mismatch', executors: [mismatchExecutor], concurrency: 1,
    heartbeatMs: 10, leaseDurationMs: 1_000, progressThrottleMs: 0,
  });
  await waitFor(() => mismatchStarted);
  // 执行器已冻结 B 后切回 A：任务 key 与当前 key 再次相等，但结果仍是 B。
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`).run(arrangementA, mismatchRow.targetId);
  releaseMismatch();
  await mismatchRun;
  assert.deepEqual(
    {
      status: getBatchTask(db, 'project-1', mismatchCoverTaskId)?.status,
      expectedState: getBatchTask(db, 'project-1', mismatchCoverTaskId)?.expectedState,
      attemptStatus: listTaskAttempts(db, mismatchCoverTaskId)[0]?.status,
      discarded: mismatchDiscarded,
    },
    { status: 'cancelled', expectedState: 'stopped', attemptStatus: 'interrupted', discarded: 1 },
    '任务 key 与当前 key 回到 A 时，B 契约结果仍必须被丢弃',
  );

  // --- 场景 6e:现代封面任务完成时当前契约不可解析，必须 fail closed ---
  const batchCoverUnverifiable = setupBatch(db, 'batch-cover-unverifiable', 1);
  const unverifiableRow = db.prepare(`
    SELECT t.id AS fullTaskId, t.targetId, p.batchVersionId
    FROM batch_tasks t
    JOIN batch_output_versions o ON o.id = t.targetId
    JOIN batch_output_plans p ON p.id = o.planId
    WHERE t.batchId = ? AND t.workType = 'render' AND t.targetKind = 'output_version'
  `).get(batchCoverUnverifiable) as { fullTaskId: string; targetId: string; batchVersionId: string };
  db.prepare(`UPDATE batch_tasks SET status = 'cancelled', expectedState = 'stopped' WHERE id = ?`).run(unverifiableRow.fullTaskId);
  const unverifiableAsset = db.prepare(`SELECT assetId FROM batch_asset_pool_items WHERE batchVersionId = ? LIMIT 1`)
    .get(unverifiableRow.batchVersionId) as { assetId: string } | undefined;
  assert.ok(unverifiableAsset, 'fixture:快照必须有素材池条目');
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`).run(JSON.stringify({
    preset: '3:4',
    clips: [{
      clipId: 'clip-1', assetId: unverifiableAsset.assetId,
      sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000,
    }],
    cover: { assetId: unverifiableAsset.assetId, timeUs: 1_000_000 },
  }), unverifiableRow.targetId);
  const unverifiableHash = resolveCoverContractHash(db, unverifiableRow.targetId);
  const unverifiableTaskId = createBatchTask(db, 'project-1', {
    batchId: batchCoverUnverifiable,
    workType: 'render',
    targetKind: 'output_version_cover',
    targetId: unverifiableRow.targetId,
    requestKey: `cover:${unverifiableRow.targetId}:${unverifiableHash}`,
    now: () => new Date('2026-08-02T13:00:00.000Z'),
  });
  let unverifiableStarted = false;
  let releaseUnverifiable!: () => void;
  let unverifiableDiscarded = 0;
  const unverifiableExecutor: BatchTaskExecutor = {
    workTypes: ['render'],
    async execute() {
      unverifiableStarted = true;
      await new Promise<void>((resolve) => { releaseUnverifiable = resolve; });
      return {
        resultJson: { coverContractHash: unverifiableHash },
        discard: () => { unverifiableDiscarded += 1; },
      };
    },
  };
  const unverifiableRun = runPendingOnce({
    db, workerId: 'worker-cover-unverifiable', executors: [unverifiableExecutor], concurrency: 1,
    heartbeatMs: 10, leaseDurationMs: 1_000, progressThrottleMs: 0,
  });
  await waitFor(() => unverifiableStarted);
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = '{' WHERE id = ?`).run(unverifiableRow.targetId);
  releaseUnverifiable();
  await unverifiableRun;
  assert.deepEqual(
    {
      status: getBatchTask(db, 'project-1', unverifiableTaskId)?.status,
      expectedState: getBatchTask(db, 'project-1', unverifiableTaskId)?.expectedState,
      attemptStatus: listTaskAttempts(db, unverifiableTaskId)[0]?.status,
      discarded: unverifiableDiscarded,
    },
    { status: 'cancelled', expectedState: 'stopped', attemptStatus: 'interrupted', discarded: 1 },
    '现代契约无法解析时不得把结果标成成功',
  );

  // --- 场景 7:startBatchScheduler 单例 + stop 清理 ---
  await resetSchedulerSingletonForTests();
  const batchD = setupBatch(db, 'batch-d', 2);
  const controlledD = controlledExecutor();
  let executedCount = 0;
  const countingExecutor: BatchTaskExecutor = {
    workTypes: ['render'],
    async execute() {
      executedCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {};
    },
  };
  const controller = startBatchScheduler({
    db,
    workerId: 'scheduler-1',
    executors: [countingExecutor],
    concurrency: 1,
    intervalMs: 50,
  });
  const same = startBatchScheduler({
    db,
    workerId: 'scheduler-1',
    executors: [countingExecutor],
    concurrency: 1,
    intervalMs: 50,
  });
  assert.equal(same, controller, '重复初始化必须幂等返回同一实例');
  await waitFor(() => (
    db.prepare(`
      SELECT COUNT(*) AS n FROM batch_tasks
      WHERE batchId = ? AND workType = 'render' AND status = 'succeeded'
    `).get(batchD) as { n: number }
  ).n === 2, 5000);
  await controller.stop();
  assert.equal(controller.running, false, 'stop 后 controller.running 必须反映真实状态');
  const before = executedCount;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(executedCount, before, 'stop 后不得继续领取执行');
  const restarted = startBatchScheduler({
    db,
    workerId: 'scheduler-2',
    executors: [countingExecutor],
    concurrency: 1,
    intervalMs: 50,
  });
  assert.notEqual(restarted, controller, '停止后的调度器必须能建立新实例');
  assert.equal(restarted.running, true);
  await restarted.stop();
  assert.equal(restarted.running, false);
  void batchD;
  void controlledD;

  // --- 场景 8:调度器关闭中止在途执行,但保留任务的可恢复运行期望 ---
  const batchShutdown = setupBatch(db, 'batch-scheduler-shutdown', 1);
  const shutdownExecutor = controlledExecutor();
  const shutdownController = startBatchScheduler({
    db,
    workerId: 'scheduler-shutdown',
    executors: [shutdownExecutor.executor],
    concurrency: 1,
    intervalMs: 50,
  });
  await waitFor(() => shutdownExecutor.releases.length >= 1, 5000);
  const stopPromise = shutdownController.stop();
  assert.equal(shutdownController.running, false, 'stop 发出后必须立即停止接受新工作');
  await waitFor(
    () => shutdownExecutor.aborts.length > 0 && shutdownExecutor.aborts[0]!(),
    3000,
  );
  await stopPromise;
  const shutdownTask = db.prepare(`
    SELECT id, status, expectedState FROM batch_tasks
    WHERE batchId = ? AND workType = 'render'
  `).get(batchShutdown) as { id: string; status: string; expectedState: string };
  assert.deepEqual(
    { status: shutdownTask.status, expectedState: shutdownTask.expectedState },
    { status: 'queued', expectedState: 'running' },
    '应用关闭只是可恢复中断,不能伪造成用户停止或暂停',
  );
  assert.equal(
    listTaskAttempts(db, shutdownTask.id)[0]?.status,
    'interrupted',
    '应用关闭必须等待在途尝试落成 interrupted 后才完成',
  );
  const afterShutdownRestart = startBatchScheduler({
    db,
    workerId: 'scheduler-after-shutdown',
    executors: [countingExecutor],
    concurrency: 1,
    intervalMs: 50,
  });
  assert.notEqual(afterShutdownRestart, shutdownController, '关闭完成后允许建立新的单例调度器');
  await afterShutdownRestart.stop();

  // --- 场景 9:受控长分析挂起期间,空闲通用执行位必须补位新入队任务 ---
  // 旧实现:runPendingOnce 用 Promise.all 等整轮结束,分析占住一轮时空闲的
  // 通用位不会再次领取,新入队的通用任务要等分析释放后才开始。
  db.prepare(`
    UPDATE batch_tasks SET status = 'cancelled', expectedState = 'stopped'
    WHERE status IN ('queued', 'running')
  `).run();
  await resetSchedulerSingletonForTests();
  const refill = setupBatchShell(db, 'batch-refill-lanes');
  const refillAnalysisTask = createBatchTask(db, 'project-1', {
    batchId: refill.batchId,
    workType: 'asset_prepare',
    targetKind: 'asset',
    targetId: refill.assetId,
    requestKey: `asset_prepare:${refill.batchId}:${refill.assetId}`,
    now: () => new Date('2026-08-02T16:20:00.000Z'),
  });
  let refillAnalysisStarted = false;
  let refillAnalysisReleased = false;
  let releaseRefillAnalysis!: () => void;
  let refillGeneralStartedAt: number | null = null;
  let refillGeneralFinished = false;
  const refillExecutors: BatchTaskExecutor[] = [
    {
      workTypes: ['asset_prepare'],
      execute({ signal }) {
        refillAnalysisStarted = true;
        return new Promise((resolve, reject) => {
          const onAbort = (): void => reject(new Error('分析已中止'));
          signal.addEventListener('abort', onAbort, { once: true });
          releaseRefillAnalysis = () => {
            signal.removeEventListener('abort', onAbort);
            refillAnalysisReleased = true;
            resolve({ resultJson: {} });
          };
        });
      },
    },
    {
      workTypes: ['semantic_score'],
      async execute() {
        refillGeneralStartedAt = Date.now();
        return { resultJson: {} };
      },
    },
  ];
  const refillController = startBatchScheduler({
    db,
    workerId: 'scheduler-refill-lanes',
    executors: refillExecutors,
    concurrency: 2,
    analysisConcurrency: 1,
    intervalMs: 20,
    idlePollMs: 20,
    progressThrottleMs: 0,
  });
  await waitFor(() => refillAnalysisStarted, 3000);
  const refillEnqueuedAt = Date.now();
  const refillGeneralTask = createBatchTask(db, 'project-1', {
    batchId: refill.batchId,
    workType: 'semantic_score',
    targetKind: 'script_snapshot',
    targetId: refill.snapshotId,
    requestKey: `semantic_score:${refill.batchId}:${refill.snapshotId}`,
    now: () => new Date('2026-08-02T16:21:00.000Z'),
  });
  // 只依靠有界空闲轮询(不显式唤醒)也必须补位;超时只作看门狗。
  await waitFor(() => refillGeneralStartedAt !== null, 3000);
  const refillBeginLatencyMs = refillGeneralStartedAt! - refillEnqueuedAt;
  assert.equal(
    refillAnalysisReleased,
    false,
    '分析仍在挂起时,新入队的通用任务就必须在空闲通用位上开始',
  );
  assert.equal(
    (db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(refillAnalysisTask) as { status: string }).status,
    'running',
    '补位发生时分析任务必须仍在运行',
  );
  refillGeneralFinished = true;
  releaseRefillAnalysis();
  await waitFor(() => (
    db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(refillGeneralTask) as { status: string }
  ).status === 'succeeded', 3000);
  await waitFor(() => (
    db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(refillAnalysisTask) as { status: string }
  ).status === 'succeeded', 3000);
  await refillController.stop();
  assert.equal(refillAnalysisReleased, true);
  assert.ok(refillBeginLatencyMs < 1000, `补位延迟应远小于分析整轮耗时(实际 ${refillBeginLatencyMs}ms)`);
  void refillGeneralFinished;

  // --- 场景 9b:显式唤醒接缝——空闲位在长时间轮询间隔内也能被入队唤醒 ---
  await resetSchedulerSingletonForTests();
  const wakeBatch = setupBatchShell(db, 'batch-wake-lanes');
  const wakeAnalysisTask = createBatchTask(db, 'project-1', {
    batchId: wakeBatch.batchId,
    workType: 'asset_prepare',
    targetKind: 'asset',
    targetId: wakeBatch.assetId,
    requestKey: `asset_prepare:${wakeBatch.batchId}:${wakeBatch.assetId}`,
    now: () => new Date('2026-08-02T16:30:00.000Z'),
  });
  let wakeAnalysisStarted = false;
  let wakeAnalysisRelease!: () => void;
  let wakeGeneralStartedAt: number | null = null;
  const wakeController = startBatchScheduler({
    db,
    workerId: 'scheduler-wake-lanes',
    executors: [
      {
        workTypes: ['asset_prepare'],
        execute({ signal }) {
          wakeAnalysisStarted = true;
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('分析已中止')), { once: true });
            wakeAnalysisRelease = () => resolve({ resultJson: {} });
          });
        },
      },
      {
        workTypes: ['semantic_score'],
        async execute() {
          wakeGeneralStartedAt = Date.now();
          return { resultJson: {} };
        },
      },
    ],
    concurrency: 2,
    analysisConcurrency: 1,
    intervalMs: 5_000,
    idlePollMs: 5_000,
    progressThrottleMs: 0,
  });
  await waitFor(() => wakeAnalysisStarted, 3000);
  const wakeEnqueuedAt = Date.now();
  createBatchTask(db, 'project-1', {
    batchId: wakeBatch.batchId,
    workType: 'semantic_score',
    targetKind: 'script_snapshot',
    targetId: wakeBatch.snapshotId,
    requestKey: `semantic_score:${wakeBatch.batchId}:${wakeBatch.snapshotId}`,
    now: () => new Date('2026-08-02T16:31:00.000Z'),
  });
  assert.equal(wakeBatchScheduler(), true, '已启动的调度器必须能被入队侧唤醒');
  await waitFor(() => wakeGeneralStartedAt !== null, 3000);
  assert.ok(
    wakeGeneralStartedAt! - wakeEnqueuedAt < 1000,
    '唤醒必须立即生效,而不是等 5 秒空闲轮询',
  );
  wakeAnalysisRelease();
  await wakeController.stop();
  void wakeAnalysisTask;

  // --- 场景 10:反向与同 lane——通用长任务挂起时,空闲分析位照常补位 ---
  await resetSchedulerSingletonForTests();
  cancelOutstandingTasks(db);
  const laneBatch = setupBatchShell(db, 'batch-lanes-reverse');
  const laneExtraAsset = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'v2', shotSetId: 'ss-1', relativePath: 'videos/b.mp4' },
    contentFingerprint: 'sha256:lanes-extra',
    mediaKind: 'video',
    now: () => new Date('2026-08-02T17:00:00.000Z'),
  });
  const laneGeneralHang = createBatchTask(db, 'project-1', {
    batchId: laneBatch.batchId,
    workType: 'semantic_score',
    targetKind: 'script_snapshot',
    targetId: laneBatch.snapshotId,
    requestKey: `semantic_score:${laneBatch.batchId}:hang`,
    now: () => new Date('2026-08-02T17:01:00.000Z'),
  });
  const laneAnalysisTasks = [
    createBatchTask(db, 'project-1', {
      batchId: laneBatch.batchId,
      workType: 'asset_prepare',
      targetKind: 'asset',
      targetId: laneBatch.assetId,
      requestKey: `asset_prepare:${laneBatch.batchId}:a`,
      now: () => new Date('2026-08-02T17:02:00.000Z'),
    }),
    createBatchTask(db, 'project-1', {
      batchId: laneBatch.batchId,
      workType: 'asset_prepare',
      targetKind: 'asset',
      targetId: laneExtraAsset,
      requestKey: `asset_prepare:${laneBatch.batchId}:b`,
      now: () => new Date('2026-08-02T17:03:00.000Z'),
    }),
  ];
  let laneGeneralRunning = false;
  const laneGeneralActive = { current: 0, peak: 0 };
  const laneAnalysisActive = { current: 0, peak: 0 };
  const laneAnalysisStarted: string[] = [];
  const laneReleases: Array<() => void> = [];
  const laneExecutors: BatchTaskExecutor[] = [
    {
      workTypes: ['semantic_score'],
      execute({ signal }) {
        laneGeneralRunning = true;
        laneGeneralActive.current += 1;
        laneGeneralActive.peak = Math.max(laneGeneralActive.peak, laneGeneralActive.current);
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            laneGeneralActive.current -= 1;
            resolve({ resultJson: {} });
          };
          signal.addEventListener('abort', () => {
            if (settled) return;
            settled = true;
            laneGeneralActive.current -= 1;
            reject(new Error('通用任务已中止'));
          }, { once: true });
          laneReleases.push(finish);
        });
      },
    },
    {
      workTypes: ['asset_prepare'],
      execute({ signal, claim }) {
        laneAnalysisStarted.push(claim.task.id);
        laneAnalysisActive.current += 1;
        laneAnalysisActive.peak = Math.max(laneAnalysisActive.peak, laneAnalysisActive.current);
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            laneAnalysisActive.current -= 1;
            resolve({ resultJson: {} });
          };
          signal.addEventListener('abort', () => {
            if (settled) return;
            settled = true;
            laneAnalysisActive.current -= 1;
            reject(new Error('分析任务已中止'));
          }, { once: true });
          laneReleases.push(finish);
        });
      },
    },
  ];
  const laneController = startBatchScheduler({
    db,
    workerId: 'scheduler-lanes-reverse',
    executors: laneExecutors,
    concurrency: 2,
    analysisConcurrency: 2,
    intervalMs: 20,
    idlePollMs: 20,
    progressThrottleMs: 0,
  });
  await waitFor(() => laneGeneralRunning, 3000);
  await waitFor(() => laneAnalysisStarted.length === 2, 3000);
  assert.deepEqual(
    [...laneAnalysisStarted].sort(),
    [...laneAnalysisTasks].sort(),
    '通用长任务挂起时,新入队的两个分析任务都必须用空闲分析位开始',
  );
  assert.equal(laneGeneralActive.current, 1, '通用位不得领取分析任务');
  assert.ok(laneAnalysisActive.peak <= 2, '分析并发不得超过 analysisConcurrency');
  // 另一个空闲通用位同样能补位新入队的通用任务。
  const laneSecondGeneral = createBatchTask(db, 'project-1', {
    batchId: laneBatch.batchId,
    workType: 'semantic_score',
    targetKind: 'script_snapshot',
    targetId: laneBatch.snapshotId,
    requestKey: `semantic_score:${laneBatch.batchId}:second`,
    now: () => new Date('2026-08-02T17:04:00.000Z'),
  });
  await waitFor(() => laneGeneralActive.current === 2, 3000);
  assert.ok(laneGeneralActive.peak <= 2, '连续调度不得突破通用并发上限');
  for (const finish of laneReleases.splice(0)) finish();
  await waitFor(() => (
    db.prepare(`
      SELECT COUNT(*) AS n FROM batch_tasks
      WHERE id IN (?, ?, ?) AND status = 'succeeded'
    `).get(laneGeneralHang, laneSecondGeneral, laneAnalysisTasks[0]!) as { n: number }
  ).n === 3, 3000);
  await laneController.stop();

  // --- 场景 11:延期任务按原因退避,让同 lane 的合格任务先推进 ---
  await resetSchedulerSingletonForTests();
  cancelOutstandingTasks(db);
  const deferBatch = setupBatchShell(db, 'batch-defer-backoff');
  const deferTaskA = createBatchTask(db, 'project-1', {
    batchId: deferBatch.batchId,
    workType: 'semantic_score',
    targetKind: 'script_snapshot',
    targetId: deferBatch.snapshotId,
    requestKey: `semantic_score:${deferBatch.batchId}:defer-a`,
    now: () => new Date('2026-08-02T17:10:00.000Z'),
  });
  const deferTaskB = createBatchTask(db, 'project-1', {
    batchId: deferBatch.batchId,
    workType: 'semantic_score',
    targetKind: 'script_snapshot',
    targetId: deferBatch.snapshotId,
    requestKey: `semantic_score:${deferBatch.batchId}:defer-b`,
    now: () => new Date('2026-08-02T17:11:00.000Z'),
  });
  const deferOrder: string[] = [];
  const deferredAttemptsAt: number[] = [];
  const deferController = startBatchScheduler({
    db,
    workerId: 'scheduler-defer-backoff',
    executors: [{
      workTypes: ['semantic_score'],
      async execute({ claim }) {
        if (claim.task.id === deferTaskA) {
          deferOrder.push('A');
          deferredAttemptsAt.push(Date.now());
          throw Object.assign(new Error('等待统一执行名额'), {
            code: 'llm_execution_deferred',
            operationId: 'operation-defer',
            waitReason: 'pool_capacity',
          });
        }
        deferOrder.push('B');
        return { resultJson: {} };
      },
    }],
    concurrency: 1,
    intervalMs: 20,
    idlePollMs: 20,
    deferBackoffMs: 40,
    progressThrottleMs: 0,
  });
  await waitFor(() => deferredAttemptsAt.length >= 2, 4000);
  assert.deepEqual(
    deferOrder,
    ['A', 'B', 'A'],
    '延期任务退避期间,同 lane 的合格任务必须先执行,而不是被同一任务反复抢占',
  );
  const deferredGapMs = deferredAttemptsAt[1]! - deferredAttemptsAt[0]!;
  assert.ok(deferredGapMs >= 200, `准入延期必须按原因退避(实际 ${deferredGapMs}ms)`);
  assert.equal(
    (db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(deferTaskB) as { status: string }).status,
    'succeeded',
  );
  await deferController.stop();

  // --- 场景 12:连续调度下的暂停/继续,暂停期间不得空转领取 ---
  await resetSchedulerSingletonForTests();
  cancelOutstandingTasks(db);
  const pauseShell = setupBatchShell(db, 'batch-continuous-pause');
  const continuousPauseTask = createBatchTask(db, 'project-1', {
    batchId: pauseShell.batchId,
    workType: 'semantic_score',
    targetKind: 'script_snapshot',
    targetId: pauseShell.snapshotId,
    requestKey: `semantic_score:${pauseShell.batchId}:pause`,
    now: () => new Date('2026-08-02T17:20:00.000Z'),
  });
  let pauseExecutions = 0;
  let pauseAborts = 0;
  const pauseController = startBatchScheduler({
    db,
    workerId: 'scheduler-continuous-pause',
    executors: [{
      workTypes: ['semantic_score'],
      execute({ signal }) {
        pauseExecutions += 1;
        if (pauseExecutions >= 2) return Promise.resolve({ resultJson: {} });
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            pauseAborts += 1;
            reject(new Error('任务已中止'));
          }, { once: true });
        });
      },
    }],
    concurrency: 1,
    intervalMs: 20,
    idlePollMs: 20,
    heartbeatMs: 10,
    leaseDurationMs: 1_000,
    progressThrottleMs: 0,
  });
  await waitFor(() => pauseExecutions === 1, 3000);
  pauseBatch(db, 'project-1', pauseShell.batchId, () => new Date('2026-08-02T17:21:00.000Z'));
  await waitFor(() => pauseAborts > 0, 3000);
  await waitFor(() => {
    const row = db.prepare(`SELECT status, expectedState FROM batch_tasks WHERE id = ?`)
      .get(continuousPauseTask) as { status: string; expectedState: string };
    return row.status === 'queued' && row.expectedState === 'paused';
  }, 3000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(pauseExecutions, 1, '暂停期间空转调度不得继续领取');
  resumeBatch(db, 'project-1', pauseShell.batchId, () => new Date('2026-08-02T17:22:00.000Z'));
  await waitFor(() => pauseExecutions >= 2, 3000);
  await waitFor(() => (
    db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(continuousPauseTask) as { status: string }
  ).status === 'succeeded', 3000);
  await pauseController.stop();

  // --- 场景 13:连续调度持续补位,但任一时刻都不超过通用并发上限 ---
  await resetSchedulerSingletonForTests();
  cancelOutstandingTasks(db);
  const capShell = setupBatchShell(db, 'batch-continuous-cap');
  const capTasks = Array.from({ length: 4 }, (_, index) => createBatchTask(db, 'project-1', {
    batchId: capShell.batchId,
    workType: 'semantic_score',
    targetKind: 'script_snapshot',
    targetId: capShell.snapshotId,
    requestKey: `semantic_score:${capShell.batchId}:cap-${index}`,
    now: () => new Date(`2026-08-02T17:30:0${index}.000Z`),
  }));
  const capActive = { current: 0, peak: 0, started: 0 };
  const capReleases: Array<() => void> = [];
  const capController = startBatchScheduler({
    db,
    workerId: 'scheduler-continuous-cap',
    executors: [{
      workTypes: ['semantic_score'],
      execute({ signal }) {
        capActive.current += 1;
        capActive.started += 1;
        capActive.peak = Math.max(capActive.peak, capActive.current);
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            capActive.current -= 1;
            resolve({ resultJson: {} });
          };
          signal.addEventListener('abort', () => {
            if (settled) return;
            settled = true;
            capActive.current -= 1;
            reject(new Error('任务已中止'));
          }, { once: true });
          capReleases.push(finish);
        });
      },
    }],
    concurrency: 2,
    intervalMs: 20,
    idlePollMs: 20,
    progressThrottleMs: 0,
  });
  await waitFor(() => capActive.started === 2, 3000);
  for (const finish of capReleases.splice(0, 2)) finish();
  await waitFor(() => capActive.started === 4, 3000);
  assert.equal(capActive.peak, 2, '连续补位不得突破 concurrency=2');
  for (const finish of capReleases.splice(0)) finish();
  await waitFor(() => (
    db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE id IN (?, ?, ?, ?) AND status = 'succeeded'`)
      .get(...capTasks) as { n: number }
  ).n === 4, 3000);
  await capController.stop();

  // --- 场景 14:连续调度丢失租约后按退避重试,不得空转或伪造成功 ---
  await resetSchedulerSingletonForTests();
  cancelOutstandingTasks(db);
  const leaseShell = setupBatchShell(db, 'batch-continuous-lease');
  const continuousLeaseTask = createBatchTask(db, 'project-1', {
    batchId: leaseShell.batchId,
    workType: 'semantic_score',
    targetKind: 'script_snapshot',
    targetId: leaseShell.snapshotId,
    requestKey: `semantic_score:${leaseShell.batchId}:lease`,
    now: () => new Date('2026-08-02T17:40:00.000Z'),
  });
  const leaseExecutionTimes: number[] = [];
  const leaseController = startBatchScheduler({
    db,
    workerId: 'scheduler-continuous-lease',
    executors: [{
      workTypes: ['semantic_score'],
      execute({ signal }) {
        leaseExecutionTimes.push(Date.now());
        // 第一次执行故意拖到租约失效之后才结束;第二次直接成功。
        if (leaseExecutionTimes.length >= 2) return Promise.resolve({ resultJson: {} });
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('租约已失效')), { once: true });
        });
      },
    }],
    concurrency: 1,
    intervalMs: 20,
    idlePollMs: 20,
    // 心跳晚于租约到期:第一次执行保持挂起,由调度器检测到租约丢失;
    // 租约本身留足成功落账时间,避免把提交开销误判成丢失。
    heartbeatMs: 1_500,
    leaseDurationMs: 1_000,
    progressThrottleMs: 0,
  });
  await waitFor(() => leaseExecutionTimes.length >= 2, 6000);
  assert.ok(
    leaseExecutionTimes[1]! - leaseExecutionTimes[0]! >= 80,
    '租约丢失后的重试必须退避,不能空转重领',
  );
  await waitFor(() => (
    db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(continuousLeaseTask) as { status: string }
  ).status === 'succeeded', 3000);
  const leaseAttempts = listTaskAttempts(db, continuousLeaseTask);
  assert.equal(leaseAttempts.length, 2, '租约恢复必须形成新的任务尝试');
  assert.equal(leaseAttempts[0]?.status, 'interrupted', '丢失租约的旧尝试必须保留为 interrupted');
  await leaseController.stop();

  db.close();
  console.log('batch runner tests passed');
} finally {
  await resetSchedulerSingletonForTests();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // 断言失败时 db 句柄可能尚未关闭(Windows EBUSY);保留原始断言错误。
  }
}
