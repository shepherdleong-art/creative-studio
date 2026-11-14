/**
 * 控制台「运行总览」与「全员任务」的纯视图模型（12 号票）。
 *
 * 这里是数量卡、最近任务行、今天的成员、名额占用、开工前清单和只读服务器默认值的**唯一**
 * 计算口径：服务端接口用它组装响应，前端只负责渲染，测试直接断言这些函数。
 *
 * 纯数据 + 纯函数，不 import React/Next/SQLite，可被 Node 测试直接跑。
 * 计划与验收依据：`docs/superpowers/plans/2026-11-07-林视界面重设计/12-运行总览和全员任务.md`。
 */

import { taskStatusLabel, taskOccupancyLabel } from './team-task-labels.ts';

/** 任务列表里本文件用到的字段；与 `lib/team-service/tasks.ts` 的投影保持同形。 */
export interface ConsoleTaskLike {
  operationId: string;
  module: string;
  taskId: string;
  taskName: string;
  stepName: string;
  scopeName: string;
  scope: { resourceType: string; resourceId: string };
  status: string;
  concurrencyReleased?: boolean;
  actorUserId: string;
  employeeId: string;
  actorDisplayName: string;
  model: string | null;
  providerName: string;
  modelStatus: string;
  createdAt: string;
  updatedAt: string;
  errorId: string | null;
  errorStage?: string | null;
  errorCode?: string | null;
}

/**
 * 状态 → 数量卡口径。**这是唯一映射表**：
 * `TASK_STATUS_LABELS` 的每种状态一个不少、互不重叠（单测逐条钉住）。
 *
 * - `running`：已经占住名额、供应商正在处理（准备发送/提交中/已受理/核查结果中）。
 * - `queued`：还没占名额（排队中 / 等待运行条件）。
 * - `succeeded`：成功；进「今天已完成」时还要按完成时间（updatedAt）落在中国时区的今天。
 * - `failed`：失败与提交结果待核查——两者都需要管理员介入。
 * - `canceled`：已取消，不算跑、不算排队、也不算错，不占任何一张数量卡。
 */
export type ConsoleTaskBucket = 'running' | 'queued' | 'succeeded' | 'failed' | 'canceled';

export const CONSOLE_STATUS_BUCKETS: Readonly<Record<string, ConsoleTaskBucket>> = Object.freeze({
  routing: 'queued',
  waiting: 'queued',
  pending: 'queued',
  deferred: 'queued',
  admitted: 'running',
  maybe_sent: 'running',
  accepted: 'running',
  reconciling: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  unknown: 'failed',
  canceled: 'canceled',
});

/** 未知状态按「排队」处理：宁可少报在跑，也不要把它算成已完成或出错。 */
export function consoleTaskBucket(status: string): ConsoleTaskBucket {
  return CONSOLE_STATUS_BUCKETS[status] ?? 'queued';
}

