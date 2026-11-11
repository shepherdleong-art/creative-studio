import type Database from 'better-sqlite3';
import { TeamUsageError } from './usage.ts';
import { queryUnifiedTaskUsageByMediaTaskIds } from './unified-usage.ts';
import type { UnifiedTaskCostStatus } from './unified-usage-contract.ts';
import type { TeamViewer } from './diagnostics.ts';
import { TASK_MODULE_LABELS, taskStepLabel, taskWaitLabel } from '../team-task-labels.ts';
import { readActorPolicy } from '../media-core/execution/pools.ts';
import { unifiedMediaDisplayName } from '../media-core/unified-media/catalog.ts';
import { projectModelCall, summarizeModelCalls, type TeamModelCall } from './task-model.ts';
import { CONSOLE_STATUS_BUCKETS, shanghaiDateKey } from '../team-console-overview.ts';
import {
  parseTeamPage,
  resolveTeamPage,
  type TeamPageParamInput,
  type TeamPageRequest,
  type TeamPagination,
} from './pagination.ts';

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
  admissionPriority: number | null;
  admissionCandidateCount: number | null;
  admissionTrace: Record<string, unknown> | null;
  modelCalls: TeamModelCall[];
}

/** 列表筛选（全部在 SQL 里生效；权限在计数与选页之前）。 */
export interface TeamTaskListFilters {
  actorUserId?: string;
  status?: string;
  /** 关键词：大小写不敏感、首尾去空格、`%`/`_`/引号按普通文字。 */
  q?: string;
}

/**
 * `GET /api/team/tasks` 的响应形状。
 *
 * - `items` 是**执行记录**，但只包含当前页完整制作任务组的记录：一页 25 个制作任务
 *   可以返回多于 25 条执行记录。
 * - `pagination.total` 数制作任务组；`totalRecords` 是这些匹配任务组内的执行记录总数。
 */
export interface TeamTaskListResult {
  items: TeamTaskView[];
  localAgentIncluded: false;
  pagination: TeamPagination;
  totalRecords: number;
}

/** 有界记录查询的选项（总览最近任务、员工首页在飞任务）。 */
export interface TeamTaskRecordQuery {
  actorUserId?: string;
  /** 按**有效状态**过滤（与列表显示、状态筛选同一口径）。 */
  statuses?: readonly string[];
  limit?: number;
}

