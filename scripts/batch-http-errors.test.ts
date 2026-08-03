import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { BatchApiUnavailableError, BatchDomainError } from '../lib/batch-production/errors.ts';
import { batchErrorResponse } from '../lib/batch-production/http-errors.ts';
import { createBatchProduction } from '../lib/batch-production/versions.ts';
import { createProjectScript } from '../lib/batch-production/scripts.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchSnapshot, startBatchProduction } from '../lib/batch-production/batch-flow.ts';
import { createBatchTask, getBatchTasksView } from '../lib/batch-production/tasks.ts';
import { pauseBatch, resumeBatch, retryTask, stopBatch } from '../lib/batch-production/scheduler.ts';

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
    INSERT INTO projects (id, name) VALUES ('project-2', '项目二');
    INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss-1', 'project-1', '分镜组A', '2026-08-02T00:00:00.000Z');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-http-errors-'));

try {
  // --- 场景 1:错误码 → HTTP 状态映射(等价行为测试,不再比较中文文案) ---
  const fallback = { error: 'test_error', message: 'fallback' };
  const notFound = batchErrorResponse(new BatchDomainError('not_found', '批次不存在'), fallback);
  assert.equal(notFound.status, 404, 'not_found 必须映射 404');
  const conflict = batchErrorResponse(new BatchDomainError('conflict', '已停止的批次是终态'), fallback);
  assert.equal(conflict.status, 409, 'conflict 必须映射 409');
  const invalid = batchErrorResponse(new BatchDomainError('invalid_input', '缺少 projectId'), fallback);
  assert.equal(invalid.status, 400, 'invalid_input 必须映射 400');
  const generic = batchErrorResponse(new Error('boom'), fallback);
  assert.equal(generic.status, 500, '普通错误必须映射 500');
  const unavailable = batchErrorResponse(new BatchApiUnavailableError('migration_failed', '升级未完成'), fallback);
  assert.equal(unavailable.status, 503, '兼容模式必须映射 503');
  assert.equal(unavailable.body.error, 'batch_api_unavailable', '503 响应必须带 batch_api_unavailable');
  assert.equal(unavailable.body.code, 'migration_failed', '503 必须保留具体错误码');
  assert.equal(notFound.body.error, 'test_error', '领域错误响应带 fallback 错误码');

  // --- 准备:批次 + 快照 + 开跑 ---
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-02T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  const assetId = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'v1', shotSetId: 'ss-1', relativePath: 'videos/a.mp4' },
    contentFingerprint: 'sha256:aaa',
    mediaKind: 'video',
    now: () => new Date('2026-08-02T09:00:00.000Z'),
  });
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'v0',
    providerId: 'p',
    model: 'm',
    now: () => new Date('2026-08-02T09:01:00.000Z'),
  });
  const scriptA = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-a',
    title: '口播A',
    bodyText: '正文A',
    sourceVersion: '2',
    now: () => new Date('2026-08-02T09:02:00.000Z'),
  });
  const batchId = createBatchProduction(db, 'project-1', '批次', () => new Date('2026-08-02T09:05:00.000Z'));
  // 任务视图的不存在/跨项目错误必须通过领域错误稳定映射为 404。
  for (const [projectId, requestedBatchId] of [
    ['project-1', 'missing-batch'],
    ['project-2', batchId],
  ] as const) {
    let mappedMissing: ReturnType<typeof batchErrorResponse> | null = null;
    try {
      getBatchTasksView(db, projectId, requestedBatchId);
    } catch (error) {
      mappedMissing = batchErrorResponse(error, { error: 'batch_tasks_failed', message: '任务列表读取失败' });
    }
    assert.equal(mappedMissing?.status, 404, '不存在或跨项目批次的任务视图必须返回 404');
  }
  const { planIds } = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections: [{ assetId, analysisId }],
    now: () => new Date('2026-08-02T09:10:00.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T09:12:00.000Z')
  `).run('ov-1', planIds[0]!);
  startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-02T09:15:00.000Z'));
  const taskId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-1',
    now: () => new Date('2026-08-02T09:16:00.000Z'),
  });

  // --- 场景 2:停止后重试被拒绝(conflict),stopped 终态不可复活 ---
  stopBatch(db, 'project-1', batchId, () => new Date('2026-08-02T09:20:00.000Z'));
  // 停止时未领取的任务进入 cancelled/stopped,重试必须拒绝
  const stoppedTask = db.prepare(`SELECT status, expectedState FROM batch_tasks WHERE id = ?`).get(taskId) as {
    status: string;
    expectedState: string;
  };
  assert.equal(stoppedTask.expectedState, 'stopped', '停止后任务期望状态为 stopped');
  assert.throws(
    () => retryTask(db, 'project-1', taskId, () => new Date('2026-08-02T09:21:00.000Z')),
    (error: unknown) => {
      assert.ok(error instanceof BatchDomainError, '停止后重试必须抛 BatchDomainError');
      assert.equal(error.code, 'conflict', '停止后重试必须是 conflict');
      return true;
    },
    '停止后的任务不能被重试',
  );
  assert.throws(
    () => resumeBatch(db, 'project-1', batchId, () => new Date('2026-08-02T09:22:00.000Z')),
    (error: unknown) => {
      assert.ok(error instanceof BatchDomainError, '恢复停止批次必须抛 BatchDomainError');
      assert.equal(error.code, 'conflict', 'stopped 终态恢复必须是 conflict');
      return true;
    },
    '停止批次不能被恢复',
  );

  // --- 场景 3:暂停 → 继续 → 失败重试 ---
  const batch2 = createBatchProduction(db, 'project-1', '批次二', () => new Date('2026-08-02T10:00:00.000Z'));
  const snapshot2 = createBatchSnapshot(db, 'project-1', batch2, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections: [{ assetId, analysisId }],
    now: () => new Date('2026-08-02T10:05:00.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T10:06:00.000Z')
  `).run('ov-b2', snapshot2.planIds[0]!);
  startBatchProduction(db, 'project-1', batch2, () => new Date('2026-08-02T10:08:00.000Z'));
  const taskB = createBatchTask(db, 'project-1', {
    batchId: batch2,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-b2',
    now: () => new Date('2026-08-02T10:09:00.000Z'),
  });
  pauseBatch(db, 'project-1', batch2, () => new Date('2026-08-02T10:10:00.000Z'));
  assert.equal(
    (db.prepare(`SELECT expectedState FROM batch_tasks WHERE id = ?`).get(taskB) as { expectedState: string }).expectedState,
    'paused',
    '暂停后任务期望状态为 paused',
  );
  resumeBatch(db, 'project-1', batch2, () => new Date('2026-08-02T10:12:00.000Z'));
  assert.equal(
    (db.prepare(`SELECT expectedState FROM batch_tasks WHERE id = ?`).get(taskB) as { expectedState: string }).expectedState,
    'running',
    '继续后任务重新可领取',
  );
  // 跨项目隔离:其他项目的批次操作必须 not_found
  assert.throws(
    () => pauseBatch(db, 'project-2', batch2, () => new Date('2026-08-02T10:13:00.000Z')),
    (error: unknown) => {
      assert.ok(error instanceof BatchDomainError);
      assert.equal(error.code, 'not_found', '跨项目操作必须是 not_found');
      return true;
    },
    '跨项目暂停必须拒绝',
  );

  db.close();
  console.log('batch http errors tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
