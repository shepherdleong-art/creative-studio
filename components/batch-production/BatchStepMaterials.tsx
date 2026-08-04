'use client';

import { useRef, useState } from 'react';
import type { BatchPreparationResult } from '@/lib/batch-production/prepare';
import type { BatchLutRow } from '@/lib/batch-production/lut-catalog';
import type { BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';
import {
  type AssetPrepareTaskView,
  BatchAssetSelectionCard,
  type PrepareAssetCardView,
} from './BatchInputSelectionCards';

export interface AssetSelectionState {
  analysisId: string;
  lutId: string | null;
}

export interface VisionProviderView {
  id: string;
  name: string;
  model: string;
  configured: boolean;
  supportsVision?: boolean;
}

export interface BatchStepMaterialsProps {
  prep: BatchPreparationResult;
  assetCards: PrepareAssetCardView[];
  selectableAssets: number;
  allSelectableAssetsSelected: boolean;
  selectedAssets: Record<string, AssetSelectionState>;
  luts: BatchLutRow[];
  previewInfos: Record<string, PreviewInfoLike>;
  analysisBusy: string | null;
  assetPrepareTasks: AssetPrepareTaskView[];
  analysisTaskByAsset: Map<string, AssetPrepareTaskView>;
  visionProviderId: string;
  visionProviderOptions: VisionProviderView[];
  visionProviderMissing: boolean;
  onVisionProviderChange: (providerId: string) => void;
  onToggleSelectAllAssets: () => void;
  onToggleAsset: (assetId: string) => void;
  onLutChange: (assetId: string, lutId: string | null) => void;
  onAnalyze: (assetIds: string[]) => void;
  onAnalyzeContent: (assetIds: string[]) => void;
  onRetryAnalyze: (taskId: string) => void;
  onRequestProxy: (assetIds: string[] | undefined, busyMarker: string | null) => void;
  onProxyControl: (taskId: string, action: 'pause' | 'resume' | 'cancel') => void;
  onProxyRetry: (taskId: string) => void;
  onCleanupProxies: (scope: 'selected' | 'project') => void;
  onLutAction: (lutId: string, action: 'archive' | 'restore' | 'delete') => void;
  onImportLutFile: (file: File) => void;
  onResync: () => void;
  onPreviewAsset: (asset: PrepareAssetCardView) => void;
  onToggleAssetExclusion: (assetId: string, excluded: boolean) => void;
  onStartBatch: () => void;
  onCreateVersionFromCurrent: () => void;
  renderPreviewBadge: (assetId: string) => React.ReactNode;
  frozen: boolean;
  hasConfirmedVersion: boolean;
  inputConfirmed: boolean;
  workspace: BatchWorkspaceView | null;
  proxyBusyAssetId: string | null;
  proxyBatchBusy: boolean;
  cleanupBusy: 'selected' | 'project' | null;
  cacheUsage: { count: number; totalBytes: number } | null;
  lutImporting: boolean;
  phaseEBusy: string | null;
}

interface PreviewInfoLike {
  kind: 'proxy' | 'original' | 'original_pending_lut' | 'unavailable';
  originalOnline: boolean;
  warning?: string;
}

const TASK_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
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

/**
 * 第 1 步 · 准备素材:统一的素材区 + 默认收起的「画质与调色(进阶)」。
 * 整个步骤在单一滚动容器内自然排布,没有固定高度内滚区。
 */
export default function BatchStepMaterials(props: BatchStepMaterialsProps) {
  const [mediaPrepOpen, setMediaPrepOpen] = useState(() => {
    try {
      return localStorage.getItem('batch-media-prep-open') === '1';
    } catch {
      return false;
    }
  });
  const lutFileInputRef = useRef<HTMLInputElement | null>(null);
  const {
    prep,
    assetCards,
    selectableAssets,
    allSelectableAssetsSelected,
    selectedAssets,
    luts,
    analysisBusy,
    assetPrepareTasks,
    analysisTaskByAsset,
    visionProviderId,
    visionProviderOptions,
    visionProviderMissing,
    frozen,
    hasConfirmedVersion,
    inputConfirmed,
    workspace,
    proxyBusyAssetId,
    proxyBatchBusy,
    cleanupBusy,
    cacheUsage,
    lutImporting,
    phaseEBusy,
  } = props;

  const toggleMediaPrep = () => {
    const next = !mediaPrepOpen;
    setMediaPrepOpen(next);
    try { localStorage.setItem('batch-media-prep-open', next ? '1' : '0'); } catch { /* 隐私模式忽略 */ }
  };

  const analysisCandidates = (prep.assets ?? []).filter(({ status, currentAnalysisId }) => status === 'online' && !currentAnalysisId);
  const contentAnalysisCandidates = (prep.assets ?? []).filter(({ status, analysisLevel }) => status === 'online' && analysisLevel !== 'content');

  const proxyButtonsDisabled = !hasConfirmedVersion || proxyBatchBusy;
  const proxyButtonsBlockedByUnconfirmed = !inputConfirmed && hasConfirmedVersion;

  const onlineAssetCount = prep.assets.filter(({ status }) => status === 'online').length;
  const unanalyzedCount = onlineAssetCount - selectableAssets;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-2">
      {frozen && (
        <div className="card flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <h3 className="font-semibold text-ink">已锁定的批次设置</h3>
            <p className="mt-1 text-sm text-ink-secondary">以下素材、分析版本与调色来自锁定快照，不随项目当前内容变化。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {workspace && workspace.cards.some(({ versionId }) => !versionId) && (
              <button type="button" className="btn-primary" onClick={() => props.onStartBatch()}>继续自动配画面</button>
            )}
            <button type="button" className="btn-secondary" onClick={() => props.onCreateVersionFromCurrent()}>
              基于当前项目输入创建新版本
            </button>
          </div>
        </div>
      )}

      <section className="card flex min-h-0 flex-col space-y-4 p-5" aria-label="素材区">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-ink">素材区</h3>
            <p className="mt-1 text-sm text-ink-secondary">
              当前在线 {onlineAssetCount} 条，可用（已分析）{selectableAssets} 条{unanalyzedCount > 0 ? `，${unanalyzedCount} 条待分析` : ''}。
            </p>
            {!frozen && (
              <p className="mt-1 text-xs text-ink-tertiary">勾选进入本批次的素材；未完成分析的素材不可勾选，请先发起分析。</p>
            )}
          </div>
          {!frozen && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink-secondary">已选 {Object.keys(selectedAssets).length} / 可用 {selectableAssets} 条</span>
              {visionProviderMissing ? (
                <p className="text-xs text-warn">没有开启图片理解的供应商 —— 请到「供应商设置」为任一脚本供应商开启视觉能力后再做内容分析。</p>
              ) : (
                <select
                  aria-label="内容分析模型"
                  value={visionProviderId}
                  onChange={(event) => props.onVisionProviderChange(event.target.value)}
                  className="h-10 max-w-60 rounded-xl border border-hairline bg-white px-3 text-sm text-ink"
                >
                  {visionProviderOptions.length === 0 && <option value="">未配置视觉供应商</option>}
                  {visionProviderOptions.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn-secondary"
                disabled={analysisCandidates.length === 0 || analysisBusy !== null}
                onClick={() => props.onAnalyze(analysisCandidates.map((asset) => asset.id))}
              >{analysisBusy === '__all__' ? '分析中…' : `基础分析（${analysisCandidates.length}）`}</button>
              <button
                type="button"
                className="btn-primary"
                disabled={!visionProviderId || visionProviderMissing || contentAnalysisCandidates.length === 0 || analysisBusy !== null}
                onClick={() => props.onAnalyzeContent(contentAnalysisCandidates.map((asset) => asset.id))}
              >{analysisBusy === '__all__' ? '分析中…' : `内容分析待补齐（${contentAnalysisCandidates.length}）`}</button>
              <button
                type="button"
                className="btn-secondary"
                aria-label={allSelectableAssetsSelected ? '取消全选' : '一键全选'}
                disabled={selectableAssets === 0}
                onClick={props.onToggleSelectAllAssets}
              >{allSelectableAssetsSelected ? '取消全选' : '一键全选'}</button>
            </div>
          )}
        </div>
        {frozen && (
          <div className="tile p-4 text-sm text-ink-secondary">
            <p className="font-medium text-ink">已锁定素材 · {Object.keys(selectedAssets).length} 条</p>
            <ul className="mt-2 space-y-1 text-xs text-ink-tertiary">
              {Object.entries(selectedAssets).map(([assetId, selection]) => {
                const exclusion = workspace?.exclusions.find((item) => item.assetId === assetId);
                return (
                  <li key={assetId} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      素材 {assetId.slice(0, 8)} · 分析版本 {selection.analysisId.slice(0, 8)}
                      {selection.lutId && <> · 调色滤镜 {luts.find((lut) => lut.id === selection.lutId)?.displayName ?? selection.lutId.slice(0, 8)}</>}
                      {exclusion && <> · 已排除:{exclusion.reason || '未填写原因'}</>}
                    </span>
                    {workspace && workspace.batch.controlState !== 'stopped' && (
                      <button
                        type="button"
                        className="text-xs text-accent underline"
                        disabled={phaseEBusy !== null}
                        onClick={() => props.onToggleAssetExclusion(assetId, !exclusion)}
                      >
                        {phaseEBusy === `exclude:${assetId}` ? '处理中…' : exclusion ? '恢复参与分配' : '从后续分配排除'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {!frozen && (
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-scroll overscroll-contain rounded-2xl bg-surface-subtle p-3 [scrollbar-gutter:stable]" aria-label="素材列表">
          {assetCards.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {assetCards.map((asset) => {
                const analysisTask = analysisTaskByAsset.get(asset.id);
                const assetAnalysisBusy = analysisBusy === asset.id
                  || analysisBusy === analysisTask?.id
                  || analysisBusy === '__all__';
                return (
                  <BatchAssetSelectionCard
                    key={asset.id}
                    asset={asset}
                    selected={selectedAssets[asset.id] !== undefined}
                    onSelectedChange={() => props.onToggleAsset(asset.id)}
                    luts={luts}
                    lutId={selectedAssets[asset.id]?.lutId ?? null}
                    onLutChange={(lutId) => props.onLutChange(asset.id, lutId)}
                    onRequestProxy={hasConfirmedVersion && inputConfirmed ? () => props.onRequestProxy([asset.id], asset.id) : undefined}
                    proxyBusy={proxyBusyAssetId === asset.id}
                    analysisTask={analysisTask}
                    onAnalyze={() => props.onAnalyze([asset.id])}
                    onAnalyzeContent={asset.analysisLevel !== 'content' && visionProviderId
                      ? () => props.onAnalyzeContent([asset.id])
                      : undefined}
                    onRetryAnalyze={analysisTask?.status === 'failed' ? () => props.onRetryAnalyze(analysisTask.id) : undefined}
                    onResync={props.onResync}
                    analyzeBusy={assetAnalysisBusy}
                    onPreview={() => props.onPreviewAsset(asset)}
                    previewBadge={props.renderPreviewBadge(asset.id)}
                  />
                );
              })}
            </div>
          ) : (
            <div className="tile p-6 text-sm text-ink-secondary">暂无可用视频素材，请先在第 4 步完成视频生成。</div>
          )}
        </div>
        )}
      </section>

      <section className="card space-y-4 p-5" aria-label="画质与调色">
        <button type="button" className="flex w-full items-center justify-between text-left" onClick={toggleMediaPrep} aria-expanded={mediaPrepOpen}>
          <div>
            <h3 className="font-semibold text-ink">画质与调色（进阶）</h3>
            <p className="mt-1 text-sm text-ink-secondary">调色滤镜与低清预览片；默认用不到，卡顿或需要调色时再展开。</p>
          </div>
          <span className="text-ink-tertiary">{mediaPrepOpen ? '收起' : '展开'}</span>
        </button>
        {mediaPrepOpen && (
          <div className="space-y-4">
            <div className="tile space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium text-ink">调色滤镜（LUT）</p>
                <div className="flex items-center gap-2">
                  <input
                    ref={lutFileInputRef}
                    type="file"
                    accept=".cube"
                    aria-label="导入 LUT 文件"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) props.onImportLutFile(file);
                    }}
                  />
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={lutImporting}
                    onClick={() => lutFileInputRef.current?.click()}
                  >{lutImporting ? '导入中…' : '导入 .cube LUT'}</button>
                </div>
              </div>
              {luts.length === 0
                ? <p className="text-xs text-ink-tertiary">尚未导入任何调色滤镜。</p>
                : <ul className="space-y-2">
                  {luts.map((lut) => (
                    <li key={lut.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-subtle px-3 py-2 text-xs">
                      <span className="min-w-0 truncate text-ink-secondary">
                        {lut.displayName}{lut.status === 'archived' && <span className="ml-2 text-ink-tertiary">已归档</span>}
                      </span>
                      <span className="flex gap-2">
                        {lut.status === 'active'
                          ? <button type="button" className="text-ink-tertiary underline" onClick={() => props.onLutAction(lut.id, 'archive')}>归档</button>
                          : <>
                            <button type="button" className="text-ink-tertiary underline" onClick={() => props.onLutAction(lut.id, 'restore')}>恢复</button>
                            <button type="button" className="text-fail underline" onClick={() => props.onLutAction(lut.id, 'delete')}>清理</button>
                          </>}
                      </span>
                    </li>
                  ))}
                </ul>}
            </div>

            <div className="tile space-y-3 p-4">
              <p className="text-sm font-medium text-ink">低清预览片</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={proxyButtonsDisabled || proxyButtonsBlockedByUnconfirmed || Object.keys(selectedAssets).length === 0}
                  onClick={() => props.onRequestProxy(Object.keys(selectedAssets), null)}
                >{proxyBatchBusy ? '请求中…' : '为选中素材生成低清预览片'}</button>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={proxyButtonsDisabled || proxyButtonsBlockedByUnconfirmed}
                  onClick={() => props.onRequestProxy(undefined, null)}
                >为当前批次全部素材生成低清预览片</button>
              </div>
              {proxyButtonsBlockedByUnconfirmed && (
                <p className="text-xs text-warn">脚本、素材、分析版本或调色滤镜已修改，重新确认整体输入后预览片请求才会匹配新快照。</p>
              )}
              {!hasConfirmedVersion && <p className="text-xs text-ink-tertiary">先确认整体输入，预览片才能对应到已锁定的设置。</p>}
              {assetPrepareTasks.length > 0 && (
                <ul className="space-y-1.5">
                  {assetPrepareTasks.map((task) => {
                    const progress = task.progressJson as { phase?: string; percent?: number | null; description?: string } | null;
                    const percent = typeof progress?.percent === 'number' ? `${Math.round(progress.percent * 100)}%` : '';
                    const phaseLabel = progress?.phase ? TASK_PHASE_LABELS[progress.phase] : undefined;
                    const statusLabel = TASK_STATUS_LABELS[task.status] ?? task.status;
                    return (
                      <li key={task.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-subtle px-3 py-2 text-xs">
                        <span className="min-w-0 truncate text-ink-secondary">
                          {phaseLabel || progress?.description || statusLabel} {percent}
                          {(task.attemptCount ?? 0) > 1 && ` · 第 ${task.attemptCount} 次尝试`}
                        </span>
                        <span className="flex items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 ${task.status === 'failed' ? 'bg-fail/10 text-fail' : task.status === 'succeeded' ? 'bg-ok/10 text-ok' : task.status === 'cancelled' ? 'bg-surface-subtle text-ink-tertiary' : 'bg-accent/10 text-accent'}`}>
                            {statusLabel}
                          </span>
                          {task.status === 'failed' && (
                            <button type="button" className="text-accent underline" onClick={() => props.onProxyRetry(task.id)}>重试</button>
                          )}
                          {(task.status === 'queued' || task.status === 'running') && (
                            <button type="button" className="text-ink-tertiary underline" onClick={() => props.onProxyControl(task.id, 'pause')}>暂停</button>
                          )}
                          {task.status === 'queued' && (
                            <button type="button" className="text-accent underline" onClick={() => props.onProxyControl(task.id, 'resume')}>继续</button>
                          )}
                          {(task.status === 'queued' || task.status === 'running') && (
                            <button type="button" className="text-fail underline" onClick={() => props.onProxyControl(task.id, 'cancel')}>取消</button>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="tile space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium text-ink">预览片缓存清理</p>
                {cacheUsage && <span className="text-xs text-ink-tertiary">当前项目占用 {(cacheUsage.totalBytes / (1024 * 1024)).toFixed(1)}MB · {cacheUsage.count} 个文件</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={cleanupBusy !== null || Object.keys(selectedAssets).length === 0}
                  onClick={() => props.onCleanupProxies('selected')}
                >{cleanupBusy === 'selected' ? '清理中…' : '清理选中素材预览片'}</button>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={cleanupBusy !== null}
                  onClick={() => props.onCleanupProxies('project')}
                >{cleanupBusy === 'project' ? '清理中…' : '清理当前项目预览片'}</button>
              </div>
              <p className="text-xs text-ink-tertiary">清理不影响原片、分析结果、批次快照和正式成片；清理后预览自动回退原片，可随时重新生成。正在使用中的文件会自动延后删除，不需要再次点击清理。</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