type AttemptRow = {
  operationId: string; attemptId: string; providerSnapshotJson: string; pricingSnapshotJson: string | null;
  submissionState: string; createdAt: string;
};

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  return tableExists(db, table)
    && (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * 制作任务名（中文）：列表投影与搜索 SQL 函数共用的**唯一**映射。
 * 图片模块按用途细分，其余沿用 `TASK_MODULE_LABELS`；未登记的模块写「其他制作任务」。
 */
export function teamTaskNameLabel(module: string, imageUsage?: string | null): string {
  if (module === 'image' && imageUsage === 'scene_seed') return '新场景图生成';
  if (module === 'image' && imageUsage === 'shot_source') return '分镜图生成';
  return TASK_MODULE_LABELS[module] ?? '其他制作任务';
}

/**
 * 搜索用的中文任务/步骤名函数（SQLite UDF）。
 *
 * 搜索必须覆盖**界面显示的中文名**（`taskName`/`stepName`），而这两个名字是
 * `lib/team-task-labels.ts` 里的纯函数算出来的。与其在 SQL 里再抄一份词典，这里把
 * 同一份函数注册成 SQLite UDF（确定性、只读），SQL 用 `instr()` 做子串匹配：
 * 词典只有一处、列表显示与搜索不会漂移。匹配是全文扫描（子串搜索本来也用不到索引），
 * 与改动前按 `updatedAt DESC` 排序的扫描量同一量级。
 */
const searchFunctionDbs = new WeakSet<object>();

function ensureTaskSearchFunctions(db: Database.Database): void {
  if (searchFunctionDbs.has(db)) return;
  db.function('team_task_name', { deterministic: true }, (moduleValue: unknown, usageValue: unknown) => {
    const moduleName = typeof moduleValue === 'string' ? moduleValue : '';
    const usage = typeof usageValue === 'string' ? usageValue : '';
    return teamTaskNameLabel(moduleName, usage);
  });
  db.function('team_task_step_name', { deterministic: true }, (moduleValue: unknown, stepValue: unknown) => {
    const moduleName = typeof moduleValue === 'string' ? moduleValue : '';
    const step = typeof stepValue === 'string' ? stepValue : '';
    return taskStepLabel(step, moduleName);
  });
  db.function('team_unified_media_name', { deterministic: true }, (value: unknown) => (
    unifiedMediaDisplayName(value) ?? ''
  ));
  searchFunctionDbs.add(db);
}

interface TaskQuerySource {
  joins: string;
  /** `unified:<mediaTaskId>` 或 `operation:<operationId>`：分页单位。 */
  groupId: string;
  unifiedTaskId: string;
  unifiedModel: string;
  /** 有效状态（取消、failed 已重试回队按显示口径归一）：筛选、聚合、显示共用。 */
  effectiveStatus: string;
  hasCanvasTable: boolean;
}

interface TaskQueryShape {
  source: TaskQuerySource;
  /** 列表/详情共用的投影字段（含统一任务身份与模型表达式）。 */
  fields: string;
}

/**
 * 能力探测（表/列是否存在）与投影字段按连接缓存。
 *
 * schema 由启动迁移建好并固定，列表/详情/聚合每次请求都重跑 `PRAGMA table_info` 没有意义；
 * 缓存后一次分页请求只剩真正的数据查询。测试里的库在第一次查询前就建好表，不受影响。
 */
const taskQueryShapes = new WeakMap<object, TaskQueryShape>();

function taskQueryShape(db: Database.Database): TaskQueryShape {
  const cached = taskQueryShapes.get(db);
  if (cached) return cached;
  const source = computeTaskSource(db);
  const shape = { source, fields: computeRecordFields(db, source) };
  taskQueryShapes.set(db, shape);
  return shape;
}

function computeTaskSource(db: Database.Database): TaskQuerySource {
  const hasImageUnified = tableHasColumn(db, 'jobs', 'unifiedModel');
  const hasVideoUnified = tableHasColumn(db, 'video_jobs', 'unifiedModel');
  const hasMediaTasks = tableHasColumn(db, 'execution_media_tasks', 'unifiedModel');
  const hasImageUnifiedTask = tableHasColumn(db, 'jobs', 'unifiedTaskId');
  const hasVideoUnifiedTask = tableHasColumn(db, 'video_jobs', 'unifiedTaskId');
  const hasOperationMediaTask = tableHasColumn(db, 'execution_operations', 'mediaTaskId');
  const hasCanvasTable = tableExists(db, 'creative_canvases');
  // 统一制作任务的身份优先取执行记录自己记下的 `mediaTaskId`（v8 起的权威关联），
  // 再回退到业务任务列；两者都没有时才为「有统一模型、但业务任务没记 id」的旧记录
  // 按「模块 + 任务号」取唯一一条媒体任务——这样普通任务不会为每一行去扫媒体任务表，
  // 也不会因为同一业务任务号存在多条媒体任务而把执行记录 JOIN 成多行。
  const explicitMediaTask = hasOperationMediaTask ? "NULLIF(o.mediaTaskId, '')" : 'NULL';
  const mayBeUnifiedLegacy = [
    hasImageUnified ? 'j.unifiedModel IS NOT NULL' : '0',
    hasVideoUnified ? 'v.unifiedModel IS NOT NULL' : '0',
  ].join(' OR ');
  const legacyMediaTask = (column: string) => (hasMediaTasks
    ? `(CASE WHEN ${explicitMediaTask} IS NULL
          AND ${hasImageUnifiedTask ? 'j.unifiedTaskId IS NULL' : '1'}
          AND ${hasVideoUnifiedTask ? 'v.unifiedTaskId IS NULL' : '1'}
          AND (${mayBeUnifiedLegacy})
        THEN (SELECT m.${column} FROM execution_media_tasks m
          WHERE m.module = o.module AND m.taskId = o.taskId
          ORDER BY m.createdAt, m.id LIMIT 1)
      END)`
    : 'NULL');
  const mediaTaskUnifiedModel = hasMediaTasks && hasOperationMediaTask
    ? '(SELECT m.unifiedModel FROM execution_media_tasks m WHERE m.id = o.mediaTaskId)'
    : 'NULL';
  const unifiedModelExpression = `COALESCE(${hasImageUnified ? 'j.unifiedModel' : 'NULL'}, ${hasVideoUnified ? 'v.unifiedModel' : 'NULL'}, ${mediaTaskUnifiedModel}, ${legacyMediaTask('unifiedModel')})`;
  const unifiedTaskExpression = `COALESCE(${explicitMediaTask}, ${hasImageUnifiedTask ? 'j.unifiedTaskId' : 'NULL'}, ${hasVideoUnifiedTask ? 'v.unifiedTaskId' : 'NULL'}, ${legacyMediaTask('id')})`;
  const businessStatus = 'COALESCE(j.status, v.status)';
  // 取消意图是业务行上的持久事实：老通道已受理任务在取消后保持 running/needs_check
  // 继续收尾，执行记录本身不会变成 failed/canceled。只看 o.status 会让任务中心一直
  // 显示「供应商已受理」，与项目页的「已取消」长期矛盾。
  const imageCancelRequested = tableHasColumn(db, 'jobs', 'cancelRequestedAt') ? 'j.cancelRequestedAt' : 'NULL';
  const videoCancelRequested = tableHasColumn(db, 'video_jobs', 'cancelRequestedAt') ? 'v.cancelRequestedAt' : 'NULL';
  const businessCancelRequested = `COALESCE(${imageCancelRequested}, ${videoCancelRequested})`;
  // 统一通道的失败是历史事实；业务任务切换到备用通道不代表旧通道重新排队。
  // 普通人工重试只在新执行记录尚未创建时，临时把最后一条失败显示为已回队。
  const requeued = `o.status = 'failed' AND ${businessStatus} IN ('pending', 'retrying', 'running')
    AND ${unifiedTaskExpression} IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM execution_operations successor
      WHERE successor.module = o.module AND successor.taskId = o.taskId AND successor.step = o.step
        AND successor.actorId = o.actorId AND successor.scopeType = o.scopeType AND successor.scopeId = o.scopeId
        AND successor.readySeq > o.readySeq
    )`;
  const joins = `execution_operations o
    JOIN team_users u ON u.id = o.actorId
    LEFT JOIN projects p ON o.scopeType = 'project' AND p.id = o.scopeId
    ${hasCanvasTable ? "LEFT JOIN creative_canvases cv ON o.scopeType = 'canvas' AND cv.id = o.scopeId" : ''}
    LEFT JOIN jobs j ON o.module = 'image' AND j.id = o.taskId
    LEFT JOIN video_jobs v ON o.module = 'video' AND v.id = o.taskId
    LEFT JOIN image_assets a ON a.id = COALESCE(j.inputImageId, v.sourceImageId)
    LEFT JOIN execution_actor_policies policy ON policy.actorId = o.actorId`;
  return {
    joins,
    groupId: `(CASE WHEN ${unifiedTaskExpression} IS NOT NULL THEN 'unified:' || ${unifiedTaskExpression} ELSE 'operation:' || o.id END)`,
    unifiedTaskId: unifiedTaskExpression,
    unifiedModel: unifiedModelExpression,
    effectiveStatus: `(CASE
      WHEN o.waitReason = 'stage_canceled'
        OR (o.status IN ('pending', 'deferred', 'failed') AND ${businessStatus} = 'canceled')
        OR (${businessStatus} = 'canceled' AND ${businessCancelRequested} IS NOT NULL) THEN 'canceled'
      WHEN ${requeued} THEN 'pending'
      ELSE o.status END)`,
    hasCanvasTable,
  };
}

function computeRecordFields(db: Database.Database, source: TaskQuerySource): string {
  const hasAdmissionPriority = tableHasColumn(db, 'execution_operations', 'admissionPriority');
  const hasAdmissionCandidateCount = tableHasColumn(db, 'execution_operations', 'admissionCandidateCount');
  const hasAdmissionTrace = tableHasColumn(db, 'execution_operations', 'admissionTraceJson');
  return `
    o.id AS operationId, o.module, o.taskId, o.step, o.inputRevision,
    o.businessAttemptId, o.businessAttemptNo, o.actorId AS actorUserId,
    u.employeeId, u.displayName AS actorDisplayName, o.scopeType, o.scopeId,
    o.status, ${source.effectiveStatus} AS effectiveStatus, o.waitReason, o.configVersion, o.clientVersion, o.serverReleaseId,
    o.currentAttemptId, o.createdAt, o.updatedAt,
    p.name AS scopeName, ${source.hasCanvasTable ? 'cv.name AS canvasName' : 'NULL AS canvasName'},
    j.status AS imageStatus, v.status AS videoStatus,
    a.filename AS inputFilename, a.usage AS imageUsage, COALESCE(j.model, v.model) AS model,
    ${source.unifiedTaskId} AS unifiedTaskId,
    ${source.unifiedModel} AS unifiedModel,
    ${hasAdmissionPriority ? 'o.admissionPriority' : 'NULL'} AS admissionPriority,
    ${hasAdmissionCandidateCount ? 'o.admissionCandidateCount' : 'NULL'} AS admissionCandidateCount,
    ${hasAdmissionTrace ? 'o.admissionTraceJson' : 'NULL'} AS admissionTraceJson,
    j.usageSnapshotJson AS imageUsageSnapshot, v.usageSnapshotJson AS videoUsageSnapshot,
    o.inputSnapshotJson, o.providerSnapshotJson,
    policy.personalConcurrency,
    (SELECT COUNT(*) FROM execution_attempts a WHERE a.operationId = o.id) AS attemptCount,
    (SELECT COUNT(*) FROM execution_attempts a WHERE a.operationId = o.id AND a.intentJournalSeq IS NOT NULL) AS submissionCount,
    (SELECT e.id FROM team_error_records e WHERE e.operationId = o.id ORDER BY e.createdAt DESC LIMIT 1) AS errorId,
    (SELECT e.stage FROM team_error_records e WHERE e.operationId = o.id ORDER BY e.createdAt DESC LIMIT 1) AS errorStage,
    (SELECT e.code FROM team_error_records e WHERE e.operationId = o.id ORDER BY e.createdAt DESC LIMIT 1) AS errorCode,
    (SELECT e.safeMessage FROM team_error_records e WHERE e.operationId = o.id ORDER BY e.createdAt DESC LIMIT 1) AS errorMessage,
    (SELECT a.errorCode FROM execution_attempts a WHERE a.operationId = o.id AND a.errorCode IS NOT NULL ORDER BY a.createdAt DESC, a.transportSeq DESC LIMIT 1) AS attemptErrorCode`;
}

interface ResolvedTaskScope {
  db: Database.Database;
  source: TaskQuerySource;
  joins: string;
  groupId: string;
  effectiveStatus: string;
  authWhere: string;
  authValues: unknown[];
  matchWhere: string;
  matchValues: unknown[];
  status?: string;
}

/**
 * 搜索条件：`SEARCH_FIELDS`（任务名/步骤名/项目名/输入文件名/任务号/执行记录号/
 * 发起人姓名/工号/模型/供应商/错误编号/错误代码）+ 中文任务与步骤名。
 *
 * 只用 `instr()` 做普通子串匹配，所以 `%`、`_` 没有通配含义；`lower()` 覆盖 ASCII
 * 大小写（中文本来不分大小写）。快照 JSON 只用于「命中」，不会回显给前端。
 */
function buildSearchConditions(db: Database.Database, source: TaskQuerySource, needle: string): {
  parts: string[];
  values: unknown[];
} {
  const parts: string[] = [];
  const values: unknown[] = [];
  const addText = (expression: string) => {
    parts.push(`instr(lower(COALESCE(${expression}, '')), ?) > 0`);
    values.push(needle);
  };
  addText('o.id');
  addText('o.taskId');
  addText('o.step');
  addText('o.module');
  addText('a.filename');
  addText('p.name');
  if (source.hasCanvasTable) addText('cv.name');
  addText('u.displayName');
  addText('u.employeeId');
  addText('j.model');
  addText('v.model');
  // 冻结在执行记录/尝试里的供应商与模型事实（providerName、model 的来源）。
  addText('o.providerSnapshotJson');
  addText('o.inputSnapshotJson');
  addText('j.usageSnapshotJson');
  addText('v.usageSnapshotJson');
  // 中文任务名与步骤名：复用 team-task-labels 的同一份函数。
  addText('team_task_name(o.module, a.usage)');
  addText('team_task_step_name(o.module, o.step)');
  addText(`team_unified_media_name(${source.unifiedModel})`);
  if (needle) ensureTaskSearchFunctions(db);
  parts.push(`EXISTS (
    SELECT 1 FROM execution_attempts sa
    WHERE sa.operationId = o.id
      AND (instr(lower(COALESCE(sa.providerSnapshotJson, '')), ?) > 0
        OR instr(lower(COALESCE(sa.pricingSnapshotJson, '')), ?) > 0)
  )`);
  values.push(needle, needle);
  for (const column of ['id', 'code'] as const) {
    parts.push(`instr(lower(COALESCE((
      SELECT e.${column} FROM team_error_records e
      WHERE e.operationId = o.id ORDER BY e.createdAt DESC LIMIT 1
    ), '')), ?) > 0`);
    values.push(needle);
  }
  parts.push(`instr(lower(COALESCE((
    SELECT sa.errorCode FROM execution_attempts sa
    WHERE sa.operationId = o.id AND sa.errorCode IS NOT NULL
    ORDER BY sa.createdAt DESC, sa.transportSeq DESC LIMIT 1
  ), '')), ?) > 0`);
  values.push(needle);
  return { parts, values };
}

/**
 * 解析授权 + 筛选条件。
 *
 * 授权（`o.actorId`）永远是第一个条件：员工只能看本人，管理员可看全员或按成员筛选，
 * 员工指定别人的 `actorUserId` 直接 403。计数、选页、搜索、聚合都从这里取条件，
 * 不另写一套可见范围。
 */
function resolveTaskScope(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamTaskListFilters,
): ResolvedTaskScope {
  if (viewer.role !== 'admin' && filters.actorUserId && filters.actorUserId !== viewer.userId) {
    throw new TeamUsageError(403, 'task_query_forbidden', '只能查询本人的任务。');
  }
  const actorUserId = viewer.role === 'admin' ? filters.actorUserId : viewer.userId;
  const authClauses: string[] = [];
  const authValues: unknown[] = [];
  if (actorUserId) { authClauses.push('o.actorId = ?'); authValues.push(actorUserId); }
  const source = taskQueryShape(db).source;
  const matchClauses = [...authClauses];
  const matchValues = [...authValues];

  const needle = (filters.q ?? '').trim().toLowerCase();
  if (needle) {
    const search = buildSearchConditions(db, source, needle);
    matchClauses.push(`(${search.parts.join(' OR ')})`);
    matchValues.push(...search.values);
  }
  return {
    db,
    source,
    joins: source.joins,
    groupId: source.groupId,
    effectiveStatus: source.effectiveStatus,
    authWhere: authClauses.join(' AND '),
    authValues,
    matchWhere: matchClauses.join(' AND '),
    matchValues,
    status: filters.status,
  };
}

function selectTaskRows(
  scope: ResolvedTaskScope,
  where: string,
  values: unknown[],
  options: { order?: string; limit?: number } = {},
): TaskRow[] {
  const fields = taskQueryShape(scope.db).fields;
  const sql = `SELECT ${fields} FROM ${scope.joins}${where ? ` WHERE ${where}` : ''}${options.order ? ` ORDER BY ${options.order}` : ''}${options.limit ? ' LIMIT ?' : ''}`;
  return (options.limit
    ? scope.db.prepare(sql).all(...values, options.limit)
    : scope.db.prepare(sql).all(...values)) as TaskRow[];
}

function andWhere(...clauses: Array<string | undefined>): string {
  return clauses.filter((clause): clause is string => Boolean(clause)).join(' AND ');
}

/**
 * 先按授权 + 筛选 + 搜索挑出**制作任务组 ID**，再取这些组的分页位置。
 *
 * `scoped` 只含授权后的可见记录（决定组的最新时间与组内记录条数），`matched` 是
 * 授权 + 关键词命中的记录（决定哪些组进入结果）。关键词命中组内任一记录即保留整组。
 * 状态使用该组按 updatedAt DESC、operationId DESC 排序的代表记录，与列表显示一致。
 */
function taskGroupStatsSql(scope: ResolvedTaskScope): { sql: string; values: unknown[] } {
  const scopedWhere = scope.authWhere ? `WHERE ${scope.authWhere}` : '';
  const matchedWhere = scope.matchWhere ? `WHERE ${scope.matchWhere}` : '';
  const values = [...scope.authValues, ...scope.matchValues];
  const representativeStatus = scope.status
    ? `, FIRST_VALUE(${scope.effectiveStatus}) OVER (
        PARTITION BY ${scope.groupId} ORDER BY o.updatedAt DESC, o.id DESC
      ) AS representativeStatus`
    : '';
  const statusWhere = scope.status ? 'WHERE s.representativeStatus = ?' : '';
  if (scope.status) values.push(scope.status);
  return {
    values,
    sql: `
      WITH scoped AS (
        SELECT ${scope.groupId} AS groupId, o.updatedAt AS updatedAt${representativeStatus}
        FROM ${scope.joins} ${scopedWhere}
      ),
      matched AS (
        SELECT DISTINCT ${scope.groupId} AS groupId
        FROM ${scope.joins} ${matchedWhere}
      ),
      group_stats AS (
        SELECT s.groupId AS groupId, MAX(s.updatedAt) AS groupUpdatedAt, COUNT(*) AS recordCount
        FROM scoped s JOIN matched m ON m.groupId = s.groupId
        ${statusWhere}
        GROUP BY s.groupId
      )`,
  };
}

function taskGroupTotals(scope: ResolvedTaskScope): { groups: number; records: number } {
  const stats = taskGroupStatsSql(scope);
  const row = scope.db.prepare(`${stats.sql}
    SELECT COUNT(*) AS totalGroups, COALESCE(SUM(recordCount), 0) AS totalRecords FROM group_stats`)
    .get(...stats.values) as { totalGroups: number; totalRecords: number };
  return { groups: Number(row.totalGroups ?? 0), records: Number(row.totalRecords ?? 0) };
}

function taskPageGroupIds(
  scope: ResolvedTaskScope,
  page: { limit: number; offset: number },
): string[] {
  const stats = taskGroupStatsSql(scope);
  const rows = scope.db.prepare(`${stats.sql}
    SELECT groupId FROM group_stats
    ORDER BY groupUpdatedAt DESC, groupId DESC
    LIMIT ? OFFSET ?`).all(...stats.values, page.limit, page.offset) as Array<{ groupId: string }>;
  return rows.map((row) => String(row.groupId));
}

function compareRecordDescending(left: TaskRow, right: TaskRow): number {
  const leftTime = String(left.updatedAt ?? '');
  const rightTime = String(right.updatedAt ?? '');
  if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1;
  const leftId = String(left.operationId ?? '');
  const rightId = String(right.operationId ?? '');
  if (leftId === rightId) return 0;
  return leftId < rightId ? 1 : -1;
}

function selectPageRecords(scope: ResolvedTaskScope, groupIds: readonly string[]): TaskRow[] {
  if (groupIds.length === 0) return [];
  const fields = taskQueryShape(scope.db).fields;
  const sql = `
    WITH scoped AS (
      SELECT ${fields}, ${scope.source.groupId} AS groupId
      FROM ${scope.joins}${scope.authWhere ? ` WHERE ${scope.authWhere}` : ''}
    )
    SELECT * FROM scoped
    WHERE groupId IN (${groupIds.map(() => '?').join(',')})`;
  const rows = scope.db.prepare(sql).all(...scope.authValues, ...groupIds) as TaskRow[];
  const groupOrder = new Map(groupIds.map((groupId, index) => [groupId, index]));
  return rows.sort((left, right) => {
    const groupDelta = (groupOrder.get(String(left.groupId)) ?? 0) - (groupOrder.get(String(right.groupId)) ?? 0);
    if (groupDelta !== 0) return groupDelta;
    return compareRecordDescending(left, right);
  });
}

function attemptRowsFor(db: Database.Database, operationIds: readonly string[]): Array<AttemptRow & { pricingSnapshotJson: string | null }> {
  if (operationIds.length === 0) return [];
  return db.prepare(`
    SELECT a.operationId, a.id AS attemptId, a.providerSnapshotJson, a.pricingSnapshotJson,
      a.submissionState, a.createdAt
    FROM execution_attempts a
    WHERE a.operationId IN (${operationIds.map(() => '?').join(',')})
    ORDER BY a.createdAt, a.transportSeq, a.id
  `).all(...operationIds) as Array<AttemptRow & { pricingSnapshotJson: string | null }>;
}

/**
 * 把执行记录行投影成页面/详情使用的 `TeamTaskView`：
 * 冻结的模型调用事实、员工脱敏、取消/回队归一、统一任务费用（按 mediaTaskId 定向）。
 */
function projectTaskRows(db: Database.Database, viewer: TeamViewer, rows: readonly TaskRow[]): TeamTaskView[] {
  if (rows.length === 0) return [];
  const items = rows.map((row) => ({ ...row }));
  const attempts = attemptRowsFor(db, items.map((item) => String(item.operationId)));
  const attemptsByOperation = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const group = attemptsByOperation.get(attempt.operationId) ?? [];
    group.push(attempt);
    attemptsByOperation.set(attempt.operationId, group);
  }
  // 统一任务费用/通道计数：只按本页实际出现的 mediaTaskId 定向查询（不再取最近 500 个统一任务
  // 做 Map，也不靠可能重名的业务 taskId 关联）。
  const mediaTaskIds = [...new Set(items
    .map((item) => (typeof item.unifiedTaskId === 'string' ? item.unifiedTaskId.trim() : ''))
    .filter((value): value is string => Boolean(value)))];
  const unifiedByMediaTaskId = queryUnifiedTaskUsageByMediaTaskIds(db, viewer, mediaTaskIds);
  // 同一批记录常常属于同一个发起人：生效并发上限按人算一次，不在每条记录上重查策略表。
  const concurrencyByActor = new Map<string, number | null>();
  const effectiveConcurrency = (actorUserId: string): number | null => {
    if (!concurrencyByActor.has(actorUserId)) {
      concurrencyByActor.set(actorUserId, readActorPolicy(db, actorUserId).effectiveConcurrency);
    }
    return concurrencyByActor.get(actorUserId) ?? null;
  };
  return items.map((item): TeamTaskView => {
    // 展示、状态筛选与总览计数共用 SQL 的有效状态，避免通道失败被再次投影成排队。
    const isCanceled = item.effectiveStatus === 'canceled';
    const requeued = item.status === 'failed' && item.effectiveStatus === 'pending';
    const moduleLabel = teamTaskNameLabel(String(item.module), typeof item.imageUsage === 'string' ? item.imageUsage : null);
    const scopeName = item.scopeType === 'canvas'
      ? typeof item.canvasName === 'string' ? item.canvasName : ''
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
    const unifiedAggregate = unifiedTaskId ? unifiedByMediaTaskId.get(unifiedTaskId) : undefined;
    const visibleModelCalls = unifiedDisplay && viewer.role !== 'admin'
      ? modelCalls.map((call) => ({
        ...call,
        providerName: unifiedDisplay,
        model: unifiedDisplay,
      }))
      : modelCalls;
    const admissionPriority = viewer.role === 'admin'
      && item.admissionPriority !== null && item.admissionPriority !== undefined
      && Number.isFinite(Number(item.admissionPriority))
      ? Number(item.admissionPriority)
      : null;
    const admissionCandidateCount = viewer.role === 'admin'
      && item.admissionCandidateCount !== null && item.admissionCandidateCount !== undefined
      && Number.isFinite(Number(item.admissionCandidateCount))
      ? Number(item.admissionCandidateCount)
      : null;
    const admissionTrace = viewer.role === 'admin' ? jsonObject(item.admissionTraceJson) : null;
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
          : taskWaitLabel(item.waitReason as string | null, effectiveConcurrency(String(item.actorUserId))),
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
        ? { providerName: unifiedDisplay, model: unifiedDisplay, modelStatus: 'recorded' }
        : display),
      unifiedModel,
      unifiedTaskId,
      unifiedTaskCostMinor: unifiedAggregate?.chargedMinor ?? 0,
      unifiedTaskCostStatus: unifiedAggregate?.costStatus ?? null,
      unifiedTaskAttemptCount: unifiedAggregate?.channelCallCount ?? 0,
      unifiedTaskChannelCount: unifiedAggregate?.usedChannelCount ?? 0,
      admissionPriority,
      admissionCandidateCount,
      admissionTrace,
      modelCalls: visibleModelCalls,
    };
  });
}

