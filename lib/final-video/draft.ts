// lib/final-video/draft.ts
/** 找到指定分镜组的最新脚本草稿（outputJson.shotSetId 匹配）。 */
import type BetterSqlite3 from 'better-sqlite3';

export interface MatchedDraft {
  id: string;
  output: {
    title?: string;
    shotSetId?: string;
    shots?: Array<{ shotId: string; shotIndex: number; voiceover?: string; subtitle?: string }>;
    fullScript?: string;
  };
}

export function findScriptDraftForShotSet(
  db: BetterSqlite3.Database,
  projectId: string,
  shotSetId: string
): MatchedDraft | null {
  const drafts = db
    .prepare(`SELECT id, outputJson FROM script_drafts WHERE projectId = ? ORDER BY createdAt DESC`)
    .all(projectId) as Array<{ id: string; outputJson: string }>;
  for (const d of drafts) {
    try {
      const output = JSON.parse(d.outputJson);
      if (output?.shotSetId === shotSetId) return { id: d.id, output };
    } catch {
      continue;
    }
  }
  return null;
}
