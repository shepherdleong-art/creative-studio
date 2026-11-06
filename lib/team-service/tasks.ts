import type Database from 'better-sqlite3';
import { TeamUsageError } from './usage.ts';
import type { TeamViewer } from './diagnostics.ts';
import { TASK_MODULE_LABELS, TASK_STEP_LABELS, taskStepLabel, taskWaitLabel } from '../team-task-labels.ts';
import { readActorPolicy } from '../media-core/execution/pools.ts';
import { projectModelCall, summarizeModelCalls, type TeamModelCall } from './task-model.ts';

type TaskRow = Record<string, unknown>;
function snapshotConfigured(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0);
  } catch { return false; }
}

type AttemptRow = {
  operationId: string; attemptId: string; providerSnapshotJson: string;
  submissionState: string; createdAt: string;
};

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

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
      j.usageSnapshotJson AS imageUsageSnapshot, v.usageSnapshotJson AS videoUsageSnapshot,
      o.inputSnapshotJson, o.providerSnapshotJson,
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
  `).all(...values) as TaskRow[];
  const attempts = items.length === 0 ? [] : db.prepare(`
    SELECT a.operationId, a.id AS attemptId, a.providerSnapshotJson, a.pricingSnapshotJson,
      a.submissionState, a.createdAt
    FROM execution_attempts a
    WHERE a.operationId IN (${items.map(() => '?').join(',')})
    ORDER BY a.createdAt, a.transportSeq, a.id
  `).all(...items.map(item => item.operationId)) as Array<AttemptRow & { pricingSnapshotJson: string | null }>;
  const attemptsByOperation = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const group = attemptsByOperation.get(attempt.operationId) ?? [];
    group.push(attempt);
    attemptsByOperation.set(attempt.operationId, group);
  }
  const canvasNames = new Map<string, string>();
  const canvases = items.filter(item => item.scopeType === 'canvas');
  if (canvases.length && tableExists(db, 'creative_canvases')) {
    const rows = db.prepare(`SELECT id, name FROM creative_canvases WHERE id IN (${canvases.map(() => '?').join(',')})`)
      .all(...canvases.map(item => item.scopeId)) as Array<{ id: string; name: string }>;
    for (const row of rows) canvasNames.set(row.id, row.name);
  }
  return {
    items: items.map((item) => {
      const isCanceled = item.waitReason === 'stage_canceled' ||
        (['pending', 'deferred', 'failed'].includes(String(item.status)) && (item.imageStatus === 'canceled' || item.videoStatus === 'canceled'));
      const moduleLabel = item.module === 'image' && item.imageUsage === 'scene_seed' ? '新场景图生成'
        : item.module === 'image' && item.imageUsage === 'shot_source' ? '分镜图生成'
          : TASK_MODULE_LABELS[String(item.module)] ?? '其他制作任务';
      const scopeName = item.scopeType === 'canvas' ? canvasNames.get(String(item.scopeId)) : item.scopeName;
      const rawAttempts = attemptsByOperation.get(String(item.operationId)) ?? [];
      const modelCalls: TeamModelCall[] = [];
      if (rawAttempts.length === 0) {
        const planned = projectModelCall({
          snapshot: item.providerSnapshotJson, inputSnapshot: item.inputSnapshotJson,
          module: String(item.module), legacyModel: item.model,
          legacyUsageSnapshot: item.imageUsageSnapshot ?? item.videoUsageSnapshot,
          submissionState: 'not_sent', createdAt: String(item.createdAt),
        });
        if (planned) modelCalls.push(planned);
      } else {
        for (const attempt of rawAttempts) {
          const call = projectModelCall({
            snapshot: attempt.providerSnapshotJson, inputSnapshot: item.inputSnapshotJson,
            pricingSnapshot: attempt.pricingSnapshotJson, module: String(item.module),
            legacyModel: item.model, legacyUsageSnapshot: item.imageUsageSnapshot ?? item.videoUsageSnapshot,
            attemptId: attempt.attemptId, submissionState: attempt.submissionState, createdAt: attempt.createdAt,
          });
          if (call) modelCalls.push(call);
        }
      }
      const display = summarizeModelCalls(modelCalls, String(item.module), snapshotConfigured(item.providerSnapshotJson));
      return {
        operationId: item.operationId, module: item.module, taskId: item.taskId, step: item.step,
        inputRevision: item.inputRevision, businessAttemptId: item.businessAttemptId,
        businessAttemptNo: item.businessAttemptNo, actorUserId: item.actorUserId,
        employeeId: item.employeeId, actorDisplayName: item.actorDisplayName,
        inputFilename: item.inputFilename, submissionCount: Number(item.submissionCount ?? 0),
        attemptCount: Number(item.attemptCount ?? 0),
        status: isCanceled ? 'canceled' : item.status,
        waitReason: isCanceled ? 'stage_canceled' : item.waitReason,
        waitLabel: taskWaitLabel(isCanceled ? 'stage_canceled' : item.waitReason as string | null, readActorPolicy(db, String(item.actorUserId)).effectiveConcurrency),
        configVersion: item.configVersion, clientVersion: item.clientVersion, serverReleaseId: item.serverReleaseId,
        currentAttemptId: item.currentAttemptId, errorId: item.errorId, createdAt: item.createdAt, updatedAt: item.updatedAt,
        taskName: moduleLabel,
        stepName: taskStepLabel(String(item.step), String(item.module)),
        scopeName: scopeName || (item.scopeType === 'project' ? '项目已删除或不可用' : item.scopeType === 'canvas' ? '画布已删除或不可用' : '未关联项目或画布'),
        scope: { resourceType: item.scopeType, resourceId: item.scopeId },
        ...display, modelCalls,
      };
    }),
    localAgentIncluded: false,
  };
}
