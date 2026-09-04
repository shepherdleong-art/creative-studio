'use client';

import { useEffect, useRef, useState } from 'react';
import type { BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';
import type { OutputPresetId } from '@/lib/final-edit/types';
import BatchOutputEditor from './BatchOutputEditor';

export type CardFilter = 'all' | BatchWorkspaceView['cards'][number]['status'];

/**
 * 分配器已知警告码 → 用户可读文案(卡片提醒与编辑器弹窗两处共用)。
 * 带冒号的按前缀匹配(码后面跟着 segment/asset 等内部 ID),其余精确匹配;未知码原样显示。
 */
const BATCH_WARNING_TEXTS: Array<{ code: string; text: string; prefix: boolean }> = [
  { code: 'previous-version-reused:', text: '换一批画面后素材池不足，沿用了上一版的部分画面', prefix: true },
  { code: 'stitched-segment:', text: '单条素材装不下这段口播，已自动拼接多个镜头', prefix: true },
  { code: 'source-overlap:', text: '部分画面区间与其他片段重复', prefix: true },
  { code: 'analysis-fallback:', text: '该素材没有画面分析，使用了兜底匹配', prefix: true },
  { code: 'semantic-degraded:', text: '该片段语义匹配度较低', prefix: true },
  { code: 'opening-reused:', text: '开头画面与其他成片重复', prefix: true },
  { code: 'no-legal-media:', text: '没有可用素材', prefix: true },
  { code: 'cover-unavailable', text: '封面抽帧不可用', prefix: false },
];

export function humanizeBatchWarning(warning: string): string {
  const hit = BATCH_WARNING_TEXTS.find(({ code, prefix }) => (prefix ? warning.startsWith(code) : warning === code));
  return hit ? hit.text : warning;
}

export interface BatchStepReviewProps {
  workspace: BatchWorkspaceView;
  cardFilter: CardFilter;
  onCardFilterChange: (filter: CardFilter) => void;
  selectedPlanIds: string[];
  onTogglePlan: (planId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onReview: (decision: 'approved' | 'rework' | 'cancelled') => void;
  phaseEBusy: string | null;
  onRetryRender: (taskId: string) => void;
  onRetryNarration: (taskId: string) => void;
  onReallocate: (planId: string) => void;
  onControlBatch: (action: 'pause' | 'resume' | 'stop') => void;
  projectId: string;
  selectedBatchId: string;
  /** 批量输出画幅,供片段编辑的实时预览画布与字幕参数使用 */
  outputPreset: OutputPresetId;
  /** 片段编辑生效后回调(外层刷新 workspace) */
  onOutputChanged?: () => void;
  busy: 'create' | 'snapshot' | 'start' | null;
  onStartBatch: () => void;
}

const CARD_STATUS_LABELS: Record<string, string> = {
  completed: '已通过',
  needs_attention: '需处理',
  processing: '处理中',
  waiting: '等待中',
  paused: '已暂停',
  retryable_failed: '可重试',
  stopped: '已停止',
};

const FILTERS: Array<[CardFilter, string]> = [
  ['all', '全部'],
  ['completed', '已通过'],
  ['needs_attention', '需处理'],
  ['processing', '处理中'],
  ['waiting', '等待中'],
  ['paused', '已暂停'],
  ['retryable_failed', '可重试'],
  ['stopped', '已停止'],
];

/**
 * 第 3 步 · 检查成片:封面墙 + 编辑器优先。
 * 点封面直接进入片段编辑器(实时预览检查与修改);卡片勾选后批量「通过 / 返工 / 撤销」。
 * 编辑器优先模型下这里没有成片视频播放器,也不存在历史版本选择与待重渲染提示。
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
    phaseEBusy,
    onRetryNarration,
    onReallocate,
    onControlBatch,
  } = props;
  const visibleCards = workspace.cards.filter(({ status }) => cardFilter === 'all' || status === cardFilter);
  const { counts } = workspace;
  const [editorCard, setEditorCard] = useState<BatchWorkspaceView['cards'][number] | null>(null);
  const editorCloseButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!editorCard) return;
    const timer = window.setTimeout(() => editorCloseButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEditorCard(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [editorCard]);

  /** 封面墙媒体:成功封面尝试(独立封面任务/老批次完整渲染尝试)。 */
  function coverUrlOf(card: BatchWorkspaceView['cards'][number]): string | null {
    if (!card.coverAttemptId) return null;
    const params = new URLSearchParams({
      projectId: props.projectId,
      kind: 'cover',
      source: 'candidate',
      renderAttemptId: card.coverAttemptId,
    });
    return `/api/batch-production/batches/${encodeURIComponent(props.selectedBatchId)}/outputs/${encodeURIComponent(card.planId)}/media?${params.toString()}`;
  }

  /** 只有「口播 + 封面」都就绪的卡片才能勾选通过。 */
  const selectableCount = workspace.cards.filter(({ approvable }) => approvable).length;
  const allSelected = selectableCount > 0 && workspace.cards.every(({ planId, approvable }) => !approvable || selectedPlanIds.includes(planId));
  const awaitingReview = workspace.cards.filter(({ approvable, approved }) => approvable && !approved).length;
  // 一条都不可勾选时的原因归类:配音未完成 / 配音失败 / 封面失败 / 其他阻塞。
  const narrationActiveCount = workspace.cards.filter((card) => (
    card.narrationTask && (card.narrationTask.status === 'queued' || card.narrationTask.status === 'running')
  )).length;
  const narrationFailedCount = workspace.cards.filter((card) => card.narrationTask?.status === 'failed').length;
  const coverFailedCount = workspace.cards.filter(({ coverStatus }) => coverStatus === 'failed').length;
  const otherBlockers = [...new Set(
    workspace.cards.filter(({ approvable }) => !approvable).flatMap((card) => card.blockers),
  )];

  const modalCard = editorCard ? workspace.cards.find((card) => card.planId === editorCard.planId) ?? editorCard : null;

  return (
    <div className="min-h-0 flex-1 space-y-4 p-2">
      <div className="card space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-ink">检查成片</h3>
            <p className="mt-1 text-sm text-ink-secondary">点封面直接进编辑器检查和修改；勾选后批量「通过 / 返工 / 撤销」。通过后的成片才能正式导出。</p>
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
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">可审核</p><strong className="text-xl text-ok">{counts.approvable}</strong></div>
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
            <span className="text-xs text-ink-secondary">已选 {selectedPlanIds.length} 条{awaitingReview > 0 && ` · ${awaitingReview} 条可审核但尚未通过`}</span>
            {selectableCount === 0 && workspace.cards.length > 0 && (
              <span className="text-xs text-warn" role="status">
                {narrationActiveCount > 0 && ` · ${narrationActiveCount} 条正在生成配音，完成后自动生成封面`}
                {narrationFailedCount > 0 && ` · ${narrationFailedCount} 条配音失败，请在卡片上点「重试配音」`}
                {coverFailedCount > 0 && ` · ${coverFailedCount} 条封面生成失败，请在卡片上点「重试封面」`}
                {narrationActiveCount === 0 && narrationFailedCount === 0 && coverFailedCount === 0 && otherBlockers.length > 0 && ` · ${otherBlockers.join('；')}`}
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
          const coverUrl = coverUrlOf(card);
          const coverProgress = card.coverTask?.progress as { phase?: string; percent?: number | null; description?: string } | null;
          const fullProgress = card.fullRenderTask?.progress as { phase?: string; percent?: number | null; description?: string } | null;
          const progress = coverProgress ?? fullProgress;
          return (
            <article key={card.planId} data-testid="batch-output-card" className="tile flex min-w-0 flex-col space-y-3 p-3">
              <button
                type="button"
                className="group relative block w-full overflow-hidden rounded-xl bg-surface-subtle text-left"
                aria-label={`编辑成片 ${card.seq} ${card.scriptTitle || ''}`}
                disabled={!card.reviewable}
                onClick={() => setEditorCard(card)}
              >
                {coverUrl ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      key={`${card.planId}-${card.coverAttemptId}`}
                      src={coverUrl}
                      alt={`成片 ${card.seq} 封面`}
                      loading="lazy"
                      className="aspect-[3/4] w-full object-cover transition group-hover:scale-[1.02]"
                      data-testid={`batch-output-cover-${card.planId}`}
                    />
                    <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 pb-2 pt-8 text-xs font-medium text-white opacity-0 transition group-hover:opacity-100">
                      点击进编辑器检查修改
                    </span>
                  </>
                ) : (
                  <span className="flex aspect-[3/4] w-full items-center justify-center text-xs text-ink-tertiary">
                    {card.coverStatus === 'failed' ? '封面生成失败' : '暂无封面预览'}
                  </span>
                )}
              </button>
              <div className="flex items-start justify-between gap-2">
                <label className="flex min-w-0 items-start gap-2">
                  <input
                    type="checkbox"
                    aria-label={`选择成片 ${card.seq}`}
                    checked={selectedPlanIds.includes(card.planId)}
                    disabled={!card.approvable}
                    title={card.approvable ? undefined : card.coverStatus === 'failed' ? '封面生成失败，请先重试封面' : card.coverStatus === 'queued' || card.coverStatus === 'running' ? '封面还在生成中' : '这条成片还没有配音，暂时无法通过'}
                    onChange={(event) => onTogglePlan(card.planId, event.target.checked)}
                    className="mt-0.5 disabled:opacity-40"
                  />
                  <span className="min-w-0">
                    <span className="block text-[11px] text-ink-tertiary">
                      成片 {String(card.seq).padStart(2, '0')} · v{card.versionNumber ?? '—'}
                    </span>
                    <strong className="mt-0.5 block truncate text-xs font-medium text-ink">{card.scriptTitle || '未命名脚本'}</strong>
                  </span>
                </label>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${card.status === 'completed' ? 'bg-ok/10 text-ok' : card.status === 'retryable_failed' || card.status === 'stopped' ? 'bg-fail/10 text-fail' : card.status === 'needs_attention' ? 'bg-warn/20 text-warn' : 'bg-accent/10 text-accent'}`}>
                    {CARD_STATUS_LABELS[card.status]}
                  </span>
                  {card.approvable && (
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${card.approved ? 'bg-accent/10 text-accent' : 'bg-warn/20 text-warn'}`}>
                      {card.approved ? '已通过' : '待审核'}
                    </span>
                  )}
                  {card.formalOutdated && (
                    <span className="rounded-full bg-warn/20 px-2 py-0.5 text-[11px] text-warn">修改未导出</span>
                  )}
                </span>
              </div>
              {progress && (
                <div className="text-xs text-ink-secondary">
                  <p>{(progress.description) || card.nextAction}{typeof progress.percent === 'number' ? ` · ${Math.round(progress.percent * 100)}%` : ''}</p>
                  {typeof progress.percent === 'number' && <progress className="mt-1 w-full" max={1} value={progress.percent} />}
                </div>
              )}
              {(card.blockers.length > 0 || card.warnings.length > 0 || card.coverTask?.errorMessage || card.fullRenderTask?.errorMessage) && (
                <ul className="space-y-1 text-xs text-warn">
                  {card.blockers.map((message) => <li key={`b-${message}`}>无法继续：{humanizeBatchWarning(message)}</li>)}
                  {card.warnings.map((message) => <li key={`w-${message}`}>提醒：{humanizeBatchWarning(message)}</li>)}
                  {card.coverTask?.errorMessage && <li>封面任务失败：{card.coverTask.errorMessage}</li>}
                  {card.fullRenderTask?.errorMessage && <li>渲染任务失败：{card.fullRenderTask.errorMessage}</li>}
                </ul>
              )}
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2">
                <span className="text-[11px] text-ink-tertiary">{card.nextAction}</span>
                <span className="flex flex-wrap gap-2">
                  {card.narrationTask?.status === 'failed' && (
                    <button type="button" className="btn-secondary h-8 px-3 text-xs text-fail" disabled={phaseEBusy !== null} onClick={() => {
                      if (card.subtitleOverride && !window.confirm('重试配音会清除这条成片的手动字幕覆盖，并按新口播重新生成自动字幕。确定继续吗？')) return;
                      onRetryNarration(card.narrationTask!.id);
                    }}>
                      {phaseEBusy === `narration:${card.narrationTask.id}` ? '重试中…' : '重试配音'}
                    </button>
                  )}
                  {card.coverStatus === 'failed' && card.coverTask && (
                    <button
                      type="button"
                      className="btn-secondary h-8 px-3 text-xs text-fail"
                      disabled={phaseEBusy !== null}
                      onClick={() => props.onRetryRender(card.coverTask!.id)}
                    >{phaseEBusy === `render:${card.coverTask.id}` ? '重试中…' : '重试封面'}</button>
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

      {editorCard && modalCard && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="batch-output-editor-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="flex h-[calc(100vh-2rem)] max-h-[96vh] w-full max-w-[96vw] flex-col gap-3 overflow-hidden rounded-2xl bg-surface p-4 shadow-xl">
            <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
              <div>
                <h3 id="batch-output-editor-title" className="font-semibold text-ink">
                  成片 {String(modalCard.seq).padStart(2, '0')} · {modalCard.scriptTitle || '未命名脚本'}
                </h3>
                <p className="mt-1 text-xs text-ink-secondary">
                  {CARD_STATUS_LABELS[modalCard.status]} · {modalCard.nextAction}
                  {modalCard.approvable && (modalCard.approved ? ' · 已通过审核' : ' · 待审核')}
                  {modalCard.formalOutdated && ' · 当前修改尚未导出'}
                </p>
              </div>
              <span className="flex shrink-0 gap-2">
                <button
                  ref={editorCloseButtonRef}
                  type="button"
                  className="btn-secondary text-xs"
                  aria-label="关闭成片编辑器"
                  onClick={() => setEditorCard(null)}
                >关闭</button>
              </span>
            </div>
            {(modalCard.blockers.length > 0 || modalCard.warnings.length > 0 || modalCard.coverTask?.errorMessage) && (
              <ul className="shrink-0 space-y-1 text-xs text-warn">
                {modalCard.blockers.map((message) => <li key={`b-${message}`}>无法继续：{humanizeBatchWarning(message)}</li>)}
                {modalCard.warnings.map((message) => <li key={`w-${message}`}>提醒：{humanizeBatchWarning(message)}</li>)}
                {modalCard.coverTask?.errorMessage && <li>封面任务失败：{modalCard.coverTask.errorMessage}</li>}
              </ul>
            )}
            <div className="min-h-0 flex-1 overflow-hidden" data-testid="batch-output-editor-layout">
              <BatchOutputEditor
                projectId={props.projectId}
                batchId={props.selectedBatchId}
                planId={modalCard.planId}
                outputPreset={props.outputPreset}
                renderBusy={false}
                candidateRenderAttemptId={modalCard.coverAttemptId}
                onChanged={props.onOutputChanged}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}