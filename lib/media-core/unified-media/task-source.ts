import type Database from 'better-sqlite3';

export interface UnifiedTaskSource {
  sourceType: string;
  sourceId: string;
  sourceMeta: Record<string, unknown>;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/**
 * Reassemble-film rework jobs are persisted in the final-edit table but the
 * media-core layer must not import the final-edit module. Reading the public
 * relation by job id keeps the dependency direction intact.
 */
export function unifiedTaskSourceForJob(
  db: Database.Database,
  input: {
    module: 'image' | 'video';
    jobId: string;
    fallbackType: string;
    fallbackId: string;
    fallbackMeta?: Record<string, unknown>;
  },
): UnifiedTaskSource {
  if (tableExists(db, 'final_edit_film_reworks')) {
    const rework = db.prepare(`
      SELECT r.id, r.bindingId, r.clipId
      FROM final_edit_film_reworks r
      WHERE r.jobId = ? AND r.kind = ?
      LIMIT 1
    `).get(
      input.jobId,
      input.module === 'image' ? 'generate_image' : 'generate_video',
    ) as { id: string; bindingId: string; clipId: string } | undefined;
    if (rework) {
      return {
        sourceType: 'team_film_rework',
        sourceId: rework.id,
        sourceMeta: {
          entry: 'team_film_rework',
          jobId: input.jobId,
          requestId: rework.id,
          bindingId: rework.bindingId,
          clipId: rework.clipId,
          ...(input.fallbackMeta ?? {}),
        },
      };
    }
  }
  return {
    sourceType: input.fallbackType,
    sourceId: input.fallbackId,
    sourceMeta: {
      entry: input.fallbackType,
      jobId: input.jobId,
      ...(input.fallbackMeta ?? {}),
    },
  };
}
