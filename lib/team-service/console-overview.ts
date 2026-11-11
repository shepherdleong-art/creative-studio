import type Database from 'better-sqlite3';
import {
  findTeamTask,
  listRecentTeamTasks,
  listTeamTaskActors,
  readTeamTaskActivity,
  type TeamTaskView,
} from './tasks.ts';
import { listTeamErrors, type TeamViewer } from './diagnostics.ts';
import { TeamUsageError } from './usage.ts';
import { readPoolAdminState } from './pools.ts';
import {
  consoleMemberRows,
  consoleSetupChecklist,
  poolOccupancyRows,
  recentConsoleTasks,
  RECENT_TASK_LIMIT,
  type ConsoleMemberRow,
  type ConsolePoolRow,
  type ConsoleSetupChecklist,
  type ConsoleTaskCounts,
  type ConsoleTaskRow,
} from '../team-console-overview.ts';
/**
 * 控制台运行总览的服务端聚合（12 号票）。
 *
 * 一屏原来要前端打 3 个接口（tasks / pools / company-provider health），这里合成**一次**
 * 读取，并把「数量卡、最近任务、今天成员、名额占用、开工前清单」的口径固定在
 * `lib/team-console-overview.ts` 的纯函数里——页面只渲染，测试直接断言同一批函数。
 *
 * 任务列表改成服务端分页后（03 号票），总览**不套用分页列表**：数量卡和成员统计走
 * `readTeamTaskActivity` 的 SQL 分桶聚合（口径仍来自 `lib/team-console-overview.ts` 的
 * `CONSOLE_STATUS_BUCKETS`），最近任务走有界的 `listRecentTeamTasks`。两者都不按当前页
 * 的 `items.length` 算数，也不为一个角标加载全量明细。
 */

export interface ConsoleRuntimeHealth {
  proxyAvailable: boolean | null;
  cosConfigured: boolean | null;
}

export interface ConsoleOverviewView {
  counts: ConsoleTaskCounts;
  recent: ConsoleTaskRow[];
  members: ConsoleMemberRow[];
  pools: ConsolePoolRow[];
  setup: ConsoleSetupChecklist;
  /** 服务器默认参数的原始对象（只读；形状校验在 `consoleDefaultsView`）。 */
  productionDefaults: unknown;
  /** 全 0 空状态：服务器上确实一条任务都没有。 */
  empty: boolean;
  /** 全可见范围的执行记录总数（不是当前页条数）。 */
  taskTotal: number;
  errorTotal: number;
  recentLimit: number;
  /** 有任务、但最近任务为空（不可能发生）时的诊断字段；正常为空数组。 */
  links: { tasksPage: string; poolsPage: string; usagePage: string };
}

export interface ConsoleOverviewInput {
  runtime: ConsoleRuntimeHealth;
  /** 现有就绪检查里的服务器默认参数；06 尚未合并时为 null。 */
  productionDefaults?: unknown;
}

export function readConsoleOverview(
  db: Database.Database,
  viewer: TeamViewer,
  input: ConsoleOverviewInput,
  now: Date = new Date(),
): ConsoleOverviewView {
  if (viewer.role !== 'admin') {
    throw new TeamUsageError(403, 'console_overview_forbidden', '只有管理员可以查看运行总览。');
  }
  const activity = readTeamTaskActivity(db, viewer, now);
  const recent = recentConsoleTasks(listRecentTeamTasks(db, viewer, RECENT_TASK_LIMIT).items, now);
  const pools = readPoolAdminState(db, viewer);
  const errors = listTeamErrors(db, viewer, { actionableOnly: true }).items;
  return {
    counts: {
      running: activity.counts.running,
      queued: activity.counts.queued,
      completedToday: activity.counts.completedToday,
      failed: activity.counts.failed,
      total: activity.counts.total,
    },
    recent,
    members: consoleMemberRows(activity.members),
    pools: poolOccupancyRows(pools.occupancy),
    setup: consoleSetupChecklist({
      proxyAvailable: input.runtime.proxyAvailable,
      cosConfigured: input.runtime.cosConfigured,
      poolsReady: pools.ready,
      poolBlockers: pools.blockers,
      enabledPools: pools.pools.filter(pool => pool.enabled).length,
    }),
    productionDefaults: input.productionDefaults ?? null,
    empty: activity.counts.total === 0,
    taskTotal: activity.counts.total,
    errorTotal: errors.length,
    recentLimit: RECENT_TASK_LIMIT,
    links: { tasksPage: '/team/tasks', poolsPage: '/team/admin/pools', usagePage: '/usage' },
  };
}

/**
 * 任务详情：按 operationId 直查（可见范围与列表一致，且不受分页/筛选限制）。
 * 保留旧名字给既有调用者（重试入口等），实现统一在 `findTeamTask`。
 */
export function findConsoleTask(
  db: Database.Database,
  viewer: TeamViewer,
  operationId: string,
): TeamTaskView | null {
  return findTeamTask(db, viewer, operationId);
}

/**
 * 发起人筛选选项：只列**当前可见结果里出现过**的成员。
 *
 * 这是刻意的：员工查询只会返回本人的任务，所以选项天然只有自己；管理员默认拿到全员，
 * 换成「按成员查」后选项收敛到该成员。不额外开一个用户列表接口，避免多一处可见性口径。
 * 用 SQL 分组直接取全范围成员，不依赖某个分页的 items。
 */
export function listConsoleActors(db: Database.Database, viewer: TeamViewer): Array<{ id: string; employeeId: string; displayName: string }> {
  return listTeamTaskActors(db, viewer);
}