/**
 * 任务列表（`GET /api/team/tasks` 的唯一实现）。
 *
 * 分页单位是**制作任务组**：先按授权 + 筛选 + 搜索选出完整组 ID，再取该页所有组内的
 * 执行记录；因此一页 25 个制作任务可以返回多于 25 条执行记录，且同一组不会跨页重复。
 */
export function listTeamTasks(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamTaskListFilters = {},
  pageInput: TeamPageParamInput | TeamPageRequest = {},
): TeamTaskListResult {
  const request = parseTeamPage({ page: pageInput.page, pageSize: pageInput.pageSize });
  const run = db.transaction(() => {
    const scope = resolveTaskScope(db, viewer, filters);
    const totals = taskGroupTotals(scope);
    const { pagination, offset } = resolveTeamPage(request, totals.groups);
    const groupIds = taskPageGroupIds(scope, { limit: pagination.pageSize, offset });
    const rows = selectPageRecords(scope, groupIds);
    return {
      items: projectTaskRows(db, viewer, rows),
      localAgentIncluded: false as const,
      pagination,
      totalRecords: totals.records,
    };
  });
  return run.deferred();
}

/**
 * 全可见范围的任务计数（侧栏角标、总览分母）。
 *
 * 不接状态/关键词：角标与总览表示「全可见范围」。`records` 是执行记录数（侧栏口径），
 * `tasks` 是制作任务组数；两者都由同一份授权条件算出，不加载明细。
 */
