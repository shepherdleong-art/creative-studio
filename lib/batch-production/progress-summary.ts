import type { BatchTaskTargetKind, BatchTaskWorkType, BatchTaskView } from './tasks.ts';

export interface BatchRenderTaskLike {
  workType: BatchTaskWorkType;
  targetKind: BatchTaskTargetKind;
}

export interface BatchRenderTaskGroups<T extends BatchRenderTaskLike> {
  /** 第 2 步用于检查页封面墙的独立封面任务。 */
  cover: T[];
  /** 第 4 步正式导出才创建的整片渲染任务。 */
  full: T[];
}

/**
 * 任务表把封面和整片都记作 workType=render，展示层不能只按 workType 统计。
 * 只接受当前两个正式渲染目标，历史隔离任务不应混进用户进度。
 */
export function splitBatchRenderTasks<T extends BatchRenderTaskLike>(
  tasks: readonly T[],
): BatchRenderTaskGroups<T> {
  const cover: T[] = [];
  const full: T[] = [];
  for (const task of tasks) {
    if (task.workType !== 'render') continue;
    if (task.targetKind === 'output_version_cover') cover.push(task);
    else if (task.targetKind === 'output_version') full.push(task);
  }
  return { cover, full };
}

/** 实际整片渲染区间的并集：排除准备、审片、排队和重试之间的空闲。 */
export function batchExportElapsedSec(tasks: readonly BatchTaskView[], nowMs: number): number {
  const intervals = splitBatchRenderTasks(tasks).full.flatMap(task => task.attempts.flatMap(attempt => {
    const start = Date.parse(attempt.startedAt);
    const end = attempt.finishedAt
      ? Date.parse(attempt.finishedAt)
      : attempt.status === 'running' && task.status === 'running' ? nowMs : NaN;
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ start, end }] : [];
  })).sort((a, b) => a.start - b.start);
  let elapsedMs = 0;
  let previousEnd = -Infinity;
  for (const { start, end } of intervals) {
    elapsedMs += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = Math.max(previousEnd, end);
  }
  return Math.floor(elapsedMs / 1000);
}
