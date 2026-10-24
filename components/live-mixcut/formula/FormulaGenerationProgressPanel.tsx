'use client';

import { useState } from 'react';
import type { FormulaGenerationProgress } from '@/lib/live-mixcut/formula/progress';

export default function FormulaGenerationProgressPanel({ progress, controlState, busy, onControl, onRetry, onReview, onHandleItem, onManualSpeech }: {
  progress: FormulaGenerationProgress; controlState: 'running' | 'paused' | 'stopped'; busy: boolean;
  onControl: (action: 'pause' | 'resume' | 'stop') => void; onRetry: (taskId: string) => void; onReview: () => void;
  /** 标红项没有可重试任务时，跳转到该成片的处理入口；阶段用于决定落到第几步。 */
  onHandleItem?: (planId: string, phase: string) => void;
  /** 原声核对失败时，打开人工填写台词与时间的入口。 */
  onManualSpeech?: (planId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  return <section className="card space-y-3 p-4" aria-label="实拍制作进度" aria-live="polite">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-semibold text-ink">{controlState === 'stopped' ? '制作已停止' : controlState === 'paused' ? '制作已暂停' : progress.finished ? '制作完成，可以审片' : '实拍制作进度'}</h2>
      <div className="flex flex-wrap gap-2">
        {!progress.finished && controlState !== 'stopped' && <>
          <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => onControl(controlState === 'paused' ? 'resume' : 'pause')}>{controlState === 'paused' ? '继续批次' : '暂停批次'}</button>
          <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => onControl('stop')}>停止批次</button>
        </>}
        <button type="button" className="btn-primary text-xs" disabled={!progress.ready || controlState === 'stopped'} onClick={onReview}>查看已就绪成片</button>
      </div>
    </div>
    <p className="text-sm text-ink">共 {progress.total} 条 · 已就绪 {progress.ready} 条 · 需处理 {progress.needsAttention} 条 · 未完成 {progress.pending} 条</p>
    <progress className="h-2 w-full accent-accent" aria-label="可审片数量" value={progress.ready} max={progress.total || 1} />
    <p className="text-xs text-ink-secondary">已就绪的可以先去审片。刷新或关闭页面后后台继续处理，重启应用会恢复未完成任务；正式 MP4 在第四步导出时生成。</p>
    <details open>
      <summary className="cursor-pointer text-xs text-ink-secondary">逐条制作状态</summary>
      <div className="max-h-72 overflow-auto">
      {(showAll ? progress.items : progress.items.slice(0, 10)).map(item => <div key={item.planId} className="flex items-start justify-between gap-3 border-t border-hairline py-2 text-sm">
        <div><p className={item.status === 'needs_attention' ? 'text-fail' : 'text-ink'}>脚本 {item.scriptNumber} · 第 {item.copyIndex} 份 · {item.phase}{item.status === 'needs_attention' ? '（需处理）' : ''}</p>
          <p className="mt-1 text-xs text-ink-secondary">{item.detail}</p></div>
        {item.status === 'needs_attention' && <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {item.retryTaskId && <button type="button" className="btn-secondary text-xs" disabled={busy || controlState !== 'running'} onClick={() => onRetry(item.retryTaskId!)}>重试此步骤</button>}
          {item.phase === '核对原声' && onManualSpeech
            ? <button type="button" className="btn-secondary text-xs" onClick={() => onManualSpeech(item.planId)}>人工核对原声</button>
            : onHandleItem && <button type="button" className="btn-secondary text-xs" onClick={() => onHandleItem(item.planId, item.phase)}>去处理</button>}
        </div>}
      </div>)}
      </div>
    </details>
    {progress.items.length > 10 && <button type="button" className="btn-secondary text-xs" onClick={() => setShowAll(value => !value)}>{showAll ? '收起' : `查看全部 ${progress.total} 条`}</button>}
  </section>;
}
