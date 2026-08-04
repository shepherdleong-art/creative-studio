import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import {
  createBatchProduction,
  createBatchProductionVersion,
  updateBatchProductionStatus,
} from '../lib/batch-production/versions.ts';
import {
  createBatchExternalScript,
  createProjectScript,
  getBatchExternalScript,
  getProjectScript,
  getScriptSnapshot,
  listProjectScripts,
  parseStoredNarrationConfig,
  saveExternalScriptAsProjectScript,
  listScriptSnapshots,
  snapshotScriptIntoBatch,
  updateBatchExternalScript,
  updateProjectScript,
  updateProjectScriptNarrationConfig,
} from '../lib/batch-production/scripts.ts';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-scripts-'));

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
  const scriptColumns = db.prepare(`PRAGMA table_info(batch_scripts)`).all() as Array<{
    name: string; notnull: number; pk: number;
  }>;
  const scriptNames = new Map(scriptColumns.map((c) => [c.name, c]));
  for (const name of [
    'id',
    'projectId',
    'sourceKind',
    'sourceId',
    'title',
    'bodyText',
    'sourceVersion',
    'ownerBatchVersionId',
    'externalSourceId',
    'createdAt',
    'updatedAt',
  ]) {
    assert.ok(scriptNames.has(name), `batch_scripts 缺少列 ${name}`);
  }
  assert.equal(scriptNames.get('id')?.pk, 1);
  const scriptForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_scripts)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(scriptForeignKeys.some((fk) => (
    fk.table === 'projects' && fk.from === 'projectId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), 'batch_scripts 缺少指向 projects 的级联外键');
  assert.ok(scriptForeignKeys.some((fk) => (
    fk.table === 'batch_production_versions'
    && fk.from === 'ownerBatchVersionId'
    && fk.to === 'id'
    && fk.on_delete.toUpperCase() === 'RESTRICT'
  )), '批次内外部文案必须归属于一个受删除保护的批次版本');

  const snapshotColumns = db.prepare(`PRAGMA table_info(batch_script_snapshots)`).all() as Array<{
    name: string; notnull: number; pk: number;
  }>;
  const snapshotNames = new Map(snapshotColumns.map((c) => [c.name, c]));
  for (const name of ['id', 'batchVersionId', 'sourceScriptId', 'title', 'bodyText', 'sourceVersion', 'copyCount', 'createdAt']) {
    assert.ok(snapshotNames.has(name), `batch_script_snapshots 缺少列 ${name}`);
  }
  const snapshotForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_script_snapshots)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(snapshotForeignKeys.some((fk) => (
    fk.table === 'batch_production_versions' && fk.from === 'batchVersionId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), '脚本快照表缺少指向批次版本的级联外键');
  assert.ok(snapshotForeignKeys.some((fk) => (
    fk.table === 'batch_scripts' && fk.from === 'sourceScriptId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'RESTRICT'
  )), '脚本快照表必须限制来源脚本被删除');
  const snapshotIndexes = db.prepare(`PRAGMA index_list(batch_script_snapshots)`).all() as Array<{ name: string }>;
  assert.ok(snapshotIndexes.some(({ name }) => name === 'idx_batch_script_snapshots_version'), '缺少脚本快照版本索引');

  // --- 项目脚本:同一来源不重复导入 ---
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-1',
    title: '口播第一版',
    bodyText: '第一版正文',
    sourceVersion: 'v1',
    now: () => new Date('2026-08-01T09:00:00.000Z'),
  });
  assert.ok(scriptId);
  const importedAgain = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-1',
    title: '口播第一版',
    bodyText: '第一版正文',
    sourceVersion: 'v1',
    now: () => new Date('2026-08-01T09:01:00.000Z'),
  });
  assert.equal(importedAgain, scriptId, '同一来源脚本不能重复导入');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_scripts`).get() as { n: number }).n, 1);

  // --- 项目脚本可以继续变化 ---
  updateProjectScript(db, 'project-1', scriptId, {
    title: '口播第二版',
    bodyText: '第二版正文',
    sourceVersion: 'v2',
    now: () => new Date('2026-08-01T09:30:00.000Z'),
  });
  assert.equal(getProjectScript(db, 'project-1', scriptId)?.bodyText, '第二版正文');

  // --- 批次快照:开跑后固定正文与标题 ---
  const batchId = createBatchProduction(db, 'project-1', '八月大促混剪', () => new Date('2026-08-01T10:00:00.000Z'));
  const version1 = createBatchProductionVersion(db, batchId, { copyCount: 2, now: () => new Date('2026-08-01T10:05:00.000Z') });

  // 外部文案是批次版本内的输入，不是项目脚本
  const externalId = createBatchExternalScript(db, version1, {
    sourceId: 'external-1',
    title: '外部文案',
    bodyText: '外部文案正文',
    sourceVersion: 'v1',
    now: () => new Date('2026-08-01T09:40:00.000Z'),
  });
  assert.notEqual(externalId, scriptId);

  // --- 外部文案默认只属于当前批次:不进入项目脚本列表 ---
  const projectScripts = listProjectScripts(db, 'project-1');
  assert.deepEqual(projectScripts.map(({ id }) => id), [scriptId], '外部文案不得出现在项目脚本列表中');
  assert.throws(
    () => updateProjectScript(db, 'project-1', externalId, {
      title: '不应成功',
      bodyText: '不能借普通项目脚本更新接口提升外部文案',
      sourceVersion: 'v2',
    }),
    /项目脚本不存在/,
    '普通更新接口不得把外部文案静默转成项目脚本',
  );

  updateBatchExternalScript(db, version1, externalId, {
    title: '外部文案第二版',
    bodyText: '外部文案正文第二版',
    sourceVersion: 'v2',
    now: () => new Date('2026-08-01T09:44:00.000Z'),
  });

  // 用户明确“保存为项目文案”时复制出独立项目脚本，批次内来源仍保留原身份
  const savedExternalId = saveExternalScriptAsProjectScript(db, version1, externalId, {
    sourceId: 'saved-external-1',
    now: () => new Date('2026-08-01T09:45:00.000Z'),
  });
  assert.notEqual(savedExternalId, externalId);
  assert.equal(getProjectScript(db, 'project-1', externalId), undefined, '项目脚本读取接口不得暴露批次内文案');
  assert.equal(getBatchExternalScript(db, version1, externalId)?.sourceKind, 'external');
  assert.equal(getProjectScript(db, 'project-1', savedExternalId)?.sourceKind, 'script_draft');
  updateProjectScript(db, 'project-1', savedExternalId, {
    title: '外部文案',
    bodyText: '外部文案正文',
    sourceVersion: 'v1',
    now: () => new Date('2026-08-01T09:45:00.000Z'),
  });
  assert.deepEqual(
    listProjectScripts(db, 'project-1').map(({ id }) => id).sort(),
    [savedExternalId, scriptId].sort(),
    '保存为项目文案后外部文案进入项目脚本列表',
  );

  const snapshotId = snapshotScriptIntoBatch(db, version1, {
    scriptId,
    copyCount: 2,
    now: () => new Date('2026-08-01T10:10:00.000Z'),
  });
  assert.ok(snapshotId);
  const snapshot = getScriptSnapshot(db, version1, snapshotId);
  assert.equal(snapshot?.bodyText, '第二版正文', '快照必须记录开始生产时的正文');
  assert.equal(snapshot?.title, '口播第二版');
  assert.equal(snapshot?.sourceVersion, 'v2');
  assert.equal(snapshot?.copyCount, 2, '快照必须记录生成份数');

  // --- 批次开始后修改项目脚本,旧批次快照不得漂移 ---
  updateProjectScript(db, 'project-1', scriptId, {
    title: '口播第三版',
    bodyText: '第三版正文',
    sourceVersion: 'v3',
    now: () => new Date('2026-08-01T11:00:00.000Z'),
  });
  const snapshotAfterChange = getScriptSnapshot(db, version1, snapshotId);
  assert.equal(snapshotAfterChange?.bodyText, '第二版正文', '上游脚本修改不得静默改写已开始的批次快照');
  assert.equal(snapshotAfterChange?.title, '口播第二版');
  assert.equal(snapshotAfterChange?.sourceVersion, 'v2');

  // 同一脚本不能在同一批次版本重复快照
  assert.throws(
    () => snapshotScriptIntoBatch(db, version1, { scriptId, copyCount: 2 }),
    /重复/,
    '同一批次版本不能重复快照同一来源脚本',
  );

  // 外部文案快照独立存在
  const externalSnapshot = snapshotScriptIntoBatch(db, version1, {
    scriptId: externalId,
    copyCount: 3,
    now: () => new Date('2026-08-01T11:30:00.000Z'),
  });
  assert.equal(listScriptSnapshots(db, version1).length, 2);
  assert.equal(getScriptSnapshot(db, version1, externalSnapshot)?.copyCount, 3);
  assert.equal(getScriptSnapshot(db, version1, externalSnapshot)?.bodyText, '外部文案正文第二版');

  // 新批次版本不受旧快照影响
  const version2 = createBatchProductionVersion(db, batchId, { copyCount: 1, now: () => new Date('2026-08-01T12:00:00.000Z') });
  assert.equal(listScriptSnapshots(db, version2).length, 0, '批次版本之间的脚本快照必须隔离');
  assert.throws(
    () => snapshotScriptIntoBatch(db, version2, { scriptId: externalId, copyCount: 1 }),
    /不属于该批次版本/,
    '外部文案不得跨批次版本复用',
  );
  const version2ExternalId = createBatchExternalScript(db, version2, {
    sourceId: 'external-1',
    title: '新版本外部文案',
    bodyText: '相同外部来源标识可以在新版本形成独立输入',
    sourceVersion: 'v1',
  });
  assert.notEqual(version2ExternalId, externalId);

  // --- 项目归属防串线:项目 2 的脚本不能快照进项目 1 的批次 ---
  db.prepare(`INSERT INTO projects (id, name) VALUES ('project-2', '项目二')`).run();
  const project2Script = createProjectScript(db, 'project-2', {
    sourceKind: 'script_draft',
    sourceId: 'draft-p2',
    title: '项目二脚本',
    bodyText: '项目二正文',
    sourceVersion: 'v1',
    now: () => new Date('2026-08-01T12:10:00.000Z'),
  });
  assert.throws(
    () => snapshotScriptIntoBatch(db, version2, { scriptId: project2Script, copyCount: 1 }),
    /不属于/,
    '其他项目的脚本不得快照进本项目的批次版本',
  );
  assert.equal(listScriptSnapshots(db, version2).length, 0, '串线尝试不得写入任何快照');

  // --- 批次开始后输入冻结:不能再向批次版本快照脚本 ---
  updateBatchProductionStatus(db, 'project-1', batchId, 'running', () => new Date('2026-08-01T12:20:00.000Z'));
  assert.throws(
    () => snapshotScriptIntoBatch(db, version2, { scriptId, copyCount: 1 }),
    /冻结/,
    '批次开始后不得向既有批次版本追加脚本快照',
  );
  assert.equal(listScriptSnapshots(db, version2).length, 0);

  // --- 配音配置按脚本单独存储(FR-S2-14) ---
  db.exec(`
    CREATE TABLE final_edit_tts_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, baseUrl TEXT NOT NULL,
      apiKey TEXT NOT NULL DEFAULT '', keyEnv TEXT NOT NULL DEFAULT '', model TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, isBuiltin INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    INSERT INTO final_edit_tts_providers
      (id, name, type, baseUrl, apiKey, keyEnv, model, enabled, isBuiltin, createdAt, updatedAt)
    VALUES ('vapi-qwen3-tts', 'V-API Qwen3 TTS Flash', 'vapi-qwen-json-url', 'https://api.v3.cm', 'k', '', 'qwen3-tts-flash', 1, 1, datetime('now'), datetime('now'));
  `);
  updateProjectScriptNarrationConfig(db, 'project-1', scriptId, { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1.3 }, () => new Date('2026-08-02T10:00:00.000Z'));
  const stored = parseStoredNarrationConfig(getProjectScript(db, 'project-1', scriptId)?.narrationConfigJson);
  assert.deepEqual(stored, { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1.3 }, '配音配置必须按脚本单独持久化');
  assert.throws(
    () => updateProjectScriptNarrationConfig(db, 'project-1', scriptId, { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 3 }),
    /0\.5x–2\.0x/,
    '语速超出 0.5–2.0 范围必须拒绝',
  );
  assert.throws(
    () => updateProjectScriptNarrationConfig(db, 'project-1', scriptId, { providerId: 'missing-provider', voice: 'Cherry', speed: 1 }),
    /供应商/,
    '未启用的配音供应商必须拒绝',
  );
  assert.throws(
    () => updateProjectScriptNarrationConfig(db, 'project-1', externalId, { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 }),
    /项目脚本不存在/,
    '外部文案不能通过项目脚本配置接口修改',
  );

  db.close();
  console.log('batch domain scripts tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
