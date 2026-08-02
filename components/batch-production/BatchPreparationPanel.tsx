'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  BatchPreparationResult,
  PrepareAssetView,
  PrepareScriptView,
  PrepareSourceView,
} from '@/lib/batch-production/prepare';

interface ReadinessResponse {
  available: boolean;
  message: string;
  code?: string;
}

interface BatchPreparationPanelProps {
  projectId: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

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

function ScriptCard({ script }: { script: PrepareScriptView }) {
  const cover = script.coverTitle;
  return (
    <article className="rounded-2xl border border-hairline bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-accent">{cover.primary || '项目脚本'}</p>
          <h3 className="mt-1 font-semibold text-ink">{script.title || '未命名脚本'}</h3>
        </div>
        <span className="rounded-full bg-surface-subtle px-2 py-1 text-[11px] text-ink-secondary">V{script.sourceVersion}</span>
      </div>
      {cover.secondary && <p className="mt-1 text-xs text-ink-secondary">{cover.secondary}</p>}
      <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{script.bodyText}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-ink-tertiary">
        <span>分镜组 {script.shotSetId}</span>
        <span>修订 {script.contentRevision.slice(0, 8)}</span>
      </div>
    </article>
  );
}

function AssetCard({ asset }: { asset: PrepareAssetView }) {
  const displayName = asset.media.displayName || asset.media.filename || '视频素材';
  return (
    <article className="rounded-2xl border border-hairline bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-ink-tertiary">项目素材</p>
          <h3 className="mt-1 font-semibold text-ink">{displayName}</h3>
        </div>
        <span className={`rounded-full px-2 py-1 text-[11px] ${asset.status === 'online' ? 'bg-ok/10 text-ok' : 'bg-fail/10 text-fail'}`}>
          {asset.status === 'online' ? '可用' : asset.status === 'archived' ? '已归档' : '离线'}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-ink-secondary">
        {typeof asset.media.durationSec === 'number' && <span>{asset.media.durationSec.toFixed(1)} 秒</span>}
        {asset.media.width && asset.media.height && <span>{asset.media.width}×{asset.media.height}</span>}
      </div>
      <div className="mt-4 space-y-2">
        {asset.sources.map((source) => (
          <SourceRow key={source.id} source={source} />
        ))}
      </div>
    </article>
  );
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

export default function BatchPreparationPanel({ projectId }: BatchPreparationPanelProps) {
  const [preparation, setPreparation] = useState<BatchPreparationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const readiness = await readJson<ReadinessResponse>(await fetch('/api/batch-production/readiness', { cache: 'no-store' }));
      if (!readiness.available) throw new Error(readiness.message || '批量生产暂不可用');
      const result = await readJson<BatchPreparationResult>(await fetch(
        `/api/batch-production/prepare?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
      setPreparation(result);
    } catch (loadError) {
      setPreparation(null);
      setError(loadError instanceof Error ? loadError.message : '无法读取批量准备区');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (loading) {
    return <div className="card p-8 text-center text-sm text-ink-secondary">正在同步项目脚本和素材…</div>;
  }

  if (error) {
    return (
      <section className="card p-6">
        <h2 className="font-semibold text-ink">批量准备区暂不可用</h2>
        <p className="mt-2 text-sm text-fail">{error}</p>
        <button type="button" className="btn-secondary mt-4" onClick={() => void load()}>重新检查</button>
      </section>
    );
  }

  if (!preparation) return null;

  const onlineAssets = preparation.assets.filter(({ status }) => status === 'online').length;
  return (
    <section className="space-y-5" aria-label="批量生产准备区">
      <header className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">Phase A · 项目输入</p>
          <h2 className="mt-1 text-lg font-semibold text-ink">批量生产准备区</h2>
          <p className="mt-1 text-sm text-ink-secondary">已自动同步项目脚本和成功视频；本阶段只核对输入，不会创建批次或开始生产。</p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void load()}>重新同步</button>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="tile p-4"><p className="text-xs text-ink-tertiary">项目脚本</p><strong className="mt-1 block text-2xl text-ink">{preparation.scripts.length}</strong></div>
        <div className="tile p-4"><p className="text-xs text-ink-tertiary">项目素材</p><strong className="mt-1 block text-2xl text-ink">{preparation.assets.length}</strong></div>
        <div className="tile p-4"><p className="text-xs text-ink-tertiary">当前可用</p><strong className="mt-1 block text-2xl text-ok">{onlineAssets}</strong></div>
      </div>

      {preparation.warnings.length > 0 && (
        <div className="rounded-2xl border border-warn/30 bg-warn-tint p-4 text-sm text-ink-secondary">
          <p className="font-medium text-ink">需要留意</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">{preparation.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>
      )}

      <section>
        <div className="mb-3 flex items-end justify-between gap-3"><div><h3 className="font-semibold text-ink">项目脚本</h3><p className="mt-1 text-sm text-ink-secondary">来自第 3 步中仍然有效的已保存脚本。</p></div></div>
        {preparation.scripts.length > 0
          ? <div className="grid gap-3 lg:grid-cols-2">{preparation.scripts.map((script) => <ScriptCard key={script.id} script={script} />)}</div>
          : <div className="tile p-6 text-sm text-ink-secondary">暂无可用项目脚本，请先在第 3 步保存脚本。</div>}
      </section>

      <section>
        <div className="mb-3"><h3 className="font-semibold text-ink">项目素材</h3><p className="mt-1 text-sm text-ink-secondary">汇总当前项目的模块 4、托管和链接来源。</p></div>
        {preparation.assets.length > 0
          ? <div className="grid gap-3 lg:grid-cols-2">{preparation.assets.map((asset) => <AssetCard key={asset.id} asset={asset} />)}</div>
          : <div className="tile p-6 text-sm text-ink-secondary">暂无可用视频素材，请先在第 4 步完成视频生成。</div>}
      </section>

      <footer className="rounded-2xl border border-dashed border-hairline p-4 text-sm text-ink-secondary">
        下一阶段将支持选择脚本、设置生成份数并建立批次快照；当前不会提前执行这些操作。
      </footer>
    </section>
  );
}
