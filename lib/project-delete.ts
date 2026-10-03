import type Database from 'better-sqlite3';

export interface DeletedProjectAsset {
  id: string;
  path: string;
  originalPath: string | null;
  processedPath: string | null;
}

/** Delete database records atomically; callers remove files only after commit. */
export function deleteProjectRecords(
  db: Database.Database,
  projectId: string,
): DeletedProjectAsset[] | null {
  return db.transaction(() => {
    const assets = db.prepare(`
      SELECT id, path, originalPath, processedPath FROM image_assets WHERE projectId = ?
    `).all(projectId) as DeletedProjectAsset[];
    // v11 的历史主题表没有 ON DELETE CASCADE；不能修改已发布迁移。
    // 仅在整项目删除时清理，按真实外键归属限定范围，并兼容尚未升级的数据库。
    if (db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'script_studio_selling_point_themes'`).get()) {
      db.prepare(`DELETE FROM script_studio_selling_point_themes WHERE revisionId IN (
        SELECT r.id FROM script_studio_library_revisions r
        JOIN script_studio_libraries l ON l.id = r.libraryId WHERE l.projectId = ?
      )`).run(projectId);
    }
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    if (result.changes !== 1) return null;
    const deleteAsset = db.prepare('DELETE FROM image_assets WHERE id = ?');
    for (const asset of assets) deleteAsset.run(asset.id);
    return assets;
  })();
}