export interface ConsoleTaskCounts {
  running: number;
  queued: number;
  completedToday: number;
  failed: number;
  total: number;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 中国时区（固定 UTC+8，无夏令时）的 `YYYY-MM-DD`。 */
export function shanghaiDateKey(value: Date | string): string {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  return new Date(time + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 中国时区的 `MM-DD HH:mm`，用于最近任务表的「时间」列。 */
export function shanghaiTimeLabel(value: Date | string): string {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const shifted = new Date(time + SHANGHAI_OFFSET_MS).toISOString();
  return `${shifted.slice(5, 10)} ${shifted.slice(11, 16)}`;
}

/**
 * 数量卡：正在跑、在排队、今天已完成、出错。
 *
 * 「今天已完成」用完成时间（`updatedAt`）落在北京时间今天判断——跨零点重跑的旧任务
 * 不会凭空算进今天的成果。
 */
export function consoleTaskCounts(
  tasks: readonly ConsoleTaskLike[],
  now: Date = new Date(),
): ConsoleTaskCounts {
  const today = shanghaiDateKey(now);
  const counts: ConsoleTaskCounts = { running: 0, queued: 0, completedToday: 0, failed: 0, total: tasks.length };
  for (const task of tasks) {
    switch (consoleTaskBucket(task.status)) {
      case 'running': counts.running += 1; break;
      case 'queued': counts.queued += 1; break;
      case 'failed': counts.failed += 1; break;
      case 'succeeded': if (shanghaiDateKey(task.updatedAt) === today) counts.completedToday += 1; break;
      case 'canceled': break;
    }
  }
  return counts;
}

export type ConsoleTagTone = 'ok' | 'warn' | 'fail' | 'run' | 'idle';

const BUCKET_TONES: Readonly<Record<ConsoleTaskBucket, ConsoleTagTone>> = Object.freeze({
  running: 'run', queued: 'idle', succeeded: 'ok', failed: 'fail', canceled: 'idle',
});

export function consoleTaskTone(status: string): ConsoleTagTone {
  return BUCKET_TONES[consoleTaskBucket(status)];
}

/** 任务详情链接的唯一形态：`/team/tasks?taskId=<operationId>`（总览行、错误中心、其他页共用）。 */
export function taskDetailHref(operationId: string): string {
  return `/team/tasks?taskId=${encodeURIComponent(operationId)}`;
}

export interface ConsoleTaskRow {
  operationId: string;
  taskLabel: string;
  stepName: string;
  projectName: string;
  actorName: string;
  employeeId: string;
  modelLabel: string;
  status: string;
  statusLabel: string;
  occupancyLabel: string;
  tone: ConsoleTagTone;
  timeLabel: string;
  href: string;
}

/** 模型列的展示口径：有实际模型写模型，未记录/不适用照实说，不猜。 */
export function consoleModelLabel(task: Pick<ConsoleTaskLike, 'model' | 'modelStatus'>): string {
  if (task.model?.trim()) return task.model;
  if (task.modelStatus === 'not_applicable') return '本地处理';
  if (task.modelStatus === 'pending') return '待调用';
  if (task.modelStatus === 'undetermined') return '待确定';
  return '未记录';
}

export const RECENT_TASK_LIMIT = 12;

/** 最近任务表：按更新时间倒序，最多 `limit` 条；每行自带详情链接。 */
export function recentConsoleTasks(
  tasks: readonly ConsoleTaskLike[],
  now: Date = new Date(),
  limit: number = RECENT_TASK_LIMIT,
): ConsoleTaskRow[] {
  void now;
  const sorted = [...tasks].sort((left, right) => {
    const difference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return Number.isFinite(difference) && difference !== 0 ? difference : right.operationId.localeCompare(left.operationId);
  });
  return sorted.slice(0, Math.max(0, limit)).map(task => ({
    operationId: task.operationId,
    taskLabel: task.taskName,
    stepName: task.stepName,
    projectName: task.scopeName,
    actorName: task.actorDisplayName,
    employeeId: task.employeeId,
    modelLabel: consoleModelLabel(task),
    status: task.status,
    statusLabel: taskStatusLabel(task),
    occupancyLabel: taskOccupancyLabel(task),
    tone: taskOccupancyLabel(task) ? 'idle' : consoleTaskTone(task.status),
    timeLabel: shanghaiTimeLabel(task.updatedAt),
    href: taskDetailHref(task.operationId),
  }));
}

export interface ConsoleMemberRow {
  actorUserId: string;
  displayName: string;
  employeeId: string;
  running: number;
  queued: number;
  completedToday: number;
  failed: number;
  /** 「3 条在产，1 处出错」这类一句话。 */
  summary: string;
}

/** 今天的成员：谁在做什么。按「在产 → 排队 → 出错」排序，再按工号稳定排序。 */
export function consoleMemberActivity(
  tasks: readonly ConsoleTaskLike[],
  now: Date = new Date(),
): ConsoleMemberRow[] {
  const today = shanghaiDateKey(now);
  const byActor = new Map<string, Omit<ConsoleMemberRow, 'summary'>>();
  for (const task of tasks) {
    const row = byActor.get(task.actorUserId) ?? {
      actorUserId: task.actorUserId, displayName: task.actorDisplayName, employeeId: task.employeeId,
      running: 0, queued: 0, completedToday: 0, failed: 0,
    };
    switch (consoleTaskBucket(task.status)) {
      case 'running': row.running += 1; break;
      case 'queued': row.queued += 1; break;
      case 'failed': row.failed += 1; break;
      case 'succeeded': if (shanghaiDateKey(task.updatedAt) === today) row.completedToday += 1; break;
      case 'canceled': break;
    }
    byActor.set(task.actorUserId, row);
  }
  return consoleMemberRows([...byActor.values()]);
}

/**
 * 把「按成员已有的分桶计数」排成总览行并补一句话说明。
 *
 * 纯函数，服务端独立聚合（`readTeamTaskActivity`）拿到分桶计数后直接复用它，
 * 与逐条任务计算的 `consoleMemberActivity` 共用同一套排序和摘要文案。
 */
export function consoleMemberRows(
  rows: readonly Omit<ConsoleMemberRow, 'summary'>[],
): ConsoleMemberRow[] {
  return rows
    .map(row => ({ ...row, summary: memberSummary(row) }))
    .sort((left, right) =>
      (right.running - left.running)
      || (right.queued - left.queued)
      || (right.failed - left.failed)
      || left.employeeId.localeCompare(right.employeeId));
}

function memberSummary(row: Omit<ConsoleMemberRow, 'summary'>): string {
  const parts: string[] = [];
  if (row.running > 0) parts.push(`${row.running} 条在产`);
  if (row.queued > 0) parts.push(`${row.queued} 条排队`);
  if (row.failed > 0) parts.push(`${row.failed} 处出错`);
  if (row.completedToday > 0) parts.push(`今天完成 ${row.completedToday} 条`);
  return parts.length > 0 ? parts.join('，') : '今天还没有任务';
}

export interface ConsolePoolOccupancy {
  poolKey: string;
  capacity: number;
  held: number;
  accepted: number;
  maybeSent: number;
  notSent: number;
  activeMembers: Array<{ actorId: string; held: number; pending: number; running: number }>;
}

export interface ConsolePoolRow extends ConsolePoolOccupancy {
  label: string;
  used: number;
  percent: number;
  /** 名额全在用满时给出人话说明，不把 100% 说成故障。 */
  hint: string;
}

/** 名额占用：一个池一行，`used` 与界面上「已占 / 名额」使用同一口径。 */
export function poolOccupancyRows(pools: readonly ConsolePoolOccupancy[]): ConsolePoolRow[] {
  return pools.map(pool => {
    const used = Math.max(0, pool.held);
    const percent = pool.capacity > 0 ? Math.min(100, Math.round((used / pool.capacity) * 100)) : 0;
    return {
      ...pool,
      label: pool.poolKey,
      used,
      percent,
      hint: pool.capacity <= 0
        ? '还没设名额'
        : used >= pool.capacity
          ? '名额已用满，新任务排队'
          : `还能再跑 ${Math.max(0, pool.capacity - used)} 条`,
    };
  }).sort((left, right) => left.label.localeCompare(right.label));
}

export type SetupState = 'ok' | 'action' | 'unknown';

export interface SetupChecklistItem {
  key: 'company-proxy' | 'cos-relay' | 'model-pools';
  label: string;
  state: SetupState;
  /** 一句话状态（已就绪 / 还没配置 / 3 项待处理）。 */
  detail: string;
  /** 去处：点这行去哪个页面处理。 */
  href: string;
  actionLabel: string;
  /** 处理事项的可读列表（名额池 blocker 等）。 */
  reasons: string[];
}

export interface SetupChecklist {
  items: SetupChecklistItem[];
  /** 三件事都就绪时为 true：界面显示「已就绪」或收起。 */
  ready: boolean;
  /** 还差几件；ready 时为 0。 */
  pendingCount: number;
  title: string;
}

/** 与 `SetupChecklist` 同形；`lib/team-service/**` 里以 `ConsoleSetupChecklist` 名引用。 */
export type ConsoleSetupChecklist = SetupChecklist;

export interface ConsoleSetupInput {
  /** 公司模型代理是否可用；未取到时传 null（显示「没读到状态」，不算通过）。 */
  proxyAvailable: boolean | null;
  /** 参考图中转 COS 是否配置。 */
  cosConfigured: boolean | null;
  /** `/api/team/pools` 的 ready。 */
  poolsReady: boolean | null;
  /** `/api/team/pools` 的 blockers。 */
  poolBlockers?: readonly string[];
  /** 已启用的名额池数量，用于「已就绪」时的说明。 */
  enabledPools?: number;
}

/**
 * 「开工前还差几件事」：公司模型代理、参考图中转、模型名额。
 *
 * 每一项都必须写清**状态和去处**；数据全部来自现有就绪检查（`/api/company-provider/health`
 * 的 `proxyAvailable`/`cosConfigured` + `/api/team/pools` 的 `ready`/`blockers`），
 * 这里不另外探测任何东西。
 */
export function consoleSetupChecklist(input: ConsoleSetupInput): SetupChecklist {
  const blockers = [...(input.poolBlockers ?? [])].filter(blocker => blocker.trim());
  const proxy: SetupChecklistItem = {
    key: 'company-proxy',
    label: '公司模型代理',
    state: input.proxyAvailable === null ? 'unknown' : input.proxyAvailable ? 'ok' : 'action',
    detail: input.proxyAvailable === null ? '没读到状态' : input.proxyAvailable ? '已就绪' : '未连接',
    href: '/settings',
    actionLabel: '去配置供应商',
    reasons: input.proxyAvailable === false ? ['公司模型暂时不可用，员工只能用已配置的外部供应商'] : [],
  };
  const cos: SetupChecklistItem = {
    key: 'cos-relay',
    label: '参考图中转',
    state: input.cosConfigured === null ? 'unknown' : input.cosConfigured ? 'ok' : 'action',
    detail: input.cosConfigured === null ? '没读到状态' : input.cosConfigured ? '已配置' : '未配置',
    href: '/settings',
    actionLabel: '查看供应商配置',
    reasons: input.cosConfigured === false ? ['参考图要经腾讯云 COS 中转才能发公司模型；由部署人员在服务器配置中填写'] : [],
  };
  const pools: SetupChecklistItem = {
    key: 'model-pools',
    label: '模型名额',
    state: input.poolsReady === null ? 'unknown' : input.poolsReady ? 'ok' : 'action',
    detail: input.poolsReady === null
      ? '没读到状态'
      : input.poolsReady
        ? `${input.enabledPools && input.enabledPools > 0 ? `${input.enabledPools} 个名额池可用` : '已就绪'}`
        : `${blockers.length} 项待处理`,
    href: '/team/admin/pools',
    actionLabel: '去设名额',
    reasons: blockers,
  };
  const items = [proxy, cos, pools];
  const pendingCount = items.filter(item => item.state !== 'ok').length;
  return {
    items,
    ready: pendingCount === 0,
    pendingCount,
    title: pendingCount === 0 ? '开工前都准备好了' : `开工前还差 ${pendingCount} 件事`,
  };
}

export interface ConsoleProductionDefaults {
  timeoutMs: number;
  projectConcurrency: number;
  videoConcurrency?: number;
  concurrencyMode?: 'shared-pool';
  imagePreprocess?: { enabled: boolean; targetMaxSide: number; jpegQuality: number };
}

export interface ConsoleDefaultsRow {
  label: string;
  value: string;
  hint: string;
}

export interface ConsoleDefaultsView {
  available: boolean;
  rows: ConsoleDefaultsRow[];
  note: string;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 服务器默认参数的**只读**视图（用户已确认：控制台只读显示，不做修改界面）。
 *
 * 数据源是 06 号票写进服务器运行配置的 `productionDefaults`。本函数对对象做形状校验后
 * 才渲染，缺失字段不猜、不补默认值（避免把「没接上」显示成「已生效」）。
 * 06 尚未合并时 `available` 为 false，界面整块收起。
 */
export function consoleDefaultsView(source: unknown): ConsoleDefaultsView {
  const value = source && typeof source === 'object' ? source as Record<string, unknown> : null;
  const preprocessRaw = value?.imagePreprocess && typeof value.imagePreprocess === 'object'
    ? value.imagePreprocess as Record<string, unknown>
    : null;
  if (!value || !isFinitePositive(value.timeoutMs) || !isFinitePositive(value.projectConcurrency)) {
    return { available: false, rows: [], note: '服务器默认值尚未接入（等 06 号票的生产参数配置）。' };
  }
  const rows: ConsoleDefaultsRow[] = [
    {
      label: '任务超时',
      value: `${Math.round(value.timeoutMs / 60_000)} 分钟`,
      hint: `${value.timeoutMs} 毫秒，由服务器统一执行`,
    },
    {
      label: '项目并发',
      value: value.concurrencyMode === 'shared-pool' ? '按名额池调度' : `${value.projectConcurrency} 条`,
      hint: value.concurrencyMode === 'shared-pool'
        ? '单项目可使用空闲名额，仍受成员规则和共享池容量约束'
        : '实际能同时跑几条仍受名额池和成员并发上限约束',
    },
  ];
  if (isFinitePositive(value.videoConcurrency)) {
    rows.push({
      label: '视频并发',
      value: value.concurrencyMode === 'shared-pool' ? '按名额池调度' : `${value.videoConcurrency} 条`,
      hint: value.concurrencyMode === 'shared-pool' ? '与图片共用对应上游池，按成员规则分配' : '由服务器统一执行',
    });
  }
  if (preprocessRaw && typeof preprocessRaw.enabled === 'boolean') {
    const size = isFinitePositive(preprocessRaw.targetMaxSide) ? `${preprocessRaw.targetMaxSide}px` : '沿用现有默认';
    const quality = isFinitePositive(preprocessRaw.jpegQuality) ? `JPEG ${preprocessRaw.jpegQuality}` : '沿用现有默认';
    rows.push({
      label: '图片预处理',
      value: preprocessRaw.enabled ? `开启 · 最长边 ${size} · ${quality}` : '关闭',
      hint: preprocessRaw.enabled ? '上传时按服务器默认值压缩' : '上传原图，不做压缩',
    });
  }
  return { available: true, rows, note: '服务器统一执行，员工看不到也改不了；这里只读展示。' };
}

export interface TaskRetryTarget {
  endpoint: string;
  label: string;
  hint: string;
}

/**
 * 任务重试的去处。
 *
 * 只对**明确失败**的图片/视频任务给重试入口：这两条是既有队列里已经验证过的重试路径
 * （`/api/jobs/[id]/retry`、`/api/video-jobs/[id]/retry`）。「提交结果待核查」不给重试——
 * 先核对结果再决定，避免重复扣费；其余模块到项目里重试，本函数如实说明。
 */
export function taskRetryTarget(task: Pick<ConsoleTaskLike, 'module' | 'taskId' | 'status'>): TaskRetryTarget | null {
  if (task.status !== 'failed') return null;
  const taskId = task.taskId;
  if (!taskId) return null;
  if (task.module === 'image') {
    return { endpoint: `/api/jobs/${encodeURIComponent(taskId)}/retry`, label: '重试这一步', hint: '重试只重新排队这一步，不会重复扣已完成的部分。' };
  }
  if (task.module === 'video') {
    return { endpoint: `/api/video-jobs/${encodeURIComponent(taskId)}/retry`, label: '重试这一步', hint: '重试沿用冻结的模型与提示词，不会换参数。' };
  }
  return null;
}

/** 任务详情链接里的 operationId（非法或空值返回 null，不抛错）。 */
export function taskIdFromQuery(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmed) ? trimmed : null;
}
