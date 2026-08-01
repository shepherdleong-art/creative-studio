import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchProduction } from '../lib/batch-production/versions.ts';
import {
  createBatchTask,
  finishTaskAttempt,
  getBatchTask,
  listTaskAttempts,
  startTaskAttempt,
} from '../lib/batch-production/tasks.ts';

function createLegacyDatabase(root: string, name: string): { db: Database.Database; databasePath: string } {
  const databasePath = path.join(root, name);
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '旧项目');
  `);
  return { db, databasePath };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-tasks-'));

try {
  const dbRoot = path.join(root, 'healthy');
  fs.mkdirSync(dbRoot, { recursive: true });
  const { db } = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-01T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // --- 结构 ---
  const taskColumns = db.prepare(`PRAGMA table_info(batch_tasks)`).all() as Array<{
    name: string; notnull: number; pk: number;
  }>;
  const taskNames = new Map(taskColumns.map((c) => [c.name, c]));
  for (const name of ['id', 'projectId', 'batchId', 'workType', 'targetKind', 'targetId', 'status', 'progressJson', 'attemptCount', 'createdAt', 'updatedAt']) {
    assert.ok(taskNames.has(name), `batch_tasks 缺少列 ${name}`);
  }
  assert.equal(taskNames.get('id')?.pk, 1);
  const taskForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_tasks)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(taskForeignKeys.some((fk) => (
    fk.table === 'batch_productions' && fk.from === 'batchId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), '生产任务表缺少指向批次的级联外键');
  const taskIndexes = db.prepare(`PRAGMA index_list(batch_tasks)`).all() as Array<{ name: string }>;
  assert.ok(taskIndexes.some(({ name }) => name === 'idx_batch_tasks_batch'), '缺少生产任务批次索引');

  const attemptColumns = db.prepare(`PRAGMA table_info(batch_task_attempts)`).all() as Array<{
    name: string; notnull: number; pk: number;
  }>;
  const attemptNames = new Map(attemptColumns.map((c) => [c.name, c]));
  for (const name of ['id', 'taskId', 'attemptNumber', 'status', 'progressJson', 'resultJson', 'errorCode', 'errorMessage', 'startedAt', 'finishedAt', 'createdAt']) {
    assert.ok(attemptNames.has(name), `batch_task_attempts 缺少列 ${name}`);
  }
  const attemptForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_task_attempts)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(attemptForeignKeys.some((fk) => (
    fk.table === 'batch_tasks' && fk.from === 'taskId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), '任务尝试表缺少指向生产任务的级联外键');
  const attemptIndexes = db.prepare(`PRAGMA index_list(batch_task_attempts)`).all() as Array<{ name: string }>;
  assert.ok(attemptIndexes.some(({ name }) => name === 'idx_batch_task_attempts_task'), '缺少任务尝试索引');

  // --- 任务生命周期:创建 → 尝试 1 失败 → 尝试 2 成功 ---
  const batchId = createBatchProduction(db, 'project-1', '八月大促混剪', () => new Date('2026-08-01T09:00:00.000Z'));
  const taskId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'output-version-1',
    now: () => new Date('2026-08-01T09:10:00.000Z'),
  });
  assert.ok(taskId);
  assert.equal(getBatchTask(db, 'project-1', taskId)?.status, 'queued');
  assert.equal(getBatchTask(db, 'project-1', taskId)?.attemptCount, 0);

  const attempt1 = startTaskAttempt(db, taskId, () => new Date('2026-08-01T09:11:00.000Z'));
  assert.equal(getBatchTask(db, 'project-1', taskId)?.status, 'running');
  assert.equal(getBatchTask(db, 'project-1', taskId)?.attemptCount, 1);

  finishTaskAttempt(db, taskId, attempt1, {
    status: 'failed',
    errorCode: 'render_error',
    errorMessage: '渲染超时',
    now: () => new Date('2026-08-01T09:20:00.000Z'),
  });
  assert.equal(getBatchTask(db, 'project-1', taskId)?.status, 'failed');
  const attemptsAfterFail = listTaskAttempts(db, taskId);
  assert.equal(attemptsAfterFail.length, 1);
  assert.equal(attemptsAfterFail[0]?.status, 'failed');

  // 重试:只增加任务尝试,不产生新任务
  const attempt2 = startTaskAttempt(db, taskId, () => new Date('2026-08-01T09:21:00.000Z'));
  assert.ok(attempt2, '重试必须产生新的任务尝试');
  assert.notEqual(attempt2, attempt1);
  finishTaskAttempt(db, taskId, attempt2, {
    status: 'succeeded',
    resultJson: { artifactId: 'artifact-1' },
    now: () => new Date('2026-08-01T09:30:00.000Z'),
  });
  const taskAfter = getBatchTask(db, 'project-1', taskId);
  assert.equal(taskAfter?.status, 'succeeded');
  assert.equal(taskAfter?.attemptCount, 2, '重试只增加任务尝试');
  const attempts = listTaskAttempts(db, taskId);
  assert.equal(attempts.length, 2, '失败重试不得产生新的生产任务');
  assert.equal(attempts[0]?.attemptNumber, 1);
  assert.equal(attempts[1]?.attemptNumber, 2);
  assert.equal(attempts[1]?.status, 'succeeded');
  assert.equal(
    (JSON.parse(attempts[1]?.resultJson ?? '{}') as { artifactId: string }).artifactId,
    'artifact-1',
  );

  // --- 部分完成:2 个任务一成一败,成功结果不因其他项失败回滚 ---
  const taskA = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'output-version-a',
    now: () => new Date('2026-08-01T10:00:00.000Z'),
  });
  const attemptA = startTaskAttempt(db, taskA, () => new Date('2026-08-01T10:01:00.000Z'));
  finishTaskAttempt(db, taskA, attemptA, {
    status: 'succeeded',
    resultJson: { artifactId: 'artifact-a' },
    now: () => new Date('2026-08-01T10:02:00.000Z'),
  });

  const taskB = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'output-version-b',
    now: () => new Date('2026-08-01T10:03:00.000Z'),
  });
  const attemptB = startTaskAttempt(db, taskB, () => new Date('2026-08-01T10:04:00.000Z'));
  finishTaskAttempt(db, taskB, attemptB, {
    status: 'failed',
    errorCode: 'render_error',
    errorMessage: '素材缺失',
    now: () => new Date('2026-08-01T10:05:00.000Z'),
  });

  assert.equal(getBatchTask(db, 'project-1', taskA)?.status, 'succeeded', '其他任务失败不得回滚已成功结果');
  assert.equal(getBatchTask(db, 'project-1', taskB)?.status, 'failed');

  // 部分完成的批次状态可由批次层表达:18/20 的成功保留,失败项单独重试
  db.prepare(`
    UPDATE batch_productions SET status = 'partially_completed', progressJson = '{"succeeded":18,"failed":2,"total":20}', updatedAt = ?
    WHERE id = ?
  `).run('2026-08-01T10:06:00.000Z', batchId);
  const partial = db.prepare(`SELECT status, progressJson FROM batch_productions WHERE id = ?`).get(batchId) as {
    status: string;
    progressJson: string;
  };
  assert.equal(partial.status, 'partially_completed');
  assert.deepEqual(JSON.parse(partial.progressJson), { succeeded: 18, failed: 2, total: 20 });

  // 失败项重试后批次重新进入运行状态(由批次层调用方负责),不在此表约束
  db.close();
  console.log('batch domain tasks tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
