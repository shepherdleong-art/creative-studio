import type Database from 'better-sqlite3';
import { TeamUsageError } from './usage.ts';
import { queryUnifiedTaskUsage } from './unified-usage.ts';
import type { UnifiedTaskCostStatus } from './unified-usage-contract.ts';
import type { TeamViewer } from './diagnostics.ts';
import { TASK_MODULE_LABELS, taskStepLabel, taskWaitLabel } from '../team-task-labels.ts';
import { readActorPolicy } from '../media-core/execution/pools.ts';
import { unifiedMediaDisplayName } from '../media-core/unified-media/catalog.ts';
import { projectModelCall, summarizeModelCalls, type TeamModelCall } from './task-model.ts';

type TaskRow = Record<string, unknown>;
function snapshotConfigured(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0);
  } catch { return false; }
}

/**
 * 一条任务投影（`listTeamTasks().items[*]`）。
 *
 * 显式声明而不是让 TS 从 `Record<string, unknown>` 里推：控制台的纯函数
 * （`lib/team-console-overview.ts`）与页面都按这个形状读字段，接口返回什么这里就是什么。
 */
export interface TeamTaskView {
  operationId: string;
  module: string;
  taskId: string;
  step: string;
  inputRevision: string;
  businessAttemptId: string;
  businessAttemptNo: number;
  actorUserId: string;
  employeeId: string;
  actorDisplayName: string;
  inputFilename: string | null;
  submissionCount: number;
  attemptCount: number;
  status: string;
  waitReason: string | null;
  waitLabel: string;
  configVersion: string | null;
  clientVersion: string | null;
  serverReleaseId: string | null;
  currentAttemptId: string | null;
  errorId: string | null;
  errorStage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  taskName: string;
  stepName: string;
  scopeName: string;
  scope: { resourceType: string; resourceId: string };
  providerName: string;
  model: string | null;
  modelStatus: string;
  unifiedModel: string | null;
  unifiedTaskId: string | null;
  unifiedTaskCostMinor: number;
  unifiedTaskCostStatus: UnifiedTaskCostStatus | null;
  unifiedTaskAttemptCount: number;
  unifiedTaskChannelCount: number;
  modelCalls: TeamModelCall[];
}

