'use client';

import type { BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';

export type CardFilter = 'all' | BatchWorkspaceView['cards'][number]['status'];

export interface BatchStepReviewProps {
  workspace: BatchWorkspaceView;
  cardFilter: CardFilter;
  onCardFilterChange: (filter: CardFilter) => void;
  selectedPlanIds: string[];
  onTogglePlan: (planId: string, checked: boolean) => void;
  phaseEBusy: string | null;
  onRetryRender: (taskId: string) => void;
  onReallocate: (planId: string) => void;
  onControlBatch: (action: 'pause' | 'resume' | 'stop') => void;
  projectId: string;
  selectedBatchId: string;
  busy: 'create' | 'snapshot' | 'start' | null;
  onStartBatch: () => void;
}

const CARD_STATUS_LABELS: Record<string, string> = {
  completed: '已完成',
  needs_attention: '需处理',
  processing: '渲染中',
  waiting: '等待中',
  paused: '已暂停',
  retryable_failed: '可重试',
  stopped: '已停止',
};

const TASK_PHASE_LABELS: Record<string, string> = {
  starting: '准备中',
  running: '执行中',
  locating: '定位来源',
  preflight: '环境检查',
  probing: '探测媒体',
  content_analyzing: '画面内容分析',
  verifying_lut: '核验 LUT',
  encoding: '编码中',
  verifying: '核验产物',
  ready: '已就绪',
  rendering: '渲染中',
  cover: '生成封面',
};

const FILTERS: Array<[CardFilter, string]> = [
  ['all', '全部'],
  ['completed', '已完成'],
  ['needs_attention', '需处理'],
  ['processing', '渲染中'],
  ['waiting', '等待中'],
  ['paused', '已暂停'],
  ['retryable_failed', '可重试'],
  ['stopped', '已停止'],
];

/**
 * 第 3 步 · 检查成片:统计条 + 状态筛选 + 卡片网格。
 * 卡片操作一律是按钮;默认只展示最新版本,版本历史数量就地标注。
 */
export default function BatchStepReview(props: BatchStepReviewProps) {
  const { workspace, cardFilter, onCardFilterChange, selectedPlanIds, onTogglePlan, phaseEBusy, onRetryRender, onReallocate, onControlBatch } = props;
  const visibleCards = workspace.cards.filter(({ status }) => cardFilter === 'all' || status === cardFilter);
  const { counts } = workspace;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-2">
      <div className="card space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-ink">批次成片工作区</h3>
            <p className="mt-1 text-sm text-ink-secondary">状态来自持久任务、候选版本和正式产物聚合；新版本失败不会隐藏旧成片。默认展示最新版本。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {workspace.batch.controlState === 'running' && (
              <button type="button" className="btn-secondary text-xs" disabled={phaseEBusy !== null} onClick={() => onControlBatch('pause')}>暂停批次</button>
            )}
            {workspace.batch.controlState === 'paused' && (
              <button type="button" className="btn-secondary text-xs" disabled={phaseEBusy !== null} onClick={() => onControlBatch('resume')}>继续批次</button>
            )}
            {workspace.batch.controlState !== 'stopped' && (
              <button type="button" className="btn-secondary text-xs text-fail" disabled={phaseEBusy !== null} onClick={() => onControlBatch('stop')}>停止批次</button>
            )}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-5">
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">全部</p><strong className="text-xl text-ink">{counts.total}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">可正式发布</p><strong className="text-xl text-ok">{counts.publishable}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">处理中</p><strong className="text-xl text-accent">{counts.processing}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">需处理</p><strong className="text-xl text-warn">{counts.needsAttention}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">可重试失败</p><strong className="text-xl text-fail">{counts.failed}</strong></div>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="成片状态筛选">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`rounded-full px-3 py-1 text-xs ${cardFilter === value ? 'bg-accent text-white' : 'bg-surface-subtle text-ink-secondary'}`}
              onClick={() => onCardFilterChange(value)}
            >{label}</button>
          ))}
        </div>
        <p className="text-xs text-ink-tertiary">没有真实口播时会先生成无配音样片供检查，但不会被冒充为可正式发布成片。</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {visibleCards.map((card) => {
          const mediaSource = card.candidate ? 'candidate' : card.currentVideo ? 'artifact' : null;
          const mediaUrl = mediaSource && props.selectedBatchId
            ? `/api/batch-production/batches/${encodeURIComponent(props.selectedBatchId)}/outputs/${encodeURIComponent(card.planId)}/media?projectId=${encodeURIComponent(props.projectId)}&kind=video&source=${mediaSource}`
            : null;
          const coverSource = card.candidate?.coverAvailable ? 'candidate' : card.currentCover ? 'artifact' : null;
          const coverUrl = coverSource && props.selectedBatchId
            ? `/api/batch-production/batches/${encodeURIComponent(props.selectedBatchId)}/outputs/${encodeURIComponent(card.planId)}/media?projectId=${encodeURIComponent(props.projectId)}&kind=cover&source=${coverSource}`
            : null;
          const progress = card.task?.progress as { phase?: string; percent?: number | null; description?: string } | null;
          const historyCount = Math.max(0, card.history.length > 0 ? card.history.length / 2 : 0);
          return (
            <article key={card.planId} data-testid="batch-output-card" className="tile space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={`选择成片 ${card.seq}`}
                    checked={selectedPlanIds.includes(card.planId)}
                    disabled={!card.publishable}
                    title={card.publishable ? undefined : '这条成片还没有配音，暂时无法导出'}
                    onChange={(event) => onTogglePlan(card.planId, event.target.checked)}
                    className="mt-1 disabled:opacity-40"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs text-ink-tertiary">
                      成片 {String(card.seq).padStart(2, '0')} · v{card.versionNumber ?? '—'}
                      {historyCount > 0 && ` · 另有 ${historyCount} 个历史版本`}
                    </span>
                    <strong className="mt-1 block truncate text-ink">{card.scriptTitle || '未命名脚本'}</strong>
                  </span>
                </div>
                <span className={`rounded-full px-2 py-1 text-[11px] ${card.status === 'completed' ? 'bg-ok/10 text-ok' : card.status === 'retryable_failed' || card.status === 'stopped' ? 'bg-fail/10 text-fail' : card.status === 'needs_attention' ? 'bg-warn/20 text-warn' : 'bg-accent/10 text-accent'}`}>
                  {CARD_STATUS_LABELS[card.status]}
                </span>
              </div>
              {(mediaUrl || coverUrl) && (
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  {mediaUrl && (
                    <video key={`${card.versionId}-${mediaSource}`} controls preload="metadata" className="aspect-video w-full rounded-xl bg-black" data-testid={`batch-output-preview-${card.planId}`}>
                      <source src={mediaUrl} type="video/mp4" />
                    </video>
                  )}
                  {coverUrl && (
                    <figure className="overflow-hidden rounded-xl border border-hairline bg-surface-subtle" data-testid={`batch-output-cover-${card.planId}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={coverUrl} alt={`成片 ${card.seq} 封面`} className="aspect-[3/4] h-full w-full object-cover" />
                      <figcaption className="border-t border-hairline px-2 py-1.5 text-center text-[11px] text-ink-secondary">封面已生成</figcaption>
                    </figure>
                  )}
                </div>
              )}
              {card.candidate && (
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <span className="rounded-full bg-ok/10 px-2 py-1 text-ok">封面已生成</span>
                  <span className={`rounded-full px-2 py-1 ${card.candidate.subtitleCueCount > 0 ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
                    {card.candidate.subtitleCueCount > 0 ? `字幕 ${card.candidate.subtitleCueCount} 条` : '字幕待生成'}
                  </span>
                </div>
              )}
              {card.candidate?.audioMode === 'silent_placeholder' && (
                <p className="rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn">无配音样片 —— 仅供检查画面，不能导出。</p>
              )}
              {progress && (
                <div className="text-xs text-ink-secondary">
                  <p>{(progress.phase && TASK_PHASE_LABELS[progress.phase]) || progress.description || card.nextAction}{typeof progress.percent === 'number' ? ` · ${Math.round(progress.percent * 100)}%` : ''}</p>
                  {typeof progress.percent === 'number' && <progress className="mt-1 w-full" max={1} value={progress.percent} />}
                </div>
              )}
              {(card.blockers.length > 0 || card.warnings.length > 0 || card.task?.errorMessage) && (
                <ul className="space-y-1 text-xs text-warn">
                  {card.blockers.map((message) => <li key={`b-${message}`}>无法继续：{message}</li>)}
                  {card.warnings.map((message) => <li key={`w-${message}`}>提醒：{message}</li>)}
                  {card.task?.errorMessage && <li>任务失败：{card.task.errorMessage}</li>}
                </ul>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
                <span className="text-xs text-ink-tertiary">历史产物 {card.history.length / 2} 项 · {card.nextAction}</span>
                <span className="flex flex-wrap gap-2">
                  {card.task?.status === 'failed' && (
                    <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={phaseEBusy !== null} onClick={() => onRetryRender(card.task!.id)}>重新渲染</button>
                  )}
                  {workspace.batch.controlState !== 'stopped' && (
                    <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={phaseEBusy !== null} onClick={() => onReallocate(card.planId)}>
                      {phaseEBusy === card.planId ? '处理中…' : '换一批画面'}
                    </button>
                  )}
                </span>
              </div>
            </article>
          );
        })}
      </div>
      {visibleCards.length === 0 && <div className="tile p-6 text-sm text-ink-secondary">当前筛选下没有成片。</div>}
    </div>
  );
}
