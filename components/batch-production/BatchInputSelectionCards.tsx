'use client';

import type { PrepareAssetView, PrepareScriptView, PrepareSourceView } from '@/lib/batch-production/prepare';
import type { BatchSnapshotDetail } from '@/lib/batch-production/batch-flow';

const HEALTH_LABELS: Record<PrepareSourceView['health'], string> = {
  healthy: '可用',
  changed: '内容已变化',
  offline: '离线',
};

function sourcePresentation(source: PrepareSourceView): { label: string; detail: string; health: string } {
  const health = HEALTH_LABELS[source.health];
  switch (source.location.kind) {
    case 'module4':
      return { label: '模块 4', detail: `视频任务 ${source.location.videoJobId}`, health };
    case 'managed':
      return {
        label: '托管副本',
        detail: source.location.relativePath.split(/[\\/]/).at(-1) || '受管文件',
        health,
      };
    case 'linked':
      return {
        label: '链接原文件',
        detail: source.location.absolutePath.split(/[\\/]/).at(-1) || '用户文件',
        health,
      };
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
          <p className="text-xs font-medium text-accent">冻结脚本快照</p>
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

export function BatchAssetSelectionCard({
  asset,
  selected,
  onSelectedChange,
}: {
  asset: PrepareAssetView;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
}) {
  const displayName = asset.media.displayName || asset.media.filename || '视频素材';
  const selectable = asset.status === 'online' && Boolean(asset.currentAnalysisId);
  return (
    <article className={`rounded-2xl border bg-white p-4 shadow-sm transition ${selected ? 'border-accent ring-2 ring-accent/10' : 'border-hairline'}`}>
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
              {asset.status === 'online' ? (asset.currentAnalysisId ? '可用' : '待分析') : asset.status === 'archived' ? '已归档' : '离线'}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-ink-secondary">
            {typeof asset.media.durationSec === 'number' && <span>{asset.media.durationSec.toFixed(1)} 秒</span>}
            {asset.media.width && asset.media.height && <span>{asset.media.width}×{asset.media.height}</span>}
          </div>
          {!asset.currentAnalysisId && asset.status === 'online' && (
            <p className="mt-3 rounded-xl bg-warn-tint px-3 py-2 text-xs text-ink-secondary">尚未完成素材分析，暂不可选</p>
          )}
          <div className="mt-4 space-y-2">
            {asset.sources.map((source) => <SourceRow key={source.id} source={source} />)}
          </div>
        </div>
      </div>
    </article>
  );
}
