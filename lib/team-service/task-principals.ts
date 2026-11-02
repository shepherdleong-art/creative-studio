import type Database from 'better-sqlite3';
import type { ResourceRef, TaskPrincipalRegistration } from '../media-core/access-context.ts';
import { assertScopeConsistency } from './resource-scopes.ts';

export interface TeamTaskPrincipal {
  module: string;
  taskId: string;
  actorUserId: string;
  scope: ResourceRef;
  creationSnapshot: unknown;
  createdAt: string;
}

export function registerTaskPrincipal(
  db: Database.Database,
  input: TaskPrincipalRegistration & { actorUserId: string },
): TeamTaskPrincipal {
  if (!input.module.trim() || !input.taskId.trim() || !input.actorUserId.trim()) {
    throw new Error('任务主体字段不完整。');
  }
  assertScopeConsistency(db, input.scope.resourceType, input.scope.resourceId);
  const at = new Date().toISOString();
  const snapshot = JSON.stringify(input.creationSnapshot ?? {});
  db.prepare(`
    INSERT INTO team_task_principals (
      module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(input.module, input.taskId, input.actorUserId, input.scope.resourceType, input.scope.resourceId, snapshot, at);
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
    createdAt: string;
  } | undefined;
  if (!row) return null;
  return {
    module: row.module,
    taskId: row.taskId,
    actorUserId: row.actorUserId,
    scope: { resourceType: row.scopeType, resourceId: row.scopeId },
    creationSnapshot: JSON.parse(row.creationSnapshot) as unknown,
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
