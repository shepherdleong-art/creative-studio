import type Database from 'better-sqlite3';

/**
 * The production database receives these columns through the append-only core
 * migration stream. A few older isolated callers construct only the subset of
 * video_jobs they need, so reads remain fail-open for that legacy shape while
 * the migrated application enforces rejection filtering.
 */
export function hasVideoJobRejectionColumns(db: Database.Database): boolean {
  const columns = db.prepare(`PRAGMA table_info(video_jobs)`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  return names.has('rejectedAt') && names.has('rejectReason');
}

export function videoJobNotRejectedSql(db: Database.Database, alias = 'video_jobs'): string {
  if (!hasVideoJobRejectionColumns(db)) return '1 = 1';
  const prefix = alias ? `${alias}.` : '';
  return `(${prefix}rejectedAt IS NULL OR ${prefix}rejectedAt = '')`;
}

export function isVideoJobRejected(db: Database.Database, videoJobId: string): boolean {
  if (!hasVideoJobRejectionColumns(db)) return false;
  const row = db.prepare(`SELECT rejectedAt FROM video_jobs WHERE id = ?`).get(videoJobId) as { rejectedAt: string | null } | undefined;
  return Boolean(row?.rejectedAt?.trim());
}
