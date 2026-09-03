import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { computeFingerprintFromFile } from '../lib/batch-production/fingerprint.ts';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createOutputPlansForSnapshot } from '../lib/batch-production/plans.ts';
import { startOrResumePhaseE } from '../lib/batch-production/phase-e.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { addAssetToPool, createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-phase-e-narration-gate-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });
const previousDataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

try {
  const db = new Database(path.join(root, 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, productCode TEXT DEFAULT '', exportDirName TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT (datetime('now')), storeCode TEXT NOT NULL DEFAULT '', productSubmodel TEXT NOT NULL DEFAULT '', productionType TEXT NOT NULL DEFAULT '', editorName TEXT NOT NULL DEFAULT '', namingDate TEXT NOT NULL DEFAULT '', currentExportIdentityId TEXT);
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL,
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'gemini', model TEXT,
      inputSnapshot TEXT NOT NULL, outputJson TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    INSERT INTO projects (id, name, productCode, createdAt) VALUES ('project-1', '测试项目', 'SKU/E', '2026-08-03T00:00:00.000Z');
  `);
  const ready = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') });
  assert.notEqual(ready.state, 'compatibility_only');
  db.exec(`
    CREATE TABLE final_edit_bgm_tracks (
      id TEXT PRIMARY KEY, relativePath TEXT NOT NULL, fileFingerprint TEXT NOT NULL,
      durationUs INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      errorMessage TEXT, scannedAt TEXT NOT NULL, UNIQUE(fileFingerprint)
    );
    INSERT INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, format, status, scannedAt)
    VALUES ('bgm-a', 'bgm/track-a.mp3', 'bgm-fingerprint-a', 12_000_000, 'mp3', 'ready', datetime('now'));
  `);
  fs.mkdirSync(path.join(storageRoot, 'bgm'), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'bgm', 'track-a.mp3'), Buffer.from('bgm-fingerprint-a'));

  async function seedBatch(batchName: string, copyCount: number): Promise<{ batchId: string; versionId: string; snapshotId: string; planIds: string[] }> {
    const batchId = createBatchProduction(db, 'project-1', batchName);
    const versionId = createBatchProductionVersion(db, batchId, {
      copyCount,
      defaultsJson: { outputPreset: '3:4', preset: '3:4', fps: 24, targetDurationSec: 4 },
    });
    const scriptId = createProjectScript(db, 'project-1', {
      sourceKind: 'script_draft',
      sourceId: `source-${batchName}`,
      title: '脚本',
      bodyText: '开场。卖点。',
      sourceVersion: 'v1',
      metadata: { targetDurationSec: 4 },
    });
    const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount });
    const planIds = createOutputPlansForSnapshot(db, versionId, snapshotId);
    const originalPath = path.join(root, `${batchName}-original.mp4`);
    fs.writeFileSync(originalPath, Buffer.from('media'));
    const originalFingerprint = await computeFingerprintFromFile(originalPath);
    const assetId = createAsset(db, {
      projectId: 'project-1',
      sourceKind: 'linked',
      locationJson: { kind: 'linked', absolutePath: originalPath },
      contentFingerprint: originalFingerprint,
      mediaKind: 'video',
    });
    db.prepare(`
      INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
      VALUES (?, ?, 'linked', ?, 'healthy', ?)
    `).run(randomUUID(), assetId, JSON.stringify({ kind: 'linked', absolutePath: originalPath }), new Date().toISOString());
    const analysisId = createAnalysisVersion(db, {
      assetId,
      analyzerVersion: 'fixture',
      providerId: 'fixture',
      model: 'fixture',
      analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }] },
    });
    addAssetToPool(db, versionId, { assetId, analysisId });
    return { batchId, versionId, snapshotId, planIds };
  }

  const narrationTasks = (versionId: string) => db.prepare(`
    SELECT COUNT(*) AS n FROM batch_tasks t
    JOIN batch_script_snapshots s ON s.id = t.targetId
    WHERE t.workType = 'narration' AND s.batchVersionId = ?
  `).get(versionId) as { n: number };
  const renderTasks = (batchId: string) => db.prepare(`
    SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'render' AND batchId = ?
  `).get(batchId) as { n: number };
  const outputVersions = (batchId: string) => db.prepare(`
    SELECT COUNT(*) AS n FROM batch_output_versions o
    JOIN batch_output_plans p ON p.id = o.planId
    WHERE p.batchVersionId = (SELECT currentVersionId FROM batch_productions WHERE id = ?)
  `).get(batchId) as { n: number };

  // 场景 1:口播未齐 → narration_pending,不建分配运行、不建渲染任务;重入同样不推进
  {
    const { batchId, versionId, snapshotId } = await seedBatch('gate-1', 2);
    const first = startOrResumePhaseE(db, 'project-1', batchId);
    assert.equal(first.status, 'narration_pending');
    assert.equal(first.narrationPending, 1);
    assert.equal(narrationTasks(versionId).n, 1, '冻结后必须建立口播任务');
    assert.equal(renderTasks(batchId).n, 0, '口播未齐不得建渲染任务');
    assert.equal(outputVersions(batchId).n, 0, '口播未齐不得建立成片版本');
    const second = startOrResumePhaseE(db, 'project-1', batchId);
    assert.equal(second.status, 'narration_pending', '重入必须幂等停留在 narration_pending');
    assert.equal(outputVersions(batchId).n, 0, '重入期间不得偷偷推进分配');
    db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE workType = 'narration' AND targetId = ?`).run(snapshotId);
  }

  // 场景 2:口播全部成功 → 重入 start 正常产出分配与渲染任务
  {
    const { batchId, versionId, planIds } = await seedBatch('gate-2', 2);
    const pending = startOrResumePhaseE(db, 'project-1', batchId);
    assert.equal(pending.status, 'narration_pending');
    const snapshots = db.prepare(`SELECT id FROM batch_script_snapshots WHERE batchVersionId = ?`).all(versionId) as Array<{ id: string }>;
    for (const { id } of snapshots) {
      db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE workType = 'narration' AND targetId = ?`).run(id);
    }
    const started = startOrResumePhaseE(db, 'project-1', batchId);
    assert.equal(started.status, 'running');
    assert.equal(Object.keys(started.outputVersionIds).length, planIds.length, '口播成功后必须产出全部成片版本');
    assert.equal(renderTasks(batchId).n, planIds.length, '每条成片一条渲染任务');
    const resumed = startOrResumePhaseE(db, 'project-1', batchId);
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.allocationRunId, started.allocationRunId, '同输入重入必须命中同一确定性分配运行');
    assert.equal(outputVersions(batchId).n, planIds.length, '幂等重入不得新增成片版本');
  }

  // 场景 3:口播失败 → 仍走静音占位路径(可出视觉候选),正式发布闸门由既有断言覆盖
  {
    const { batchId, versionId, planIds } = await seedBatch('gate-3', 1);
    const pending = startOrResumePhaseE(db, 'project-1', batchId);
    assert.equal(pending.status, 'narration_pending');
    const snapshots = db.prepare(`SELECT id FROM batch_script_snapshots WHERE batchVersionId = ?`).all(versionId) as Array<{ id: string }>;
    for (const { id } of snapshots) {
      db.prepare(`UPDATE batch_tasks SET status = 'failed', attemptCount = 1 WHERE workType = 'narration' AND targetId = ?`).run(id);
    }
    const started = startOrResumePhaseE(db, 'project-1', batchId);
    assert.equal(started.status, 'running', '口播失败仍要能出静音预览候选,不得卡死整批');
    assert.equal(Object.keys(started.outputVersionIds).length, planIds.length);
    assert.equal(renderTasks(batchId).n, planIds.length);
  }

  db.close();
  console.log('batch Phase E narration-gate tests passed');
} finally {
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
