import type Database from 'better-sqlite3';
import { requireAccessContext } from '../media-core/access-context.ts';
import type { FinalEditBgmTrackView } from './types.ts';

export { BGM_EXTENSIONS as FINAL_EDIT_BGM_EXTENSIONS, scanBgmTracks as scanFinalEditBgm } from '../media-core/bgm-catalog.ts';

export function finalEditBgmFilename(relativePath: string): string {
  return relativePath.split(/[\\/]/).filter(Boolean).at(-1) || relativePath;
}

export function listReadyFinalEditBgmTracks(
  db: Database.Database,
): FinalEditBgmTrackView[] {
  const access = requireAccessContext();
  const visibility = access.kind === 'local' ? { sql: '', params: [] as string[] } : {
    sql: ` AND EXISTS (
      SELECT 1 FROM team_resource_scopes scope
      WHERE scope.resourceType = 'bgm' AND scope.resourceId = final_edit_bgm_tracks.id
        AND scope.deletedAt IS NULL
        AND (scope.visibility = 'public' ${access.actor.role === 'admin' ? 'OR 1 = 1' : 'OR scope.ownerUserId = ?'})
    )`,
    params: access.actor.role === 'admin' ? [] : [access.actor.userId],
  };
  const rows = db.prepare(`
    SELECT id, relativePath, durationUs
    FROM final_edit_bgm_tracks
    WHERE status='ready' ${visibility.sql}
    ORDER BY relativePath
  `).all(...visibility.params) as Array<{
    id: string;
    relativePath: string;
    durationUs: number;
  }>;
  return rows.map((row) => ({
    ...row,
    filename: finalEditBgmFilename(row.relativePath),
  }));
}
