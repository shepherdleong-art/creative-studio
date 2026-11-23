import type Database from 'better-sqlite3';

export function hasTeamPublicationBarrier(db: Database.Database): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM team_lifecycle_barriers
    WHERE releasedAt IS NULL AND kind IN ('backup', 'release') LIMIT 1
  `).get());
}

export function assertTeamPublicationAllowed(db: Database.Database): void {
  if (hasTeamPublicationBarrier(db)) throw new Error('维护屏障正在生效，暂停发布新的不可变文件版本');
}
