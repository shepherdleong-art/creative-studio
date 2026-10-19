// scripts/batch-lut-catalog.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchProduction } from '../lib/batch-production/versions.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createProjectScript } from '../lib/batch-production/scripts.ts';
import { createBatchSnapshot } from '../lib/batch-production/batch-flow.ts';
import {
  archiveLut,
  createManagedLut,
  deleteLutIfUnreferenced,
  getLut,
  listProjectLuts,
  restoreLut,
} from '../lib/batch-production/lut-catalog.ts';
import { BatchDomainError } from '../lib/batch-production/errors.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
    INSERT INTO projects (id, name) VALUES ('project-2', '项目二');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-lut-catalog-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');
  const migrated = await ensureBatchSchemaReady({
    db, backupRoot: path.join(dbRoot, 'backups'), now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // --- 场景 1:同一内容重复导入复用同一身份 ---
  const lutId1 = createManagedLut(db, 'project-1', {
    contentFingerprint: `sha256:${'a'.repeat(64)}`,
    displayName: 'LOG-A',
    relativePath: 'storage/luts/project-1/lut-1.cube',
    fileSizeBytes: 2048,
    now: () => new Date('2026-08-03T08:01:00.000Z'),
  });
  const lutId1Dup = createManagedLut(db, 'project-1', {
    contentFingerprint: `sha256:${'a'.repeat(64)}`,
    displayName: 'LOG-A (重新选择同一个文件)',
    relativePath: 'storage/luts/project-1/lut-1-again.cube',
    fileSizeBytes: 2048,
    now: () => new Date('2026-08-03T08:02:00.000Z'),
  });
  assert.equal(lutId1Dup, lutId1, '同一完整内容指纹重复导入必须复用同一 LUT 身份');

  // --- 场景 2:同名不同内容建立新身份,不覆盖旧内容 ---
  const lutId2 = createManagedLut(db, 'project-1', {
    contentFingerprint: `sha256:${'b'.repeat(64)}`,
    displayName: 'LOG-A',
    relativePath: 'storage/luts/project-1/lut-2.cube',
    fileSizeBytes: 4096,
    now: () => new Date('2026-08-03T08:03:00.000Z'),
  });
  assert.notEqual(lutId2, lutId1, '同名不同内容必须建立新的 LUT 身份');
  assert.equal(getLut(db, 'project-1', lutId1)?.contentFingerprint, `sha256:${'a'.repeat(64)}`, '旧 LUT 内容指纹不受同名新导入影响');

  // --- 场景 3:项目隔离——项目 2 看不到项目 1 的 LUT ---
  assert.equal(getLut(db, 'project-2', lutId1), undefined, '项目 2 不能读取项目 1 的 LUT');
  assert.deepEqual(listProjectLuts(db, 'project-2'), [], '项目 2 的 LUT 列表必须为空');
  assert.equal(listProjectLuts(db, 'project-1').length, 2);

  // --- 场景 4:归档只影响新选择列表,不删除文件/历史关系;可以恢复 ---
  archiveLut(db, 'project-1', lutId2, () => new Date('2026-08-03T08:04:00.000Z'));
  assert.equal(listProjectLuts(db, 'project-1').length, 1, '归档后默认列表不再包含该 LUT');
  assert.equal(listProjectLuts(db, 'project-1', { includeArchived: true }).length, 2, '包含归档时仍能看到完整历史');
  assert.equal(getLut(db, 'project-1', lutId2)?.status, 'archived');
  restoreLut(db, 'project-1', lutId2, () => new Date('2026-08-03T08:05:00.000Z'));
  assert.equal(getLut(db, 'project-1', lutId2)?.status, 'active', '恢复后重新出现在选择列表中');

  assert.throws(
    () => archiveLut(db, 'project-2', lutId1, () => new Date('2026-08-03T08:06:00.000Z')),
    (error: unknown) => error instanceof BatchDomainError && error.code === 'not_found',
    '项目 2 不能归档项目 1 的 LUT',
  );

  // --- 场景 5:没有引用时可以物理清理;被批次版本引用时必须拒绝,只能归档 ---
  const lutId3 = createManagedLut(db, 'project-1', {
    contentFingerprint: `sha256:${'c'.repeat(64)}`,
    displayName: 'LOG-B',
    relativePath: 'storage/luts/project-1/lut-3.cube',
    fileSizeBytes: 1024,
    now: () => new Date('2026-08-03T08:07:00.000Z'),
  });
  assert.equal(deleteLutIfUnreferenced(db, 'project-1', lutId3), true, '没有任何引用的 LUT 必须允许物理清理');
  assert.equal(getLut(db, 'project-1', lutId3), undefined);

  const script = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft', sourceId: 'draft-a', title: '口播A', bodyText: '正文A', sourceVersion: '1',
    now: () => new Date('2026-08-03T08:08:00.000Z'),
  });
  const asset = createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: '/tmp/lut-catalog-asset.mp4' },
    contentFingerprint: 'sha256:lut-catalog-asset', mediaKind: 'video',
    now: () => new Date('2026-08-03T08:09:00.000Z'),
  });
  const analysis = createAnalysisVersion(db, {
    assetId: asset, analyzerVersion: '0.1.0', providerId: 'p', model: 'm',
    now: () => new Date('2026-08-03T08:09:30.000Z'),
  });
  const batchId = createBatchProduction(db, 'project-1', 'LUT 引用测试', () => new Date('2026-08-03T08:10:00.000Z'));
  createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId: asset, analysisId: analysis, colorSnapshot: { lutId: lutId1 } }],
    now: () => new Date('2026-08-03T08:11:00.000Z'),
  });
  assert.equal(deleteLutIfUnreferenced(db, 'project-1', lutId1), false, '被批次版本引用的 LUT 不能物理清理');
  assert.ok(getLut(db, 'project-1', lutId1), '拒绝清理后 LUT 记录必须继续存在');

  db.close();
  console.log('batch-lut-catalog tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
