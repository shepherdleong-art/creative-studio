import type Database from 'better-sqlite3';
import type { FilmBinding, ReassembledFilmView } from './types.ts';

export function filmBinding(db: Database.Database, groupId: string): FilmBinding | undefined {
  return db.prepare('SELECT * FROM final_edit_film_bindings WHERE groupId=?').get(groupId) as FilmBinding | undefined;
}
export function filmView(db: Database.Database, groupId: string): ReassembledFilmView | undefined {
  const row = filmBinding(db, groupId);
  if (!row) return undefined;
  return { id: row.id, baseName: row.baseName, template: JSON.parse(row.specJson).template.id,
    deliveryDirectory: row.deliveryDir, deliveryVersion: row.deliveryVersion,
    deliveredRevision: row.deliveredRevision, previewRevision: row.previewRevision,
    reviewUrl: `/api/reassembled-films/${row.id}/review`,
    candidates: JSON.parse(row.candidatesJson).map((c: { videoJobId: string; clipId: string; approvedRangeSec: [number, number] }) => ({
      videoJobId: c.videoJobId, clipId: c.clipId, approvedRangeSec: c.approvedRangeSec,
    })) };
}
