'use client';

import type { BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';

export interface BatchStepExportProps {
  workspace: BatchWorkspaceView;
  selectedPlanIds: string[];
  onTogglePlan: (planId: string, checked: boolean) => void;
  onSelectAll: () => void;
  phaseEBusy: string | null;
  onPublish: () => void;
  onRevealFolder: () => void;
  revealAvailable: boolean;
  revealBusy: boolean;
  folderRelativePath: string | null;
  projectId: string;
  selectedBatchId: string;
}

/**
 * 第 4 步 · 导出成片:多选可导出的成片 → 导出 → 显示成品文件夹路径与「打开文件夹」。
 * 无配音成片不可勾选;跳过原因按原因归类合并。
 */
export default function BatchStepExport(props: BatchStepExportProps) {
  const {
    workspace,
    selectedPlanIds,
    onTogglePlan,
    onSelectAll,
    phaseEBusy,
    onPublish,
    onRevealFolder,
    revealAvailable,
    revealBusy,
    folderRelativePath,
    projectId,
    selectedBatchId,
  } = props;
  const { counts } = workspace;
  // 可导出 = 技术上可发布 && 已审核通过(审核门禁是服务端单点判断,UI 同步过滤)
  const selectable = workspace.cards.filter(({ publishable, approved }) => publishable && approved);
  const allSelected = selectable.length > 0 && selectable.every(({ planId }) => selectedPlanIds.includes(planId));

  const awaitingReview = workspace.cards.filter(({ publishable, approved }) => publishable && !approved).length;
  const silentCount = workspace.cards.filter((card) => card.candidate?.audioMode === 'silent_placeholder').length;
  const blockedReasons = [...new Set(
    workspace.cards
      .filter((card) => !card.publishable && card.candidate?.audioMode !== 'silent_placeholder')
      .flatMap((card) => card.blockers),
  )];

  const mediaUrl = (card: BatchWorkspaceView['cards'][number], kind: 'video' | 'cover', source: 'candidate' | 'artifact') => (
    `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/outputs/${encodeURIComponent(card.planId)}/media?projectId=${encodeURIComponent(projectId)}&kind=${kind}&source=${source}`
  );

  return (
    <div className="min-h-0 flex-1 space-y-4 p-2">
      <div className="card space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-ink">导出成片</h3>
            <p className="mt-1 text-sm text-ink-secondary">
              合格成片 = 视频 + 封面，两个文件同名成对。导出前自动检查，缺配音等不满足条件的成片不可勾选。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary text-xs" disabled={selectable.length === 0} onClick={onSelectAll}>
              {allSelected ? '取消全选' : `全选可导出（${selectable.length}）`}
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={phaseEBusy !== null || selectedPlanIds.length === 0}
              onClick={onPublish}
            >{phaseEBusy === 'export' ? '导出中…' : `正式导出选中项（${selectedPlanIds.length}）`}</button>
          </div>
        </div>
        {counts.publishable === 0 && counts.total > 0 && (
          <div className="w-full space-y-1 text-xs text-warn" role="status">
            {silentCount > 0 && (
              <p>{silentCount} 条成片的配音尚未完成或失败：请到「检查成片」确认配音状态，必要时重试配音。</p>
            )}
            {blockedReasons.length > 0 && (
              <p>另有 {blockedReasons.length} 类阻塞原因：{blockedReasons.join('；')}</p>
            )}
          </div>
        )}
        {awaitingReview > 0 && (
          <p className="w-full text-xs text-warn" role="status">
            {awaitingReview} 条成片可发布但尚未审核：请到「检查成片」勾选后点「通过」，审核通过后才能导出。
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-5">
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">全部</p><strong className="text-xl text-ink">{counts.total}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">可导出</p><strong className="text-xl text-ok">{counts.publishable}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">处理中</p><strong className="text-xl text-accent">{counts.processing}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">需处理</p><strong className="text-xl text-warn">{counts.needsAttention}</strong></div>
          <div className="tile p-3"><p className="text-xs text-ink-tertiary">可重试失败</p><strong className="text-xl text-fail">{counts.failed}</strong></div>
        </div>
        {folderRelativePath && (
          <div className="rounded-xl bg-ok/10 px-4 py-3 text-sm text-ink" role="status">
            <p className="font-medium text-ok">已导出到成品文件夹</p>
            <p className="mt-1 break-all text-xs text-ink-secondary">{folderRelativePath}</p>
            <button
              type="button"
              className="btn-secondary mt-2 text-xs"
              disabled={!revealAvailable || revealBusy}
              title={revealAvailable ? undefined : '仅在桌面安装版可用'}
              onClick={onRevealFolder}
            >{revealBusy ? '打开中…' : '打开文件夹'}</button>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {workspace.cards.map((card) => {
          const mediaSource = card.candidate ? 'candidate' : card.currentVideo ? 'artifact' : null;
          const published = Boolean(card.currentVideo);
          return (
            <article key={card.planId} data-testid="batch-export-card" className="tile space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <label className="flex min-w-0 items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={`选择成片 ${card.seq}`}
                    checked={selectedPlanIds.includes(card.planId)}
                    disabled={!card.publishable || !card.approved}
                    title={card.publishable && !card.approved ? '这条成片尚未审核通过，请先到检查页点「通过」' : card.publishable ? undefined : '这条成片还没有配音，暂时无法导出'}
                    onChange={(event) => onTogglePlan(card.planId, event.target.checked)}
                    className="mt-1 disabled:opacity-40"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs text-ink-tertiary">成片 {String(card.seq).padStart(2, '0')} · v{card.versionNumber ?? '—'}</span>
                    <strong className="mt-1 block truncate text-ink">{card.scriptTitle || '未命名脚本'}</strong>
                  </span>
                </label>
                <span className={`rounded-full px-2 py-1 text-[11px] ${card.publishable && card.approved ? 'bg-ok/10 text-ok' : card.status === 'needs_attention' ? 'bg-warn/20 text-warn' : 'bg-surface-subtle text-ink-tertiary'}`}>
                  {card.publishable && card.approved ? '可导出' : card.publishable ? '待审核' : '不可导出'}
                </span>
              </div>
              {mediaSource && (
                <video controls preload="metadata" className="aspect-video w-full rounded-xl bg-black" data-testid={`batch-export-preview-${card.planId}`}>
                  <source src={mediaUrl(card, 'video', mediaSource)} type="video/mp4" />
                </video>
              )}
              {card.candidate?.audioMode === 'silent_placeholder' && (
                <p className="rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn">无配音样片 —— 仅供检查画面，不能导出。</p>
              )}
              {published && (
                <p className="text-xs text-ok">已导出过正式成片，重复导出会追加新文件、不会覆盖旧文件。</p>
              )}
              {(card.blockers.length > 0 || card.warnings.length > 0) && (
                <ul className="space-y-1 text-xs text-warn">
                  {card.blockers.map((message) => <li key={`b-${message}`}>无法继续：{message}</li>)}
                  {card.warnings.map((message) => <li key={`w-${message}`}>提醒：{message}</li>)}
                </ul>
              )}
            </article>
          );
        })}
      </div>
      {workspace.cards.length === 0 && <div className="tile p-6 text-sm text-ink-secondary">还没有成片，请先完成前面步骤。</div>}
    </div>
  );
}
