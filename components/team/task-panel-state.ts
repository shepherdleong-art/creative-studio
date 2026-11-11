/**
 * 全员任务 / 我的任务页的分页、搜索与分组展示逻辑（06 号票）。
 *
 * 与 `components/team/TeamTasksPanel.tsx` 分开，是为了让这些规则在 Node 里能直接断言：
 * 页面组件带 React/Next，`scripts/*.test.ts` 无法 import JSX；而「请求哪些参数、总数怎么
 * 写、分组是否只作用于当前页、筛选变化回第 1 页」正是验收要钉住的行为。
 *
 * 纯数据 + 纯函数：不 import React、浏览器或 SQLite。分页字段类型直接来自 03 号票的
 * 公共分页模块（相对带扩展名导入，Node 测试与 Next 构建都能解析），**不复制一份规则**。
 * 合同见 `outputs/2026-11-11-工作台版本标记与团队列表易用性/notes/03-pagination-contract.md`
 * 与 `notes/05-pagination-component.md`。
 */

import type { TeamPagination } from '../../lib/team-service/pagination.ts';

/** 搜索输入防抖：打字时约 300ms 后才发服务端请求，Enter 立即搜索。 */
export const TASK_SEARCH_DEBOUNCE_MS = 300;

/** 展示层用到的最小任务字段；`TeamTask` 结构上兼容它。 */
export interface TaskRowLike {
  operationId: string;
  unifiedTaskId: string | null;
  actorUserId: string;
  employeeId: string;
  actorDisplayName: string;
}

/** 一个制作任务（同 `unifiedTaskId` 的多条执行记录合并在 `items` 里）。 */
export interface TaskDisplayGroup<T extends TaskRowLike = TaskRowLike> {
  key: string;
  items: T[];
  representative: T;
}

/** 当前页里同一个发起人的制作任务。 */
export interface TaskActorGroup<T extends TaskRowLike = TaskRowLike> {
  actorUserId: string;
  displayName: string;
  employeeId: string;
  groups: TaskDisplayGroup<T>[];
}

export interface TaskMemberOption {
  id: string;
  employeeId: string;
  displayName: string;
}

export interface TaskListQuery {
  q?: string;
  status?: string;
  actorUserId?: string;
  page: number;
  pageSize: number;
}

/**
 * 同一制作任务的执行记录只展示一次（分页单位是制作任务，列表按组展示）。
 *
 * 输入顺序即服务端顺序（组内 `updatedAt DESC, operationId DESC`），所以第一条就是
 * 代表记录；这里不再排序，也不补数据。
 */
