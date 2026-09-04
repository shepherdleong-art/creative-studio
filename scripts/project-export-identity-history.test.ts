import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  createExportIdentity,
  activateNewExportIdentity,
  getExportIdentity,
  getCurrentExportIdentity,
  listExportIdentities,
  hasExportIdentity,
} from '../lib/project-export-identity.ts';
import type { ProjectProductionIdentity } from '../lib/project-production-identity.ts';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      productCode TEXT DEFAULT '',
      exportDirName TEXT NOT NULL DEFAULT '',
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

function insertProject(db: Database.Database, row: { id: string; name: string; productCode?: string; exportDirName?: string }): void {
  db.prepare(`INSERT INTO projects (id, name, createdAt, productCode, exportDirName) VALUES (?, ?, ?, ?, ?)`)
    .run(row.id, row.name, '2026-08-01 08:00:00', row.productCode ?? '', row.exportDirName ?? '');
}

const FIXED_NOW = new Date('2026-09-03T02:00:00Z');

const identityA: ProjectProductionIdentity = {
  namingDate: '20260815', storeCode: 'B店', productCode: 'XQ9A', productSubmodel: '', productionType: 'AI种草', editorName: '紫菜卷',
};

// 1. 首次冻结:revision 1,projects.name/exportDirName/currentExportIdentityId 同步
{
  const db = makeDb();
  insertProject(db, { id: 'p1', name: '旧名', productCode: 'OLD' });
  const view = createExportIdentity(db, { projectId: 'p1', identity: identityA, now: FIXED_NOW });
  assert.equal(view.revisionNumber, 1);
  assert.equal(view.baseName, '20260815-B店-XQ9A-AI种草-紫菜卷');
  assert.equal(view.exportDirName, '20260815-B店-XQ9A-AI种草-紫菜卷');
  assert.deepEqual(view.identity, identityA);
  const row = db.prepare(`SELECT name, exportDirName, currentExportIdentityId FROM projects WHERE id = 'p1'`).get() as Record<string, string>;
  assert.equal(row.name, '20260815-B店-XQ9A-AI种草-紫菜卷');
  assert.equal(row.exportDirName, '20260815-B店-XQ9A-AI种草-紫菜卷');
  assert.equal(row.currentExportIdentityId, view.id);
  assert.equal(hasExportIdentity(db, 'p1'), true);
  assert.equal(getCurrentExportIdentity(db, 'p1')?.id, view.id);
  db.close();
}

// 2. 基础名与目录名使用同一个唯一消解:同名项目追加 -02
{
  const db = makeDb();
  insertProject(db, { id: 'p1', name: '20260815-B店-XQ9A-AI种草-紫菜卷' });
  insertProject(db, { id: 'p2', name: 'x', productCode: 'XQ9A' });
  const view = createExportIdentity(db, { projectId: 'p2', identity: identityA, now: FIXED_NOW });
  assert.equal(view.baseName, '20260815-B店-XQ9A-AI种草-紫菜卷-02');
  assert.equal(view.exportDirName, '20260815-B店-XQ9A-AI种草-紫菜卷-02');
  db.close();
}

// 3. 显式启用新名称:旧修订 superseded,新修订 revision 2,历史可追溯
{
  const db = makeDb();
  insertProject(db, { id: 'p1', name: 'x', productCode: 'XQ9A' });
  const v1 = createExportIdentity(db, { projectId: 'p1', identity: identityA, now: FIXED_NOW });
  const identityB: ProjectProductionIdentity = {
    ...identityA, productSubmodel: 'A', productCode: 'XQ9A',
  };
  const v2 = activateNewExportIdentity(db, { projectId: 'p1', identity: identityB, now: FIXED_NOW });
  assert.equal(v2.revisionNumber, 2);
  assert.equal(v2.baseName, '20260815-B店-XQ9A-A-AI种草-紫菜卷');
  assert.equal(v2.exportDirName, '20260815-B店-XQ9A-A-AI种草-紫菜卷');
  assert.equal(getCurrentExportIdentity(db, 'p1')?.id, v2.id);
  assert.equal(getExportIdentity(db, v1.id).supersededAt, FIXED_NOW.toISOString(), '旧身份必须标记 superseded');
  const all = listExportIdentities(db, 'p1');
  assert.equal(all.length, 2);
  assert.equal(all[0].id, v1.id);
  assert.equal(all[1].id, v2.id);
  // 旧目录名保留不变
  const oldDir = all[0].exportDirName;
  assert.equal(oldDir, '20260815-B店-XQ9A-AI种草-紫菜卷');
  db.close();
}

// 4. 冻结后普通字段不同但未显式启用:不产生新修订
{
  const db = makeDb();
  insertProject(db, { id: 'p1', name: 'x' });
  createExportIdentity(db, { projectId: 'p1', identity: identityA, now: FIXED_NOW });
  assert.equal(listExportIdentities(db, 'p1').length, 1, '未显式启用时不得新增修订');
  db.close();
}

// 5. 无冻结时 hasExportIdentity 为 false
{
  const db = makeDb();
  insertProject(db, { id: 'p1', name: 'x' });
  assert.equal(hasExportIdentity(db, 'p1'), false);
  assert.equal(getCurrentExportIdentity(db, 'p1'), null);
  assert.deepEqual(listExportIdentities(db, 'p1'), []);
  db.close();
}

console.log('project-export-identity-history tests passed');
