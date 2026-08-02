import type Database from 'better-sqlite3';
import { isUsableMixcutScriptDraft } from '../final-edit/mixcut-context.ts';
import type { StoredScriptOutput } from '../script-providers/types.ts';
import { createProjectScript } from './scripts.ts';

export interface ScriptSyncResult {
  /** 成功同步的有效草稿数(含重复来源的去重) */
  synced: number;
  /** 无法解析或不符合 V2/V3 有效条件的草稿数 */
  skipped: number;
  /** 同步后项目脚本的稳定身份列表(同一来源多次同步复用同一身份) */
  scripts: string[];
}

interface ScriptDraftRow {
  id: string;
  outputJson: string;
}

/**
 * 把第 3 步明确保存的项目脚本草稿同步进批量脚本目录。
 *
 * - 来源身份是 script_drafts.id：同一来源重复同步只保留一份项目脚本，
 *   不按标题或正文猜测是否重复。
 * - 正文由有序叙事段落重组（忽略空段），标题、来源版本一起跟随。
 * - 草稿更新后再次同步会更新项目脚本当前内容；已开始批次只读自己的
 *   快照，不受这里的影响。
 * - 无效草稿（JSON 解析失败、非 V2/V3、无段或全空叙文）一律跳过。
 */
export function syncProjectScripts(
  db: Database.Database,
  projectId: string,
  now?: () => Date,
): ScriptSyncResult {
  const draftRows = db.prepare(`
    SELECT id, outputJson FROM script_drafts WHERE projectId = ? ORDER BY createdAt, id
  `).all(projectId) as ScriptDraftRow[];
  const result: ScriptSyncResult = { synced: 0, skipped: 0, scripts: [] };
  for (const row of draftRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.outputJson);
    } catch {
      result.skipped += 1;
      continue;
    }
    if (!isUsableMixcutScriptDraft(parsed)) {
      result.skipped += 1;
      continue;
    }
    const script = parsed as StoredScriptOutput;
    const narrationText = script.segments
      .map((segment) => typeof segment.narration === 'string' ? segment.narration.trim() : '')
      .filter(Boolean)
      .join('\n');
    if (!narrationText) {
      result.skipped += 1;
      continue;
    }
    const scriptId = createProjectScript(db, projectId, {
      sourceKind: 'script_draft',
      sourceId: row.id,
      title: script.title || '',
      bodyText: narrationText,
      sourceVersion: String(script.version),
      now,
    });
    result.scripts.push(scriptId);
    result.synced += 1;
  }
  return result;
}
