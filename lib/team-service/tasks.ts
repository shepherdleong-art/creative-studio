import type Database from 'better-sqlite3';
import { TeamUsageError } from './usage.ts';
import type { TeamViewer } from './diagnostics.ts';
import { TASK_MODULE_LABELS, TASK_STEP_LABELS, taskWaitLabel } from '../team-task-labels.ts';

/** 最近记录上限：任务中心不做全历史分页，界面必须显式说明截断。 */
export const TEAM_TASK_RECORD_LIMIT = 500;

export interface TeamTaskActorOption {
  actorUserId: string;
  employeeId: string;
  displayName: string;
  accountStatus: 'active' | 'disabled';
  role: 'employee' | 'admin';
}

export interface TeamTaskFilters {
  actorUserId?: string;
  status?: string;
}

function assertActorScope(viewer: TeamViewer, actorUserId: string | undefined): void {
  if (viewer.role !== 'admin' && actorUserId && actorUserId !== viewer.userId) {
    throw new TeamUsageError(403, 'task_query_forbidden', '只能查询本人的任务。');
  }
}

/**
 * 成员筛选选项。
 *
 * 选项来自团队成员表而不是任务结果，否则低频成员会被最近 500 条挤出下拉框，
 * 再也无法被选中查询。员工只能拿到自己的选项，不暴露团队名册。
 */
export function listTeamTaskActorOptions(
  db: Database.Database,
  viewer: TeamViewer,
  filters: { actorUserId?: string } = {},
): TeamTaskActorOption[] {
  assertActorScope(viewer, filters.actorUserId);
  if (viewer.role !== 'admin') {
    const own = db.prepare(`
      SELECT id AS actorUserId, employeeId, displayName, status AS accountStatus, role
      FROM team_users WHERE id = ?
    `).get(viewer.userId) as (Omit<TeamTaskActorOption, 'accountStatus'> & { accountStatus: string }) | undefined;
    if (!own) return [];
    return [{ ...own, accountStatus: own.accountStatus === 'disabled' ? 'disabled' : 'active' }];
  }
  const rows = db.prepare(`
    SELECT id AS actorUserId, employeeId, displayName, status AS accountStatus, role
    FROM team_users ORDER BY employeeId
  `).all() as Array<Omit<TeamTaskActorOption, 'accountStatus'> & { accountStatus: string }>;
  return rows
    .filter((row) => !filters.actorUserId || row.actorUserId === filters.actorUserId)
    .map((row) => ({ ...row, accountStatus: row.accountStatus === 'disabled' ? 'disabled' : 'active' }));
}

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
  actorAccountStatus: 'active' | 'disabled';
  status: string;
  waitReason: string | null;
  waitLabel: string;
  configVersion: string | null;
  clientVersion: string | null;
  serverReleaseId: string | null;
  currentAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
  scopeName: string;
  scope: { resourceType: string; resourceId: string };
  inputFilename: string | null;
  model: string | null;
  taskName: string;
  stepName: string;
  attemptCount: number;
  submissionCount: number;
  errorId: string | null;
}

export interface TeamTaskListResult {
  items: TeamTaskView[];
  /** 最近记录上限；界面必须据此说明「仅最近 N 条」。 */
  limit: number;
  /** true 表示筛选结果超过上限，界面不能说成该成员全历史任务数。 */
  truncated: boolean;
  /** 本轮不做全历史分页，明确不给总数而不是虚报一个数。 */
  totalMatching: null;
  localAgentIncluded: false;
}

export function listTeamTasks(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamTaskFilters = {},
): TeamTaskListResult {
  assertActorScope(viewer, filters.actorUserId);
  const actorUserId = viewer.role === 'admin' ? filters.actorUserId : viewer.userId;
  const clauses: string[] = [];
  const values: string[] = [];
  if (actorUserId) { clauses.push('o.actorId = ?'); values.push(actorUserId); }
  const canceled = `(o.waitReason = 'stage_canceled' OR (o.status IN ('pending', 'deferred', 'failed') AND COALESCE(j.status, v.status) = 'canceled'))`;
  if (filters.status === 'canceled') clauses.push(canceled);
  else if (filters.status) { clauses.push(`o.status = ? AND NOT COALESCE(${canceled}, 0)`); values.push(filters.status); }
  const rows = db.prepare(`
    SELECT o.id AS operationId, o.module, o.taskId, o.step, o.inputRevision,
      o.businessAttemptId, o.businessAttemptNo, o.actorId AS actorUserId,
      u.employeeId, u.displayName AS actorDisplayName, u.status AS actorAccountStatus,
      o.scopeType, o.scopeId,
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
    ORDER BY o.updatedAt DESC, o.id DESC LIMIT ${TEAM_TASK_RECORD_LIMIT + 1}
  `).all(...values) as Array<Record<string, unknown>>;
  // 多取一条只用于判断是否还有更早记录，不把第 501 条返回给界面。
  const truncated = rows.length > TEAM_TASK_RECORD_LIMIT;
  const items = truncated ? rows.slice(0, TEAM_TASK_RECORD_LIMIT) : rows;
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
      operationId: String(item.operationId),
      module: String(item.module),
      taskId: String(item.taskId),
      step: String(item.step),
      inputRevision: String(item.inputRevision),
      businessAttemptId: String(item.businessAttemptId),
      businessAttemptNo: Number(item.businessAttemptNo ?? 0),
      actorUserId: String(item.actorUserId),
      employeeId: String(item.employeeId),
      actorDisplayName: String(item.actorDisplayName),
      actorAccountStatus: (item.actorAccountStatus === 'disabled' ? 'disabled' : 'active') as 'active' | 'disabled',
      submissionCount: Number(item.submissionCount ?? 0),
      attemptCount: Number(item.attemptCount ?? 0),
      status: String(isCanceled ? 'canceled' : item.status),
      waitReason: (isCanceled ? 'stage_canceled' : item.waitReason) as string | null,
      waitLabel: taskWaitLabel(isCanceled ? 'stage_canceled' : item.waitReason as string | null, Number(item.personalConcurrency ?? 0)),
      configVersion: (item.configVersion ?? null) as string | null,
      clientVersion: (item.clientVersion ?? null) as string | null,
      serverReleaseId: (item.serverReleaseId ?? null) as string | null,
      currentAttemptId: (item.currentAttemptId ?? null) as string | null,
      createdAt: String(item.createdAt),
      updatedAt: String(item.updatedAt),
      taskName: moduleLabel,
      stepName: TASK_STEP_LABELS[String(item.step)] ?? String(item.step),
      scopeName: String(scopeName || (item.scopeType === 'project' ? '项目已删除或不可用' : item.scopeType === 'canvas' ? '画布已删除或不可用' : item.scopeType)),
      scope: { resourceType: String(item.scopeType), resourceId: String(item.scopeId) },
      inputFilename: (item.inputFilename ?? null) as string | null,
      model: (item.model ?? null) as string | null,
      errorId: (item.errorId ?? null) as string | null,
    }; }),
    limit: TEAM_TASK_RECORD_LIMIT,
    truncated,
    totalMatching: null,
    localAgentIncluded: false,
  };
}
