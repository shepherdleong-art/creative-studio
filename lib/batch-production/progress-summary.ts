import type { BatchTaskTargetKind, BatchTaskWorkType } from './tasks.ts';

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
