'use client';

import { useEffect, useRef, useState } from 'react';
import type { BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';

export type CardFilter = 'all' | BatchWorkspaceView['cards'][number]['status'];

export interface BatchStepReviewProps {
  workspace: BatchWorkspaceView;
  cardFilter: CardFilter;
  onCardFilterChange: (filter: CardFilter) => void;
  selectedPlanIds: string[];
  onTogglePlan: (planId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onReview: (decision: 'approved' | 'rework' | 'cancelled') => void;
  onChangeCover: (planId: string, timeUs: number) => void;
  coverBusy: string | null;
  phaseEBusy: string | null;
  onRetryRender: (taskId: string) => void;
  onRetryNarration: (taskId: string) => void;
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
  semantic_score: '语义匹配',
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
 * 第 3 步 · 检查成片:封面墙 + 弹窗预览 + 审核(通过/返工/撤销)。
 * 封面墙只看封面;点击封面弹窗播放成片并处理细节(状态、失败原因、换封面)。
 */
export default function BatchStepReview(props: BatchStepReviewProps) {
  const {
    workspace,
    cardFilter,
    onCardFilterChange,
    selectedPlanIds,
    onTogglePlan,
    onSelectAll,
    onReview,
    onChangeCover,
    coverBusy,
    phaseEBusy,
    onRetryRender,
    onRetryNarration,
    onReallocate,
    onControlBatch,
  } = props;
  const visibleCards = workspace.cards.filter(({ status }) => cardFilter === 'all' || status === cardFilter);
  const { counts } = workspace;
  // 每张卡片当前查看的成片版本(缺省 = 最新版本);切换只影响弹窗预览的媒体
  const [viewedVersionIds, setViewedVersionIds] = useState<Record<string, string>>({});
  const [previewCard, setPreviewCard] = useState<BatchWorkspaceView['cards'][number] | null>(null);
  const previewCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const [coverDraftUs, setCoverDraftUs] = useState<number | null>(null);

  useEffect(() => {
    if (!previewCard) return;
    const timer = window.setTimeout(() => previewCloseButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewCard(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [previewCard]);

  useEffect(() => {
    if (!previewCard) return;
    void (async () => {
      setCoverDraftUs(previewCard.coverRange?.currentUs ?? null);
    })();
  }, [previewCard]);

  function mediaUrlFn(card: BatchWorkspaceView['cards'][number], kind: 'video' | 'cover', source: 'candidate' | 'artifact', outputVersionId: string | null): string | null {
    if (!props.selectedBatchId) return null;
    const params = new URLSearchParams({ projectId: props.projectId, kind, source });
    if (outputVersionId) params.set('outputVersionId', outputVersionId);
    return `/api/batch-production/batches/${encodeURIComponent(props.selectedBatchId)}/outputs/${encodeURIComponent(card.planId)}/media?${params.toString()}`;
  }

  const selectableCount = workspace.cards.filter(({ publishable }) => publishable).length;
  const allSelected = selectableCount > 0 && workspace.cards.every(({ planId, publishable }) => !publishable || selectedPlanIds.includes(planId));
  const awaitingReview = workspace.cards.filter(({ publishable, approved }) => publishable && !approved).length;
  // 一条都不可勾选时的原因归类(问题 5):配音未完成 / 配音失败 / 其他阻塞。
  const narrationActiveCount = workspace.cards.filter((card) => (
    card.narrationTask && (card.narrationTask.status === 'queued' || card.narrationTask.status === 'running')
  )).length;
  const narrationFailedCount = workspace.cards.filter((card) => card.narrationTask?.status === 'failed').length;
  const otherBlockers = [...new Set(
    workspace.cards.filter(({ publishable }) => !publishable).flatMap((card) => card.blockers),
  )];

  /** 卡片当前查看版本可用的媒体来源(candidate 优先,其次正式产物) */
  function mediaSourceOf(card: BatchWorkspaceView['cards'][number], viewedVersionId: string | null): 'candidate' | 'artifact' | null {
    const isCurrentView = !viewedVersionId || viewedVersionId === card.versionId;
    if (isCurrentView) {
      if (card.candidate) return 'candidate';
      if (card.currentVideo) return 'artifact';
      return null;
    }
    const viewedVersion = card.versions.find((version) => version.id === viewedVersionId) ?? null;
    if (viewedVersion?.hasCandidate) return 'candidate';
    if (viewedVersion?.hasArtifact) return 'artifact';
    return null;
  }

  function openPreview(card: BatchWorkspaceView['cards'][number]): void {
    const viewedVersionId = viewedVersionIds[card.planId] ?? card.versionId;
    if (!mediaSourceOf(card, viewedVersionId)) return;
    setPreviewCard(card);
  }

  function previewMediaUrl(card: BatchWorkspaceView['cards'][number], kind: 'video' | 'cover'): string | null {
    const viewedVersionId = viewedVersionIds[card.planId] ?? card.versionId;
    const source = mediaSourceOf(card, viewedVersionId);
    if (!source) return null;
    const isCurrentView = !viewedVersionId || viewedVersionId === card.versionId;
    return mediaUrlFn(card, kind, source, isCurrentView ? null : viewedVersionId);
  }

  const previewVideo = previewCard ? previewMediaUrl(previewCard, 'video') : null;
  const previewCover = previewCard ? previewMediaUrl(previewCard, 'cover') : null;

  return (
    <div className="min-h-0 flex-1 space-y-4 p-2">
      <div className="card space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-ink">检查成片</h3>
            <p className="mt-1 text-sm text-ink-secondary">点封面预览成片；勾选后批量「通过 / 返工 / 撤销」。通过后的成片才能正式导出。</p>
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
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">已通过</p><strong className="text-xl text-accent">{counts.approved}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">处理中</p><strong className="text-xl text-accent">{counts.processing}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">需处理</p><strong className="text-xl text-warn">{counts.needsAttention}</strong></div>
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
      </div>

      {visibleCards.length > 0 && (
        <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-secondary h-9 px-3 text-xs" disabled={selectableCount === 0} onClick={onSelectAll}>
              {allSelected ? '全不选' : `一键全选（${selectableCount}）`}
            </button>
            <span className="text-xs text-ink-secondary">已选 {selectedPlanIds.length} 条{awaitingReview > 0 && ` · ${awaitingReview} 条可发布但尚未审核`}</span>
            {selectableCount === 0 && workspace.cards.length > 0 && (
              <span className="text-xs text-warn" role="status">
                {narrationActiveCount > 0 && ` · ${narrationActiveCount} 条正在生成配音，完成后自动继续渲染`}
                {narrationFailedCount > 0 && ` · ${narrationFailedCount} 条配音失败，请在卡片上点「重试配音」`}
                {narrationActiveCount === 0 && narrationFailedCount === 0 && otherBlockers.length > 0 && ` · ${otherBlockers.join('；')}`}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary h-9 px-3 text-xs"
              disabled={phaseEBusy !== null || selectedPlanIds.length === 0}
              onClick={() => onReview('approved')}
            >{phaseEBusy === 'review:approved' ? '处理中…' : `通过（${selectedPlanIds.length}）`}</button>
            <button
              type="button"
              className="btn-secondary h-9 px-3 text-xs"
              disabled={phaseEBusy !== null || selectedPlanIds.length === 0}
              onClick={() => onReview('rework')}
            >{phaseEBusy === 'review:rework' ? '处理中…' : `返工（${selectedPlanIds.length}）`}</button>
            <button
              type="button"
              className="btn-secondary h-9 px-3 text-xs"
              disabled={phaseEBusy !== null || selectedPlanIds.length === 0}
              onClick={() => onReview('cancelled')}
            >{phaseEBusy === 'review:cancelled' ? '处理中…' : `撤销审核（${selectedPlanIds.length}）`}</button>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visibleCards.map((card) => {
          const viewedVersionId = viewedVersionIds[card.planId] ?? card.versionId;
          const isCurrentView = !viewedVersionId || viewedVersionId === card.versionId;
          const coverSource = mediaSourceOf(card, viewedVersionId);
          const coverUrl = coverSource ? mediaUrlFn(card, 'cover', coverSource, isCurrentView ? null : viewedVersionId) : null;
          const progress = card.task?.progress as { phase?: string; percent?: number | null; description?: string } | null;
          const historyCount = Math.max(0, card.history.length > 0 ? card.history.length / 2 : 0);
          return (
            <article key={card.planId} data-testid="batch-output-card" className="tile flex min-w-0 flex-col space-y-3 p-3">
              <button
                type="button"
                className="group relative block w-full overflow-hidden rounded-xl bg-surface-subtle text-left"
                aria-label={`预览成片 ${card.seq} ${card.scriptTitle || ''}`}
                disabled={!coverSource}
                onClick={() => openPreview(card)}
              >
                {coverUrl ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={coverUrl}
                      alt={`成片 ${card.seq} 封面`}
                      loading="lazy"
                      className="aspect-[3/4] w-full object-cover transition group-hover:scale-[1.02]"
                      data-testid={`batch-output-cover-${card.planId}`}
                    />
                    <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 pb-2 pt-8 text-xs font-medium text-white opacity-0 transition group-hover:opacity-100">
                      {coverSource === 'candidate' ? '点击预览成片' : '已导出 · 点击预览'}
                    </span>
                  </>
                ) : (
                  <span className="flex aspect-[3/4] w-full items-center justify-center text-xs text-ink-tertiary">暂无封面预览</span>
                )}
              </button>
              <div className="flex items-start justify-between gap-2">
                <label className="flex min-w-0 items-start gap-2">
                  <input
                    type="checkbox"
                    aria-label={`选择成片 ${card.seq}`}
                    checked={selectedPlanIds.includes(card.planId)}
                    disabled={!card.publishable}
                    title={card.publishable ? undefined : '这条成片还没有配音，暂时无法导出'}
                    onChange={(event) => onTogglePlan(card.planId, event.target.checked)}
                    className="mt-0.5 disabled:opacity-40"
                  />
                  <span className="min-w-0">
                    <span className="block text-[11px] text-ink-tertiary">
                      成片 {String(card.seq).padStart(2, '0')} · v{card.versionNumber ?? '—'}
                      {historyCount > 0 && ` · 另有 ${historyCount} 个历史版本`}
                    </span>
                    <strong className="mt-0.5 block truncate text-xs font-medium text-ink">{card.scriptTitle || '未命名脚本'}</strong>
                  </span>
                </label>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${card.status === 'completed' ? 'bg-ok/10 text-ok' : card.status === 'retryable_failed' || card.status === 'stopped' ? 'bg-fail/10 text-fail' : card.status === 'needs_attention' ? 'bg-warn/20 text-warn' : 'bg-accent/10 text-accent'}`}>
                    {CARD_STATUS_LABELS[card.status]}
                  </span>
                  {card.publishable && (
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${card.approved ? 'bg-accent/10 text-accent' : 'bg-warn/20 text-warn'}`}>
                      {card.approved ? '已通过' : '待审核'}
                    </span>
                  )}
                </span>
              </div>
              {card.versions.length > 1 && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2">
                  <span className="text-[11px] text-ink-tertiary">查看版本（默认最新）</span>
                  <select
                    aria-label={`成片 ${card.seq} 版本切换`}
                    value={viewedVersionId ?? ''}
                    onChange={(event) => setViewedVersionIds((current) => ({ ...current, [card.planId]: event.target.value }))}
                    className="h-8 max-w-32 rounded-lg border border-hairline bg-white px-2 text-xs text-ink"
                  >
                    {card.versions.map((version) => (
                      <option key={version.id} value={version.id} disabled={!version.hasCandidate && !version.hasArtifact}>
                        v{version.versionNumber}{!version.hasCandidate && !version.hasArtifact ? '（无预览）' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {isCurrentView && card.candidate && (
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <span className={`rounded-full px-2 py-1 ${card.candidate.subtitleCueCount > 0 ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
                    {card.candidate.subtitleCueCount > 0 ? `字幕 ${card.candidate.subtitleCueCount} 条` : '字幕待生成'}
                  </span>
                </div>
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
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2">
                <span className="text-[11px] text-ink-tertiary">{card.nextAction}</span>
                <span className="flex flex-wrap gap-2">
                  {card.narrationTask?.status === 'failed' && (
                    <button type="button" className="btn-secondary h-8 px-3 text-xs text-fail" disabled={phaseEBusy !== null} onClick={() => onRetryNarration(card.narrationTask!.id)}>
                      {phaseEBusy === `narration:${card.narrationTask.id}` ? '重试中…' : '重试配音'}
                    </button>
                  )}
                  {card.task && (
                    <button
                      type="button"
                      className="btn-secondary h-8 px-3 text-xs"
                      disabled={phaseEBusy !== null || card.task.status === 'running' || card.task.status === 'queued'}
                      onClick={() => onRetryRender(card.task!.id)}
                    >{card.task.status === 'failed' ? '重试渲染' : '重新生成'}</button>
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

      {previewCard && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="batch-output-preview-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="max-h-[90vh] w-full max-w-3xl space-y-4 overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 id="batch-output-preview-title" className="font-semibold text-ink">
                  成片 {String(previewCard.seq).padStart(2, '0')} · {previewCard.scriptTitle || '未命名脚本'}
                </h3>
                <p className="mt-1 text-xs text-ink-secondary">
                  {CARD_STATUS_LABELS[previewCard.status]} · {previewCard.nextAction}
                  {previewCard.publishable && (previewCard.approved ? ' · 已通过审核' : ' · 待审核')}
                </p>
              </div>
              <button
                ref={previewCloseButtonRef}
                type="button"
                className="btn-secondary text-xs"
                aria-label="关闭成片预览"
                onClick={() => setPreviewCard(null)}
              >关闭</button>
            </div>
            {previewVideo && (
              <video
                key={`${previewCard.planId}-${previewCard.versionId}`}
                className="aspect-video w-full rounded-xl bg-black"
                controls
                autoFocus
                preload="metadata"
                data-testid={`batch-output-preview-${previewCard.planId}`}
              >
                <source src={previewVideo} type="video/mp4" />
              </video>
            )}
            {(previewCard.blockers.length > 0 || previewCard.warnings.length > 0 || previewCard.task?.errorMessage) && (
              <ul className="space-y-1 text-xs text-warn">
                {previewCard.blockers.map((message) => <li key={`b-${message}`}>无法继续：{message}</li>)}
                {previewCard.warnings.map((message) => <li key={`w-${message}`}>提醒：{message}</li>)}
                {previewCard.task?.errorMessage && <li>任务失败：{previewCard.task.errorMessage}</li>}
              </ul>
            )}
            {previewCover && (
              <figure className="overflow-hidden rounded-xl border border-hairline bg-surface-subtle">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewCover} alt={`成片 ${previewCard.seq} 封面`} className="aspect-[3/4] w-full max-w-56 object-cover" />
              </figure>
            )}
            {previewCard.coverRange && (
              <div className="tile space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-ink">封面抽帧时间</p>
                  <span className="text-xs text-ink-secondary">
                    {coverDraftUs == null ? '—' : `${(coverDraftUs / 1_000_000).toFixed(2)} 秒`}
                    <span className="text-ink-tertiary">（第一镜头原片区间 {(previewCard.coverRange.startUs / 1_000_000).toFixed(1)}–{(previewCard.coverRange.endUs / 1_000_000).toFixed(1)} 秒）</span>
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="封面抽帧时间"
                  min={previewCard.coverRange.startUs}
                  max={Math.max(previewCard.coverRange.startUs, previewCard.coverRange.endUs - 1)}
                  step={100_000}
                  value={coverDraftUs ?? previewCard.coverRange.currentUs}
                  onChange={(event) => setCoverDraftUs(Number(event.target.value))}
                  className="w-full"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-ink-tertiary">封面始终从原片抽帧，不裁剪成片画面。封面同时是成片开头的片头静帧，所以应用后会重新渲染这一条成片，再重新导出才会更新成品。</p>
                  <button
                    type="button"
                    className="btn-primary h-9 px-3 text-xs"
                    disabled={coverBusy === previewCard.planId || coverDraftUs == null || coverDraftUs === previewCard.coverRange.currentUs}
                    onClick={() => onChangeCover(previewCard.planId, coverDraftUs!)}
                  >{coverBusy === previewCard.planId ? '生成中…' : '应用新封面'}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
