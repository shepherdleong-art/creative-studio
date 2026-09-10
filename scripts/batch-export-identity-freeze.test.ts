import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';
import { freezeBatchExportIdentity, readFrozenBatchExportIdentity } from '../lib/batch-production/batch-flow.ts';
import { createExportIdentity } from '../lib/project-export-identity.ts';

// ---------------------------------------------------------------------------
// 回归测试:批次 start 冻结导出身份(freezeBatchExportIdentity)。
//
// 2026-09-10 事故:生产身份完整但项目还没有冻结身份(从未正式导出)时,
// 批次 start 把导出目录名冻结成旧公式 `<型号>-<日期>`(如 BS883-A-20260909),
// 且 baseName 留空;发布时目录名沿用冻结快照(错),文件名只有「创建身份的那一
// 次发布调用」用新名,后续调用全部回退 `成片-` 旧名——同批导出出现混合命名。
// 正确行为:身份完整时按首次正式导出将使用的 `{日期}-{店铺}-{型号}[-{子型号}]-{生产类型}-{剪辑师}`
// 公式冻结目录名与 baseName(只读预判,不落库;身份修订仍在首次导出时创建)。
// ---------------------------------------------------------------------------

function createTestDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      productCode TEXT DEFAULT '',
      exportDirName TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      storeCode TEXT NOT NULL DEFAULT '',
      productSubmodel TEXT NOT NULL DEFAULT '',
      productionType TEXT NOT NULL DEFAULT '',
      editorName TEXT NOT NULL DEFAULT '',
      namingDate TEXT NOT NULL DEFAULT '',
      currentExportIdentityId TEXT
    );
    CREATE TABLE project_export_identities (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      revisionNumber INTEGER NOT NULL,
      baseName TEXT NOT NULL,
      exportDirName TEXT NOT NULL,
      identityJson TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      supersededAt TEXT,
      UNIQUE(projectId, revisionNumber),
      UNIQUE(exportDirName)
    );
  `);
  return db;
}

const IDENTITY = {
  storeCode: '京东',
  productCode: 'BS883-A',
  productSubmodel: '',
  productionType: 'AI种草',
  editorName: 'PUIKIN',
  namingDate: '20260909',
} as const;
const EXPECTED_NAME = '20260909-京东-BS883-A-AI种草-PUIKIN';

function insertCompleteProject(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO projects (id, name, productCode, createdAt, storeCode, productSubmodel, productionType, editorName, namingDate)
    VALUES (?, ?, ?, '2026-09-09 07:42:22', ?, ?, ?, ?, ?)
  `).run(id, EXPECTED_NAME, IDENTITY.productCode, IDENTITY.storeCode, IDENTITY.productSubmodel, IDENTITY.productionType, IDENTITY.editorName, IDENTITY.namingDate);
}

function makeVersion(db: Database.Database, projectId: string): string {
  const batchId = createBatchProduction(db, projectId, '批次');
  return createBatchProductionVersion(db, batchId, { copyCount: 1 });
}