type AttemptRow = {
  operationId: string; attemptId: string; providerSnapshotJson: string;
  submissionState: string; createdAt: string;
};

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  return tableExists(db, table)
    && (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
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
      ${tableHasColumn(db, 'jobs', 'unifiedModel') ? 'j.unifiedModel' : 'NULL'} AS unifiedModel,
      ${tableHasColumn(db, 'jobs', 'unifiedTaskId') ? 'j.unifiedTaskId' : 'NULL'} AS unifiedTaskId,
      j.usageSnapshotJson AS imageUsageSnapshot, v.usageSnapshotJson AS videoUsageSnapshot,
      o.inputSnapshotJson, o.providerSnapshotJson,
      policy.personalConcurrency,
      (SELECT COUNT(*) FROM execution_attempts a WHERE a.operationId = o.id) AS attemptCount,
      (SELECT COUNT(*) FROM execution_attempts a WHERE a.operationId = o.id AND a.intentJournalSeq IS NOT NULL) AS submissionCount,
      (SELECT e.id FROM team_error_records e WHERE e.operationId = o.id ORDER BY e.createdAt DESC LIMIT 1) AS errorId,
      (SELECT e.stage FROM team_error_records e WHERE e.operationId = o.id ORDER BY e.createdAt DESC LIMIT 1) AS errorStage,
      (SELECT e.code FROM team_error_records e WHERE e.operationId = o.id ORDER BY e.createdAt DESC LIMIT 1) AS errorCode,
      (SELECT e.safeMessage FROM team_error_records e WHERE e.operationId = o.id ORDER BY e.createdAt DESC LIMIT 1) AS errorMessage,
      (SELECT a.errorCode FROM execution_attempts a WHERE a.operationId = o.id AND a.errorCode IS NOT NULL ORDER BY a.createdAt DESC, a.transportSeq DESC LIMIT 1) AS attemptErrorCode
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
  const unifiedTasksByJobId = new Map(
    queryUnifiedTaskUsage(db, viewer, filters).tasks.map((task) => [task.taskId, task]),
  );
  const canvasNames = new Map<string, string>();
  const canvases = items.filter(item => item.scopeType === 'canvas');
  if (canvases.length && tableExists(db, 'creative_canvases')) {
    const rows = db.prepare(`SELECT id, name FROM creative_canvases WHERE id IN (${canvases.map(() => '?').join(',')})`)
      .all(...canvases.map(item => item.scopeId)) as Array<{ id: string; name: string }>;
    for (const row of rows) canvasNames.set(row.id, row.name);
  }
  return {
    items: items.map((item): TeamTaskView => {
      const isCanceled = item.waitReason === 'stage_canceled' ||
        (['pending', 'deferred', 'failed'].includes(String(item.status)) && (item.imageStatus === 'canceled' || item.videoStatus === 'canceled'));
      // 「已重试、已回到队列」：执行记录本身仍是上一轮的 failed，但业务任务（jobs / video_jobs）
      // 已经被重试入口放回待领状态。控制台与全员任务都要如实显示成「排队中」，
      // 否则用户点了重试还会看到「失败」，以为没生效。
      const requeued = String(item.status) === 'failed'
        && ['pending', 'retrying', 'running'].includes(String(item.imageStatus ?? item.videoStatus ?? ''));
      const moduleLabel = item.module === 'image' && item.imageUsage === 'scene_seed' ? '新场景图生成'
        : item.module === 'image' && item.imageUsage === 'shot_source' ? '分镜图生成'
          : TASK_MODULE_LABELS[String(item.module)] ?? '其他制作任务';
      const scopeName = item.scopeType === 'canvas'
        ? canvasNames.get(String(item.scopeId)) ?? ''
        : String(item.scopeName ?? '');
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
      const unifiedModel = typeof item.unifiedModel === 'string' && item.unifiedModel.trim()
        ? item.unifiedModel.trim()
        : null;
      const unifiedDisplay = unifiedMediaDisplayName(unifiedModel);
      const unifiedTaskId = typeof item.unifiedTaskId === 'string' && item.unifiedTaskId.trim()
        ? item.unifiedTaskId.trim()
        : null;
      const unifiedAggregate = unifiedTaskId
        ? unifiedTasksByJobId.get(String(item.taskId))
        : undefined;
      const visibleModelCalls = unifiedDisplay && viewer.role !== 'admin'
        ? modelCalls.map((call) => ({
          ...call,
          providerName: 'Image 2',
          model: unifiedDisplay,
        }))
        : modelCalls;
      return {
        operationId: String(item.operationId), module: String(item.module), taskId: String(item.taskId), step: String(item.step),
        inputRevision: String(item.inputRevision), businessAttemptId: String(item.businessAttemptId),
        businessAttemptNo: Number(item.businessAttemptNo), actorUserId: String(item.actorUserId),
        employeeId: String(item.employeeId), actorDisplayName: String(item.actorDisplayName),
        inputFilename: (item.inputFilename as string | null) ?? null, submissionCount: Number(item.submissionCount ?? 0),
        attemptCount: Number(item.attemptCount ?? 0),
        status: isCanceled ? 'canceled' : requeued ? 'pending' : String(item.status),
        waitReason: isCanceled ? 'stage_canceled' : requeued ? null : (item.waitReason as string | null) ?? null,
        waitLabel: isCanceled
          ? taskWaitLabel('stage_canceled', null)
          : requeued
            ? '已重新加入队列，等待开始'
            : taskWaitLabel(item.waitReason as string | null, readActorPolicy(db, String(item.actorUserId)).effectiveConcurrency),
        configVersion: (item.configVersion as string | null) ?? null,
        clientVersion: (item.clientVersion as string | null) ?? null,
        serverReleaseId: (item.serverReleaseId as string | null) ?? null,
        currentAttemptId: (item.currentAttemptId as string | null) ?? null,
        errorId: (item.errorId as string | null) ?? null,
        // 详情要写清「失败在哪一步、错误编号、模型」：错误阶段与代码直接取最新一条错误记录，
        // 没有 AI 记录时回退到执行尝试上的错误代码，两者都没有就当空。
        errorStage: (item.errorStage as string | null) ?? null,
        errorCode: (item.errorCode as string | null) ?? (item.attemptErrorCode as string | null) ?? null,
        errorMessage: (item.errorMessage as string | null) ?? null,
        createdAt: String(item.createdAt), updatedAt: String(item.updatedAt),
        taskName: moduleLabel,
        stepName: taskStepLabel(String(item.step), String(item.module)),
        scopeName: scopeName || (item.scopeType === 'project' ? '项目已删除或不可用' : item.scopeType === 'canvas' ? '画布已删除或不可用' : '未关联项目或画布'),
        scope: { resourceType: String(item.scopeType), resourceId: String(item.scopeId) },
        ...(unifiedDisplay
          ? { providerName: 'Image 2', model: unifiedDisplay, modelStatus: 'recorded' }
          : display),
        unifiedModel,
        unifiedTaskId,
        unifiedTaskCostMinor: unifiedAggregate?.chargedMinor ?? 0,
        unifiedTaskCostStatus: unifiedAggregate?.costStatus ?? null,
        unifiedTaskAttemptCount: unifiedAggregate?.channelCallCount ?? 0,
        unifiedTaskChannelCount: unifiedAggregate?.usedChannelCount ?? 0,
        modelCalls: visibleModelCalls,
      };
    }),
    localAgentIncluded: false,
  };
}
