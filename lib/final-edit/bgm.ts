import type Database from 'better-sqlite3';
import type { FinalEditBgmTrackView } from './types.ts';

export { BGM_EXTENSIONS as FINAL_EDIT_BGM_EXTENSIONS, scanBgmTracks as scanFinalEditBgm } from '../media-core/bgm-catalog.ts';

export function finalEditBgmFilename(relativePath: string): string {
  return relativePath.split(/[\\/]/).filter(Boolean).at(-1) || relativePath;
}

export function listReadyFinalEditBgmTracks(
  db: Database.Database,
): FinalEditBgmTrackView[] {
  const rows = db.prepare(`
    SELECT id, relativePath, durationUs
    FROM final_edit_bgm_tracks
    WHERE status='ready'
    ORDER BY relativePath
  `).all() as Array<{
    id: string;
    relativePath: string;
    durationUs: number;
  }>;
  return rows.map((row) => ({
    ...row,
    filename: finalEditBgmFilename(row.relativePath),
  }));
}
