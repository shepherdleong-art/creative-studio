// scripts/batch-task-level-control.test.ts
//
// Phase D 任务级 pause/resume/cancel 回归(交接文档 §5.3):
//   - pauseTask/resumeTask/cancelTask 只影响目标任务,不影响同批次的其他任务,
//     也不改变批次 controlState。
//   - 正在运行的任务被单独暂停/取消后,调度器心跳必须在一个心跳周期内感知并中止,
//     不必等任务自然跑完。
//   - 取消后用户明确重新启用,能在同一业务任务上形成新 attempt。
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
import type { BatchTaskExecutor } from '../lib/batch-production/executors.ts';
import { runPendingOnce } from '../lib/batch-production/runner.ts';
// 目标 seam:任务级控制。这三个具名导出在 D2 之前不存在,
// import 本身就会让整个测试文件在加载阶段失败——这就是 D0 期望的红。
import { pauseTask, resumeTask, cancelTask } from '../lib/batch-production/scheduler.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL,
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
    INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss-1', 'project-1', '分镜组A', '2026-08-03T00:00:00.000Z');
  `);
  return db;
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-task-control-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  const script = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-a',
    title: '口播A',
    bodyText: '正文A',
    sourceVersion: '1',
    now: () => new Date('2026-08-03T08:01:00.000Z'),
  });
  const assetA = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'va', shotSetId: 'ss-1', relativePath: 'videos/a.mp4' },
    contentFingerprint: 'sha256:task-control-a',
    mediaKind: 'video',
    now: () => new Date('2026-08-03T08:02:00.000Z'),
  });
  const analysisA = createAnalysisVersion(db, {
    assetId: assetA, analyzerVersion: '0.1.0', providerId: 'p', model: 'm',
    now: () => new Date('2026-08-03T08:02:30.000Z'),
  });
  const assetB = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'vb', shotSetId: 'ss-1', relativePath: 'videos/b.mp4' },
    contentFingerprint: 'sha256:task-control-b',
    mediaKind: 'video',
    now: () => new Date('2026-08-03T08:02:40.000Z'),
  });
  const analysisB = createAnalysisVersion(db, {
    assetId: assetB, analyzerVersion: '0.1.0', providerId: 'p', model: 'm',
    now: () => new Date('2026-08-03T08:02:50.000Z'),
  });

  const batchId = createBatchProduction(db, 'project-1', '任务级控制测试', () => new Date('2026-08-03T08:03:00.000Z'));
  createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [
      { assetId: assetA, analysisId: analysisA },
      { assetId: assetB, analysisId: analysisB },
    ],
    now: () => new Date('2026-08-03T08:04:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-03T08:05:00.000Z'));

  // 开跑自动为素材池建立两个 asset_prepare 任务(A、B)
  const tasks = db.prepare(`
    SELECT id, targetId FROM batch_tasks WHERE batchId = ? ORDER BY createdAt, id
  `).all(batchId) as Array<{ id: string; targetId: string }>;
  assert.equal(tasks.length, 2, '两份素材必须各自建立一个 asset_prepare 任务');
  const taskA = tasks.find((t) => t.targetId === assetA)!;
  const taskB = tasks.find((t) => t.targetId === assetB)!;
  assert.ok(taskA && taskB);

  // --- 场景 1:单独暂停正在运行的任务 A,任务 B 与批次 controlState 不受影响 ---
  {
    const aStarted = createDeferred<void>();
    const executor: BatchTaskExecutor = {
      workTypes: ['asset_prepare'],
      async execute(context) {
        if (context.claim.task.targetId === assetA) {
          aStarted.resolve();
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            if (context.signal.aborted) {
              throw new Error('执行器感知到 abort 信号');
            }
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          return { resultJson: { finishedWithoutAbort: true } };
        }
        context.reportProgress({ phase: 'done', percent: 1 });
        return { resultJson: { ok: true } };
      },
    };

    const runPromise = runPendingOnce({
      db,
      workerId: 'worker-1',
      executors: [executor],
      concurrency: 2,
      leaseDurationMs: 10_000,
      heartbeatMs: 100,
    });

    await aStarted.promise;
    // 只暂停任务 A,任务 B 应该继续正常跑完
    pauseTask(db, 'project-1', taskA.id);
    await runPromise;

    const taskARow = db.prepare(`SELECT status, expectedState FROM batch_tasks WHERE id = ?`).get(taskA.id) as {
      status: string; expectedState: string;
    };
    assert.equal(taskARow.status, 'queued', '被单独暂停的运行中任务必须中止并回到可继续状态,而不是跑完');
    assert.equal(taskARow.expectedState, 'paused', '被单独暂停的任务期望状态必须是 paused');

    const taskBRow = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(taskB.id) as { status: string };
    assert.equal(taskBRow.status, 'succeeded', '暂停任务 A 不能影响同批次的任务 B');

    const batchRow = getBatchProduction(db, 'project-1', batchId);
    assert.equal(batchRow?.status !== undefined, true);
    const controlState = (db.prepare(`SELECT controlState FROM batch_productions WHERE id = ?`).get(batchId) as {
      controlState: string;
    }).controlState;
    assert.equal(controlState, 'running', '单独暂停一个任务不能把整个批次 controlState 改成 paused');
  }

  // --- 场景 2:继续任务 A,能重新领取并跑完 ---
  {
    resumeTask(db, 'project-1', taskA.id);
    const taskARow = db.prepare(`SELECT expectedState FROM batch_tasks WHERE id = ?`).get(taskA.id) as {
      expectedState: string;
    };
    assert.equal(taskARow.expectedState, 'running', '继续后任务期望状态必须回到 running');

    const executor: BatchTaskExecutor = {
      workTypes: ['asset_prepare'],
      async execute(context) {
        context.reportProgress({ phase: 'done', percent: 1 });
        return { resultJson: { ok: true } };
      },
    };
    await runPendingOnce({
      db, workerId: 'worker-1', executors: [executor], concurrency: 1, leaseDurationMs: 10_000, heartbeatMs: 100,
    });
    const taskAFinal = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(taskA.id) as { status: string };
    assert.equal(taskAFinal.status, 'succeeded', '继续后的任务必须能正常跑完');
  }

  // --- 场景 3:单独取消一个正在运行的任务,任务进入不可重试的终态,不影响批次或其他任务 ---
  const batch2 = createBatchProduction(db, 'project-1', '任务级取消测试', () => new Date('2026-08-03T09:00:00.000Z'));
  createBatchSnapshot(db, 'project-1', batch2, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [
      { assetId: assetA, analysisId: analysisA },
      { assetId: assetB, analysisId: analysisB },
    ],
    now: () => new Date('2026-08-03T09:01:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batch2, () => new Date('2026-08-03T09:02:00.000Z'));
  const tasks2 = db.prepare(`
    SELECT id, targetId FROM batch_tasks WHERE batchId = ? ORDER BY createdAt, id
  `).all(batch2) as Array<{ id: string; targetId: string }>;
  const task2A = tasks2.find((t) => t.targetId === assetA)!;
  const task2B = tasks2.find((t) => t.targetId === assetB)!;

  {
    const aStarted = createDeferred<void>();
    const executor: BatchTaskExecutor = {
      workTypes: ['asset_prepare'],
      async execute(context) {
        if (context.claim.task.targetId === assetA) {
          aStarted.resolve();
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            if (context.signal.aborted) throw new Error('执行器感知到 abort 信号');
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          return { resultJson: { finishedWithoutAbort: true } };
        }
        context.reportProgress({ phase: 'done', percent: 1 });
        return { resultJson: { ok: true } };
      },
    };
    const runPromise = runPendingOnce({
      db, workerId: 'worker-1', executors: [executor], concurrency: 2, leaseDurationMs: 10_000, heartbeatMs: 100,
    });
    await aStarted.promise;
    cancelTask(db, 'project-1', task2A.id);
    await runPromise;

    const task2ARow = db.prepare(`SELECT status, expectedState FROM batch_tasks WHERE id = ?`).get(task2A.id) as {
      status: string; expectedState: string;
    };
    assert.equal(task2ARow.status, 'cancelled', '被单独取消的任务必须进入 cancelled 终态');
    assert.equal(task2ARow.expectedState, 'stopped');

    const task2BRow = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task2B.id) as { status: string };
    assert.equal(task2BRow.status, 'succeeded', '取消任务 A 不能影响同批次的任务 B');

    const controlState2 = (db.prepare(`SELECT controlState FROM batch_productions WHERE id = ?`).get(batch2) as {
      controlState: string;
    }).controlState;
    assert.equal(controlState2, 'running', '单独取消一个任务不能停止整个批次');
  }

  db.close();
  console.log('batch-task-level-control tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
