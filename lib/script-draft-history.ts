import type Database from 'better-sqlite3';

export interface ScriptDraftHistoryRow {
  id: string;
  provider: string;
  model: string;
  inputSnapshot: string;
  outputJson: string;
  createdAt: string;
  generationDurationMs: number | null;
}

export interface ScriptDraftHistoryPage {
  drafts: ScriptDraftHistoryRow[];
  nextCursor: string | null;
}

/**
 * 按 createdAt DESC, id DESC 做稳定的 keyset 分页。
 * cursor 是上一页末条草稿的稳定 id；服务端从数据库恢复完整排序边界。
 */
export function listScriptDraftHistoryPage(
  db: Database.Database,
  input: { projectId: string; cursor?: string; limit?: number },
): ScriptDraftHistoryPage {
  const requestedLimit = Number.isFinite(input.limit) ? Math.floor(input.limit!) : 50;
  const limit = Math.max(1, Math.min(100, requestedLimit || 50));
  const cursor = input.cursor?.trim() || '';
  let rows: ScriptDraftHistoryRow[];

  if (cursor) {
    const boundary = db.prepare(`
      SELECT id, createdAt
      FROM script_drafts
      WHERE projectId = ? AND id = ?
    `).get(input.projectId, cursor) as { id: string; createdAt: string } | undefined;
    if (!boundary) return { drafts: [], nextCursor: null };
    rows = db.prepare(`
      SELECT id, provider, model, inputSnapshot, outputJson, createdAt, generationDurationMs
      FROM script_drafts
      WHERE projectId = ?
        AND (createdAt < ? OR (createdAt = ? AND id < ?))
      ORDER BY createdAt DESC, id DESC
      LIMIT ?
    `).all(input.projectId, boundary.createdAt, boundary.createdAt, boundary.id, limit + 1) as ScriptDraftHistoryRow[];
  } else {
    rows = db.prepare(`
      SELECT id, provider, model, inputSnapshot, outputJson, createdAt, generationDurationMs
      FROM script_drafts
      WHERE projectId = ?
      ORDER BY createdAt DESC, id DESC
      LIMIT ?
    `).all(input.projectId, limit + 1) as ScriptDraftHistoryRow[];
  }

  const hasMore = rows.length > limit;
  const drafts = rows.slice(0, limit);
  return {
    drafts,
    nextCursor: hasMore ? drafts[drafts.length - 1]?.id ?? null : null,
  };
}
