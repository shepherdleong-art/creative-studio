import type Database from 'better-sqlite3';
import { runWithAccessContext, setTaskAccessContextFactory, type ResourceAccessContext } from '../media-core/access-context.ts';
import { readRuntimeConfig } from './config.ts';
import { createTeamAccessContext } from './resource-scopes.ts';
import { requireTaskScope } from './task-principals.ts';
import type { AuthPrincipal, TeamRole } from './auth/types.ts';

/**
 * 已受理任务只使用持久任务身份：
 * - 角色取受理时的快照；旧记录缺少证据时按最小 employee 处理，不继承当前 admin；
 * - 访问范围限定在冻结 scope 及其后代，降权/升权都不扩大旧任务权限；
 * - 软删除的依赖仍可读（allowDeleted），保证原任务能收取结果。
 */
export function createAcceptedTaskAccessContext(
  db: Database.Database,
  module: string,
  taskId: string,
): ResourceAccessContext {
  const accepted = requireTaskScope(db, module, taskId);
  const user = db.prepare('SELECT id, employeeId, displayName FROM team_users WHERE id = ?')
    .get(accepted.actorUserId) as { id: string; employeeId: string; displayName: string } | undefined;
  if (!user) throw new Error('持久任务发起人不存在，已拒绝执行。');
  const role: TeamRole = accepted.roleAtAcceptance ?? 'employee';
  const principal: AuthPrincipal = {
    kind: 'user',
    userId: user.id,
    employeeId: user.employeeId,
    displayName: user.displayName,
    role,
    sessionId: `accepted:${module}:${taskId}`,
    sessionVersion: 0,
    mustChangePassword: false,
    absoluteExpiresAt: accepted.createdAt,
  };
  return createTeamAccessContext({
    db,
    principal,
    allowDeleted: true,
    restrictToScope: accepted.scope,
  });
}

setTaskAccessContextFactory(createAcceptedTaskAccessContext);

export function runWithAcceptedTaskAccess<T>(
  db: Database.Database,
  module: string,
  taskId: string,
  operation: () => T,
): T {
  if (readRuntimeConfig().mode === 'local') return operation();
  return runWithAccessContext(createAcceptedTaskAccessContext(db, module, taskId), operation);
}
