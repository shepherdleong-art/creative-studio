import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from './data-root.ts';

/** Portable distributions may include reviewed presets, never an author database. */
export function seedBundledMotionPresets(db: Database.Database, root = dataRoot()): void {
  const file = path.join(root, 'bundled-presets', 'motion-template-presets.json');
  if (!fs.existsSync(file)) return;
  if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('内置运镜模板包过大');
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (bundle.schemaVersion !== 1 || bundle.kind !== 'creative-studio-motion-templates'
    || !Array.isArray(bundle.templates) || bundle.templates.length > 500) throw new Error('内置运镜模板包格式无效');
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const row of bundle.templates) {
    if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.id)
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 24
      || typeof row.description !== 'string' || row.description.length > 60
      || typeof row.prompt !== 'string' || !row.prompt.trim() || row.prompt.length > 1000
      || ![0, 1].includes(row.inRandomPool) || ids.has(row.id) || names.has(row.name)) {
      throw new Error('内置运镜模板字段无效');
    }
    ids.add(row.id); names.add(row.name);
  }
  db.transaction(() => {
    const find = db.prepare('SELECT id, isBuiltin FROM video_prompt_templates WHERE id = ? OR name = ?');
    const updateBuiltin = db.prepare('UPDATE video_prompt_templates SET description=?, prompt=? WHERE id=? AND isBuiltin=1');
    const insert = db.prepare(`INSERT INTO video_prompt_templates
      (id, name, description, prompt, inRandomPool, category, isBuiltin)
      VALUES (?, ?, ?, ?, ?, 'camera_motion', 0)`);
    for (const row of bundle.templates) {
      const matches = find.all(row.id, row.name) as Array<{ id: string; isBuiltin: number }>;
      if (!matches.length) insert.run(row.id, row.name, row.description, row.prompt, row.inRandomPool);
      // These historical custom presets became built-ins with stable opening codes.
      // Reuse that identity, but never replace user-authored content or pool choices.
      else if (matches.length === 1 && matches[0].isBuiltin === 1) {
        updateBuiltin.run(row.description, row.prompt, matches[0].id);
      }
    }
  }).immediate();
}
