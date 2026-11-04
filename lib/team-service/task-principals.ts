import type Database from 'better-sqlite3';
import type { ResourceRef, TaskPrincipalRegistration } from '../media-core/access-context.ts';
import { assertScopeConsistency } from './resource-scopes.ts';

export type TeamTaskRole = 'employee' | 'admin';

export interface TeamTaskPrincipal {
  module: string;
  taskId: string;
  actorUserId: string;
  scope: ResourceRef;
  creationSnapshot: unknown;
  /** 受理时的角色快照；旧记录没有证据时为 null，不得按当前 admin 身份推导全局权限。 */
  roleAtAcceptance: TeamTaskRole | null;
  authorizationEvidence: 'frozen' | 'missing';
  createdAt: string;
}

export function registerTaskPrincipal(
  db: Database.Database,
  input: TaskPrincipalRegistration & { actorUserId: string },
): TeamTaskPrincipal {
  if (!input.module.trim() || !input.taskId.trim() || !input.actorUserId.trim()) {
    throw new Error('任务主体字段不完整。');
  }
  if (input.roleAtAcceptance !== undefined && !['employee', 'admin'].includes(input.roleAtAcceptance)) {
    throw new Error('任务受理角色快照无效。');
  }
  assertScopeConsistency(db, input.scope.resourceType, input.scope.resourceId);
  const at = new Date().toISOString();
  const snapshot = JSON.stringify(input.creationSnapshot ?? {});
  db.prepare(`
    INSERT INTO team_task_principals (
      module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, roleAtAcceptance, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.module, input.taskId, input.actorUserId, input.scope.resourceType, input.scope.resourceId,
    snapshot, input.roleAtAcceptance ?? null, at);
  return getTaskPrincipal(db, input.module, input.taskId)!;
}

export function getTaskPrincipal(
  db: Database.Database,
  module: string,
  taskId: string,
): TeamTaskPrincipal | null {
  const row = db.prepare(`
    SELECT * FROM team_task_principals WHERE module = ? AND taskId = ?
  `).get(module, taskId) as {
    module: string;
    taskId: string;
    actorUserId: string;
    scopeType: string;
    scopeId: string;
    creationSnapshot: string;
    roleAtAcceptance: TeamTaskRole | null;
    createdAt: string;
  } | undefined;
  if (!row) return null;
  const roleAtAcceptance = row.roleAtAcceptance === 'admin' || row.roleAtAcceptance === 'employee'
    ? row.roleAtAcceptance : null;
  return {
    module: row.module,
    taskId: row.taskId,
    actorUserId: row.actorUserId,
    scope: { resourceType: row.scopeType, resourceId: row.scopeId },
    creationSnapshot: JSON.parse(row.creationSnapshot) as unknown,
    roleAtAcceptance,
    authorizationEvidence: roleAtAcceptance ? 'frozen' : 'missing',
    createdAt: row.createdAt,
  };
}

export function requireTaskScope(
  db: Database.Database,
  module: string,
  taskId: string,
): TeamTaskPrincipal {
  const principal = getTaskPrincipal(db, module, taskId);
  if (!principal) throw new Error('任务缺少持久发起人，已拒绝执行。');
  assertScopeConsistency(db, principal.scope.resourceType, principal.scope.resourceId);
  return principal;
}

/**
 * 已受理任务的访问边界：只允许冻结 scope 及其后代。
 * 即使受理时是管理员，也不得用历史角色读取其他用户资源。
 */
export function requireTaskScopeAccess(
  db: Database.Database,
  principal: TeamTaskPrincipal,
  resourceType: string,
  resourceId: string,
): void {
  if (resourceType === principal.scope.resourceType && resourceId === principal.scope.resourceId) return;
  const scope = db.prepare(`
    SELECT * FROM team_resource_scopes WHERE resourceType = ? AND resourceId = ?
  `).get(resourceType, resourceId) as { rootType: string; rootId: string } | undefined;
  if (!scope) throw new Error('已受理任务引用的资源不存在，已拒绝访问。');
  if (scope.rootType === principal.scope.resourceType && scope.rootId === principal.scope.resourceId) return;
  throw new Error('已受理任务只能访问其冻结的资源范围。');
}
