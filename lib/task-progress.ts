/**
 * 「正在生产」的进度口径（06 号票）。
 *
 * 规格红线：**只有能真实测量的阶段才显示百分比，目前只有成片渲染**。
 * 原型里每项都画了百分比，那只是示意；照抄会在界面上写假数字。
 *
 * 所以这里只有一个纯函数：拿到真实渲染进度（`final_edit_jobs.progress`，0–1）
 * 才给 percent，否则一律返回「正在做什么 · 第几条」的文案。
 * 页面与测试共用这一份规则，组件里不得再自己拼百分比。
 */

export interface RunningTaskInput {
  operationId: string;
  module: string;
  status: string;
  taskName: string;
  stepName: string;
  waitLabel?: string | null;
  /** 同一项目同一模块里，这条任务在「未完成」队列中的 1-based 序号。 */
  queuePosition?: number | null;
  /** 仅当任务确实是渲染任务且进度可测时传入（0–1）。 */
  renderProgress?: number | null;
}

export interface RunningTaskView {
  operationId: string;
  /** 主标题：正在做什么。 */
  label: string;
  /** 副标题：第几条 / 百分比 / 等待原因。 */
  detail: string;
  /** 只有真实可测的阶段才非 null。 */
  percent: number | null;
}

/**
 * 仍在生产中的状态。前七个来自 `execution_operations`（图片/视频/脚本任务的
 * 受理状态机），`running` 来自成片任务自己的状态列（`final_edit_jobs`）。
 *
 * 导出给服务端的有界记录查询（员工首页「正在生产」）复用：SQL 的 `IN (…)` 与
 * `isTaskInFlight` 必须是同一份清单，不要在别处再抄一遍。
 */
export const IN_FLIGHT_STATUSES = [
  'pending', 'deferred', 'admitted', 'maybe_sent', 'submitted', 'accepted', 'reconciling', 'unknown', 'running',
] as const;

export function isTaskInFlight(status: string): boolean {
  return (IN_FLIGHT_STATUSES as readonly string[]).includes(status);
}

/** 渲染进度的 0–1 转成整数百分比；越界或非数字按「不可测」处理。 */
export function renderPercent(progress: number | null | undefined): number | null {
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) return null;
  return Math.round(progress * 100);
}

export function describeRunningTask(input: RunningTaskInput): RunningTaskView {
  const position = typeof input.queuePosition === 'number' && input.queuePosition > 0
    ? `第 ${input.queuePosition} 条`
    : '';
  const percent = input.renderProgress == null ? null : renderPercent(input.renderProgress);
  if (percent !== null) {
    return {
      operationId: input.operationId,
      label: '正在渲染成片',
      detail: [`已完成 ${percent}%`, position].filter(Boolean).join(' · '),
      percent,
    };
  }
  // 非渲染阶段：写清楚在做什么、第几条，绝不编造百分比。
  const doing = input.waitLabel?.trim() || input.stepName || input.taskName;
  return {
    operationId: input.operationId,
    label: `${input.taskName} · ${doing}`,
    detail: position || (input.status === 'pending' || input.status === 'deferred' ? '排队中' : '服务器处理中'),
    percent: null,
  };
}

/**
 * 一次算完整份「正在生产」：按项目 + 模块给每条在飞任务编号，
 * 渲染任务带上真实百分比。不在飞的任务不会出现在结果里。
 */
export function describeRunningTasks(input: Array<RunningTaskInput & {
  scope?: { resourceType: string; resourceId: string };
}>): RunningTaskView[] {
  const counters = new Map<string, number>();
  const views: RunningTaskView[] = [];
  for (const task of input) {
    if (!isTaskInFlight(task.status)) continue;
    const key = `${task.scope?.resourceType ?? ''}:${task.scope?.resourceId ?? ''}:${task.module}`;
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    views.push(describeRunningTask({ ...task, queuePosition: task.queuePosition ?? next }));
  }
  return views;
}
