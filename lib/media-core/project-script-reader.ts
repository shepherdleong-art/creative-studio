import type Database from 'better-sqlite3';

export interface ReadableProjectScriptRow {
  id: string;
  kind: 'project' | 'legacy';
  projectId: string;
  provider: string;
  model: string;
  outputJson: string;
  createdAt: string;
  generationDurationMs: number | null;
  shotSetId: string | null;
  currentRevisionId: string | null;
  revisionNumber: number | null;
  libraryRevisionId: string | null;
}

/**
 * 项目脚本统一读取源：project_scripts（新核心层）∪ script_drafts（历史兼容）。
 * 历史行仍保留只读兼容，不在这里改写。
 */
export function listReadableProjectScripts(
  db: Database.Database,
  projectId: string,
  options: { excludeArchived?: boolean } = {},
): ReadableProjectScriptRow[] {
  const projectTableExists = Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_scripts'`,
  ).get());
  const revisionTableExists = Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_script_revisions'`,
  ).get());
  const newRows = projectTableExists && revisionTableExists
    ? db.prepare(`
        SELECT
          ps.id AS id,
          'project' AS kind,
          ps.projectId AS projectId,
          '' AS provider,
          '' AS model,
          COALESCE(r.contentJson, '{}') AS outputJson,
          COALESCE(r.createdAt, ps.updatedAt) AS createdAt,
          NULL AS generationDurationMs,
          ps.shotSetId AS shotSetId,
          ps.currentRevisionId AS currentRevisionId,
          r.revisionNumber AS revisionNumber,
          r.libraryRevisionId AS libraryRevisionId
        FROM project_scripts ps
        LEFT JOIN project_script_revisions r ON r.id = ps.currentRevisionId
        WHERE ps.projectId = ? ${options.excludeArchived === false ? '' : 'AND ps.archivedAt IS NULL'}
      `).all(projectId) as ReadableProjectScriptRow[]
    : [];
  const legacyColumns = (db.prepare(`PRAGMA table_info(script_drafts)`).all() as Array<{ name: string }>)
    .map((column) => column.name);
  const legacyProviderSql = legacyColumns.includes('provider') ? 'd.provider AS provider' : "'' AS provider";
  const legacyModelSql = legacyColumns.includes('model') ? 'd.model AS model' : "'' AS model";
  const legacyDurationSql = legacyColumns.includes('generationDurationMs')
    ? 'd.generationDurationMs AS generationDurationMs'
    : 'NULL AS generationDurationMs';
  const legacyRows = db.prepare(`
    SELECT
      d.id AS id,
      'legacy' AS kind,
      d.projectId AS projectId,
      ${legacyProviderSql},
      ${legacyModelSql},
      d.outputJson AS outputJson,
      d.createdAt AS createdAt,
      ${legacyDurationSql},
      NULL AS shotSetId,
      NULL AS currentRevisionId,
      NULL AS revisionNumber,
      NULL AS libraryRevisionId
    FROM script_drafts d
    WHERE d.projectId = ?
  `).all(projectId) as ReadableProjectScriptRow[];
  return [...newRows, ...legacyRows];
}

export function readableScriptShotSetId(row: ReadableProjectScriptRow): string {
  if (typeof row.shotSetId === 'string') return row.shotSetId;
  try {
    const parsed = JSON.parse(row.outputJson) as { shotSetId?: unknown };
    return typeof parsed.shotSetId === 'string' ? parsed.shotSetId.trim() : '';
  } catch {
    return '';
  }
}

export function projectionForReadableScript(
  row: ReadableProjectScriptRow,
): {
  id: string;
  kind: 'project' | 'legacy';
  shotSetId: string;
  currentRevisionId: string | null;
  revisionNumber: number | null;
} {
  return {
    id: row.id,
    kind: row.kind,
    shotSetId: readableScriptShotSetId(row),
    currentRevisionId: row.currentRevisionId,
    revisionNumber: row.revisionNumber,
  };
}
