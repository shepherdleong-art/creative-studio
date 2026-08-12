import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { splitCoverTitle } from '../media-core/cover-domain.ts';
import { isUsableMixcutScriptDraft } from '../media-core/script-draft-usable.ts';
import type { StoredScriptOutput } from '../script-providers/types.ts';
import { createProjectScript } from './scripts.ts';

export interface ScriptSyncResult {
  /** 成功同步的有效草稿数(含重复来源的去重) */
  synced: number;
  /** 无法解析、不符合 V2/V3 有效条件或不属于项目有效分镜组的草稿数 */
  skipped: number;
  /** 同步后项目脚本的稳定身份列表(同一来源多次同步复用同一身份) */
  scripts: string[];
}

interface ScriptDraftRow {
  id: string;
  outputJson: string;
}

function contentRevisionOf(outputJson: string): string {
  return createHash('sha256').update(outputJson).digest('hex');
}

/** 提取脚本的结构化封面标题;V2 旧草稿可能没有,由快照创建时确定性拆分 */
function coverTitleOf(script: StoredScriptOutput): unknown {
  if (script.coverTitleParts) {
    return { primary: script.coverTitleParts.primary, secondary: script.coverTitleParts.secondary };
  }
  return splitCoverTitle(script.title || '');
}

/**
 * 把第 3 步明确保存的项目脚本草稿同步进批量脚本目录。
 *
 * - 来源身份是 script_drafts.id:同一来源重复同步只保留一份项目脚本,
 *   不按标题或正文猜测是否重复。
 * - 正文由有序叙事段落重组(忽略空段);普通标题、结构化封面标题、
 *   shotSetId 归属与内容修订身份(草稿 outputJson 的 SHA-256)一起同步。
 * - 草稿更新后再次同步会更新项目脚本当前内容与修订身份;已开始批次
 *   只读自己的快照,不受这里的影响。
 * - 无效草稿(JSON 解析失败、非 V2/V3、无段、全空叙文、shotSetId 不属于
 *   当前项目)一律跳过。
 */
export function syncProjectScripts(
  db: Database.Database,
  projectId: string,
  now?: () => Date,
): ScriptSyncResult {
  return db.transaction(() => {
    const validShotSetIds = new Set(
      (db.prepare(`SELECT id FROM shot_sets WHERE projectId = ?`).all(projectId) as Array<{ id: string }>)
        .map(({ id }) => id),
    );
    const draftRows = db.prepare(`
      SELECT id, outputJson FROM script_drafts WHERE projectId = ? ORDER BY createdAt, id
    `).all(projectId) as ScriptDraftRow[];
    db.prepare(`
      UPDATE batch_scripts
      SET catalogManaged = 1
      WHERE projectId = ? AND sourceKind = 'script_draft' AND ownerBatchVersionId IS NULL
        AND sourceId IN (SELECT id FROM script_drafts WHERE projectId = ?)
    `).run(projectId, projectId);
    db.prepare(`
      UPDATE batch_scripts
      SET sourceAvailable = 0, updatedAt = ?
      WHERE projectId = ? AND sourceKind = 'script_draft'
        AND ownerBatchVersionId IS NULL AND catalogManaged = 1
    `).run((now ?? (() => new Date()))().toISOString(), projectId);
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
      if (!validShotSetIds.has(script.shotSetId)) {
        result.skipped += 1;
        continue;
      }
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
        metadata: {
          coverTitleJson: coverTitleOf(script),
          shotSetId: script.shotSetId,
          contentRevision: contentRevisionOf(row.outputJson),
          targetDurationSec: script.targetDurationSec,
        },
        catalogManaged: true,
        now,
      });
      result.scripts.push(scriptId);
      result.synced += 1;
    }
    return result;
  }).immediate();
}