export function countTeamTasks(
  db: Database.Database,
  viewer: TeamViewer,
  filters: { actorUserId?: string } = {},
): { tasks: number; records: number } {
  const scope = resolveTaskScope(db, viewer, { actorUserId: filters.actorUserId });
  const row = scope.db.prepare(`
    WITH scoped AS (
      SELECT ${scope.groupId} AS groupId FROM ${scope.joins}${scope.authWhere ? ` WHERE ${scope.authWhere}` : ''}
    )
    SELECT COUNT(*) AS records, COUNT(DISTINCT groupId) AS tasks FROM scoped
  `).get(...scope.authValues) as { records: number; tasks: number };
  return { tasks: Number(row.tasks ?? 0), records: Number(row.records ?? 0) };
}

/**
 * 按 operationId 直接查一条任务（详情接口、重试入口）。
 *
 * 与列表同一份授权与投影，但**不受 page/q/status 限制**：500 条之外、当前筛选之外的
 * 合法任务都能打开；员工查别人的返回 null（路由按 404 处理，不泄露存在性）。
 */
export function findTeamTask(
  db: Database.Database,
  viewer: TeamViewer,
  operationId: string,
): TeamTaskView | null {
  const normalized = typeof operationId === 'string' ? operationId.trim() : '';
  if (!normalized) return null;
  const scope = resolveTaskScope(db, viewer, {});
  const rows = selectTaskRows(scope, andWhere(scope.authWhere, 'o.id = ?'), [...scope.authValues, normalized]);
  return projectTaskRows(db, viewer, rows)[0] ?? null;
}

