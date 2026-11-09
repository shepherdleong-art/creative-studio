import type Database from 'better-sqlite3';
import { listTeamErrors, type TeamViewer } from './diagnostics.ts';
import { listTeamTasks } from './tasks.ts';
import { readTeamMemberSummary } from './usage.ts';
import { readProjectProgress } from '../project-progress-query.ts';
import { deriveProjectProgress } from '../project-progress.ts';
import { toStorageImageUrl } from '../storage-url.ts';
import {
  describeRunningTask,
  isTaskInFlight,
  renderPercent,
  type RunningTaskView,
} from '../task-progress.ts';

/**
 * 员工首页的数据聚合（06 号票）。
 *
 * 首页要同时显示「出错的任务 / 接着做 / 正在生产 / 本月用量」四块，如果让浏览器
 * 分别打 4–5 个接口再各自拼规则，「做没做完」「第几步」「要不要显示百分比」这些
 * 判断就会散在组件里、也没法在接口级断言。这里把它们收成一个只读聚合：
 *
 * - 出错的任务：复用 `listTeamErrors`（与「出错的任务」页同一口径、同一可见范围）；
 * - 接着做：项目列表 + `readProjectProgress`（纯函数判断第几步）；
 * - 正在生产：`listTeamTasks` 里的在飞任务 + **只有渲染**的真实百分比；
 * - 本月用量：`readTeamMemberSummary`（本人额度，只读）。
 *
 * 红线：**非渲染阶段不返回百分比**。原型里每项都画了百分比，那只是示意；
 * 这里 `percent` 只有渲染任务才非 null，页面直接照抄，不再自己算。
 */

const MAX_PROJECTS = 8;
const MAX_ERRORS = 3;
const MAX_RUNNING = 5;

export interface DashboardProject {
  id: string;
  name: string;
  storeCode: string;
  productionType: string;
  productCode: string;
  thumbnailImageUrl: string | null;
  progress: { step: number; label: string; empty: boolean };
  totalJobs: number;
  completedJobs: number;
  lastOpenedAt: string | null;
}

export interface DashboardError {
  errorId: string;
  stage: string;
  safeMessage: string;
  actionHint: string;
  scopeName: string | null;
  taskHref: string | null;
  createdAt: string;
}

export interface EmployeeDashboard {
  greetingName: string;
  errors: DashboardError[];
  running: { items: RunningTaskView[]; total: number };
  projects: DashboardProject[];
  usage: {
    monthChargedMinor: number;
    monthSettledMinor: number;
    monthlyLimitMinor: number | null;
    remainingMinor: number | null;
    accountingPeriod: string;
  };
}

type ProjectRow = {
  id: string;
  name: string;
  storeCode: string | null;
  productionType: string | null;
  productCode: string | null;
  lastOpenedAt: string | null;
  thumbnailPath: string | null;
  totalJobs: number;
  completedJobs: number;
};

/**
 * 员工首页的「接着做」只列**本人**项目——包括管理员调这个接口时也一样：
 * 管理员的运行总览（全员数据）归 12 号票的接口，不在这里。
 */
function visibleProjectsSql(viewer: TeamViewer): { sql: string; params: string[] } {
  return {
    sql: `WHERE EXISTS (
      SELECT 1 FROM team_resource_scopes scope
      WHERE scope.resourceType = 'project' AND scope.resourceId = p.id
        AND scope.deletedAt IS NULL AND scope.ownerUserId = ?
    )`,
    params: [viewer.userId],
  };
}

