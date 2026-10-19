import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const fields = ['id', 'name', 'description', 'prompt', 'inRandomPool'];
export function validatePresets(bundle) {
  if (bundle?.schemaVersion !== 1 || bundle?.kind !== 'creative-studio-motion-templates'
    || !Array.isArray(bundle.templates) || bundle.templates.length < 1 || bundle.templates.length > 500) {
    throw new Error('自定义运镜模板包格式无效。');
  }
  const ids = new Set();
  const names = new Set();
  for (const row of bundle.templates) {
    if (!row || Object.keys(row).some(key => !fields.includes(key))
      || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.id)
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 24
      || typeof row.description !== 'string' || row.description.length > 60
      || typeof row.prompt !== 'string' || !row.prompt.trim() || row.prompt.length > 1000
      || (row.inRandomPool !== 0 && row.inRandomPool !== 1)
      || ids.has(row.id) || names.has(row.name)) {
      throw new Error('模板字段无效或存在重复条目，未导入任何模板。');
    }
    ids.add(row.id);
    names.add(row.name);
  }
  return bundle.templates;
}

export async function importPresets(dataRoot, bundle) {
  const rows = validatePresets(bundle);
  const root = path.resolve(dataRoot);
  const databasePath = path.join(root, 'data/workbench.db');
  if (!fs.existsSync(databasePath)) throw new Error('请先启动一次此目录中的工作台，正常退出后再导入模板。');
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 10000');
    const columns = db.prepare('PRAGMA table_info(video_prompt_templates)').all().map(row => row.name);
    if (![...fields, 'isBuiltin', 'category'].every(field => columns.includes(field))) {
      throw new Error('模板数据表尚未就绪，请先启动 0.6.2 工作台，正常退出后重试。');
    }
    const backupRoot = path.join(root, 'data/backups/motion-template-import');
    fs.mkdirSync(backupRoot, { recursive: true });
    const backupPath = path.join(backupRoot, `${Date.now()}-${randomUUID()}.db`);
    await db.backup(backupPath);
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      if (backup.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('导入前备份校验失败，未写入模板。');
    } finally { backup.close(); }
    const result = { added: 0, existing: 0, conflicts: [], backupPath };
    db.transaction(() => {
      const find = db.prepare('SELECT * FROM video_prompt_templates WHERE id = ? OR name = ?');
      const insert = db.prepare(`INSERT INTO video_prompt_templates
        (id, name, description, prompt, inRandomPool, category, isBuiltin)
        VALUES (@id, @name, @description, @prompt, @inRandomPool, 'camera_motion', 0)`);
      for (const row of rows) {
        const matches = find.all(row.id, row.name);
        if (matches.length) {
          const same = matches.length === 1 && matches[0].isBuiltin === 0
            && fields.every(field => matches[0][field] === row[field]);
          if (same) result.existing++;
          else result.conflicts.push(row.name);
          continue;
        }
        insert.run(row);
        result.added++;
      }
    }).immediate();
    return result;
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const rootIndex = process.argv.indexOf('--root');
    if (rootIndex < 0 || !process.argv[rootIndex + 1]) throw new Error('缺少 --root 工作台目录。');
    const root = path.resolve(process.argv[rootIndex + 1]);
    const bundlePath = path.join(root, 'motion-template-presets.json');
    if (fs.statSync(bundlePath).size > 4 * 1024 * 1024) throw new Error('模板包过大，停止导入。');
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    const result = await importPresets(root, bundle);
    console.log(`导入完成：新增 ${result.added} 条，已有相同内容 ${result.existing} 条。`);
    if (result.conflicts.length) console.log(`以下模板同名或已被修改，保留本机内容：${result.conflicts.join('、')}`);
    console.log(`导入前备份：${result.backupPath}`);
    console.log('重新打开工作台，在「设置 → 运镜模板」查看。');
  } catch (error) {
    console.error(`导入失败：${error.message}`);
    process.exitCode = 1;
  }
}
