import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchProduction } from '../lib/batch-production/versions.ts';
import { createProjectScript } from '../lib/batch-production/scripts.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchSnapshot } from '../lib/batch-production/batch-flow.ts';
import { createBatchTask, listBatchTasks } from '../lib/batch-production/tasks.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-request-key-'));

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

  // --- 准备:素材 + 批次 + 快照(素材池 1 个素材) ---
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
  const { planIds } = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections: [{ assetId, analysisId }],
    now: () => new Date('2026-08-02T09:10:00.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T09:12:00.000Z')
  `).run('ov-1', planIds[0]!);

  // --- 场景 1:同一 requestKey 重复提交返回同一任务,不产生副本 ---
  const requestKey = `asset_prepare:${batchId}:${assetId}`;
  const first = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'asset_prepare',
    targetKind: 'asset',
    targetId: assetId,
    requestKey,
    now: () => new Date('2026-08-02T09:15:00.000Z'),
  });
  for (let i = 0; i < 10; i += 1) {
    const repeated = createBatchTask(db, 'project-1', {
      batchId,
      workType: 'asset_prepare',
      targetKind: 'asset',
      targetId: assetId,
      requestKey,
      now: () => new Date(`2026-08-02T09:1${i}:00.000Z`),
    });
    assert.equal(repeated, first, '同一 requestKey 重复提交必须返回同一任务');
  }
  const stored = db.prepare(`SELECT requestKey FROM batch_tasks WHERE id = ?`).get(first) as { requestKey: string };
  assert.equal(stored.requestKey, requestKey, 'requestKey 必须原样持久化');
  assert.equal(listBatchTasks(db, batchId).length, 1, '重复提交不得产生等价任务副本');

  // --- 场景 2:并发提交(两个事务同 key)→ 只有一个任务 ---
  const concurrentKey = `render:${batchId}:ov-1`;
  const results = db.transaction(() => {
    const a = createBatchTask(db, 'project-1', {
      batchId,
      workType: 'render',
      targetKind: 'output_version',
      targetId: 'ov-1',
      requestKey: concurrentKey,
      now: () => new Date('2026-08-02T09:20:00.000Z'),
    });
    const b = createBatchTask(db, 'project-1', {
      batchId,
      workType: 'render',
      targetKind: 'output_version',
      targetId: 'ov-1',
      requestKey: concurrentKey,
      now: () => new Date('2026-08-02T09:20:01.000Z'),
    });
    return [a, b];
  })();
  assert.equal(results[0], results[1], '同事务内并发提交同 key 必须幂等');
  const byKey = db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE requestKey = ?`).get(concurrentKey) as { n: number };
  assert.equal(byKey.n, 1, '并发提交只产生一个任务');

  // --- 场景 3:不同 requestKey 是不同任务 ---
  const different = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-1',
    requestKey: `render:${batchId}:ov-1:second`,
    now: () => new Date('2026-08-02T09:25:00.000Z'),
  });
  assert.notEqual(different, results[0], '不同 requestKey 必须建立不同任务');

  db.close();
  console.log('batch task request key tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
