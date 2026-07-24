import type Database from 'better-sqlite3';

export interface Module4VideoRecord {
  videoJobId: string;
  projectId: string;
  shotSetId: string;
  localVideoPath: string;
}

export function findModule4Video(
  db: Database.Database,
  scope: { projectId: string; shotSetId: string; videoJobId: string },
): Module4VideoRecord | null {
  const row = db.prepare(`
    SELECT id AS videoJobId, projectId, shotSetId, localVideoPath
    FROM video_jobs
    WHERE id = ? AND projectId = ? AND shotSetId = ?
      AND status = 'succeeded' AND localVideoPath IS NOT NULL
  `).get(scope.videoJobId, scope.projectId, scope.shotSetId) as Module4VideoRecord | undefined;
  return row ?? null;
}
