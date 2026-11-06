import type Database from 'better-sqlite3';
import type { AuthPrincipal } from './auth/types.ts';
import { assertScopeConsistency, ResourceAccessError } from './resource-scopes.ts';
import { assertTeamPublicationTarget, switchTeamVersionedRoot, type TeamVersionedResourceKind } from '../script-studio/team-publications.ts';

export interface VersionedPublicationResult {
  alreadyPublished: boolean;
  currentRevisionId: string;
  rootId: string;
}

function publishScope(
  db: Database.Database,
  resourceType: string,
  resourceId: string,
  now: string,
): void {
  const scope = assertScopeConsistency(db, resourceType, resourceId);
  if (scope.deletedAt) throw new ResourceAccessError('resource_not_found', '目标版本已失效，不能发布');
  db.prepare(`UPDATE team_resource_scopes SET visibility = 'public', updatedAt = ?
    WHERE resourceType = ? AND resourceId = ? AND deletedAt IS NULL`).run(now, resourceType, resourceId);
}

function childScopes(db: Database.Database, parentType: string, parentId: string): Array<{ resourceType: string; resourceId: string }> {
  return db.prepare(`SELECT resourceType, resourceId FROM team_resource_scopes
    WHERE parentType = ? AND parentId = ? AND deletedAt IS NULL`).all(parentType, parentId) as Array<{ resourceType: string; resourceId: string }>;
}

function publishCompleteRevision(
  db: Database.Database,
  kind: TeamVersionedResourceKind,
  rootId: string,
  revisionId: string,
  now: string,
): void {
  const rootType = kind === 'viral' ? 'viral_template_library' : 'script_catalog';
  const revisionType = kind === 'viral' ? 'viral_template_revision' : 'script_catalog_revision';
  publishScope(db, rootType, rootId, now);
  publishScope(db, revisionType, revisionId, now);
  const children = childScopes(db, revisionType, revisionId);
  if (kind === 'viral') {
    const actualCount = (db.prepare('SELECT COUNT(*) AS count FROM script_studio_viral_tpl_entries WHERE revisionId = ?').pluck().get(revisionId) as number);
    if (actualCount === 0) throw new Error('该版本没有可发布的条目');
    for (const child of children) publishScope(db, child.resourceType, child.resourceId, now);
    const publishedCount = (db.prepare(`SELECT COUNT(*) AS count FROM script_studio_viral_tpl_entries e
      JOIN team_resource_scopes s ON s.resourceType = 'viral_template_entry' AND s.resourceId = e.id
      WHERE e.revisionId = ? AND s.visibility = 'public' AND s.deletedAt IS NULL`).pluck().get(revisionId) as number);
    if (publishedCount !== actualCount) throw new Error('爆文模板条目权限不完整，发布已取消');
    return;
  }
  if (kind === 'strategy') {
    const count = (db.prepare("SELECT COUNT(*) AS count FROM script_studio_strategy_entries WHERE revisionId = ? AND status = 'active'").pluck().get(revisionId) as number);
    if (count === 0) throw new Error('该知识库版本没有可发布的有效条目');
    return;
  }
  const count = (db.prepare("SELECT COUNT(*) AS count FROM script_studio_framework_templates WHERE revisionId = ? AND status = 'active'").pluck().get(revisionId) as number);
  if (count === 0) throw new Error('该脚本模板版本没有可发布的核心框架');
  for (const child of children) publishScope(db, child.resourceType, child.resourceId, now);
  const assets = (db.prepare('SELECT COUNT(*) AS count FROM script_studio_template_assets WHERE revisionId = ?').pluck().get(revisionId) as number);
  const publishedAssets = (db.prepare(`SELECT COUNT(*) AS count FROM script_studio_template_assets a
    JOIN team_resource_scopes s ON s.resourceType = 'script_template_asset' AND s.resourceId = a.id
    WHERE a.revisionId = ? AND s.visibility = 'public' AND s.deletedAt IS NULL`).pluck().get(revisionId) as number);
  if (assets !== publishedAssets) throw new Error('脚本模板参考图权限不完整，发布已取消');
}

/** 库根、目标修订及其条目/素材在同一事务生效，保留旧已发布修订供冻结输入追溯。 */
export function publishVersionedTeamResource(
  db: Database.Database,
  principal: AuthPrincipal,
  input: { resourceType: 'script_catalog_revision' | 'viral_template_revision'; resourceId: string; baseRevisionId: string | null },
): VersionedPublicationResult {
  if (principal.role !== 'admin') throw new ResourceAccessError('resource_forbidden', '只有管理员可以发布公共版本', 403);
  const kind: TeamVersionedResourceKind = input.resourceType === 'viral_template_revision' ? 'viral'
    : (db.prepare('SELECT kind FROM script_studio_catalog_revisions r JOIN script_studio_catalogs c ON c.id = r.catalogId WHERE r.id = ?').pluck().get(input.resourceId) as TeamVersionedResourceKind | undefined)
      ?? (() => { throw new ResourceAccessError('resource_not_found', '目标版本不存在'); })();
  const target = assertTeamPublicationTarget(db, kind, input.resourceId);
  const publish = db.transaction(() => {
    const alreadyPublished = switchTeamVersionedRoot(db, kind, target.rootId, input.resourceId, input.baseRevisionId, principal.userId, new Date().toISOString());
    publishCompleteRevision(db, kind, target.rootId, input.resourceId, new Date().toISOString());
    return { alreadyPublished, currentRevisionId: input.resourceId, rootId: target.rootId };
  });
  return publish.immediate();
}
