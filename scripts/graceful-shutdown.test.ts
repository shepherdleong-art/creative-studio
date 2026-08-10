import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createProjectScript } from '../lib/batch-production/scripts.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchProduction } from '../lib/batch-production/versions.ts';
import { createBatchSnapshot, startBatchProduction } from '../lib/batch-production/batch-flow.ts';
import { createBatchTask } from '../lib/batch-production/tasks.ts';
import { claimNextTask, expireStaleLeases } from '../lib/batch-production/scheduler.ts';
import {
  gracefulShutdown,
  resetGracefulShutdownForTests,
  type GracefulShutdownDependencies,
} from '../lib/shutdown.ts';

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

try {
  // 编排顺序是公开停机契约:先停止领取/中止媒体,再等待,最后关闭数据库与 sidecar。
  {
    const events: string[] = [];
    const dependencies: GracefulShutdownDependencies = {
      scheduler: {
        running: true,
        async stop() {
          events.push('scheduler.stop');
        },
      },
      abortFfmpeg: () => {
        events.push('ffmpeg.abort');
        return 1;
      },
      waitForFfmpeg: async () => {
        events.push('ffmpeg.wait');
        return 0;
      },
      closeDatabase: () => events.push('db.close'),
      stopSidecar: () => { events.push('sidecar.stop'); },
    };

    const result = await gracefulShutdown({ timeoutMs: 100 }, dependencies);
    assert.deepEqual(events, [
      'scheduler.stop',
      'ffmpeg.abort',
      'ffmpeg.wait',
      'db.close',
      'sidecar.stop',
    ]);
    assert.deepEqual(result, { stopped: true, pendingTasks: 0 });
  }

  await resetGracefulShutdownForTests();

  // 单步超时不得把服务永久卡住,并且必须暴露仍未收尾的工作数量。
  {
    const dependencies: GracefulShutdownDependencies = {
      scheduler: {
        running: true,
        stop: () => new Promise<void>(() => undefined),
      },
      abortFfmpeg: () => 1,
      waitForFfmpeg: async () => 2,
      closeDatabase: () => undefined,
      stopSidecar: () => undefined,
    };
    const startedAt = Date.now();
    const result = await gracefulShutdown({ timeoutMs: 20 }, dependencies);
    assert.ok(Date.now() - startedAt < 500, '停机步骤超时后必须及时返回');
    assert.deepEqual(result, { stopped: false, pendingTasks: 3 });
  }

  await resetGracefulShutdownForTests();

  // timeoutMs is the total shutdown budget, not a fresh budget per wait step.
  {
    const waitUntilBudgetExpires = async (timeoutMs: number): Promise<number> =>
      new Promise((resolve) => setTimeout(() => resolve(1), timeoutMs));
    const dependencies: GracefulShutdownDependencies = {
      scheduler: {
        running: true,
        stop: () => undefined,
      },
      abortBatchTasks: () => 1,
      waitForBatchTasks: waitUntilBudgetExpires,
      abortFinalEdit: () => 1,
      waitForFinalEdit: waitUntilBudgetExpires,
      abortFfmpeg: () => 1,
      waitForFfmpeg: waitUntilBudgetExpires,
      closeDatabase: () => undefined,
      stopSidecar: () => undefined,
    };
    const startedAt = Date.now();
    const result = await gracefulShutdown({ timeoutMs: 300 }, dependencies);
    assert.ok(Date.now() - startedAt < 600, '所有停机步骤必须共享总预算');
    assert.deepEqual(result, { stopped: false, pendingTasks: 3 });
  }

  await resetGracefulShutdownForTests();

  // A shutdown timeout must leave a persisted running task recoverable by its
  // lease, rather than turning it into a failed/ghost-running record.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-shutdown-db-'));
    const dbRoot = path.join(root, 'db');
    fs.mkdirSync(dbRoot, { recursive: true });
    const db = new Database(path.join(dbRoot, 'workbench.db'));
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
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
      INSERT INTO shot_sets (id, projectId, name, createdAt)
        VALUES ('ss-1', 'project-1', '分镜组A', '2026-08-02T00:00:00.000Z');
    `);
    await ensureBatchSchemaReady({
      db,
      backupRoot: path.join(dbRoot, 'backups'),
      now: () => new Date('2026-08-02T08:00:00.000Z'),
    });
    const scriptId = createProjectScript(db, 'project-1', {
      sourceKind: 'script_draft',
      sourceId: 'draft-shutdown',
      title: '停机脚本',
      bodyText: '停机恢复测试',
      sourceVersion: '1',
      now: () => new Date('2026-08-02T09:00:00.000Z'),
    });
    const assetId = createAsset(db, {
      projectId: 'project-1',
      sourceKind: 'module4',
      locationJson: { kind: 'module4', videoJobId: 'v-shutdown', shotSetId: 'ss-1', relativePath: 'videos/shutdown.mp4' },
      contentFingerprint: 'sha256:shutdown',
      mediaKind: 'video',
      now: () => new Date('2026-08-02T09:01:00.000Z'),
    });
    const analysisId = createAnalysisVersion(db, {
      assetId,
      analyzerVersion: '0.1.0',
      providerId: 'local',
      model: 'technical',
      now: () => new Date('2026-08-02T09:02:00.000Z'),
    });
    const batchId = createBatchProduction(db, 'project-1', '停机恢复批次', () => new Date('2026-08-02T09:03:00.000Z'));
    const snapshot = createBatchSnapshot(db, 'project-1', batchId, {
      scriptSelections: [{ scriptId, copyCount: 1 }],
      assetSelections: [{ assetId, analysisId }],
      now: () => new Date('2026-08-02T09:04:00.000Z'),
    });
    db.prepare(`
      INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
      VALUES ('ov-shutdown', ?, 1, '{}', '2026-08-02T09:05:00.000Z')
    `).run(snapshot.planIds[0]);
    const taskId = createBatchTask(db, 'project-1', {
      batchId,
      workType: 'render',
      targetKind: 'output_version',
      targetId: 'ov-shutdown',
      now: () => new Date('2026-08-02T09:06:00.000Z'),
    });
    startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-02T09:07:00.000Z'));
    const claimed = claimNextTask(db, {
      workerId: 'shutdown-worker',
      now: () => new Date('2026-08-02T09:08:00.000Z'),
      leaseDurationMs: 60_000,
    });
    assert.equal(claimed?.task.id, taskId);

    const result = await gracefulShutdown({ timeoutMs: 100 }, {
      scheduler: { running: true, stop: () => undefined },
      abortBatchTasks: () => 0,
      waitForBatchTasks: async () => 1,
      abortFinalEdit: () => 0,
      waitForFinalEdit: async () => 0,
      abortFfmpeg: () => 0,
      waitForFfmpeg: async () => 0,
      closeDatabase: () => undefined,
      stopSidecar: () => undefined,
    });
    assert.deepEqual(result, { stopped: false, pendingTasks: 1 });
    const runningAfterShutdown = db.prepare(`
      SELECT t.status AS taskStatus, a.status AS attemptStatus
      FROM batch_tasks t JOIN batch_task_attempts a ON a.taskId = t.id
      WHERE t.id = ? ORDER BY a.attemptNumber DESC LIMIT 1
    `).get(taskId) as { taskStatus: string; attemptStatus: string };
    assert.deepEqual(runningAfterShutdown, { taskStatus: 'running', attemptStatus: 'running' });

    expireStaleLeases(db, { now: () => new Date('2026-08-02T09:09:01.000Z') });
    const recovered = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(taskId) as { status: string };
    assert.equal(recovered.status, 'queued', '租约过期后任务必须回到可领取状态');
    const reclaimed = claimNextTask(db, {
      workerId: 'recovery-worker',
      now: () => new Date('2026-08-02T09:09:02.000Z'),
      leaseDurationMs: 60_000,
    });
    assert.equal(reclaimed?.task.id, taskId, '调度器必须能重新领取停机遗留任务');
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  await resetGracefulShutdownForTests();

  // 默认 FFmpeg 广播必须终止没有显式接入调度器 signal 的直接媒体任务。
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-graceful-shutdown-'));
    try {
      const output = path.join(root, 'long.mp4');
      const runPromise = runFfmpeg([
        '-f', 'lavfi', '-re', '-i', 'testsrc=duration=30:size=320x240:rate=25',
        '-pix_fmt', 'yuv420p', '-y', output,
      ]);
      await nextTick();
      const shutdown = gracefulShutdown(
        { timeoutMs: 2_000 },
        { scheduler: null, closeDatabase: () => undefined, stopSidecar: () => undefined },
      );
      await assert.rejects(runPromise, (error: unknown) => error instanceof Error && error.name === 'AbortError');
      assert.deepEqual(await shutdown, { stopped: true, pendingTasks: 0 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log('graceful shutdown tests passed');
} finally {
  await resetGracefulShutdownForTests();
}
