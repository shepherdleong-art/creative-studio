'use client';

import { memo, useState } from 'react';
import type { PrepareAssetView, PrepareScriptView, PrepareSourceView } from '@/lib/batch-production/prepare';
import type { BatchSnapshotDetail } from '@/lib/batch-production/batch-flow';
import type { BatchLutRow } from '@/lib/batch-production/lut-catalog';

/**
 * The prepare endpoint grows these presentation fields independently from the
 * persisted asset domain model. Keep them optional here so the preparation
 * panel can still render an older server response while a fresh response is
 * being loaded after an analysis task completes.
 */
export type PrepareAssetAnalysisLevel = 'none' | 'technical' | 'content';

export type PrepareAssetCardView = PrepareAssetView & {
  analysisLevel?: PrepareAssetAnalysisLevel;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
};

export interface AssetPrepareTaskView {
  id: string;
  targetId: string;
  status: string;
  progressJson?: unknown;
  attemptCount?: number;
  attempts?: Array<{
    attemptNumber: number;
    status: string;
    errorMessage: string | null;
    progressJson?: unknown;
  }>;
}

const HEALTH_LABELS: Record<PrepareSourceView['health'], string> = {
  healthy: '可用',
  changed: '内容已变化',
  offline: '离线',
};

function sourcePresentation(source: PrepareSourceView): { label: string; detail: string; health: string } {
  const health = HEALTH_LABELS[source.health];
  switch (source.sourceKind) {
    case 'module4':
      return { label: '模块 4', detail: source.displayName, health };
    case 'managed':
      return { label: '托管副本', detail: source.displayName, health };
    case 'linked':
      return { label: '链接原文件', detail: source.displayName, health };
  }
}

function SourceRow({ source }: { source: PrepareSourceView }) {
  const presentation = sourcePresentation(source);
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-subtle px-3 py-2 text-xs">
      <span className="min-w-0 truncate text-ink-secondary">{presentation.label} · {presentation.detail}</span>
      <span className={source.health === 'healthy' ? 'text-ok' : 'text-fail'}>{presentation.health}</span>
    </div>
  );
}