function frozenOf(db: Database.Database, versionId: string) {
  const frozen = readFrozenBatchExportIdentity(db, versionId);
  assert.ok(frozen, 'start 必须冻结导出身份快照');
  return frozen;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-freeze-identity-'));
let db: Database.Database | null = null;

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  db = createTestDatabase(dbRoot, 'workbench.db');
  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-09-10T00:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // 1. 身份完整、尚无冻结身份(从未正式导出):必须按新公式冻结目录名与 baseName。
  {
    insertCompleteProject(db, 'proj-complete');
    const versionId = makeVersion(db, 'proj-complete');
    freezeBatchExportIdentity(db, 'proj-complete', versionId);
    const frozen = frozenOf(db, versionId);
    assert.equal(frozen.exportDirName, EXPECTED_NAME, '身份完整时冻结目录名必须使用新命名公式,不得回落旧「型号-日期」');
    assert.equal(frozen.baseName, EXPECTED_NAME, '身份完整时 baseName 不得留空(否则后续发布调用回退「成片-」旧文件名)');
    assert.deepEqual(frozen.identity, IDENTITY, '身份字段快照保持完整');
    const project = db.prepare(`SELECT exportDirName, currentExportIdentityId FROM projects WHERE id = 'proj-complete'`).get() as { exportDirName: string; currentExportIdentityId: string | null };
    assert.equal(project.exportDirName, '', 'start 冻结不得提前落库 projects.exportDirName(身份修订只在首次正式导出时创建)');
    assert.equal(project.currentExportIdentityId, null, 'start 冻结不得创建身份修订');
  }

  // 2. 已有当前冻结身份:沿用当前身份的名字,即使项目字段后来被改动。
  {
    insertCompleteProject(db, 'proj-current');
    const identity = createExportIdentity(db, { projectId: 'proj-current', identity: { ...IDENTITY, namingDate: '20260909' }, now: new Date('2026-09-09T08:00:00.000Z') });
    db.prepare(`UPDATE projects SET productCode = '改名后' WHERE id = 'proj-current'`).run();
    const versionId = makeVersion(db, 'proj-current');
    freezeBatchExportIdentity(db, 'proj-current', versionId);
    const frozen = frozenOf(db, versionId);
    assert.equal(frozen.exportDirName, identity.exportDirName, '已冻结身份优先,批次不得另算名字');
    assert.equal(frozen.baseName, identity.baseName);
  }

  // 3. 身份不完整:保持旧公式回退与 identity 留空(历史项目兼容语义)。
  {
    db.prepare(`
      INSERT INTO projects (id, name, productCode, createdAt) VALUES ('proj-legacy', '老项目', 'BS883-A', '2026-09-09 07:42:22')
    `).run();
    const versionId = makeVersion(db, 'proj-legacy');
    freezeBatchExportIdentity(db, 'proj-legacy', versionId);
    const frozen = frozenOf(db, versionId);
    assert.equal(frozen.exportDirName, 'BS883-A-20260909', '身份不完整时目录名保持旧「型号-日期」回退');
    assert.equal(frozen.baseName, null);
    assert.equal(frozen.identity, null);
  }

  // 4. 预判名与他项目已占用名冲突:与 createExportIdentity 同样的唯一消解(-02)。
  {
    const clashIdentity = { ...IDENTITY, productCode: 'PC615' };
    const clashName = '20260909-京东-PC615-AI种草-PUIKIN';
    db.prepare(`
      INSERT INTO projects (id, name, productCode, createdAt, storeCode, productSubmodel, productionType, editorName, namingDate)
      VALUES ('proj-taken', ?, 'PC615', '2026-09-09 07:42:22', ?, '', ?, ?, ?)
    `).run(clashName, clashIdentity.storeCode, clashIdentity.productionType, clashIdentity.editorName, clashIdentity.namingDate);
    createExportIdentity(db, { projectId: 'proj-taken', identity: clashIdentity, now: new Date('2026-09-09T08:00:00.000Z') });
    db.prepare(`
      INSERT INTO projects (id, name, productCode, createdAt, storeCode, productSubmodel, productionType, editorName, namingDate)
      VALUES ('proj-clash', ?, 'PC615', '2026-09-09 07:42:22', ?, '', ?, ?, ?)
    `).run(clashName, clashIdentity.storeCode, clashIdentity.productionType, clashIdentity.editorName, clashIdentity.namingDate);
    const versionId = makeVersion(db, 'proj-clash');
    freezeBatchExportIdentity(db, 'proj-clash', versionId);
    const frozen = frozenOf(db, versionId);
    assert.equal(frozen.exportDirName, `${clashName}-02`, '与他项目撞名时必须像首次导出一样追加 -02');
    assert.equal(frozen.baseName, `${clashName}-02`);
  }

  db.close();
  db = null;
  console.log('batch export-identity freeze tests passed');
} finally {
  try { db?.close(); } catch { /* 已关闭 */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
