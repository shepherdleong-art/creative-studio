import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import {
  createOutputPlan,
  createOutputPlansForSnapshot,
  createOutputVersion,
  getOutputPlan,
  getOutputVersion,
  listOutputPlans,
  listOutputVersions,
} from '../lib/batch-production/plans.ts';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-plans-'));

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
  const planColumns = db.prepare(`PRAGMA table_info(batch_output_plans)`).all() as Array<{
    name: string; notnull: number; pk: number;
  }>;
  const planNames = new Map(planColumns.map((c) => [c.name, c]));
  for (const name of ['id', 'batchVersionId', 'scriptSnapshotId', 'seq', 'planJson', 'currentVersionId', 'createdAt']) {
    assert.ok(planNames.has(name), `batch_output_plans 缺少列 ${name}`);
  }
  assert.equal(planNames.get('id')?.pk, 1);
  const planForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_output_plans)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(planForeignKeys.some((fk) => (
    fk.table === 'batch_production_versions' && fk.from === 'batchVersionId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), '成片计划表缺少指向批次版本的级联外键');
  assert.ok(planForeignKeys.some((fk) => (
    fk.table === 'batch_script_snapshots' && fk.from === 'scriptSnapshotId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'RESTRICT'
  )), '成片计划表必须限制脚本快照被删除');
  const planIndexes = db.prepare(`PRAGMA index_list(batch_output_plans)`).all() as Array<{ name: string; unique: number }>;
  assert.ok(planIndexes.some(({ name, unique }) => name === 'idx_batch_output_plans_version' && unique === 0), '缺少成片计划版本索引');

  const versionColumns = db.prepare(`PRAGMA table_info(batch_output_versions)`).all() as Array<{
    name: string; notnull: number; pk: number;
  }>;
  const versionNames = new Map(versionColumns.map((c) => [c.name, c]));
  for (const name of ['id', 'planId', 'versionNumber', 'arrangementJson', 'createdAt']) {
    assert.ok(versionNames.has(name), `batch_output_versions 缺少列 ${name}`);
  }
  const versionForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_output_versions)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(versionForeignKeys.some((fk) => (
    fk.table === 'batch_output_plans' && fk.from === 'planId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), '成片版本表缺少指向成片计划的级联外键');
  const versionIndexes = db.prepare(`PRAGMA index_list(batch_output_versions)`).all() as Array<{ name: string }>;
  assert.ok(versionIndexes.some(({ name }) => name === 'idx_batch_output_versions_plan'), '缺少成片版本计划索引');

  // --- 准备:批次、版本、脚本快照 ---
  const batchId = createBatchProduction(db, 'project-1', '八月大促混剪', () => new Date('2026-08-01T09:00:00.000Z'));
  const version1 = createBatchProductionVersion(db, batchId, { copyCount: 3, now: () => new Date('2026-08-01T09:05:00.000Z') });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-1',
    title: '口播',
    bodyText: '正文',
    sourceVersion: 'v1',
    now: () => new Date('2026-08-01T09:10:00.000Z'),
  });
  const snapshotId = snapshotScriptIntoBatch(db, version1, { scriptId, copyCount: 3, now: () => new Date('2026-08-01T09:15:00.000Z') });

  // --- 份数决定计划数量:3 份 → 3 条稳定计划 ---
  const planIds = createOutputPlansForSnapshot(db, version1, snapshotId, () => new Date('2026-08-01T09:20:00.000Z'));
  assert.equal(planIds.length, 3, '份数必须精确决定成片计划数量');
  const plans = listOutputPlans(db, version1);
  assert.deepEqual(plans.map(({ seq }) => seq), [1, 2, 3], '计划序号必须连续 1..N');

  // --- 重试不增加卡片:重复创建被拒绝,计划数量不变 ---
  assert.throws(
    () => createOutputPlansForSnapshot(db, version1, snapshotId, () => new Date('2026-08-01T09:21:00.000Z')),
    /已建立/,
    '同一快照不能重复创建计划',
  );
  assert.equal(listOutputPlans(db, version1).length, 3, '重试不得多出第 N+1 张卡片');

  // --- 序号不得越过生成份数:copyCount=3 时 seq=4 必须被拒绝 ---
  assert.throws(
    () => createOutputPlan(db, version1, {
      scriptSnapshotId: snapshotId,
      seq: 4,
      planJson: {},
      now: () => new Date('2026-08-01T09:22:00.000Z'),
    }),
    /1\.\.3/,
    '成片计划序号不能超过脚本快照的生成份数',
  );
  assert.equal(listOutputPlans(db, version1).length, 3);

  // 计划属于批次版本,新版本计划隔离
  const version2 = createBatchProductionVersion(db, batchId, { copyCount: 1, now: () => new Date('2026-08-01T10:00:00.000Z') });
  assert.equal(listOutputPlans(db, version2).length, 0, '批次版本之间计划必须隔离');

  // --- 成片版本:单条局部调整形成新版本,不改变其他成片 ---
  const plan1 = getOutputPlan(db, version1, planIds[0]);
  assert.equal(plan1?.seq, 1);
  const firstVersion = createOutputVersion(db, planIds[0], {
    arrangementJson: { shots: ['a', 'b'], cover: 'c1', bgm: 'bgm-1' },
    now: () => new Date('2026-08-01T11:00:00.000Z'),
  });
  assert.ok(firstVersion);
  assert.equal(getOutputPlan(db, version1, planIds[0])?.currentVersionId, firstVersion, '新成片版本自动成为计划的当前版本');

  const secondVersion = createOutputVersion(db, planIds[0], {
    arrangementJson: { shots: ['a', 'b', 'c'], cover: 'c2', bgm: 'bgm-1' },
    now: () => new Date('2026-08-01T11:30:00.000Z'),
  });
  assert.notEqual(secondVersion, firstVersion);
  assert.equal(listOutputVersions(db, planIds[0]).length, 2, '旧成片版本必须保留');
  assert.equal(getOutputVersion(db, planIds[0], firstVersion)?.versionNumber, 1);
  assert.equal(getOutputVersion(db, planIds[0], secondVersion)?.versionNumber, 2);
  assert.equal(getOutputPlan(db, version1, planIds[0])?.currentVersionId, secondVersion);

  // 只调整第一条成片:其他计划没有成片版本
  assert.equal(listOutputVersions(db, planIds[1]).length, 0, '单条调整不得影响同批次其他成片');

  db.close();
  console.log('batch domain plans tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
