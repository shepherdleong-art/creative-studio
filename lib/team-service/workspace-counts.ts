import type Database from 'better-sqlite3';
import { listTeamErrors, type TeamViewer } from './diagnostics.ts';
import { listTeamTasks } from './tasks.ts';
import type { WorkspaceBadgeKey } from '../workspace-navigation.ts';

/**
 * 侧栏数量角标（05 号票）。
 *
 * 口径的唯一来源是页面自己用的列表函数：`listTeamTasks`（我的任务 / 全员任务页）和
 * `listTeamErrors`（出错的任务页）。这里刻意**不写 SQL、不改可见范围**——那会让角标和
 * 页面条目数漂移，或在员工端出现越权取数。两个列表各自的 500 条上限也一并继承，
 * 因此角标最多显示 500，与页面「服务端最多返回最近 500 条」的说明一致。
 *
 * 不新增接口：`/api/team/tasks`、`/api/team/errors` 已经返回 `{ items }`，前端直接数长度。
 * 这个函数是给服务端渲染/测试复用的同一口径实现。
 */
export interface WorkspaceBadgeCounts {
  tasks: number | null;
  errors: number | null;
}

/** 员工传别人的 actorUserId 会被列表层拒绝（403），角标按「不显示」处理。 */
function countSafely(read: () => { items: unknown[] }): number | null {
  try {
    return read().items.length;
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
    tasks: countSafely(() => listTeamTasks(db, viewer, { actorUserId })),
    errors: countSafely(() => listTeamErrors(db, viewer, { actorUserId })),
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
    ? countSafely(() => listTeamTasks(db, viewer, { actorUserId }))
    : countSafely(() => listTeamErrors(db, viewer, { actorUserId }));
}
