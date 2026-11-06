import type Database from 'better-sqlite3';

export type TeamVersionedResourceKind = 'strategy' | 'template' | 'viral';

export class TeamPublicationConflictError extends Error {
  constructor(message = '团队当前版本已被其他管理员变更，请刷新候选并确认后再发布。') {
    super(message);
    this.name = 'TeamPublicationConflictError';
  }
}

export interface TeamVersionedRoot {
  resourceType: 'script_catalog' | 'viral_template_library';
  rootId: string;
  rootKind: 'script_catalog' | 'viral_template_library';
  revisionId: string | null;
}

interface PublicationRow {
  resourceType: TeamVersionedResourceKind;
  rootId: string;
  currentRevisionId: string;
  withdrawnAt?: string | null;
}

/** 团队唯一指针。缺表表示旧版尚未就绪，调用方 fail closed，不隐退回私人版本。 */
function publication(db: Database.Database, kind: TeamVersionedResourceKind): PublicationRow | undefined {
  return db.prepare('SELECT * FROM script_studio_team_publications WHERE resourceType = ?').get(kind) as PublicationRow | undefined;
}

export function findTeamVersionedRoot(
  db: Database.Database,
  kind: TeamVersionedResourceKind,
): TeamVersionedRoot | null {
  const row = publication(db, kind);
  if (!row) return null;
  const revisionId = row.withdrawnAt ? null : row.currentRevisionId;
  return kind === 'viral'
    ? { resourceType: 'viral_template_library', rootKind: 'viral_template_library', rootId: row.rootId, revisionId }
    : { resourceType: 'script_catalog', rootKind: 'script_catalog', rootId: row.rootId, revisionId };
}

export function assertTeamPublicationTarget(
  db: Database.Database,
  kind: TeamVersionedResourceKind,
  revisionId: string,
): { rootId: string; currentRevisionId: string | null } {
  const relation = kind === 'viral'
    ? db.prepare('SELECT libraryId AS rootId FROM script_studio_viral_tpl_revisions WHERE id = ?').get(revisionId)
    : db.prepare(`SELECT r.catalogId AS rootId FROM script_studio_catalog_revisions r
      JOIN script_studio_catalogs c ON c.id = r.catalogId AND c.kind = ? WHERE r.id = ?`).get(kind, revisionId);
  if (!relation) throw new Error('目标版本不存在或不属于该资源类型');
  const rootId = String((relation as { rootId: string }).rootId);
  const current = findTeamVersionedRoot(db, kind);
  const currentRevisionId = current?.rootId === rootId ? current.revisionId : null;
  return { rootId, currentRevisionId };
}

/** 在调用方同一个 immediate transaction 中比较基准并切换指针。 */
export function switchTeamVersionedRoot(
  db: Database.Database,
  kind: TeamVersionedResourceKind,
  rootId: string,
  revisionId: string,
  baseRevisionId: string | null,
  publishedBy: string,
  now: string,
): boolean {
  const current = findTeamVersionedRoot(db, kind);
  const actual = current?.rootId === rootId ? current.revisionId : null;
  if (actual === revisionId) return true;
  if (actual !== baseRevisionId) {
    throw new TeamPublicationConflictError();
  }
  db.prepare(`INSERT INTO script_studio_team_publications (
    resourceType, rootId, currentRevisionId, publishedBy, publishedAt, updatedAt
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(resourceType) DO UPDATE SET rootId = excluded.rootId,
    currentRevisionId = excluded.currentRevisionId, publishedBy = excluded.publishedBy,
    publishedAt = excluded.publishedAt, updatedAt = excluded.updatedAt, withdrawnAt = NULL`)
    .run(kind, rootId, revisionId, publishedBy, now, now);
  return false;
}

// 保持历史公开修订可读，不在激活另一版本时撤销其 scope。
export function teamPublicationConflict(error: unknown): boolean {
  return error instanceof Error && error.name === 'TeamPublicationConflictError';
}
