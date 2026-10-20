import type Database from 'better-sqlite3';
import type { FilmBinding, ReassembledFilmView } from './types.ts';
import { filmContent } from './content.ts';
import type { VideoTimeline } from '../types.ts';

export function filmBinding(db: Database.Database, groupId: string): FilmBinding | undefined {
  const row = db.prepare('SELECT * FROM final_edit_film_bindings WHERE groupId=?').get(groupId) as FilmBinding | undefined;
  if (row) {
    const variant = db.prepare('SELECT timelineJson FROM final_edit_variants WHERE id=?').get(row.variantId) as { timelineJson: string } | undefined;
    if (variant && JSON.parse(variant.timelineJson).importedFilmEditor === 'mixcut') return undefined;
  }
  return row;
}
export function filmView(db: Database.Database, groupId: string): ReassembledFilmView | undefined {
  const row = filmBinding(db, groupId);
  if (!row) return undefined;
  const originalContent = filmContent(JSON.parse(row.specJson));
  const variant = db.prepare('SELECT timelineJson FROM final_edit_variants WHERE id=?').get(row.variantId) as { timelineJson: string };
  const content = (JSON.parse(variant.timelineJson) as VideoTimeline).filmContent || originalContent;
  return { id: row.id, baseName: row.baseName, template: content.decoration.template, content, originalContent,
    proposals: (db.prepare("SELECT id,baseRevision,proposalJson,status FROM final_edit_proposals WHERE variantId=? AND kind='film-content' ORDER BY createdAt DESC").all(row.variantId) as Array<{ id: string; baseRevision: number; proposalJson: string; status: string }>).map(p => ({ id: p.id, baseRevision: p.baseRevision, summary: JSON.parse(p.proposalJson).summary, content: JSON.parse(p.proposalJson).content, status: p.status })),
    history: (db.prepare("SELECT revision,commandJson,createdAt FROM final_edit_revisions WHERE scopeKind='variant' AND scopeId=? ORDER BY revision DESC").all(row.variantId) as Array<{ revision: number; commandJson: string; createdAt: string }>).map(r => ({ revision: r.revision, type: JSON.parse(r.commandJson).type, createdAt: r.createdAt })),
    deliveryDirectory: row.deliveryDir, deliveryVersion: row.deliveryVersion,
    deliveredRevision: row.deliveredRevision, previewRevision: row.previewRevision,
    reviewUrl: `/api/reassembled-films/${row.id}/review`,
    candidates: JSON.parse(row.candidatesJson).map((c: { videoJobId: string; clipId: string; approvedRangeSec: [number, number] }) => ({
      videoJobId: c.videoJobId, clipId: c.clipId, approvedRangeSec: c.approvedRangeSec,
    })) };
}
