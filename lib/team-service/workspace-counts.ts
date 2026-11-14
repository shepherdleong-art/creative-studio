import type Database from 'better-sqlite3';
import { listTeamErrors, type TeamViewer } from './diagnostics.ts';
import { countTeamTasks } from './tasks.ts';
import type { WorkspaceBadgeKey } from '../workspace-navigation.ts';

/**
 * 侧栏数量角标；由 /api/team/workspace-counts 提供，沿用页面的全范围计数。
 *
 * 口径的唯一来源仍是页面自己用的查询：`countTeamTasks`（我的任务 / 全员任务页）和
 * `listTeamErrors`（出错的任务页）。这里刻意**不写 SQL、不改可见范围**——那会让角标和
 * 页面条目数漂移，或在员工端出现越权取数。
 *
 * 任务列表改为服务端分页后，角标**不能再数一页的 `items.length`**：改成
 * `countTeamTasks().records` —— 全可见范围的执行记录数（505 条就是 505，不是 25 或 500）。
 * 用 COUNT/DISTINCT 聚合，不加载页面明细。
 */
export interface WorkspaceBadgeCounts {
  tasks: number | null;
  errors: number | null;
}

/** 员工传别人的 actorUserId 会被列表层拒绝（403），角标按「不显示」处理。 */
function countSafely(read: () => number): number | null {
  try {
    return read();
  } catch {
    return null;
  }
}

export function readWorkspaceBadgeCounts(
  db: Database.Database,
  viewer: TeamViewer | null | undefined,
  filters: { actorUserId?: string } = {},
): WorkspaceBadgeCounts {
  if (!viewer) return { tasks: null, errors: null };
  const actorUserId = filters.actorUserId?.trim() || undefined;
  return {
    tasks: countSafely(() => countTeamTasks(db, viewer, { actorUserId }).records),
    errors: countSafely(() => listTeamErrors(db, viewer, { actorUserId, actionableOnly: true }).items.length),
  };
}

/** 只取一个角标时用：避免为了一个数字把另一份列表也查出来。 */
export function readWorkspaceBadgeCount(
  db: Database.Database,
  viewer: TeamViewer | null | undefined,
  badge: WorkspaceBadgeKey,
  filters: { actorUserId?: string } = {},
): number | null {
  if (!viewer) return null;
  const actorUserId = filters.actorUserId?.trim() || undefined;
  return badge === 'tasks'
    ? countSafely(() => countTeamTasks(db, viewer, { actorUserId }).records)
    : countSafely(() => listTeamErrors(db, viewer, { actorUserId, actionableOnly: true }).items.length);
}
