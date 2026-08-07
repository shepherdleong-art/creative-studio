import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { resolveProjectExportDirName, assertSafeExportDirName } from '../lib/project-export-dir.ts';
import { FinalEditError } from '../lib/final-edit/errors.ts';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      productCode TEXT DEFAULT '',
      exportDirName TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

function insertProject(db: Database.Database, row: { id: string; name: string; productCode?: string; createdAt?: string; exportDirName?: string }): void {
  db.prepare(`
    INSERT INTO projects (id, name, createdAt, productCode, exportDirName)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, row.name, row.createdAt ?? '2026-08-01 08:00:00', row.productCode ?? '', row.exportDirName ?? '');
}

// 1. 正常生成:<产品编码>-<YYYYMMDD>,日期取项目创建日(上海时区)
{
  const db = makeDb();
  insertProject(db, { id: 'p1', name: '床垫项目', productCode: 'G564', createdAt: '2026-08-07 08:00:00' });
  assert.equal(resolveProjectExportDirName(db, 'p1'), 'G564-20260807');
  db.close();
}

// 2. 产品编码为空的回落链:编码 → 项目名 → projectId
{
  const db = makeDb();
  insertProject(db, { id: 'p-name', name: '乳胶枕 项目', productCode: '', createdAt: '2026-08-07 08:00:00' });
  assert.equal(resolveProjectExportDirName(db, 'p-name'), '乳胶枕 项目-20260807'.replace(' ', ''));
  const rawName = resolveProjectExportDirName(db, 'p-name');
  assert.equal(rawName, '乳胶枕项目-20260807', '空格不在允许字符集内,应被清洗');
  insertProject(db, { id: 'p-empty', name: '', productCode: '', createdAt: '2026-08-07 08:00:00' });
  assert.equal(resolveProjectExportDirName(db, 'p-empty'), 'p-empty-20260807', '名称也为空时必须回落到 projectId');
  db.close();
}

// 3. 非法字符清洗:只允许 [A-Za-z0-9._\-一-龥]
{
  const db = makeDb();
  insertProject(db, { id: 'p-dirty', name: 'x', productCode: 'A/B:C*D?E"F<G>H|I  J…（括号）', createdAt: '2026-08-07 08:00:00' });
  const name = resolveProjectExportDirName(db, 'p-dirty');
  assert.ok(/^[A-Za-z0-9._\-一-龥]+$/.test(name), `目录名含非法字符: ${name}`);
  assert.equal(name, 'ABCDEFGHIJ括号-20260807', 'ASCII 标点与空格被清洗,中文汉字保留');
  db.close();
}

// 4. 跨项目重名加后缀 -2、-3
{
  const db = makeDb();
  insertProject(db, { id: 'a', name: 'A', productCode: 'G564', createdAt: '2026-08-07 08:00:00' });
  insertProject(db, { id: 'b', name: 'B', productCode: 'G564', createdAt: '2026-08-07 08:00:00' });
  insertProject(db, { id: 'c', name: 'C', productCode: 'G564', createdAt: '2026-08-07 08:00:00' });
  assert.equal(resolveProjectExportDirName(db, 'a'), 'G564-20260807');
  assert.equal(resolveProjectExportDirName(db, 'b'), 'G564-20260807-2');
  assert.equal(resolveProjectExportDirName(db, 'c'), 'G564-20260807-3');
  db.close();
}

// 5. 二次调用幂等:已落库的名字不随产品编码变化而重算
{
  const db = makeDb();
  insertProject(db, { id: 'p-idem', name: 'X', productCode: 'OLD-CODE', createdAt: '2026-08-07 08:00:00' });
  assert.equal(resolveProjectExportDirName(db, 'p-idem'), 'OLD-CODE-20260807');
  db.prepare(`UPDATE projects SET productCode = 'NEW-CODE' WHERE id = 'p-idem'`).run();
  assert.equal(resolveProjectExportDirName(db, 'p-idem'), 'OLD-CODE-20260807', '已落库的目录名不得随编码改动漂移');
  db.close();
}

// 6. 守卫:非法目录名一律拒绝
{
  assert.throws(() => assertSafeExportDirName(''), (error: unknown) => error instanceof FinalEditError && error.code === 'unsafe_path');
  assert.throws(() => assertSafeExportDirName('..'), (error: unknown) => error instanceof FinalEditError && error.code === 'unsafe_path');
  assert.throws(() => assertSafeExportDirName('a/b'), (error: unknown) => error instanceof FinalEditError && error.code === 'unsafe_path');
  assert.throws(() => assertSafeExportDirName('a\\b'), (error: unknown) => error instanceof FinalEditError && error.code === 'unsafe_path');
  assert.throws(() => assertSafeExportDirName('a b'), (error: unknown) => error instanceof FinalEditError && error.code === 'unsafe_path');
  assert.doesNotThrow(() => assertSafeExportDirName('G564-20260807'));
  assert.doesNotThrow(() => assertSafeExportDirName('乳胶枕项目-20260807'));
}

console.log('project-export-dir tests passed');