/** 有界最近任务（运行总览的「最近任务」表）：按执行记录更新时间倒序，不加载全量。 */
export function listRecentTeamTasks(
  db: Database.Database,
  viewer: TeamViewer,
  limit = 12,
): { items: TeamTaskView[] } {
  const bounded = Math.max(1, Math.min(Math.trunc(limit) || 12, 50));
  const scope = resolveTaskScope(db, viewer, {});
  const rows = selectTaskRows(scope, scope.authWhere, scope.authValues, {
    order: 'o.updatedAt DESC, o.id DESC',
    limit: bounded,
  });
  return { items: projectTaskRows(db, viewer, rows) };
}

/**
 * 有界记录查询（员工首页「正在生产」）：按**有效状态**筛选，返回总数与有界列表。
 * 不套用分页列表：调用方拿 `total` 显示条数，用 `items` 显示前几条。
 */
export function listTeamTaskRecords(
  db: Database.Database,
  viewer: TeamViewer,
  options: TeamTaskRecordQuery = {},
): { items: TeamTaskView[]; total: number } {
  const bounded = Math.max(1, Math.min(Math.trunc(options.limit ?? 12) || 12, 100));
  const scope = resolveTaskScope(db, viewer, { actorUserId: options.actorUserId });
  const statuses = (options.statuses ?? []).filter((status) => typeof status === 'string' && status.trim())
    .map((status) => status.trim());
  const statusWhere = statuses.length > 0
    ? `${scope.effectiveStatus} IN (${statuses.map(() => '?').join(',')})`
    : undefined;
  const where = andWhere(scope.authWhere, statusWhere);
  const values = [...scope.authValues, ...statuses];
  const total = Number(scope.db.prepare(`SELECT COUNT(*) FROM ${scope.joins}${where ? ` WHERE ${where}` : ''}`)
    .pluck().get(...values) ?? 0);
  const rows = selectTaskRows(scope, where, values, {
    order: 'o.updatedAt DESC, o.id DESC',
    limit: bounded,
  });
  return { items: projectTaskRows(db, viewer, rows), total };
}

