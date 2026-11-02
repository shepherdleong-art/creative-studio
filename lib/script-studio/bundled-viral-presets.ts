import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { importViralTemplateLibrary } from './viral-templates.ts';

const pending = new WeakMap<Database.Database, Promise<void>>();

/** Called only after the module's backup/migration gate has succeeded. */
export function ensureBundledViralPresets(db: Database.Database, root = dataRoot()): Promise<void> {
  const existing = pending.get(db);
  if (existing) return existing;
  const run = async () => {
    if (process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE === 'server') {
      // 公共 preset 只能由首管理员初始化流程以明确管理员上下文发布。
      return;
    }
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'script_studio_viral_tpl_libraries'`).get()) return;
    if (db.prepare('SELECT 1 FROM script_studio_viral_tpl_libraries WHERE currentRevisionId IS NOT NULL').get()) return;
    const file = path.join(root, 'bundled-presets', 'viral-templates.xlsx');
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('内置爆文模板库过大');
    await importViralTemplateLibrary(db, fs.readFileSync(file), '内置种草爆文库.xlsx', undefined, { onlyIfEmpty: true });
  };
  const promise = run().catch(error => { pending.delete(db); throw error; });
  pending.set(db, promise);
  return promise;
}
