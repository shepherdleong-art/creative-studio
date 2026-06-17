import type Database from 'better-sqlite3';

export type ProjectFinalStatus = 'completed' | 'needs_check' | 'partial_failed' | 'draft';

export function getEffectiveProjectFinalStatus(db: Database.Database, projectId: string): ProjectFinalStatus {
  const statusCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'needs_check' THEN 1 ELSE 0 END) as needsCheck,
      SUM(CASE WHEN status IN ('pending', 'retrying', 'running') THEN 1 ELSE 0 END) as active
    FROM jobs
    WHERE projectId = ?
      AND COALESCE(reviewMark, '') != 'rework'
      AND NOT EXISTS (
        SELECT 1 FROM jobs child
        WHERE child.parentJobId = jobs.id
      )
  `).get(projectId) as { failed: number | null; needsCheck: number | null; active: number | null };

  if ((statusCounts.needsCheck || 0) > 0) return 'needs_check';
  if ((statusCounts.failed || 0) > 0) return 'partial_failed';
  if ((statusCounts.active || 0) > 0) return 'draft';
  return 'completed';
}