function readProjects(db: Database.Database, viewer: TeamViewer): ProjectRow[] {
  const visibility = visibleProjectsSql(viewer);
  const thumbnailLifecycle = `AND EXISTS (
    SELECT 1 FROM team_resource_scopes scope
    WHERE scope.resourceType = 'image' AND scope.resourceId = image_assets.id
      AND scope.deletedAt IS NULL
  )`;
  return db.prepare(`
    SELECT p.id, p.name, p.storeCode, p.productionType, p.productCode, p.lastOpenedAt,
      (SELECT COUNT(*) FROM jobs WHERE projectId = p.id)
        + (SELECT COUNT(*) FROM video_jobs WHERE projectId = p.id) AS totalJobs,
      (SELECT COUNT(*) FROM jobs WHERE projectId = p.id AND status = 'succeeded')
        + (SELECT COUNT(*) FROM video_jobs WHERE projectId = p.id AND status = 'succeeded') AS completedJobs,
      (SELECT path FROM (
        SELECT path, ROW_NUMBER() OVER (ORDER BY createdAt ASC) AS rn
        FROM image_assets
        WHERE role = 'output' AND usage = 'scene_gen' AND projectId = p.id ${thumbnailLifecycle}
      ) WHERE rn = 1) AS thumbnailPath
    FROM projects p
    ${visibility.sql}
    ORDER BY COALESCE(p.lastOpenedAt, p.createdAt) DESC
    LIMIT ${MAX_PROJECTS}
  `).all(...visibility.params) as ProjectRow[];
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/**
 * 渲染任务进度：这是唯一「能真实测量」的阶段。
 * `final_edit_jobs.progress` 是 0–1 的真实完成比例（改这个字段的解析只在
 * `lib/task-progress.ts` 里发生，页面不自己乘 100）。
 */
function readRenderProgress(
  db: Database.Database,
  projectIds: string[],
  projectNames: Map<string, string>,
): RunningTaskView[] {
  if (projectIds.length === 0 || !tableExists(db, 'final_edit_jobs')) return [];
  const rows = db.prepare(`
    SELECT id, projectId, kind, status, phase, progress
    FROM final_edit_jobs
    WHERE projectId IN (${projectIds.map(() => '?').join(',')})
      AND status IN ('queued', 'running')
      AND kind IN ('render', 'packaging')
    ORDER BY createdAt ASC
    LIMIT ${MAX_RUNNING}
  `).all(...projectIds) as Array<{
    id: string; projectId: string; kind: string; status: string; phase: string; progress: number;
  }>;
  return rows.map((row) => {
    const rendered = row.kind === 'packaging' ? '正在包装成片' : '正在渲染成片';
    const view = describeRunningTask({
      operationId: `render:${row.id}`,
      module: 'final_edit',
      status: row.status,
      taskName: rendered,
      stepName: row.phase,
      renderProgress: row.progress,
    });
    return {
      ...view,
      label: `${projectNames.get(row.projectId) ?? '项目'} · ${view.label}`,
    };
  });
}

export function readEmployeeDashboard(
  db: Database.Database,
  viewer: TeamViewer,
  options: { displayName?: string; now?: Date } = {},
): EmployeeDashboard {
  const now = options.now ?? new Date();
  const displayName = options.displayName?.trim()
    || String(db.prepare('SELECT displayName FROM team_users WHERE id = ?').pluck().get(viewer.userId) ?? '');

  const errors = listTeamErrors(db, viewer, { actorUserId: viewer.userId, actionableOnly: true }).items.slice(0, MAX_ERRORS).map((item) => ({
    errorId: item.errorId,
    stage: item.stage,
    safeMessage: item.safeMessage,
    actionHint: item.actionHint,
    scopeName: item.scopeName,
    taskHref: item.taskHref,
    createdAt: item.createdAt,
  }));

  // 管理员分支（运行总览）归 12 号票，用自己的接口；这里即使被管理员调用，
  // 也只按「本人」取数，避免为首页把全团队的 500 条任务拉出来。
  const tasks = listTeamTasks(db, viewer, { actorUserId: viewer.userId }).items;
  const inFlight = tasks.filter((task) => isTaskInFlight(String(task.status)));
  const projectIds = [...new Set(inFlight.map((task) => task.scope?.resourceId).filter((id): id is string => Boolean(id)))];

  const runningItems: RunningTaskView[] = projectIds.length === 0 ? [] : [];
  // 非渲染阶段：只写「正在做什么 · 第几条」，percent 恒为 null。
  const counters = new Map<string, number>();
  for (const task of inFlight) {
    if (task.module === 'final_edit') continue;
    const key = `${task.scope?.resourceType ?? ''}:${task.scope?.resourceId ?? ''}:${task.module}`;
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    runningItems.push(describeRunningTask({
      operationId: String(task.operationId),
      module: String(task.module),
      status: String(task.status),
      taskName: String(task.taskName),
      stepName: String(task.stepName),
      waitLabel: typeof task.waitLabel === 'string' ? task.waitLabel : null,
      queuePosition: next,
    }));
  }

  const projectRows = readProjects(db, viewer);
  const projectNames = new Map(projectRows.map((row) => [row.id, row.name]));
  const progress = readProjectProgress(db, projectRows.map((row) => row.id));
  const renderItems = readRenderProgress(
    db,
    projectRows.map((row) => row.id),
    projectNames,
  );
  const running = [...renderItems, ...runningItems].slice(0, MAX_RUNNING);

  const member = readTeamMemberSummary(db, viewer, viewer.userId, now);
  // 额度为 0 表示「还没给这个人设额度」，不是「额度用完了」。首页要把它当成
  // 未设置来写，否则会显示「已用 ¥0.00 / 额度 ¥0.00」，看起来像被卡住了。
  const monthlyLimitMinor = member.monthlyLimitMinor === 0 ? null : member.monthlyLimitMinor;

  return {
    greetingName: displayName,
    errors,
    running: { items: running, total: inFlight.length + renderItems.length },
    projects: projectRows.map((row) => {
      const projectProgress = progress.get(row.id) ?? deriveProjectProgress({
        sceneCandidateCount: 0, shotResultCount: 0, approvedShotSetCount: 0,
        scriptCount: 0, videoJobCount: 0, succeededVideoCount: 0, finalGroupCount: 0,
      });
      return {
        id: row.id,
        name: row.name,
        storeCode: row.storeCode ?? '',
        productionType: row.productionType ?? '',
        productCode: row.productCode ?? '',
        thumbnailImageUrl: toStorageImageUrl(row.thumbnailPath) || null,
        progress: projectProgress,
        totalJobs: Number(row.totalJobs ?? 0),
        completedJobs: Number(row.completedJobs ?? 0),
        lastOpenedAt: row.lastOpenedAt,
      };
    }),
    usage: {
      monthChargedMinor: member.monthChargedMinor,
      monthSettledMinor: member.monthSettledMinor,
      monthlyLimitMinor,
      remainingMinor: monthlyLimitMinor === null ? null : Math.max(0, monthlyLimitMinor - member.monthChargedMinor),
      accountingPeriod: now.toISOString().slice(0, 7),
    },
  };
}

/** 导出给测试：确认「非渲染不返回百分比」这条规则在聚合层就被执行了。 */
export { renderPercent };