export function groupTeamTaskRows<T extends TaskRowLike>(items: readonly T[]): TaskDisplayGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.unifiedTaskId ? `unified:${item.unifiedTaskId}` : `operation:${item.operationId}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([key, groupedItems]) => ({
    key,
    items: groupedItems,
    representative: groupedItems[0] as T,
  }));
}

/**
 * 先分页、再按发起人分组：只重排传入的当前页制作任务，不额外选页、不按成员分别分页。
 * 组合计由 `groups.length` 得出（组标题「本页 N 项」）。
 */
export function groupPageByActor<T extends TaskRowLike>(
  groups: readonly TaskDisplayGroup<T>[],
): TaskActorGroup<T>[] {
  const byActor = new Map<string, TaskActorGroup<T>>();
  for (const group of groups) {
    const actor = group.representative;
    const bucket = byActor.get(actor.actorUserId);
    if (bucket) bucket.groups.push(group);
    else {
      byActor.set(actor.actorUserId, {
        actorUserId: actor.actorUserId,
        displayName: actor.actorDisplayName,
        employeeId: actor.employeeId,
        groups: [group],
      });
    }
  }
  return [...byActor.values()];
}

/** `GET /api/team/tasks` 的请求路径：关键词/状态/成员走服务端，分页参数永远携带。 */
export function taskListRequestPath(query: TaskListQuery): string {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  if (q) params.set('q', q);
  const status = query.status?.trim();
  if (status) params.set('status', status);
  const actorUserId = query.actorUserId?.trim();
  if (actorUserId) params.set('actorUserId', actorUserId);
  params.set('page', String(Math.max(1, Math.trunc(query.page) || 1)));
  params.set('pageSize', String(query.pageSize));
  return `/api/team/tasks?${params.toString()}`;
}

function finiteCount(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * 页面总数文案：读服务端 `pagination.total`（制作任务）与 `totalRecords`（执行记录），
 * **不用当前页数组长度**。
 */
export function taskTotalSummary(total: number, totalRecords: number): string {
  return `共 ${finiteCount(total)} 个制作任务，${finiteCount(totalRecords)} 条执行记录`;
}

export type TaskPageChange =
  | { kind: 'page'; page: number }
  | { kind: 'pageSize' }
  | { kind: 'filter' }
  | { kind: 'refresh' };

/**
 * 页码状态规则（功能方案第 5 节）：翻页只改页码；搜索/成员/状态/每页条数变化回第 1 页；
 * 手动刷新保留当前页（越界由响应 `pagination.page` 收敛）。
 */
export function taskPageAfterChange(current: number, change: TaskPageChange): number {
  switch (change.kind) {
    case 'page': {
      if (!Number.isFinite(change.page)) return Math.max(1, Math.trunc(current) || 1);
      return Math.max(1, Math.trunc(change.page));
    }
    case 'pageSize':
    case 'filter':
      return 1;
    case 'refresh':
      return Math.max(1, Math.trunc(current) || 1);
  }
}

/**
 * 管理员成员下拉：来自完整用户数据（`/api/team/users`），不是当前页去重。
 * 含停用成员——历史任务仍要能按成员筛选；按工号稳定排序，按 id 去重。
 */
export function memberOptionsFromUsers(
  users: readonly { id?: unknown; employeeId?: unknown; displayName?: unknown; [key: string]: unknown }[],
): TaskMemberOption[] {
  const seen = new Map<string, TaskMemberOption>();
  for (const user of users) {
    if (!user || typeof user.id !== 'string' || !user.id) continue;
    if (typeof user.employeeId !== 'string' || typeof user.displayName !== 'string') continue;
    if (!user.employeeId.trim() || !user.displayName.trim()) continue;
    if (seen.has(user.id)) continue;
    seen.set(user.id, { id: user.id, employeeId: user.employeeId, displayName: user.displayName });
  }
  return [...seen.values()].sort((left, right) => left.employeeId.localeCompare(right.employeeId));
}

export interface TaskListResponse<T extends TaskRowLike = TaskRowLike> {
  items: T[];
  pagination: TeamPagination;
  totalRecords: number;
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded >= 0 && Number.isSafeInteger(rounded) ? rounded : null;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = readNonNegativeInteger(value);
  return parsed !== null && parsed >= 1 ? parsed : null;
}

/**
 * 解析 `GET /api/team/tasks` 响应。
 *
 * 缺分页元数据或数值非法时**抛错**（界面显示错误 + 重试），不降级成「0 条」——失败不能
 * 伪装成空结果。页码以响应 `pagination.page` 为准：越界时服务端已归位，调用方只同步一次。
 */
export function readTaskListResponse<T extends TaskRowLike>(body: unknown): TaskListResponse<T> {
  if (!body || typeof body !== 'object') throw new Error('团队任务响应格式无效。');
  const value = body as { items?: unknown; pagination?: unknown; totalRecords?: unknown };
  if (!Array.isArray(value.items)) throw new Error('团队任务响应缺少任务列表。');
  const rawPagination = value.pagination;
  if (!rawPagination || typeof rawPagination !== 'object') throw new Error('团队任务响应缺少分页信息。');
  const pagination = rawPagination as Partial<TeamPagination>;
  const page = readPositiveInteger(pagination.page);
  const pageSize = readPositiveInteger(pagination.pageSize);
  const total = readNonNegativeInteger(pagination.total);
  const totalPages = readPositiveInteger(pagination.totalPages);
  if (page === null || pageSize === null || total === null || totalPages === null) {
    throw new Error('团队任务响应分页信息无效。');
  }
  const totalRecords = readNonNegativeInteger(value.totalRecords);
  if (totalRecords === null) throw new Error('团队任务响应缺少执行记录总数。');
  return {
    items: value.items as T[],
    pagination: { page, pageSize: pageSize as TeamPagination['pageSize'], total, totalPages },
    totalRecords,
  };
}