export function BatchScriptSelectionCard({
  script,
  selected,
  copyCount,
  onSelectedChange,
  onCopyCountChange,
}: {
  script: PrepareScriptView;
  selected: boolean;
  copyCount: number;
  onSelectedChange: (selected: boolean) => void;
  onCopyCountChange: (copyCount: number) => void;
}) {
  const cover = script.coverTitle;
  const title = script.title || '未命名脚本';
  return (
    <article className={`rounded-2xl border bg-white p-4 shadow-sm transition ${selected ? 'border-accent ring-2 ring-accent/10' : 'border-hairline'}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          aria-label={`选择脚本 ${title}`}
          checked={selected}
          onChange={(event) => onSelectedChange(event.target.checked)}
          className="mt-1 h-4 w-4 accent-[var(--accent)]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-accent">{cover.primary || '项目脚本'}</p>
              <h3 className="mt-1 font-semibold text-ink">{title}</h3>
            </div>
            <span className="rounded-full bg-surface-subtle px-2 py-1 text-[11px] text-ink-secondary">V{script.sourceVersion}</span>
          </div>
          {cover.secondary && <p className="mt-1 text-xs text-ink-secondary">{cover.secondary}</p>}
          <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{script.bodyText}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-ink-tertiary">
            <span>分镜组 {script.shotSetId}</span>
            <span>修订 {script.contentRevision.slice(0, 8)}</span>
          </div>
          <label className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-surface-subtle px-3 py-2 text-sm text-ink-secondary">
            <span>生成份数</span>
            <input
              type="number"
              min={1}
              max={99}
              step={1}
              disabled={!selected}
              aria-label={`${title} 生成份数`}
              value={copyCount}
              onChange={(event) => onCopyCountChange(Math.max(1, Number.parseInt(event.target.value, 10) || 1))}
              className="w-20 rounded-lg border border-hairline bg-white px-2 py-1 text-right text-ink disabled:opacity-50"
            />
          </label>
        </div>
      </div>
    </article>
  );
}

export function BatchFrozenScriptCard({
  snapshot,
}: {
  snapshot: BatchSnapshotDetail['scriptSnapshots'][number];
}) {
  return (
    <article className="rounded-2xl border border-accent/30 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-accent">已锁定的脚本快照</p>
          <h3 className="mt-1 font-semibold text-ink">{snapshot.title || '未命名脚本'}</h3>
        </div>
        <span className="rounded-full bg-surface-subtle px-2 py-1 text-[11px] text-ink-secondary">
          V{snapshot.sourceVersion} · {snapshot.copyCount} 份
        </span>
      </div>
      {snapshot.coverTitle.primary && (
        <p className="mt-2 text-sm font-medium text-ink">{snapshot.coverTitle.primary}</p>
      )}
      {snapshot.coverTitle.secondary && (
        <p className="mt-1 text-xs text-ink-secondary">{snapshot.coverTitle.secondary}</p>
      )}
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{snapshot.bodyText}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-ink-tertiary">
        <span>分镜组 {snapshot.shotSetId}</span>
        <span>修订 {snapshot.contentRevision.slice(0, 8)}</span>
      </div>
    </article>
  );
}

export const BatchAssetSelectionCard = memo(function BatchAssetSelectionCard({
  asset,
  selected,
  onSelectedChange,
  luts,
  lutId,
  onLutChange,
  onRequestProxy,
  proxyBusy,
  analysisTask,
  onAnalyze,
  onAnalyzeContent,
  onRetryAnalyze,
  onResync,
  analyzeBusy,
  onPreview,
  previewBadge,
}: {
  asset: PrepareAssetCardView;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  luts?: BatchLutRow[];
  lutId?: string | null;
  onLutChange?: (lutId: string | null) => void;
  onRequestProxy?: () => void;
  proxyBusy?: boolean;
  analysisTask?: AssetPrepareTaskView;
  onAnalyze?: () => void;
  onAnalyzeContent?: () => void;
  onRetryAnalyze?: () => void;
  onResync?: () => void;
  analyzeBusy?: boolean;
  onPreview?: () => void;
  /** 预览来源信息(低清预览片/原片/LUT 待生成警告等) */
  previewBadge?: React.ReactNode;
}) {
  const displayName = asset.media.displayName || asset.media.filename || '视频素材';
  const selectable = asset.status === 'online' && Boolean(asset.currentAnalysisId);
  const [thumbnailFailedUrl, setThumbnailFailedUrl] = useState<string | null>(null);
  const thumbnailFailed = Boolean(asset.thumbnailUrl && thumbnailFailedUrl === asset.thumbnailUrl);

  const progress = (analysisTask?.progressJson && typeof analysisTask.progressJson === 'object'
    ? analysisTask.progressJson
    : null) as { phase?: string; description?: string; percent?: number | null } | null;
  const phaseLabels: Record<string, string> = {
    locating: '定位来源',
    probing: '探测媒体',
    content_analyzing: '画面内容分析',
    verified: '媒体核验完成',
    analyzed: '基础分析完成',
  };
  const taskStatus = analysisTask?.status;
  const taskError = analysisTask?.attempts?.at(-1)?.errorMessage;
  const analysisLevel = asset.analysisLevel ?? (asset.currentAnalysisId ? 'technical' : 'none');
  const analysisLabel = analysisLevel === 'content' ? '内容分析可用' : '基础分析可用';
  const previewAvailable = Boolean(asset.status === 'online' && asset.previewUrl && onPreview);

  function renderAnalysisAction() {
    if (asset.status !== 'online') {
      return (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warn-tint px-3 py-2 text-xs text-ink-secondary">
          <span>{asset.status === 'archived' ? '素材已归档，暂不可入池。' : '素材来源离线，暂不可入池。'}</span>
          {onResync && <button type="button" className="text-accent underline" onClick={onResync}>重新同步素材状态</button>}
        </div>
      );
    }
    if (asset.currentAnalysisId) {
      return (
        <div className="mt-3 space-y-2 rounded-xl bg-ok/10 px-3 py-2 text-xs text-ink-secondary" role="status">
          <p className="font-medium text-ok">{analysisLabel}</p>
          {analysisLevel !== 'content' && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>当前只有媒体参数；内容分析后才能按画面语义分配。</p>
              {onAnalyzeContent && (
                <button type="button" className="text-accent underline" disabled={analyzeBusy} onClick={onAnalyzeContent}>
                  {analyzeBusy ? '分析中…' : '补充内容分析'}
                </button>
              )}
            </div>
          )}
        </div>
      );
    }
    if (taskStatus === 'queued' || taskStatus === 'running') {
      const phaseLabel = progress?.phase ? phaseLabels[progress.phase] : undefined;
      const description = phaseLabel || progress?.description || (taskStatus === 'queued' ? '等待分析任务' : '分析中');
      return (
        <div className="mt-3 space-y-1 rounded-xl bg-accent/10 px-3 py-2 text-xs text-ink-secondary" role="status" aria-live="polite">
          <p className="font-medium text-accent">{description}</p>
          <p>{taskStatus === 'queued' ? '排队中，开始后会定位来源并探测媒体。' : '正在处理；FFprobe 阶段不可测进度。'}</p>
        </div>
      );
    }
    if (taskStatus === 'failed') {
      return (
        <div className="mt-3 space-y-2 rounded-xl bg-fail/10 px-3 py-2 text-xs text-fail" role="alert">
          <p className="font-medium">基础分析失败</p>
          <p>{taskError || '未能完成媒体探测，请重试。'}</p>
          {onRetryAnalyze && <button type="button" className="underline" disabled={analyzeBusy} onClick={onRetryAnalyze}>{analyzeBusy ? '重试中…' : '重试'}</button>}
        </div>
      );
    }
    if (taskStatus === 'succeeded') {
      return <p className="mt-3 rounded-xl bg-accent/10 px-3 py-2 text-xs text-accent" role="status">基础分析已完成，正在同步素材状态…</p>;
    }
    return (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warn-tint px-3 py-2 text-xs text-ink-secondary">
        <span>尚未完成基础分析，暂不可选。</span>
        {onAnalyze && <button type="button" className="btn-primary h-8 px-3 text-xs" disabled={analyzeBusy} onClick={onAnalyze}>{analyzeBusy ? '分析中…' : '开始分析'}</button>}
      </div>
    );
  }

  return (
    <article className={`rounded-2xl border bg-white p-4 shadow-sm transition ${selected ? 'border-accent ring-2 ring-accent/10' : 'border-hairline'}`}>
      <div className="space-y-3">
        <div className="relative aspect-video overflow-hidden rounded-xl border border-hairline bg-surface-subtle">
          {asset.thumbnailUrl && !thumbnailFailed ? (
            <button
              type="button"
              className="block h-full w-full cursor-pointer text-left"
              aria-label={`预览素材 ${displayName}`}
              disabled={!previewAvailable}
              onClick={onPreview}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={asset.thumbnailUrl}
                alt={`${displayName} 缩略图`}
                loading="lazy"
                onError={() => setThumbnailFailedUrl(asset.thumbnailUrl ?? null)}
                className="h-full w-full object-cover"
              />
            </button>
          ) : (
            <button
              type="button"
              className="flex h-full w-full items-center justify-center text-sm text-ink-tertiary"
              aria-label={`预览素材 ${displayName}`}
              disabled={!previewAvailable}
              onClick={onPreview}
            >
              缩略图暂不可用
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {onPreview && (
            <button type="button" className="text-xs text-accent underline" disabled={!previewAvailable} onClick={onPreview}>
              预览
            </button>
          )}
        </div>
        <div className="flex items-start gap-3">
        <input
          type="checkbox"
          aria-label={`选择素材 ${displayName}`}
          checked={selected}
          disabled={!selectable}
          onChange={(event) => onSelectedChange(event.target.checked)}
          className="mt-1 h-4 w-4 accent-[var(--accent)] disabled:opacity-40"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-ink-tertiary">项目素材</p>
              <h3 className="mt-1 font-semibold text-ink">{displayName}</h3>
            </div>
            <span className={`rounded-full px-2 py-1 text-[11px] ${selectable ? 'bg-ok/10 text-ok' : 'bg-fail/10 text-fail'}`}>
              {asset.status === 'online' ? (asset.currentAnalysisId ? analysisLabel : '待分析') : asset.status === 'archived' ? '已归档' : '离线'}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-ink-secondary">
            {typeof asset.media.durationSec === 'number' && <span>{asset.media.durationSec.toFixed(1)} 秒</span>}
            {asset.media.width && asset.media.height && <span>{asset.media.width}×{asset.media.height}</span>}
          </div>
          {previewBadge}
          {renderAnalysisAction()}
          <div className="mt-4 space-y-2">
            {asset.sources.map((source) => <SourceRow key={source.id} source={source} />)}
          </div>
          {selected && luts && onLutChange && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="flex-1 text-xs text-ink-secondary">
                <span className="mb-1 block">LUT</span>
                <select
                  aria-label={`${displayName} 的 LUT`}
                  value={lutId ?? ''}
                  onChange={(event) => onLutChange(event.target.value || null)}
                  className="h-9 w-full rounded-lg border border-hairline bg-white px-2 text-ink"
                >
                  <option value="">关闭</option>
                  {luts.filter((lut) => lut.status === 'active').map((lut) => (
                    <option key={lut.id} value={lut.id}>{lut.displayName}</option>
                  ))}
                </select>
              </label>
              {onRequestProxy && (
                <button
                  type="button"
                  className="btn-secondary h-9 self-end px-3 text-xs"
                  disabled={proxyBusy}
                   onClick={onRequestProxy}
                >{proxyBusy ? '请求中…' : '为当前素材生成代理'}</button>
              )}
            </div>
          )}
        </div>
      </div>
      </div>
    </article>
  );
});