export interface TeamTaskActivityCounts {
  total: number;
  running: number;
  queued: number;
  completedToday: number;
  failed: number;
  canceled: number;
}

export interface TeamTaskActivityMember {
  actorUserId: string;
  employeeId: string;
  displayName: string;
  running: number;
  queued: number;
  completedToday: number;
  failed: number;
}

/**
 * 运行总览的独立聚合：按执行记录的**有效状态**分桶（口径来自
 * `lib/team-console-overview.ts` 的 `CONSOLE_STATUS_BUCKETS` 唯一映射），
 * 在 SQL 里按成员 + 桶计数，不把全量任务行渲染成对象。
 */
export function readTeamTaskActivity(
  db: Database.Database,
  viewer: TeamViewer,
  now: Date = new Date(),
): { counts: TeamTaskActivityCounts; members: TeamTaskActivityMember[] } {
  const scope = resolveTaskScope(db, viewer, {});
  const bucketCase = `CASE ${scope.effectiveStatus} ${Object.entries(CONSOLE_STATUS_BUCKETS)
    .map(([status, bucket]) => `WHEN '${status}' THEN '${bucket}'`).join(' ')} ELSE 'queued' END`;
  const rows = scope.db.prepare(`
    WITH scoped AS (
      SELECT o.actorId AS actorUserId, u.employeeId AS employeeId, u.displayName AS displayName,
        ${bucketCase} AS bucket, o.updatedAt AS updatedAt
      FROM ${scope.joins}${scope.authWhere ? ` WHERE ${scope.authWhere}` : ''}
    )
    SELECT actorUserId, employeeId, displayName, bucket, COUNT(*) AS records,
      SUM(CASE WHEN date(updatedAt, '+8 hours') = ? THEN 1 ELSE 0 END) AS completedToday
    FROM scoped
    GROUP BY actorUserId, employeeId, displayName, bucket
  `).all(...scope.authValues, shanghaiDateKey(now)) as Array<{
    actorUserId: string; employeeId: string; displayName: string; bucket: string;
    records: number; completedToday: number;
  }>;
  const counts: TeamTaskActivityCounts = { total: 0, running: 0, queued: 0, completedToday: 0, failed: 0, canceled: 0 };
  const members = new Map<string, TeamTaskActivityMember>();
  for (const row of rows) {
    const records = Number(row.records ?? 0);
    counts.total += records;
    const member = members.get(row.actorUserId) ?? {
      actorUserId: row.actorUserId, employeeId: row.employeeId, displayName: row.displayName,
      running: 0, queued: 0, completedToday: 0, failed: 0,
    };
    if (row.bucket === 'running') {
      counts.running += records;
      member.running += records;
    } else if (row.bucket === 'queued') {
      counts.queued += records;
      member.queued += records;
    } else if (row.bucket === 'failed') {
      counts.failed += records;
      member.failed += records;
    } else if (row.bucket === 'succeeded') {
      const today = Number(row.completedToday ?? 0);
      counts.completedToday += today;
      member.completedToday += today;
    } else if (row.bucket === 'canceled') {
      counts.canceled += records;
    }
    members.set(row.actorUserId, member);
  }
  return { counts, members: [...members.values()] };
}

/** 发起人筛选选项：当前可见范围里出现过任务的成员（不额外开用户列表接口）。 */
export function listTeamTaskActors(
  db: Database.Database,
  viewer: TeamViewer,
): Array<{ id: string; employeeId: string; displayName: string }> {
  const scope = resolveTaskScope(db, viewer, {});
  return scope.db.prepare(`
    SELECT u.id AS id, u.employeeId AS employeeId, u.displayName AS displayName
    FROM ${scope.joins}${scope.authWhere ? ` WHERE ${scope.authWhere}` : ''}
    GROUP BY u.id, u.employeeId, u.displayName
    ORDER BY u.employeeId
  `).all(...scope.authValues) as Array<{ id: string; employeeId: string; displayName: string }>;
}
