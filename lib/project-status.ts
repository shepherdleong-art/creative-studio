import type Database from 'better-sqlite3';

export type ProjectFinalStatus = 'completed' | 'needs_check' | 'failed' | 'partial_failed' | 'draft';

export function getEffectiveProjectFinalStatus(db: Database.Database, projectId: string): ProjectFinalStatus {
  const statusCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN status = 'needs_check' THEN 1 ELSE 0 END) as needsCheck,
      SUM(CASE WHEN status IN ('pending', 'retrying', 'running') THEN 1 ELSE 0 END) as active
    FROM jobs
    WHERE projectId = ?
      AND COALESCE(reviewMark, '') != 'rework'
      AND NOT EXISTS (
        SELECT 1 FROM jobs child
        WHERE child.parentJobId = jobs.id
      )
  `).get(projectId) as {
    failed: number | null;
    succeeded: number | null;
    needsCheck: number | null;
    active: number | null;
  };

  const failed = statusCounts.failed || 0;
  const succeeded = statusCounts.succeeded || 0;
  const needsCheck = statusCounts.needsCheck || 0;
  const active = statusCounts.active || 0;

  if (needsCheck > 0) return 'needs_check';
  if (failed > 0) {
    // 全军覆没(有效任务里一条都没成功、也没有还在跑的)才算 failed;
    // 只要还有成果在就仍然是 partial_failed。UI 上这两档是红 / 黄之分。
    return succeeded === 0 && active === 0 ? 'failed' : 'partial_failed';
  }
  if (active > 0) return 'draft';
  return 'completed';
}
