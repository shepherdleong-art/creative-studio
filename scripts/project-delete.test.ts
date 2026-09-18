import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { deleteProjectRecords } from '../lib/project-delete.ts';
import { SCRIPT_STUDIO_MIGRATIONS } from '../lib/script-studio/schema.ts';

function fixture(withScriptStudio = true) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE shot_sets (id TEXT PRIMARY KEY);
    CREATE TABLE image_assets (
      id TEXT PRIMARY KEY, projectId TEXT REFERENCES projects(id) ON DELETE SET NULL,
      path TEXT, originalPath TEXT, processedPath TEXT
    );
    INSERT INTO projects VALUES ('p1'), ('p2');
    INSERT INTO image_assets VALUES ('a1', 'p1', 'one.png', 'original.png', NULL),
      ('a2', 'p2', 'two.png', NULL, NULL);
  `);
  if (withScriptStudio) {
    for (const migration of SCRIPT_STUDIO_MIGRATIONS) db.exec(migration.sql);
    for (const projectId of ['p1', 'p2']) {
      db.prepare(`INSERT INTO script_studio_source_sets
        (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
        VALUES (?, ?, 'fingerprint', '[]', 'now')`).run(projectId, projectId);
      db.prepare(`INSERT INTO script_studio_libraries
        (id, projectId, createdAt, updatedAt) VALUES (?, ?, 'now', 'now')`).run(projectId, projectId);
      db.prepare(`INSERT INTO script_studio_library_revisions
        (id, libraryId, revisionNumber, sourceSetId, sourceFingerprint, origin, createdAt)
        VALUES (?, ?, 1, ?, 'fingerprint', 'ai_extract', 'now')`).run(projectId, projectId, projectId);
      db.prepare(`INSERT INTO script_studio_selling_point_themes
        (id, revisionId, seq, themeKey, title, createdAt)
        VALUES (?, ?, 1, 'theme', '历史卖点主题', 'now')`).run(projectId, projectId);
    }
  }
  return db;
}

// 历史 v11 主题引用真实迁移创建的卖点修订，复现脚本测试后项目无法删除。
{
  const db = fixture();
  assert.deepEqual(deleteProjectRecords(db, 'p1'), [
    { id: 'a1', path: 'one.png', originalPath: 'original.png', processedPath: null },
  ]);
  for (const table of ['projects', 'image_assets', 'script_studio_source_sets',
    'script_studio_libraries', 'script_studio_library_revisions', 'script_studio_selling_point_themes']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 1);
  }
  assert.ok(db.prepare("SELECT 1 FROM script_studio_selling_point_themes WHERE id = 'p2'").get());
  assert.ok(db.prepare("SELECT 1 FROM image_assets WHERE id = 'a2' AND projectId = 'p2'").get());
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(deleteProjectRecords(db, 'missing'), null);
  db.close();
}

// 未安装脚本模块以及 v11 之前的数据库仍可删除项目。
for (const withScriptStudio of [false, true]) {
  const db = fixture(withScriptStudio);
  if (withScriptStudio) db.exec('DROP TABLE script_studio_selling_point_themes');
  assert.equal(deleteProjectRecords(db, 'p1')?.length, 1);
  assert.ok(db.prepare("SELECT 1 FROM projects WHERE id = 'p2'").get());
  db.close();
}

// 后续删除失败时，历史主题、项目、素材全部回滚，不能返回待删文件。
{
  const db = fixture();
  db.exec(`CREATE TRIGGER block_asset_delete BEFORE DELETE ON image_assets
    BEGIN SELECT RAISE(ABORT, 'asset deletion blocked'); END;`);
  assert.throws(() => deleteProjectRecords(db, 'p1'), /asset deletion blocked/);
  assert.ok(db.prepare("SELECT 1 FROM projects WHERE id = 'p1'").get());
  assert.ok(db.prepare("SELECT 1 FROM script_studio_selling_point_themes WHERE id = 'p1'").get());
  assert.ok(db.prepare("SELECT 1 FROM image_assets WHERE id = 'a1' AND projectId = 'p1'").get());
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
}

console.log('project-delete tests passed');
