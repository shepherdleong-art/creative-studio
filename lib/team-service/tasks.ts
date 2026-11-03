import type Database from 'better-sqlite3';
import { TeamUsageError } from './usage.ts';
import type { TeamViewer } from './diagnostics.ts';

export function listTeamTasks(
  db: Database.Database,
  viewer: TeamViewer,
  filters: { actorUserId?: string; status?: string } = {},
) {
  if (viewer.role !== 'admin' && filters.actorUserId && filters.actorUserId !== viewer.userId) {
    throw new TeamUsageError(403, 'task_query_forbidden', '只能查询本人的任务。');
  }
  const actorUserId = viewer.role === 'admin' ? filters.actorUserId : viewer.userId;
  const clauses: string[] = [];
  const values: string[] = [];
  if (actorUserId) { clauses.push('o.actorId = ?'); values.push(actorUserId); }
  if (filters.status) { clauses.push('o.status = ?'); values.push(filters.status); }
  const items = db.prepare(`
    SELECT o.id AS operationId, o.module, o.taskId, o.step, o.inputRevision,
      o.businessAttemptId, o.businessAttemptNo, o.actorId AS actorUserId,
      u.employeeId, u.displayName AS actorDisplayName, o.scopeType, o.scopeId,
      o.status, o.waitReason, o.configVersion, o.clientVersion, o.serverReleaseId,
      o.currentAttemptId, o.createdAt, o.updatedAt,
      (SELECT COUNT(*) FROM execution_attempts a WHERE a.operationId = o.id) AS attemptCount,
      (SELECT e.id FROM team_error_records e WHERE e.operationId = o.id ORDER BY e.createdAt DESC LIMIT 1) AS errorId
    FROM execution_operations o JOIN team_users u ON u.id = o.actorId
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY o.updatedAt DESC, o.id DESC LIMIT 500
  `).all(...values) as Array<Record<string, unknown>>;
  return {
    items: items.map((item) => ({
      ...item,
      scope: { resourceType: item.scopeType, resourceId: item.scopeId },
      scopeType: undefined,
      scopeId: undefined,
    })),
    localAgentIncluded: false,
  };
}
