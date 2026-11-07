import type Database from 'better-sqlite3';
import { listTeamTasks } from './tasks.ts';
import { listTeamErrors, type TeamViewer } from './diagnostics.ts';
import { TeamUsageError } from './usage.ts';
import { readPoolAdminState } from './pools.ts';
import {
  consoleMemberActivity,
  consoleSetupChecklist,
  consoleTaskCounts,
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
 * 数据来源刻意全部沿用现有检查：任务用 `listTeamTasks`（与全员任务页同一可见范围），
 * 名额用 `readPoolAdminState`（与「模型与名额」页同一份 `ready`/`blockers`/`occupancy`）。
 * 这里不新增任何 SQL 口径。
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
  const tasks = listTeamTasks(db, viewer).items;
  const pools = readPoolAdminState(db, viewer);
  const errors = listTeamErrors(db, viewer).items;
  const recent = recentConsoleTasks(tasks, now);
  return {
    counts: consoleTaskCounts(tasks, now),
    recent,
    members: consoleMemberActivity(tasks, now),
    pools: poolOccupancyRows(pools.occupancy),
    setup: consoleSetupChecklist({
      proxyAvailable: input.runtime.proxyAvailable,
      cosConfigured: input.runtime.cosConfigured,
      poolsReady: pools.ready,
      poolBlockers: pools.blockers,
      enabledPools: pools.pools.filter(pool => pool.enabled).length,
    }),
    productionDefaults: input.productionDefaults ?? null,
    empty: tasks.length === 0,
    taskTotal: tasks.length,
    errorTotal: errors.length,
    recentLimit: RECENT_TASK_LIMIT,
    links: { tasksPage: '/team/tasks', poolsPage: '/team/admin/pools', usagePage: '/usage' },
  };
}

/** 任务详情：从全员任务接口的同一投影里按 operationId 取一条（可见范围与列表一致）。 */
export function findConsoleTask(
  db: Database.Database,
  viewer: TeamViewer,
  operationId: string,
) {
  return listTeamTasks(db, viewer).items.find(item => item.operationId === operationId) ?? null;
}

/**
 * 发起人筛选选项：只列**当前可见结果里出现过**的成员。
 *
 * 这是刻意的：员工查询只会返回本人的任务，所以选项天然只有自己；管理员默认拿到全员，
 * 换成「按成员查」后选项收敛到该成员。不额外开一个用户列表接口，避免多一处可见性口径。
 */
export function listConsoleActors(db: Database.Database, viewer: TeamViewer): Array<{ id: string; employeeId: string; displayName: string }> {
  const seen = new Map<string, { id: string; employeeId: string; displayName: string }>();
  for (const item of listTeamTasks(db, viewer).items) {
    seen.set(item.actorUserId, { id: item.actorUserId, employeeId: item.employeeId, displayName: item.actorDisplayName });
  }
  return [...seen.values()].sort((left, right) => left.employeeId.localeCompare(right.employeeId));
}
