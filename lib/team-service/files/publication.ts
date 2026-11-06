import type Database from 'better-sqlite3';
import type { AuthPrincipal } from '../auth/types.ts';
import { assertScopeConsistency, ResourceAccessError } from '../resource-scopes.ts';

export function withdrawTeamResource(
  db: Database.Database,
  principal: AuthPrincipal,
  resource: { resourceType: string; resourceId: string },
): void {
  if (principal.role !== 'admin') throw new ResourceAccessError('resource_forbidden', '只有管理员可以撤回公共资源', 403);
  const scope = assertScopeConsistency(db, resource.resourceType, resource.resourceId);
  if (scope.deletedAt) throw new ResourceAccessError('resource_not_found', '资源已移入回收站');
  db.prepare("UPDATE team_resource_scopes SET visibility = 'private', updatedAt = ? WHERE resourceType = ? AND resourceId = ?")
    .run(new Date().toISOString(), resource.resourceType, resource.resourceId);
}

/** 管理员显式发布一个不可变逻辑资源；不会连带公开其私人历史修订。 */
export function publishTeamResource(
  db: Database.Database,
  principal: AuthPrincipal,
  resource: { resourceType: string; resourceId: string },
): { alreadyPublished: boolean } {
  if (principal.role !== 'admin') throw new Error('只有管理员可以发布公共资源');
  const scope = assertScopeConsistency(db, resource.resourceType, resource.resourceId);
  if (scope.deletedAt) throw new ResourceAccessError('resource_not_found', '资源不存在或不可用');
  if (resource.resourceType === 'lut') {
    const lut = db.prepare("SELECT status FROM batch_luts WHERE id = ? AND status = 'active'").get(resource.resourceId);
    if (!lut) throw new Error('LUT 已归档或不可用，请先在原项目中恢复');
  }
  if (resource.resourceType === 'bgm') {
    const bgm = db.prepare("SELECT status FROM final_edit_bgm_tracks WHERE id = ? AND status = 'ready'").get(resource.resourceId);
    if (!bgm) throw new Error('BGM 尚未就绪或已失效');
  }
  if (scope.visibility === 'public') return { alreadyPublished: true };
  const result = db.prepare(`
    UPDATE team_resource_scopes SET visibility = 'public', updatedAt = ?
    WHERE resourceType = ? AND resourceId = ? AND deletedAt IS NULL AND visibility = 'private'
  `).run(new Date().toISOString(), resource.resourceType, resource.resourceId);
  if (result.changes !== 1) throw new Error('资源不存在或不可用');
  return { alreadyPublished: false };
}
