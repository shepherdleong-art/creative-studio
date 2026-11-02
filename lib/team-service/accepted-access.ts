import type Database from 'better-sqlite3';
import { runWithAccessContext, setTaskAccessContextFactory, type ResourceAccessContext } from '../media-core/access-context.ts';
import { readRuntimeConfig } from './config.ts';
import { createTeamAccessContext } from './resource-scopes.ts';
import { requireTaskScope } from './task-principals.ts';
import type { AuthPrincipal, TeamRole } from './auth/types.ts';

export function createAcceptedTaskAccessContext(
  db: Database.Database,
  module: string,
  taskId: string,
): ResourceAccessContext {
  const accepted = requireTaskScope(db, module, taskId);
  const user = db.prepare('SELECT id, employeeId, displayName, role FROM team_users WHERE id = ?')
    .get(accepted.actorUserId) as { id: string; employeeId: string; displayName: string; role: TeamRole } | undefined;
  if (!user) throw new Error('持久任务发起人不存在，已拒绝执行。');
  const principal: AuthPrincipal = {
    kind: 'user',
    userId: user.id,
    employeeId: user.employeeId,
    displayName: user.displayName,
    role: user.role,
    sessionId: `accepted:${module}:${taskId}`,
    sessionVersion: 0,
    mustChangePassword: false,
    absoluteExpiresAt: accepted.createdAt,
  };
  return createTeamAccessContext({ db, principal, allowDeleted: true });
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
