'use client';

import type { BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';

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
}

/**
 * 第 4 步 · 导出成片:多选可导出成片 → 导出 → 播放/下载当前正式成片。
 * 播放器只绑定 currentFormalArtifact:第一次导出显示渲染进度;返工再导出时
 * 旧正式成片继续可播,卡片叠加「当前修改尚未导出」;新成片发布成功后同一
 * 卡片原位切换到新 artifact。
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
  } = props;
  const { counts } = workspace;
  // 服务端硬门禁:productCode 参与导出文件名,为空则整批导出被拒。
  const productCodeMissing = !productCode.trim();
  const hasPublished = workspace.cards.some(({ currentFormalArtifact }) => Boolean(currentFormalArtifact));
  const exportFolder = folderRelativePath
    ?? (hasPublished && workspace.exportDirName ? `storage/projects/${workspace.exportDirName}/成片` : null);
  const selectable = workspace.cards.filter(({ exportEligible }) => exportEligible);
  const allSelected = selectable.length > 0 && selectable.every(({ planId }) => selectedPlanIds.includes(planId));
  const selectedExportCount = selectable.filter(({ planId }) => selectedPlanIds.includes(planId)).length;

  const awaitingReview = workspace.cards.filter(({ approvable, approved }) => approvable && !approved).length;
  // 渲染/失败/已导出全部消费服务端 exportStatus,不再从前端自拼任务状态。
  const renderFailedCount = workspace.cards.filter(({ exportStatus }) => exportStatus === 'failed').length;
  const renderingCount = workspace.cards.filter(({ exportStatus }) => exportStatus === 'rendering').length;
  const outdatedCount = workspace.cards.filter(({ formalOutdated }) => formalOutdated).length;

  const mediaUrl = (
    card: BatchWorkspaceView['cards'][number],
    kind: 'video' | 'cover',
    artifactId: string,
    download = false,
  ) => {
    const params = new URLSearchParams({ projectId, kind, source: 'artifact', artifactId });
    if (download) params.set('download', '1');
    return `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/outputs/${encodeURIComponent(card.planId)}/media?${params.toString()}`;
  };

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
            <span className="ml-1">正式导出的文件名是「产品编码-日期-脚本-plan序号-版本」，缺了它服务端会拒绝整批导出。请回到项目信息补上产品编码后再来导出。</span>
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
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {workspace.cards.map((card) => {
          const formal = card.currentFormalArtifact;
          // 服务端统一判断的导出状态:frontend 不自行从任务表拼状态。
          const exporting = card.exportStatus === 'rendering';
          const exportFailed = card.exportStatus === 'failed';
          const progress = card.fullRenderTask?.progress as { phase?: string; percent?: number | null; description?: string } | null;
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
                <span className={`rounded-full px-2 py-1 text-[11px] ${exportFailed ? 'bg-fail/10 text-fail' : formal && card.exportStatus !== 'exported' && card.formalOutdated ? 'bg-warn/20 text-warn' : exporting ? 'bg-accent/10 text-accent' : card.exportStatus === 'exported' || formal ? 'bg-ok/10 text-ok' : card.status === 'needs_attention' ? 'bg-warn/20 text-warn' : 'bg-surface-subtle text-ink-tertiary'}`}>
                  {exportFailed ? '渲染失败' : formal && card.exportStatus !== 'exported' && card.formalOutdated ? '修改未导出' : exporting ? '正在渲染成片' : card.exportStatus === 'exported' || formal ? '已导出' : card.approved ? '可导出' : '待审核'}
                </span>
              </div>
              {formal && (
                <video
                  key={`${card.planId}-${formal.video.id}`}
                  controls
                  preload="metadata"
                  className="aspect-video w-full rounded-xl bg-black"
                  data-testid={`batch-export-preview-${card.planId}`}
                >
                  <source src={mediaUrl(card, 'video', formal.video.id)} type="video/mp4" />
                </video>
              )}
              {formal && card.formalOutdated && (
                <p className="rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn" role="status">
                  当前修改尚未导出：正在播放的是上一版正式成片，重新导出后同一卡片会原位替换。
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
                  <a className="btn-secondary h-8 px-3 text-xs leading-8" href={mediaUrl(card, 'video', formal.video.id, true)} download>
                    下载当前正式版视频
                  </a>
                  {formal.cover && (
                    <a className="btn-secondary h-8 px-3 text-xs leading-8" href={mediaUrl(card, 'cover', formal.cover.id, true)} download>
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
    </div>
  );
}