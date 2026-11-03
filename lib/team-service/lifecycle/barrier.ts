import type Database from 'better-sqlite3';

export function assertTeamPublicationAllowed(db: Database.Database): void {
  const blocked = db.prepare(`
    SELECT 1 FROM team_lifecycle_barriers
    WHERE releasedAt IS NULL AND kind IN ('backup', 'release') LIMIT 1
  `).get();
  if (blocked) throw new Error('维护屏障正在生效，暂停发布新的不可变文件版本');
}
