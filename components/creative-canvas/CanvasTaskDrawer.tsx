'use client';

/**
 * 全局任务入口骨架（P3；P6 补完成提示与定位体验）。
 * 跨画布查看等待／排队／进行中／失败任务；点击当前画布的任务定位到节点。
 */

import { useEffect, useState } from 'react';
import { canvasApi, type CanvasTaskDto } from './api';
import type { CanvasTaskPhase } from '@/lib/creative-canvas/types';

const PHASE_LABELS: Record<CanvasTaskPhase, string> = {
  waiting_input: '等待上游',
  queued: '排队中',
  preparing: '准备中',
  submitting: '提交中',
  polling: '生成中',
  downloading: '下载保存中',
  download_failed: '下载失败',
  succeeded: '已完成',
  failed: '失败',
  blocked: '上游未完成',
  cancelled: '已停止',
  uncertain: '待核查',
  resume_pending: '待继续',
};

export function CanvasTaskDrawer({
  canvasId,
  knownNodeIds,
  onLocate,
}: {
  canvasId: string;
  /** 当前画布图里仍然存在的节点；不在其中的任务说明节点已被删除。 */
  knownNodeIds: ReadonlySet<string>;
  onLocate: (nodeId: string) => void;
}) {
  const [tasks, setTasks] = useState<CanvasTaskDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { tasks: next } = await canvasApi.tasks({ limit: 50 });
        if (!cancelled) {
          setTasks(next);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '任务列表加载失败');
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <aside className="sc-canvas-drawer" data-testid="task-drawer">
      <h2 className="text-[13px] font-semibold">全部任务</h2>
      {error ? <p className="mt-2 text-[11px] text-[var(--color-fail)]">{error}</p> : null}
      {tasks.length === 0 ? (
        <p className="mt-2 text-[11px] text-ink-tertiary">还没有任务。</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {tasks.map((task) => (
            <li key={task.id} className="sc-canvas-task-row" data-task-phase={task.phase}>
              <button
                type="button"
                className="w-full text-left"
                data-testid={`task-${task.id}`}
                onClick={() => {
                  if (task.canvasId === canvasId) onLocate(task.nodeId);
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  {task.canvasId === canvasId ? (
                    <span className="text-[12px] font-medium">{task.canvasName || task.canvasId.slice(0, 8)}</span>
                  ) : (
                    <a
                      className="text-[12px] font-medium underline"
                      href={`/canvas/${task.canvasId}`}
                      data-testid={`task-canvas-link-${task.id}`}
                    >
                      {task.canvasName || task.canvasId.slice(0, 8)}
                    </a>
                  )}
                  <span className="text-[11px] text-ink-secondary">{PHASE_LABELS[task.phase] ?? task.phase}</span>
                </div>
                <div className="text-[11px] text-ink-tertiary">
                  {task.mediaKind === 'image' ? '图片' : '视频'} · {task.nodeId}
                </div>
                {task.canvasId === canvasId && !knownNodeIds.has(task.nodeId) ? (
                  <div className="text-[11px] text-ink-tertiary" data-testid={`task-node-deleted-${task.id}`}>
                    对应节点已删除，结果与任务记录仍保留。
                  </div>
                ) : null}
                {task.errorMessage ? (
                  <div className="text-[11px] text-[var(--color-fail)]" data-testid={`task-error-${task.id}`}>
                    {task.errorMessage}
                  </div>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
