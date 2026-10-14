import type Database from 'better-sqlite3';
import { BUILTIN_OPENING_CODES, normalizeProductionCode, scriptCodeFromContent } from './production-codes.ts';

/** 旧脚本按明确的模板 ID 补读编号；新脚本的冻结编号（含显式空值）优先。 */
export function resolveScriptCode(db: Database.Database, value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const content = value as { scriptCode?: unknown; templateRewrite?: { scriptCode?: unknown; sourceTemplateId?: unknown } };
  if (content.scriptCode !== undefined || content.templateRewrite?.scriptCode !== undefined) return scriptCodeFromContent(value);
  const sourceId = content.templateRewrite?.sourceTemplateId;
  if (typeof sourceId !== 'string' || !sourceId) return '';
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='script_studio_viral_tpl_entries'").get()) return '';
  const row = db.prepare(`SELECT e.rawColumnsJson FROM script_studio_viral_tpl_entries e
    JOIN script_studio_viral_tpl_libraries l ON l.currentRevisionId=e.revisionId
    WHERE e.sourceTemplateId=? LIMIT 1`).get(sourceId) as { rawColumnsJson: string } | undefined;
  try { return normalizeProductionCode(JSON.parse(row?.rawColumnsJson || '{}').scriptCode, 'J'); } catch { return ''; }
}

/** 升级前的混剪快照缺编号时，按冻结的项目脚本修订 ID 查来源，不读当前改写版本。 */
export function resolveRevisionScriptCode(db: Database.Database, projectId: string, revisionId: string | null | undefined): string {
  if (!revisionId || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_script_revisions'").get()) return '';
  const row = db.prepare(`SELECT r.contentJson FROM project_script_revisions r
    JOIN project_scripts s ON s.id=r.scriptId WHERE r.id=? AND s.projectId=?`).get(revisionId, projectId) as { contentJson: string } | undefined;
  try { return resolveScriptCode(db, JSON.parse(row?.contentJson || '{}')); } catch { return ''; }
}

/** 新视频冻结当时的编号；旧内置开头只按稳定模板 ID 识别，不按名称/提示词猜。 */
export function resolveVideoOpeningCode(db: Database.Database, projectId: string, videoJobId: string, shotSetId?: string): string {
  if (!videoJobId || videoJobId.startsWith('external-asset-')) return '';
  const row = db.prepare('SELECT * FROM video_jobs WHERE id=? AND projectId=?').get(videoJobId, projectId) as {
    openingCode?: string | null; templateId?: string; shotSetId?: string;
  } | undefined;
  if (!row || (shotSetId !== undefined && row.shotSetId !== shotSetId)) return '';
  return row.openingCode != null ? normalizeProductionCode(row.openingCode, 'K') : BUILTIN_OPENING_CODES[row.templateId || ''] || '';
}

export function resolveTemplateOpeningCode(db: Database.Database, templateId: string | null): string {
  if (!templateId) return '';
  const row = db.prepare('SELECT * FROM video_prompt_templates WHERE id=?').get(templateId) as { openingCode?: string | null } | undefined;
  return row ? normalizeProductionCode(row.openingCode ?? BUILTIN_OPENING_CODES[templateId], 'K') : '';
}
