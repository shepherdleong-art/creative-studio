import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { importPresets, validatePresets } from './import-motion-template-presets.mjs';
import { exportPresets } from './export-motion-template-presets.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-presets-'));
function database(name) {
  const dataRoot = path.join(root, name);
  fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
  const db = new Database(path.join(dataRoot, 'data/workbench.db'));
  db.exec(`CREATE TABLE video_prompt_templates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', prompt TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'camera_motion', isBuiltin INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), inRandomPool INTEGER NOT NULL DEFAULT 1
  ); CREATE TABLE providers (apiKey TEXT); INSERT INTO providers VALUES ('PRIVATE_SENTINEL');`);
  return { dataRoot, db };
}
const template = (id, name) => ({ id, name, description: '', prompt: '镜头缓慢推进', inRandomPool: 0 });
const bundle = { schemaVersion: 1, kind: 'creative-studio-motion-templates', templates: [template('custom-one', '自定义一'), template('custom-two', '自定义二')] };
try {
  const { dataRoot, db } = database('中文 空格');
  db.prepare('INSERT INTO video_prompt_templates (id,name,prompt,isBuiltin) VALUES (?,?,?,1)').run('builtin', '推进', '内置');
  const result = await importPresets(dataRoot, bundle);
  assert.equal(result.added, 2);
  const backup = new Database(result.backupPath, { readonly: true });
  assert.equal(backup.prepare('SELECT COUNT(*) n FROM video_prompt_templates').get().n, 1);
  assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
  backup.close();
  assert.equal(db.prepare('SELECT inRandomPool FROM video_prompt_templates WHERE id=?').get('custom-one').inRandomPool, 0);
  db.prepare('UPDATE video_prompt_templates SET prompt=?,inRandomPool=1 WHERE id=?').run('同事已修改', 'custom-one');
  const again = await importPresets(dataRoot, bundle);
  assert.equal(again.added, 0);
  assert.deepEqual(again.conflicts, ['自定义一']);
  assert.equal(again.existing, 1);
  assert.equal(db.prepare('SELECT prompt FROM video_prompt_templates WHERE id=?').get('custom-one').prompt, '同事已修改');
  const sameName = await importPresets(dataRoot, { ...bundle, templates: [template('another-id', '自定义一')] });
  assert.equal(sameName.added, 0);
  assert.equal(sameName.conflicts.length, 1);
  assert.equal(db.prepare('SELECT apiKey FROM providers').get().apiKey, 'PRIVATE_SENTINEL');
  assert.throws(() => validatePresets({ ...bundle, templates: [...bundle.templates, { ...template('invalid', '无效'), inRandomPool: 'yes' }] }));
  await assert.rejects(importPresets(dataRoot, { ...bundle, templates: [template('valid', '有效'), { ...template('bad', '无效'), prompt: '' }] }));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM video_prompt_templates').get().n, 3, 'invalid bundle must not partially import');
  db.exec(`CREATE TRIGGER reject_bad_template BEFORE INSERT ON video_prompt_templates
    WHEN NEW.id = 'reject-me' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
  await assert.rejects(importPresets(dataRoot, { ...bundle, templates: [template('rollback-one', '事务第一条'), template('reject-me', '事务第二条')] }), /fixture failure/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM video_prompt_templates').get().n, 3, 'database failure must roll back every insertion');
  db.exec('DROP TRIGGER reject_bad_template');
  await assert.rejects(importPresets(path.join(root, 'never-started'), bundle), /启动/);
  assert.equal(fs.existsSync(path.join(root, 'never-started/data/workbench.db')), false);
  const addonRoot = path.join(root, 'addon');
  const exported = exportPresets(dataRoot, addonRoot);
  assert.equal(exported.count, 2);
  const serialized = fs.readFileSync(path.join(addonRoot, 'motion-template-presets.json'), 'utf8');
  assert.ok(!serialized.includes('PRIVATE_SENTINEL'));
  assert.ok(!serialized.includes('builtin'));
  assert.ok(!fs.existsSync(path.join(addonRoot, 'data')));
  assert.throws(() => exportPresets(dataRoot, addonRoot), /已存在/);
  const fresh = database('recipient');
  const imported = await importPresets(fresh.dataRoot, JSON.parse(serialized));
  assert.equal(imported.added, 2);
  assert.equal(fresh.db.prepare('SELECT prompt FROM video_prompt_templates WHERE id=?').get('custom-one').prompt, '同事已修改');
  fresh.db.close();
  db.close();
  console.log('motion template presets tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
