import type Database from 'better-sqlite3';
import { executionModelIdentity } from '../media-core/execution/pools.ts';

export interface TeamModelOption { model: string; label: string; category: string }

/** Admin-only catalog: project no credentials or endpoint configuration. */
export function listTeamModelOptions(db: Database.Database): TeamModelOption[] {
  const options = new Map<string, TeamModelOption>();
  const add = (model: string | null, label: string, category: string) => {
    if (model?.trim() && !options.has(model.trim())) {
      options.set(model.trim(), { model: model.trim(), label, category });
    }
  };
  for (const [table, category] of [
    ['providers', '图片'], ['video_providers', '视频'], ['script_providers', '文本 / 视觉'],
    ['final_edit_tts_providers', '配音'],
  ]) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
    if (!columns.size) continue;
    const fields = ['name', 'model', 'defaultModel', 'modelEnv'].filter(field => columns.has(field));
    const rows = db.prepare(`SELECT ${fields.join(', ')} FROM ${table}`).all() as Array<Record<string, string>>;
    for (const row of rows) {
      add(row.model || (row.modelEnv ? process.env[row.modelEnv]?.trim() : '') || row.defaultModel || null, row.name, category);
    }
  }
  // Alignment is also an external model call, even though it has no provider picker.
  add('whisper-1', '字幕对齐', '语音识别');
  for (const row of db.prepare('SELECT DISTINCT providerSnapshotJson FROM execution_operations').all() as Array<{ providerSnapshotJson: string }>) {
    add(executionModelIdentity(JSON.parse(row.providerSnapshotJson)), '曾使用的模型', '其他');
  }
  return [...options.values()].sort((a, b) => a.category.localeCompare(b.category, 'zh-CN') || a.model.localeCompare(b.model));
}
