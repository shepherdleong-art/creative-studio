import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-bundled-presets-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
register('./typescript-extension-loader.mjs', import.meta.url);
const { getDb, closeDb } = await import('../lib/db.ts');
const { getScriptStudioReadiness } = await import('../lib/script-studio/runtime-readiness.ts');
const { seedBundledMotionPresets } = await import('../lib/bundled-motion-presets.ts');
const { importViralTemplateLibrary, getViralTemplateLibraryView } = await import('../lib/script-studio/viral-templates.ts');

async function workbook(text: string): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('全部模板');
  sheet.addRow(['类目', '子类目', '模板名称', '标题', '参考文案', '结构摘要', '模板ID']);
  sheet.addRow(['床', '实木床', '内置模板', '床的选择', text, '钩子>卖点>结尾', 'tpl-bundled']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

try {
  fs.mkdirSync(path.join(root, 'bundled-presets'));
  const bundle = { schemaVersion: 1, kind: 'creative-studio-motion-templates', templates: [
    { id: 'bundled-motion', name: '内置运镜', description: '说明', prompt: '缓慢推近主体', inRandomPool: 1 },
  ] };
  fs.writeFileSync(path.join(root, 'bundled-presets/motion-template-presets.json'), JSON.stringify(bundle));
  const buffer = await workbook('整块实木框架搭配舒适床头，卧室空间更自然。');
  fs.writeFileSync(path.join(root, 'bundled-presets/viral-templates.xlsx'), buffer);
  const db = getDb();
  assert.equal((db.prepare('SELECT prompt FROM video_prompt_templates WHERE id=?').get('bundled-motion') as { prompt: string }).prompt, '缓慢推近主体');
  const ready = await getScriptStudioReadiness();
  assert.equal(ready.available, true);
  const first = getViralTemplateLibraryView(db);
  assert.equal(first.current?.entryCounts.total, 1);
  await Promise.all([getScriptStudioReadiness(), getScriptStudioReadiness()]);
  assert.equal(getViralTemplateLibraryView(db).revisions.length, 1);

  db.prepare('UPDATE video_prompt_templates SET prompt=?, inRandomPool=0 WHERE id=?').run('用户自己的修改', 'bundled-motion');
  seedBundledMotionPresets(db);
  assert.deepEqual(db.prepare('SELECT prompt,inRandomPool FROM video_prompt_templates WHERE id=?').get('bundled-motion'), { prompt: '用户自己的修改', inRandomPool: 0 });
  bundle.templates[0].id = 'renamed-source-id';
  fs.writeFileSync(path.join(root, 'bundled-presets/motion-template-presets.json'), JSON.stringify(bundle));
  seedBundledMotionPresets(db);
  assert.equal(db.prepare('SELECT id FROM video_prompt_templates WHERE id=?').get('renamed-source-id'), undefined);

  const builtin = db.prepare('SELECT id, openingCode, inRandomPool FROM video_prompt_templates WHERE name=?').get('纸箱爆炸') as { id: string; openingCode: string; inRandomPool: number };
  bundle.templates = [{ id: 'historical-carton-id', name: '纸箱爆炸', description: '随包定稿', prompt: '使用随包的最终定稿文案', inRandomPool: 0 }];
  fs.writeFileSync(path.join(root, 'bundled-presets/motion-template-presets.json'), JSON.stringify(bundle));
  seedBundledMotionPresets(db);
  assert.deepEqual(db.prepare('SELECT id, openingCode, inRandomPool FROM video_prompt_templates WHERE name=?').get('纸箱爆炸'), builtin);
  assert.equal((db.prepare('SELECT prompt FROM video_prompt_templates WHERE id=?').get(builtin.id) as { prompt: string }).prompt, '使用随包的最终定稿文案');
  assert.equal(db.prepare('SELECT id FROM video_prompt_templates WHERE id=?').get('historical-carton-id'), undefined);

  const manual = await importViralTemplateLibrary(db, await workbook('用户手动导入的新版本，保留这份内容。'), '用户模板.xlsx');
  const skipped = await importViralTemplateLibrary(db, await workbook('另一个随包版本，不应覆盖用户内容。'), '默认库.xlsx', undefined, { onlyIfEmpty: true });
  assert.equal(skipped.created, false);
  assert.equal(skipped.revisionId, manual.revisionId);
  closeDb();
  const reopened = getDb();
  // New connection models restarting after migrating a populated database.
  const { ensureBundledViralPresets } = await import('../lib/script-studio/bundled-viral-presets.ts');
  await ensureBundledViralPresets(reopened);
  assert.equal(getViralTemplateLibraryView(reopened).current?.id, manual.revisionId);
  assert.equal(getViralTemplateLibraryView(reopened).revisions.length, 2);
  console.log('PASS: bundled presets first launch, repeat launch, conflicts, and existing library preservation');
} finally {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
