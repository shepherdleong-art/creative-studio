import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlan, createOutputVersion } from '../lib/batch-production/plans.ts';
import {
  getArtifact,
  getCurrentArtifactId,
  listPlanArtifacts,
  registerArtifact,
  setCurrentArtifact,
} from '../lib/batch-production/artifacts.ts';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-artifacts-'));

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
  const artifactColumns = db.prepare(`PRAGMA table_info(batch_artifacts)`).all() as Array<{
    name: string; notnull: number; pk: number;
  }>;
  const artifactNames = new Map(artifactColumns.map((c) => [c.name, c]));
  for (const name of ['id', 'projectId', 'batchId', 'batchVersionId', 'outputPlanId', 'outputVersionId', 'kind', 'relativePath', 'checksum', 'createdAt']) {
    assert.ok(artifactNames.has(name), `batch_artifacts 缺少列 ${name}`);
  }
  assert.equal(artifactNames.get('id')?.pk, 1);
  const artifactForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_artifacts)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(artifactForeignKeys.some((fk) => (
    fk.table === 'batch_productions' && fk.from === 'batchId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), '正式产物表缺少指向批次的级联外键');
  assert.ok(artifactForeignKeys.some((fk) => (
    fk.table === 'batch_output_versions' && fk.from === 'outputVersionId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'RESTRICT'
  )), '正式产物表必须限制成片版本被删除');
  const artifactIndexes = db.prepare(`PRAGMA index_list(batch_artifacts)`).all() as Array<{ name: string }>;
  assert.ok(artifactIndexes.some(({ name }) => name === 'idx_batch_artifacts_plan'), '缺少正式产物计划索引');

  // 成片计划表追加了当前成片指向列
  const planColumns = db.prepare(`PRAGMA table_info(batch_output_plans)`).all() as Array<{ name: string }>;
  assert.ok(planColumns.some(({ name }) => name === 'currentArtifactId'), 'batch_output_plans 缺少当前成片指向列');

  // --- 准备:批次 → 版本 → 快照 → 计划 → 成片版本 ---
  const batchId = createBatchProduction(db, 'project-1', '八月大促混剪', () => new Date('2026-08-01T09:00:00.000Z'));
  const version1 = createBatchProductionVersion(db, batchId, { copyCount: 1, now: () => new Date('2026-08-01T09:05:00.000Z') });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-1',
    title: '口播',
    bodyText: '正文',
    sourceVersion: 'v1',
    now: () => new Date('2026-08-01T09:10:00.000Z'),
  });
  const snapshotId = snapshotScriptIntoBatch(db, version1, { scriptId, copyCount: 1, now: () => new Date('2026-08-01T09:15:00.000Z') });
  const planId = createOutputPlan(db, version1, { scriptSnapshotId: snapshotId, seq: 1, now: () => new Date('2026-08-01T09:20:00.000Z') });
  const outputVersion1 = createOutputVersion(db, planId, { now: () => new Date('2026-08-01T09:25:00.000Z') });
  const outputVersion2 = createOutputVersion(db, planId, { now: () => new Date('2026-08-01T09:30:00.000Z') });
  const outputVersion3 = createOutputVersion(db, planId, { now: () => new Date('2026-08-01T09:35:00.000Z') });

  // --- 同一成片重新导出三次:三份不覆盖的正式产物,最新版自动成为当前成片 ---
  const artifact1 = registerArtifact(db, 'project-1', {
    batchId,
    batchVersionId: version1,
    outputPlanId: planId,
    outputVersionId: outputVersion1,
    kind: 'video',
    relativePath: 'final-edits/plan-1/v1.mp4',
    checksum: 'sha256:one',
    now: () => new Date('2026-08-01T10:00:00.000Z'),
  });
  const artifact2 = registerArtifact(db, 'project-1', {
    batchId,
    batchVersionId: version1,
    outputPlanId: planId,
    outputVersionId: outputVersion2,
    kind: 'video',
    relativePath: 'final-edits/plan-1/v2.mp4',
    checksum: 'sha256:two',
    now: () => new Date('2026-08-01T10:10:00.000Z'),
  });
  const artifact3 = registerArtifact(db, 'project-1', {
    batchId,
    batchVersionId: version1,
    outputPlanId: planId,
    outputVersionId: outputVersion3,
    kind: 'video',
    relativePath: 'final-edits/plan-1/v3.mp4',
    checksum: 'sha256:three',
    now: () => new Date('2026-08-01T10:20:00.000Z'),
  });

  assert.notEqual(artifact1, artifact2);
  assert.notEqual(artifact2, artifact3);
  const allArtifacts = listPlanArtifacts(db, planId);
  assert.equal(allArtifacts.length, 3, '每次成功导出必须新增正式产物,不覆盖旧文件');
  assert.deepEqual(allArtifacts.map(({ relativePath }) => relativePath), [
    'final-edits/plan-1/v1.mp4',
    'final-edits/plan-1/v2.mp4',
    'final-edits/plan-1/v3.mp4',
  ]);
  assert.equal(getCurrentArtifactId(db, planId), artifact3, '最新导出必须自动成为当前成片');
  assert.equal(getArtifact(db, 'project-1', artifact1)?.relativePath, 'final-edits/plan-1/v1.mp4');

  // 同一成片版本重复登记:拒绝
  assert.throws(
    () => registerArtifact(db, 'project-1', {
      batchId,
      batchVersionId: version1,
      outputPlanId: planId,
      outputVersionId: outputVersion1,
      kind: 'video',
      relativePath: 'final-edits/plan-1/v1-dup.mp4',
      checksum: 'sha256:one-dup',
      now: () => new Date('2026-08-01T10:30:00.000Z'),
    }),
    /已登记/,
    '同一成片版本的同一类型产物不能重复登记',
  );
  assert.equal(listPlanArtifacts(db, planId).length, 3);

  // --- 从历史恢复旧版为当前成片:历史产物不删除 ---
  setCurrentArtifact(db, 'project-1', planId, artifact1);
  assert.equal(getCurrentArtifactId(db, planId), artifact1, '用户可恢复旧版为当前成片');
  assert.equal(listPlanArtifacts(db, planId).length, 3, '恢复旧版不得删除历史产物');

  // --- 其他成片失败不影响已登记的正式产物 ---
  assert.equal(getArtifact(db, 'project-1', artifact3)?.checksum, 'sha256:three', '登记过的产物不受其他成片失败影响');

  // --- 封面产物与视频产物独立登记 ---
  const cover = registerArtifact(db, 'project-1', {
    batchId,
    batchVersionId: version1,
    outputPlanId: planId,
    outputVersionId: outputVersion3,
    kind: 'cover',
    relativePath: 'final-edits/plan-1/cover-3.jpg',
    checksum: 'sha256:cover',
    now: () => new Date('2026-08-01T11:10:00.000Z'),
  });
  assert.ok(cover);
  assert.equal(listPlanArtifacts(db, planId).length, 4, '封面与视频是不同产物类型');

  db.close();
  console.log('batch domain artifacts tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
