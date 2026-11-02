import type Database from 'better-sqlite3';
import type { AuthPrincipal } from '../auth/types.ts';
import { assertScopeConsistency } from '../resource-scopes.ts';

/** 管理员显式发布一个不可变逻辑资源；不会连带公开其私人历史修订。 */
export function publishTeamResource(
  db: Database.Database,
  principal: AuthPrincipal,
  resource: { resourceType: string; resourceId: string },
): void {
  if (principal.role !== 'admin') throw new Error('只有管理员可以发布公共资源');
  assertScopeConsistency(db, resource.resourceType, resource.resourceId);
  const result = db.prepare(`
    UPDATE team_resource_scopes SET visibility = 'public', updatedAt = ?
    WHERE resourceType = ? AND resourceId = ? AND deletedAt IS NULL
  `).run(new Date().toISOString(), resource.resourceType, resource.resourceId);
  if (result.changes !== 1) throw new Error('资源不存在或不可用');
}
