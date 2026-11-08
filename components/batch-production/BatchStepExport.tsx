'use client';

import { useCallback, useMemo, useState } from 'react';
import type { BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';
import type { OutputPresetId } from '@/lib/final-edit/types';
import { FilmPreviewDialog, type FilmPreviewItem } from '@/components/media/FilmPreviewDialog';
import { Icon } from '@/components/ui/Icon';
import type { ClientDownloadManifest, DesktopBridge } from '@/desktop/bridge-types';

export type BatchDownloadScope = 'both' | 'video' | 'cover';

/** 一键下载全部的三个选项（规格：成片和封面 / 只要成片 / 只要封面）。 */
const DOWNLOAD_OPTIONS: Array<{ scope: BatchDownloadScope; label: string; hint: string }> = [
  { scope: 'both', label: '成片和封面', hint: '打包下载这一批的成片与封面' },
  { scope: 'video', label: '只要成片', hint: '只取视频文件' },
  { scope: 'cover', label: '只要封面', hint: '只取封面图' },
];

/** 卡片缩略图：按画幅比例、**按高度**算宽高（与预览对话框同一口径，不靠 aspect-ratio）。 */
const THUMBNAIL_HEIGHT = 236;
const PRESET_RATIOS: Record<OutputPresetId, number> = {
  '3x4': 3 / 4,
  '9x16': 9 / 16,
  '16x9': 16 / 9,
};

interface DownloadManifestResponse {
  scope: BatchDownloadScope;
  exportDirName: string;
  outdated: boolean;
  totalBytes: number;
  emptyMessage?: string;
  items: Array<{
    planId: string;
    seq: number;
    kind: 'video' | 'cover';
    filename: string;
    relativeName: string;
    byteSize: number;
    outdated: boolean;
  }>;
  deliveryManifests?: ClientDownloadManifest[];
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface BatchStepExportProps {
  workspace: BatchWorkspaceView;
  selectedPlanIds: string[];
  onTogglePlan: (planId: string, checked: boolean) => void;
  onSelectAll: () => void;
  phaseEBusy: string | null;
  onPublish: () => void;
  /** 渲染失败后的重试:重排队该计划任务并直接为该计划重新发起导出。 */
  onRetryExport: (planId: string, taskId: string) => void;
  /** 回到检查成片修改。 */
  onGoReview: () => void;
  onRevealFolder: () => void;
  revealAvailable: boolean;
  revealBusy: boolean;
  revealFeedback: { kind: 'ok' | 'error'; message: string } | null;
  folderRelativePath: string | null;
  projectId: string;
  selectedBatchId: string;
  /** 项目产品编码:参与正式导出的文件名,为空时服务端会拒绝导出 */
  productCode: string;
  /** 批量输出画幅（批量顶层「画幅」选择）；预览对话框按它算画面宽高。 */
  outputPreset?: OutputPresetId;
}

/**
 * 第 4 步 · 导出成片（11 号票）：
 * - 卡片**不再嵌播放器**：封面 + 悬停播放图标，点卡片打开大预览；
 * - 预览复用 09 的 `FilmPreviewDialog`：已导出播当前成片；改过没重导播**上一版正式成片**
 *   并写明；从没导出播**检查成片里的合成预览**并写明，且**不给下载按钮**；
 * - 「一键下载全部」三个选项；轻客户端交给现有交付下载，只用浏览器时服务端打包 ZIP。
 *
 * 正式成片的判定只消费服务端 `currentFormalArtifact` / `formalOutdated` / `exportStatus`，
 * 前端不另拼一套状态。
 */
export default function BatchStepExport(props: BatchStepExportProps) {
  const {
    workspace,
    selectedPlanIds,
    onTogglePlan,
    onSelectAll,
    phaseEBusy,
    onPublish,
    onRetryExport,
    onGoReview,
    onRevealFolder,
    revealAvailable,
    revealBusy,
    revealFeedback,
    folderRelativePath,
    projectId,
    selectedBatchId,
    productCode,
    outputPreset = '3x4',
  } = props;
  const { counts } = workspace;

  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState<BatchDownloadScope | null>(null);
  const [downloadFeedback, setDownloadFeedback] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [manifest, setManifest] = useState<DownloadManifestResponse | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);

  // 服务端硬门禁:productCode 参与导出文件名,为空则整批导出被拒。
  const productCodeMissing = !productCode.trim();
  const hasPublished = workspace.cards.some(({ currentFormalArtifact }) => Boolean(currentFormalArtifact));
  const exportFolder = folderRelativePath
    ?? (hasPublished && workspace.exportDirName ? `storage/projects/${workspace.exportDirName}/成片` : null);
  const selectable = workspace.cards.filter(({ exportEligible }) => exportEligible);
  const allSelected = selectable.length > 0 && selectable.every(({ planId }) => selectedPlanIds.includes(planId));
  const selectedExportCount = selectable.filter(({ planId }) => selectedPlanIds.includes(planId)).length;

  const awaitingReview = workspace.cards.filter(({ approvable, approved }) => approvable && !approved).length;
  const renderFailedCount = workspace.cards.filter(({ exportStatus }) => exportStatus === 'failed').length;
  const renderingCount = workspace.cards.filter(({ exportStatus }) => exportStatus === 'rendering').length;
  const outdatedCount = workspace.cards.filter(({ formalOutdated }) => formalOutdated).length;

  const mediaUrl = (
    card: BatchWorkspaceView['cards'][number],
    kind: 'video' | 'cover',
    artifactIdOrAttempt: string,
    options: { source?: 'artifact' | 'candidate'; download?: boolean } = {},
  ) => {
    const source = options.source ?? 'artifact';
    const params = new URLSearchParams({ projectId, kind, source });
    if (source === 'artifact') params.set('artifactId', artifactIdOrAttempt);
    else params.set('renderAttemptId', artifactIdOrAttempt);
    if (options.download) params.set('download', '1');
    return `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/outputs/${encodeURIComponent(card.planId)}/media?${params.toString()}`;
  };

  /** 卡片封面：正式成片优先，其次检查成片的封面尝试（没有就只显示占位）。 */
  const coverUrl = (card: BatchWorkspaceView['cards'][number]) => {
    const formal = card.currentFormalArtifact;
    if (formal?.cover) return mediaUrl(card, 'cover', formal.video.id);
    if (card.coverAttemptId) return mediaUrl(card, 'cover', card.coverAttemptId, { source: 'candidate' });
    return null;
  };

  /** 卡片状态文案：与服务端 exportStatus / formalOutdated 一一对应。 */
  const cardState = (card: BatchWorkspaceView['cards'][number]) => {
    const formal = card.currentFormalArtifact;
    if (card.exportStatus === 'failed') return { text: '渲染失败', tone: 'fail' as const };
    if (formal && card.exportStatus !== 'exported' && card.formalOutdated) return { text: '修改未导出', tone: 'warn' as const };
    if (card.exportStatus === 'rendering') return { text: '正在渲染成片', tone: 'accent' as const };
    if (card.exportStatus === 'exported' || formal) return { text: '已导出', tone: 'ok' as const };
    if (card.approved) return { text: '可导出', tone: 'ok' as const };
    return { text: '待审核', tone: 'idle' as const };
  };

  /**
   * 预览条目。三种播放内容：
   * - 已导出 / 修改未导出 → 当前正式成片（`source=artifact`，修改未导出时那就是**上一版**）；
   * - 从没导出 → 检查成片里的合成预览（`source=candidate`），且不给下载按钮；
   * - 正在渲染/失败且没有任何可播放内容 → 不进预览列表。
   *
   * 这里是纯派生：URL 由 `projectId` / `selectedBatchId` 直接拼，不引用会重建的函数，
   * 否则每次渲染都会生成新 item 让预览对话框（受控 index）跳位。
   */
  const previewItems = useMemo<FilmPreviewItem[]>(() => {
    const url = (planId: string, kind: 'video' | 'cover', id: string, options: { source?: 'artifact' | 'candidate'; download?: boolean } = {}) => {
      const params = new URLSearchParams({ projectId, kind, source: options.source ?? 'artifact' });
      if ((options.source ?? 'artifact') === 'artifact') params.set('artifactId', id);
      else params.set('renderAttemptId', id);
      if (options.download) params.set('download', '1');
      return `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/outputs/${encodeURIComponent(planId)}/media?${params.toString()}`;
    };
    return workspace.cards.flatMap((card): FilmPreviewItem[] => {
      const formal = card.currentFormalArtifact;
      const state = cardState(card);
      if (formal) {
        return [{
          id: `${card.planId}:${formal.video.id}`,
          title: `${String(card.seq).padStart(2, '0')} ${card.scriptTitle || '未命名脚本'}`,
          src: url(card.planId, 'video', formal.video.id),
          poster: formal.cover ? url(card.planId, 'cover', formal.video.id) : undefined,
          preset: outputPreset,
          // 正式产物文件名由服务端导出命名合约生成；相对路径缺失时留空让预览显示「—」。
          filename: formal.video.relativePath
            ? formal.video.relativePath.split(/[\\/]/).pop()
            : undefined,
          status: state.text,
          note: card.formalOutdated
            ? '当前修改尚未导出：这里播放的是上一版正式成片，重新导出后同一张卡片会原位替换。'
            : undefined,
          // 下载按钮只在真有正式成片时给（从没导出不给）。
          downloadVideoUrl: url(card.planId, 'video', formal.video.id, { download: true }),
          downloadCoverUrl: formal.cover ? url(card.planId, 'cover', formal.video.id, { download: true }) : undefined,
        }];
      }
      // 从没导出：只有检查成片里已经有合成预览（成功渲染过候选版本）才可播。
      if (card.coverAttemptId && card.exportStatus !== 'failed') {
        return [{
          id: `${card.planId}:candidate:${card.coverAttemptId}`,
          title: `${String(card.seq).padStart(2, '0')} ${card.scriptTitle || '未命名脚本'}`,
          src: url(card.planId, 'video', card.coverAttemptId, { source: 'candidate' }),
          poster: card.coverAttemptId ? url(card.planId, 'cover', card.coverAttemptId, { source: 'candidate' }) : undefined,
          preset: outputPreset,
          status: state.text,
          note: '这条成片还没有正式导出：这里播放的是检查成片里的合成预览，正式导出后才有可下载的成片。',
          // 规格：从没导出不给下载按钮。
        }];
      }
      return [];
    });
  }, [workspace.cards, outputPreset, projectId, selectedBatchId]);

  /** 卡片 → 预览列表下标（点哪张就打开哪条）。 */
  const openPreview = (card: BatchWorkspaceView['cards'][number]) => {
    const index = previewItems.findIndex((item) => item.id.startsWith(`${card.planId}:`));
    if (index < 0) {
      setDownloadFeedback({ kind: 'error', message: '这条成片还没有可播放的合成预览，请先回检查成片。' });
      return;
    }
    setPreviewIndex(index);
    setPreviewOpen(true);
  };

  const loadManifest = useCallback(async (scope: BatchDownloadScope): Promise<DownloadManifestResponse> => {
    const response = await fetch(
      `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/downloads?projectId=${encodeURIComponent(projectId)}&scope=${scope}`,
      { cache: 'no-store' },
    );
    const body = await response.json() as DownloadManifestResponse & { message?: string };
    if (!response.ok) throw new Error(body.message || '可下载文件清单读取失败');
    return body;
  }, [projectId, selectedBatchId]);

  // 打开「一键下载全部」时先取清单：没有可下载成片就只给提示。
  // 清单在点击时取（不从 effect 里同步 setState），换 scope 时刷新同一条。
  const openDownloadOptions = () => {
    if (downloadOpen) {
      setDownloadOpen(false);
      return;
    }
    setDownloadOpen(true);
    setManifest(null);
    setManifestError(null);
    void loadManifest('both').then((body) => setManifest(body)).catch((error: unknown) => {
      setManifestError(error instanceof Error ? error.message : '可下载文件清单读取失败');
    });
  };

  const downloadZip = (scope: BatchDownloadScope) => {
    const url = `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/downloads/zip?projectId=${encodeURIComponent(projectId)}&scope=${scope}`;
    // 只用浏览器时：服务端打包 ZIP 后直接下载（ZIP 内容与清单一致）。
    // 用带 `download` 的锚点而不是 `location.assign`：附件响应不该把页面导航走。
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '';
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setDownloadFeedback({ kind: 'ok', message: `已开始下载这一批的${DOWNLOAD_OPTIONS.find((option) => option.scope === scope)?.label ?? '成片'}。` });
    setDownloadOpen(false);
  };

  const downloadToClient = async (scope: BatchDownloadScope) => {
    const bridge = (window as Window & { desktopBridge?: DesktopBridge }).desktopBridge;
    if (!bridge?.createDownloads) {
      downloadZip(scope);
      return;
    }
    setDownloadBusy(scope);
    setDownloadFeedback(null);
    try {
      const response = await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/downloads?projectId=${encodeURIComponent(projectId)}&scope=${scope}&delivery=1`,
        { cache: 'no-store' },
      );
      const body = await response.json() as DownloadManifestResponse & { message?: string };
      if (!response.ok) throw new Error(body.message || '可下载文件清单读取失败');
      const manifests = body.deliveryManifests ?? [];
      if (manifests.length === 0) {
        setDownloadFeedback({ kind: 'ok', message: body.emptyMessage ?? '还没有导出过的成片' });
        setDownloadOpen(false);
        return;
      }
      await bridge.createDownloads(manifests);
      setDownloadFeedback({
        kind: 'ok',
        message: `已交给本机交付下载：${manifests.length} 个文件，存到下载根目录的「${body.exportDirName}」下；已下过的会跳过。`,
      });
      setDownloadOpen(false);
    } catch (error) {
      setDownloadFeedback({ kind: 'error', message: error instanceof Error ? error.message : '一键下载全部失败' });
    } finally {
      setDownloadBusy(null);
    }
  };

  const hasDownloadable = (manifest?.items.length ?? 0) > 0;

  return (
    <div className="min-h-0 flex-1 space-y-4 p-2">
      <div className="card space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-ink">导出成片</h3>
            <p className="mt-1 text-sm text-ink-secondary">
              正式成片在点「导出」时才渲染生成。修改后重新导出，同一张卡片会原位替换成新成片。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary text-xs" disabled={selectable.length === 0} onClick={onSelectAll}>
              {allSelected ? '取消全选' : `全选可导出（${selectable.length}）`}
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={phaseEBusy !== null || selectedExportCount === 0 || productCodeMissing}
              title={productCodeMissing ? '请先在项目信息中填写产品编码' : undefined}
              onClick={onPublish}
            >{phaseEBusy === 'export' ? '导出中…' : productCodeMissing ? '请先填写产品编码' : `正式导出选中项（${selectedExportCount}）`}</button>
          </div>
        </div>
        {productCodeMissing && (
          <div className="rounded-xl bg-warn/10 px-4 py-3 text-xs leading-5 text-warn" role="alert">
            <strong className="font-medium">还差一步：本项目还没有产品编码。</strong>
            <span className="ml-1">导出文件名会包含产品编码及脚本、开头、包装编号。请回到项目信息补上产品编码后再来导出。</span>
          </div>
        )}
        {awaitingReview > 0 && (
          <p className="w-full text-xs text-warn" role="status">
            {awaitingReview} 条成片可导出但尚未审核：请到「检查成片」勾选后点「通过」，审核通过后才能导出。
          </p>
        )}
        {renderingCount > 0 && (
          <p className="w-full text-xs text-accent" role="status">
            {renderingCount} 条成片正在渲染完整视频，渲染完成后会自动继续发布；如果期间关闭或刷新了页面，重新进入后需要再点一次「导出」完成发布。
          </p>
        )}
        {renderFailedCount > 0 && (
          <p className="w-full text-xs text-fail" role="status">
            {renderFailedCount} 条成片渲染失败：可在卡片上点「重试导出」，或回检查成片修改后再导出。
          </p>
        )}
        {outdatedCount > 0 && (
          <p className="w-full text-xs text-warn" role="status">
            {outdatedCount} 条成片当前修改尚未导出：旧正式成片仍可播放和下载，重新导出后原位替换。
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-5">
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">全部</p><strong className="text-xl text-ink">{counts.total}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">可导出</p><strong className="text-xl text-ok">{selectable.length}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">处理中</p><strong className="text-xl text-accent">{renderingCount}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">需处理</p><strong className="text-xl text-warn">{counts.needsAttention}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">渲染失败</p><strong className="text-xl text-fail">{renderFailedCount}</strong></div>
        </div>
        {exportFolder && (
          <div className="rounded-xl bg-ok/10 px-4 py-3 text-sm text-ink" role="status">
            <p className="font-medium text-ok">{folderRelativePath ? '已导出到成品文件夹' : '成品文件夹'}</p>
            <p className="mt-1 break-all text-xs text-ink-secondary">{exportFolder}</p>
            {revealAvailable ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={revealBusy}
                  onClick={onRevealFolder}
                >{revealBusy ? '打开中…' : '打开文件夹'}</button>
                {revealFeedback && (
                  <p className={`text-xs ${revealFeedback.kind === 'ok' ? 'text-ok' : 'text-fail'}`} role="status">
                    {revealFeedback.message}
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-2 text-xs text-ink-tertiary">
                浏览器里打不开本地文件夹（「打开文件夹」仅桌面安装版可用）。用下方每条成片的「下载视频 / 下载封面」取文件，保存位置和文件名可自选。
              </p>
            )}
          </div>
        )}

        {/* 一键下载全部：三个选项；轻客户端交给现有交付下载，只用浏览器时服务端打包 ZIP。 */}
        <div className="rounded-xl border border-hairline bg-surface-subtle px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-ink">一键下载全部</p>
              <p className="mt-1 text-xs text-ink-secondary">
                成片和封面、只要成片、只要封面三选一。工作台桌面版存到下载根目录（已下过的跳过）；只用浏览器时服务端打包成 ZIP。
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary text-xs"
              data-testid="batch-download-all"
              aria-expanded={downloadOpen}
              onClick={openDownloadOptions}
            >{downloadOpen ? '收起选项' : '一键下载全部'}</button>
          </div>
          {downloadFeedback && (
            <p className={`mt-2 text-xs ${downloadFeedback.kind === 'ok' ? 'text-ok' : 'text-fail'}`} role="status">
              {downloadFeedback.message}
            </p>
          )}
          {downloadOpen && (
            <div className="mt-3 space-y-2" role="group" aria-label="一键下载全部选项">
              {manifestError && <p className="text-xs text-fail" role="alert">{manifestError}</p>}
              {!manifest && !manifestError && <p className="text-xs text-ink-tertiary">正在读取可下载文件…</p>}
              {manifest && !hasDownloadable && (
                <p className="text-xs text-ink-secondary" role="status">
                  {manifest.emptyMessage ?? '还没有导出过的成片'}
                </p>
              )}
              {manifest && hasDownloadable && (
                <>
                  <p className="text-xs text-ink-tertiary" data-testid="batch-download-summary">
                    共 {manifest.items.length} 个文件 · {formatBytes(manifest.totalBytes)} · 存到「{manifest.exportDirName}」
                    {manifest.outdated ? ' · 当前修改尚未导出，给的是上一版正式产物' : ''}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {DOWNLOAD_OPTIONS.map((option) => (
                      <button
                        key={option.scope}
                        type="button"
                        className="btn-primary text-xs"
                        data-testid={`batch-download-${option.scope}`}
                        aria-label={`下载${option.label}`}
                        title={option.hint}
                        disabled={downloadBusy !== null}
                        onClick={() => void downloadToClient(option.scope)}
                      >{downloadBusy === option.scope ? '准备中…' : option.label}</button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {workspace.cards.map((card) => {
          const formal = card.currentFormalArtifact;
          const exporting = card.exportStatus === 'rendering';
          const exportFailed = card.exportStatus === 'failed';
          const state = cardState(card);
          const progress = card.fullRenderTask?.progress as { phase?: string; percent?: number | null; description?: string } | null;
          const poster = coverUrl(card);
          return (
            <article key={card.planId} data-testid="batch-export-card" className="tile space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <label className="flex min-w-0 items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={`选择成片 ${card.seq}`}
                    checked={selectedPlanIds.includes(card.planId)}
                    disabled={!card.exportEligible}
                    title={card.exportEligible ? undefined : card.approved ? '这条成片口播或封面尚未就绪，暂时无法导出' : '这条成片尚未审核通过，请先到检查页点「通过」'}
                    onChange={(event) => onTogglePlan(card.planId, event.target.checked)}
                    className="mt-1 disabled:opacity-40"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs text-ink-tertiary">成片 {String(card.seq).padStart(2, '0')} · v{card.versionNumber ?? '—'}</span>
                    <strong className="mt-1 block truncate text-ink">{card.scriptTitle || '未命名脚本'}</strong>
                  </span>
                </label>
                <span className={`rounded-full px-2 py-1 text-[11px] ${
                  state.tone === 'fail' ? 'bg-fail/10 text-fail'
                    : state.tone === 'warn' ? 'bg-warn/20 text-warn'
                      : state.tone === 'accent' ? 'bg-accent/10 text-accent'
                        : state.tone === 'ok' ? 'bg-ok/10 text-ok'
                          : 'bg-surface-subtle text-ink-tertiary'
                }`} data-state={state.tone}>{state.text}</span>
              </div>

              {/* 卡片只显示封面 + 悬停播放图标；点卡片打开大预览（不再嵌播放器）。
                  缩略图宽高按画幅**从高度算出来**显式写死，和预览对话框同一口径
                  （Safari 不靠 aspect-ratio 反推；也不会把卡片撑出窗口）。 */}
              <button
                type="button"
                className="group relative mx-auto block overflow-hidden rounded-xl bg-black/80 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid={`batch-export-card-open-${card.planId}`}
                aria-label={`打开成片 ${card.seq} 的大预览`}
                onClick={() => openPreview(card)}
              >
                {/* 封面缩略图不声明 data-preset / data-media-frame：
                    「视频画面保持 3:4」量的是真画面（预览对话框），不是列表封面。
                    比例本身仍由下面的显式宽高保证（高度 → 宽度，不靠 aspect-ratio）。 */}
                <span
                  className="relative block"
                  style={{
                    height: THUMBNAIL_HEIGHT,
                    width: Math.round(THUMBNAIL_HEIGHT * (PRESET_RATIOS[outputPreset] ?? 3 / 4)),
                  }}
                >
                  {poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={poster} alt={`成片 ${String(card.seq).padStart(2, '0')} 封面`} className="h-full w-full object-cover opacity-95 transition group-hover:opacity-70" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-xs text-ink-tertiary">
                      还没有封面
                    </span>
                  )}
                </span>
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                    <Icon name="play" size={20} />
                  </span>
                </span>
              </button>

              {formal && card.formalOutdated && (
                <p className="rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn" role="status">
                  当前修改尚未导出：播放、下载的是上一版正式成片，重新导出后同一卡片会原位替换。
                </p>
              )}
              {exporting && progress && (
                <div className="text-xs text-ink-secondary">
                  <p>{progress.description || '正在渲染完整成片'}{typeof progress.percent === 'number' ? ` · ${Math.round(progress.percent * 100)}%` : ''}</p>
                  {typeof progress.percent === 'number' && <progress className="mt-1 w-full" max={1} value={progress.percent} />}
                </div>
              )}
              {exportFailed && (
                <p className="text-xs text-fail" role="status">
                  渲染失败：{card.fullRenderTask?.errorMessage || '未知原因'}
                </p>
              )}
              {formal && (
                <div className="flex flex-wrap gap-2">
                  <a className="btn-secondary h-8 px-3 text-xs leading-8" href={mediaUrl(card, 'video', formal.video.id, { download: true })} download>
                    下载当前正式版视频
                  </a>
                  {formal.cover && (
                    <a className="btn-secondary h-8 px-3 text-xs leading-8" href={mediaUrl(card, 'cover', formal.video.id, { download: true })} download>
                      下载当前正式版封面
                    </a>
                  )}
                </div>
              )}
              {exportFailed && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-secondary h-8 px-3 text-xs"
                    disabled={phaseEBusy !== null || !card.fullRenderTask}
                    onClick={() => card.fullRenderTask && onRetryExport(card.planId, card.fullRenderTask.id)}
                  >重试导出</button>
                  <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onGoReview}>回检查成片修改</button>
                </div>
              )}
              {!formal && card.exportStatus === 'not_exported' && !card.exportEligible && (
                <p className="text-xs text-ink-tertiary">
                  {card.blockers.length > 0 ? card.blockers.join('；') : '先到检查成片通过审核后再来导出。'}
                </p>
              )}
            </article>
          );
        })}
      </div>
      {workspace.cards.length === 0 && <div className="tile p-6 text-sm text-ink-secondary">还没有成片，请先完成前面步骤。</div>}

      <FilmPreviewDialog
        open={previewOpen && previewItems.length > 0}
        items={previewItems}
        index={previewIndex}
        onIndexChange={setPreviewIndex}
        onClose={() => setPreviewOpen(false)}
        title="成片预览"
        subtitle={previewItems.length > 1 ? `第 ${previewIndex + 1} 条，共 ${previewItems.length} 条 · 左右键换条` : undefined}
      />
    </div>
  );
}
