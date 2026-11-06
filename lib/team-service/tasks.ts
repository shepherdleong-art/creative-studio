import type Database from 'better-sqlite3';
import { TeamUsageError } from './usage.ts';
import type { TeamViewer } from './diagnostics.ts';
import { TASK_MODULE_LABELS, TASK_STEP_LABELS, taskWaitLabel } from '../team-task-labels.ts';
import { readActorPolicy } from '../media-core/execution/pools.ts';

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
  const canceled = `(o.waitReason = 'stage_canceled' OR (o.status IN ('pending', 'deferred', 'failed') AND COALESCE(j.status, v.status) = 'canceled'))`;
  if (filters.status === 'canceled') clauses.push(canceled);
  else if (filters.status) { clauses.push(`o.status = ? AND NOT COALESCE(${canceled}, 0)`); values.push(filters.status); }
  const items = db.prepare(`
    SELECT o.id AS operationId, o.module, o.taskId, o.step, o.inputRevision,
      o.businessAttemptId, o.businessAttemptNo, o.actorId AS actorUserId,
      u.employeeId, u.displayName AS actorDisplayName, o.scopeType, o.scopeId,
      o.status, o.waitReason, o.configVersion, o.clientVersion, o.serverReleaseId,
      o.currentAttemptId, o.createdAt, o.updatedAt,
      p.name AS scopeName, j.status AS imageStatus, v.status AS videoStatus,
      a.filename AS inputFilename, a.usage AS imageUsage, COALESCE(j.model, v.model) AS model,
      policy.personalConcurrency,
      (SELECT COUNT(*) FROM execution_attempts a WHERE a.operationId = o.id) AS attemptCount,
      (SELECT COUNT(*) FROM execution_attempts a WHERE a.operationId = o.id AND a.intentJournalSeq IS NOT NULL) AS submissionCount,
      (SELECT e.id FROM team_error_records e WHERE e.operationId = o.id ORDER BY e.createdAt DESC LIMIT 1) AS errorId
    FROM execution_operations o JOIN team_users u ON u.id = o.actorId
    LEFT JOIN projects p ON o.scopeType = 'project' AND p.id = o.scopeId
    LEFT JOIN jobs j ON o.module = 'image' AND j.id = o.taskId
    LEFT JOIN video_jobs v ON o.module = 'video' AND v.id = o.taskId
    LEFT JOIN image_assets a ON a.id = COALESCE(j.inputImageId, v.sourceImageId)
    LEFT JOIN execution_actor_policies policy ON policy.actorId = o.actorId
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY o.updatedAt DESC, o.id DESC LIMIT 500
  `).all(...values) as Array<Record<string, unknown>>;
  return {
    items: items.map((item) => {
      const isCanceled = item.waitReason === 'stage_canceled' ||
        (['pending', 'deferred', 'failed'].includes(String(item.status)) && (item.imageStatus === 'canceled' || item.videoStatus === 'canceled'));
      const moduleLabel = item.module === 'image' && item.imageUsage === 'scene_seed' ? '新场景图生成'
        : item.module === 'image' && item.imageUsage === 'shot_source' ? '分镜图生成'
          : TASK_MODULE_LABELS[String(item.module)] ?? String(item.module);
      let scopeName = item.scopeName;
      if (item.scopeType === 'canvas' && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creative_canvases'").get()) {
        scopeName = db.prepare('SELECT name FROM creative_canvases WHERE id=?').pluck().get(item.scopeId);
      }
      return {
      ...item,
      submissionCount: Number(item.submissionCount ?? 0),
      attemptCount: Number(item.attemptCount ?? 0),
      status: isCanceled ? 'canceled' : item.status,
      waitReason: isCanceled ? 'stage_canceled' : item.waitReason,
      waitLabel: taskWaitLabel(isCanceled ? 'stage_canceled' : item.waitReason as string | null, readActorPolicy(db, String(item.actorUserId)).effectiveConcurrency),
      taskName: moduleLabel,
      stepName: TASK_STEP_LABELS[String(item.step)] ?? String(item.step),
      scopeName: scopeName || (item.scopeType === 'project' ? '项目已删除或不可用' : item.scopeType === 'canvas' ? '画布已删除或不可用' : String(item.scopeType)),
      scope: { resourceType: item.scopeType, resourceId: item.scopeId },
      scopeType: undefined,
      scopeId: undefined,
    }; }),
    localAgentIncluded: false,
  };
}
