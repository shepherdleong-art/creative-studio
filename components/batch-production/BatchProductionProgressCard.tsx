'use client';

export interface BatchProgressView {
  overallPercent: number;
  elapsedSec: number;
  /** 终态(全部生产任务结束)时置 true,组件停表并固定进度条 */
  finished: boolean;
  stages: Array<{
    label: string;
    status: 'waiting' | 'running' | 'done' | 'failed';
    detail?: string;
    percent?: number;
  }>;
}

export interface BatchProductionProgressCardProps {
  progress: BatchProgressView;
  variant?: 'full' | 'compact';
}

/**
 * 批量生产进度卡(问题 4):第 2 步用完整阶段列表,其余步骤用一行紧凑进度。
 * 计时由调用方驱动(nowMs tick),组件只负责展示;终态时显示「已完成」并停表。
 */
export default function BatchProductionProgressCard({ progress, variant = 'full' }: BatchProductionProgressCardProps) {
  const percent = progress.finished ? 100 : Math.round(progress.overallPercent * 100);
  const minutes = Math.floor(progress.elapsedSec / 60);
  const seconds = progress.elapsedSec % 60;
  const anyFailed = progress.stages.some((stage) => stage.status === 'failed');

  if (variant === 'compact') {
    return (
      <section className="card flex flex-wrap items-center justify-between gap-3 p-4" aria-label="批量生产进度">
        <div>
          <h3 className="text-sm font-semibold text-ink">生产进度</h3>
          <p className="mt-1 text-xs text-ink-secondary">
            {progress.finished
              ? anyFailed ? '已完成 · 部分失败' : '已完成'
              : '生产中'}
            {progress.finished ? ` · 总用时 ${minutes} 分 ${seconds} 秒` : ` · 已用时 ${minutes} 分 ${seconds} 秒`}
          </p>
        </div>
        <div className="w-40">
          <div
            className={`h-2 overflow-hidden rounded-full bg-surface-subtle ${progress.finished && anyFailed ? 'bg-fail/15' : ''}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div
              className={`h-full rounded-full transition-all ${progress.finished && anyFailed ? 'bg-fail' : 'bg-accent'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1 text-right text-[11px] text-ink-tertiary">{percent}%</p>
        </div>
      </section>
    );
  }

  return (
    <section className="card space-y-3 p-5" aria-label="批量生产进度">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink">生产进度</h3>
          <p className="mt-1 text-xs text-ink-secondary">
            {progress.finished
              ? `已完成 · 总用时 ${minutes} 分 ${seconds} 秒`
              : `已用时 ${minutes} 分 ${seconds} 秒 · 刷新页面不丢失进度`}
          </p>
        </div>
        <div className="w-40">
          <div
            className={`h-2 overflow-hidden rounded-full bg-surface-subtle ${progress.finished && anyFailed ? 'bg-fail/15' : ''}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div
              className={`h-full rounded-full transition-all ${progress.finished && anyFailed ? 'bg-fail' : 'bg-accent'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1 text-right text-[11px] text-ink-tertiary">{percent}%</p>
        </div>
      </div>
      <ul className="space-y-1.5">
        {progress.stages.map((stage) => (
          <li key={stage.label} className="flex items-center gap-3 rounded-xl bg-surface-subtle px-3 py-2 text-xs">
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
              stage.status === 'done' ? 'bg-ok/15 text-ok'
                : stage.status === 'failed' ? 'bg-fail/15 text-fail'
                  : stage.status === 'running' ? 'bg-accent text-white'
                    : 'bg-surface-subtle text-ink-tertiary'
            }`}>
              {stage.status === 'done' ? '✓' : stage.status === 'failed' ? '!' : ''}
            </span>
            <span className={`flex-1 font-medium ${stage.status === 'running' ? 'text-accent' : stage.status === 'failed' ? 'text-fail' : stage.status === 'waiting' ? 'text-ink-tertiary' : 'text-ink'}`}>
              {stage.label}
            </span>
            {typeof stage.percent === 'number' && stage.status === 'running' && (
              <span className="shrink-0 text-ink-tertiary">{Math.round(stage.percent * 100)}%</span>
            )}
            <span className={`shrink-0 ${stage.status === 'failed' ? 'text-fail' : stage.status === 'waiting' ? 'text-ink-tertiary' : 'text-ink-secondary'}`}>
              {stage.status === 'waiting' ? '等待' : stage.status === 'failed' ? '失败' : stage.status === 'running' ? '进行中' : '已完成'}
              {stage.detail ? ` · ${stage.detail}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
