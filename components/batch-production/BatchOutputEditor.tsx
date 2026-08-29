'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OutputPresetId } from '@/lib/final-edit/types';
import type {
  BatchOutputClipEditResult,
  BatchOutputClipEditView,
} from '@/lib/batch-production/output-arrangement';
import BatchClipTrimEditor from './BatchClipTrimEditor';
import BatchTimeline from './BatchTimeline';
import BatchTimelinePreview from './BatchTimelinePreview';

export interface BatchOutputEditorProps {
  projectId: string;
  batchId: string;
  planId: string;
  outputPreset: OutputPresetId;
  /** 外层卡片正在重渲染时传入,编辑控件暂时锁定 */
  renderBusy?: boolean;
  active?: boolean;
  /** 编辑生效后回调,外层据此刷新 workspace(卡片进入渲染中) */
  onChanged?: () => void;
}

interface EditFeedback {
  kind: 'success' | 'error';
  message: string;
}

/**
 * 「检查成片」片段编辑面板:左侧实时预览 + 下方时间轴,右侧冻结素材池。
 * 自身拉取 arrangement 视图;编辑生效后静默重拉本视图。
 *
 * 渲染时机:编辑期一次都不排渲染(POST 带 deferRender),退出这一轮调整时再
 * commit_render 一次性提交。本面板的预览是客户端实时合成的,不看渲染产物,
 * 而每次微调排一次整片重渲染要 4~7 秒,还会经 renderBusy 把编辑器整个锁死——
 * 用户实测「调一下等一下」就是这么来的。commit 幂等,重复提交不会多排任务。
 */
export default function BatchOutputEditor({
  projectId,
  batchId,
  planId,
  outputPreset,
  renderBusy = false,
  active = true,
  onChanged,
}: BatchOutputEditorProps) {
  const [view, setView] = useState<BatchOutputClipEditView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [freeformClipId, setFreeformClipId] = useState<string | null>(null);
  const [replaceCandidateId, setReplaceCandidateId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editFeedback, setEditFeedback] = useState<EditFeedback | null>(null);
  const [editWarnings, setEditWarnings] = useState<string[]>([]);
  // 这一轮调整里有画面变化尚未提交渲染。卸载兜底要读最新值,但 effect 不能依赖它
  // (依赖它就会在编辑中途重跑、提前提交),所以 state 与 ref 并存。
  const [pendingRender, setPendingRender] = useState(false);
  const pendingRenderRef = useRef(false);
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; });

  const clipsUrl = `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/clips?projectId=${encodeURIComponent(projectId)}`;

  const markRenderPending = useCallback((pending: boolean) => {
    pendingRenderRef.current = pending;
    setPendingRender(pending);
  }, []);

  const loadView = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setLoadError('');
    }
    try {
      const response = await fetch(
        `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/arrangement?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${response.status}`);
      }
      setView(body as BatchOutputClipEditView);
    } catch (error) {
      if (!silent) setLoadError(error instanceof Error ? error.message : '读取成片安排失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [batchId, planId, projectId]);

  useEffect(() => {
    // 换片段计划时重置交互态并重新拉取;统一推迟到宏任务,避免 effect 内同步 setState。
    const timer = window.setTimeout(() => {
      setSelectedClipId(null);
      setPlayheadSec(0);
      setFreeformClipId(null);
      setReplaceCandidateId(null);
      setEditFeedback(null);
      setEditWarnings([]);
      void loadView();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadView]);

  useEffect(() => {
    // 退出这一轮调整(关闭弹窗/换成片/切步骤)时才把欠着的重渲染一次性提交。
    // url 按当次的 projectId/batchId/planId 固化:换成片时提交的必须是上一条的渲染。
    const url = `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/clips?projectId=${encodeURIComponent(projectId)}`;
    return () => {
      if (!pendingRenderRef.current) return;
      pendingRenderRef.current = false;
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'commit_render' }),
        keepalive: true,
      }).then(() => onChangedRef.current?.()).catch(() => undefined);
    };
  }, [projectId, batchId, planId]);

  const clips = useMemo(() => view?.clips ?? [], [view]);
  const poolAssets = useMemo(() => view?.poolAssets ?? [], [view]);
  const assetsById = useMemo(() => new Map(poolAssets.map((asset) => [asset.assetId, asset])), [poolAssets]);
  const previewAssetsById = useMemo(
    () => Object.fromEntries(poolAssets.map((asset) => [asset.assetId, { previewUrl: asset.previewUrl }])),
    [poolAssets],
  );
  const selectedClip = clips.find((clip) => clip.clipId === selectedClipId) ?? null;
  const freeformClip = clips.find((clip) => clip.clipId === freeformClipId) ?? null;
  const pendingReplaceAsset = replaceCandidateId ? assetsById.get(replaceCandidateId) ?? null : null;

  const usedHere = poolAssets.filter((asset) => asset.usedByPlanIds.includes(planId)).length;
  const neverUsed = poolAssets.filter((asset) => asset.usedByPlanIds.length === 0).length;
  const visualSec = (view?.visualDurationUs ?? 0) / 1_000_000;
  const narrationSec = view?.narration.durationUs != null ? view.narration.durationUs / 1_000_000 : null;
  const durationDeltaSec = narrationSec == null ? 0 : visualSec - narrationSec;

  const editLocked = !view?.editable || renderBusy || submitting;

  const narrationUrl = view?.narration.audioRelativePath
    ? `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/media?kind=narration&projectId=${encodeURIComponent(projectId)}`
    : null;
  const coverUrl = view?.coverAssetId
    ? `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/media?projectId=${encodeURIComponent(projectId)}&kind=cover&source=candidate`
    : null;
  const previewBgm = useMemo(() => (view?.music.trackId
    ? {
      fileUrl: `/api/final-edit-bgm/${encodeURIComponent(view.music.trackId)}/file`,
      gainDb: view.music.gainDb,
      fadeInSec: view.music.fadeInSec,
      fadeOutSec: view.music.fadeOutSec,
    }
    : null), [view]);

  async function submitEdit(payload: Record<string, unknown>): Promise<boolean> {
    setSubmitting(true);
    setEditFeedback(null);
    setEditWarnings([]);
    try {
      const response = await fetch(clipsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, deferRender: true }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`);
      }
      const editResult = result as BatchOutputClipEditResult & { renderTaskId?: string | null };
      setEditWarnings(Array.isArray(editResult.warnings) ? editResult.warnings : []);
      if (editResult.changed && !editResult.visualChanged) {
        setEditFeedback({ kind: 'success', message: '修改已保存，片段已分割，画面总长不变，无需重新渲染。' });
      } else if (editResult.changed) {
        markRenderPending(true);
        setEditFeedback({ kind: 'success', message: '修改已保存。退出片段调整后会按新画面重新渲染，期间可以接着调。' });
      } else {
        setEditFeedback({ kind: 'success', message: '片段画面没有变化，已保持当前安排。' });
      }
      // 静默重拉:预览立即吃到新 arrangement(即改即看),不打断当前交互。
      await loadView(true);
      return true;
    } catch (error) {
      setEditFeedback({ kind: 'error', message: error instanceof Error ? error.message : '保存片段修改失败' });
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  /** 手动提交这一轮调整的重渲染(不必等退出)。幂等:同一 editRevision 不会重复排队。 */
  async function commitPendingRender(): Promise<void> {
    if (!pendingRenderRef.current) return;
    markRenderPending(false);
    try {
      const response = await fetch(clipsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'commit_render' }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setEditFeedback({ kind: 'success', message: '已排队重新渲染，完成后以新成片为准。' });
      onChangedRef.current?.();
    } catch {
      markRenderPending(true);
      setEditFeedback({ kind: 'error', message: '提交重新渲染失败，请重试。' });
    }
  }

  const handleVariableTrimCommit = async (sourceStartUs: number, sourceEndUs: number): Promise<boolean> => {
    if (!freeformClip) return false;
    return submitEdit({
      type: 'trim_variable',
      clipId: freeformClip.clipId,
      sourceStartUs,
      sourceEndUs,
    });
  };

  const handleSplitCommit = async (offsetUs: number): Promise<boolean> => {
    if (!freeformClip) return false;
    return submitEdit({ type: 'split', clipId: freeformClip.clipId, offsetUs });
  };

  const confirmReplace = async (): Promise<void> => {
    if (!selectedClip || !pendingReplaceAsset) return;
    const accepted = await submitEdit({ type: 'replace', clipId: selectedClip.clipId, assetId: pendingReplaceAsset.assetId });
    if (accepted) setReplaceCandidateId(null);
  };

  const confirmInsertAfter = async (): Promise<void> => {
    if (!selectedClip || !pendingReplaceAsset) return;
    const accepted = await submitEdit({
      type: 'insert',
      assetId: pendingReplaceAsset.assetId,
      afterClipId: selectedClip.clipId,
    });
    if (accepted) setReplaceCandidateId(null);
  };

  const confirmAppendToEnd = async (): Promise<void> => {
    if (!pendingReplaceAsset || clips.length === 0) return;
    const accepted = await submitEdit({
      type: 'insert',
      assetId: pendingReplaceAsset.assetId,
      afterClipId: clips[clips.length - 1].clipId,
    });
    if (accepted) setReplaceCandidateId(null);
  };

  const confirmDelete = async (targetClipId: string): Promise<void> => {
    const target = clips.find((clip) => clip.clipId === targetClipId);
    if (!target || clips.length === 1) return;
    const accepted = window.confirm(
      '删除后后续片段会自动前移，口播仍按原时间播放，需要注意声画对位。确定删除这段吗？',
    );
    if (!accepted) return;
    const result = await submitEdit({ type: 'delete', clipId: target.clipId });
    if (result) {
      setSelectedClipId(null);
      setReplaceCandidateId(null);
    }
  };

  if (loading && !view) {
    return <div className="tile p-6 text-center text-sm text-ink-secondary">正在读取成片安排…</div>;
  }
  if (loadError && !view) {
    return (
      <div className="tile space-y-3 p-6 text-sm">
        <p className="text-fail">读取成片安排失败：{loadError}</p>
        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => void loadView()}>重试</button>
      </div>
    );
  }
  if (!view) return null;

  return (
    <div className="space-y-4" data-testid={`batch-output-editor-${planId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-secondary">
          本片使用 {usedHere}/{poolAssets.length} 条素材 · 本批次还有 {neverUsed} 条素材从未被任何成片使用
          · 画面 {visualSec.toFixed(1)} 秒{narrationSec != null ? ` / 口播 ${narrationSec.toFixed(1)} 秒` : ''}
        </p>
        {pendingRender && (
          <span className="flex items-center gap-2 text-[11px] text-warn">
            修改已保存，退出本轮调整后会自动重新渲染
            <button
              type="button"
              className="btn-secondary h-7 shrink-0 whitespace-nowrap px-2 text-[11px]"
              onClick={() => void commitPendingRender()}
            >立即渲染</button>
          </span>
        )}
        {view.versionNumber != null && (
          <span className="text-[11px] text-ink-tertiary">
            当前 v{view.versionNumber}{view.editRevision > 0 ? ` · 已调整 ${view.editRevision} 次` : ''}
          </span>
        )}
      </div>

      {!view.outputVersionId && (
        <p className="tile p-3 text-xs text-warn">还没有可编辑的成片版本，请先完成首次渲染。</p>
      )}
      {view.outputVersionId && !view.editable && (
        <p className="tile p-3 text-xs text-warn">批次已停止或输入尚未冻结，当前只能查看，不能调整片段。</p>
      )}
      {renderBusy && (
        <p className="tile p-3 text-xs text-accent">正在按最新画面重新渲染，期间片段编辑暂时锁定。</p>
      )}
      {editFeedback && (
        <p
          role={editFeedback.kind === 'error' ? 'alert' : 'status'}
          className={`tile p-3 text-xs ${editFeedback.kind === 'error' ? 'text-fail' : 'text-ok'}`}
        >{editFeedback.message}</p>
      )}
      {editWarnings.length > 0 && (
        <ul className="tile space-y-1 p-3 text-xs text-warn" role="status">
          {editWarnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      {narrationSec != null && Math.abs(durationDeltaSec) >= 0.05 && (
        <p className="tile p-3 text-xs text-warn" role="status">
          {durationDeltaSec > 0
            ? `画面比口播长 ${durationDeltaSec.toFixed(1)} 秒，超出部分渲染时会被裁掉。`
            : `画面比口播短 ${Math.abs(durationDeltaSec).toFixed(1)} 秒，结尾会定格最后一帧补齐。`}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="min-w-0 space-y-3">
          <BatchTimelinePreview
            clips={clips}
            assetsById={previewAssetsById}
            coverUrl={coverUrl}
            subtitleCues={view.subtitleCues}
            narrationUrl={narrationUrl}
            bgm={previewBgm}
            outputPreset={outputPreset}
            playheadSec={playheadSec}
            onSeek={setPlayheadSec}
            active={active}
          />
        </section>

        <section className="min-w-0 space-y-2" aria-label="冻结素材池">
          <p className="text-xs font-medium text-ink">冻结素材池（{poolAssets.length}）</p>
          <p className="text-[11px] text-ink-tertiary">
            {selectedClip
              ? '点击素材后可替换当前片段、插入到它之后，或追加到末尾。'
              : '点击素材可追加到末尾；先在时间轴上选中片段，还可替换当前片段或插入到它之后。'}
          </p>
          <div className="grid max-h-[46vh] grid-cols-2 gap-2 overflow-y-auto pr-1">
            {poolAssets.map((asset) => {
              const usedByThis = asset.usedByPlanIds.includes(planId);
              const usedByOthers = !usedByThis && asset.usedByPlanIds.length > 0;
              const selectable = !asset.excluded && !editLocked && clips.length > 0;
              const pending = replaceCandidateId === asset.assetId;
              return (
                <button
                  key={asset.assetId}
                  type="button"
                  disabled={!selectable}
                  title={asset.excluded ? '该素材已被排除出本批次分配，不可用于替换' : undefined}
                  className={`tile space-y-1 p-2 text-left ${asset.excluded ? 'opacity-45' : ''} ${pending ? 'ring-2 ring-accent' : ''}`}
                  onClick={() => setReplaceCandidateId(pending ? null : asset.assetId)}
                >
                  {asset.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={asset.thumbnailUrl} alt="" loading="lazy" className="aspect-video w-full rounded-lg object-cover" />
                  ) : (
                    <span className="flex aspect-video w-full items-center justify-center rounded-lg bg-surface-subtle text-[10px] text-ink-tertiary">无缩略图</span>
                  )}
                  <span className="block truncate text-[11px] font-medium text-ink" title={asset.displayName}>{asset.displayName}</span>
                  <span className="block text-[10px] text-ink-tertiary">{asset.durationSec != null ? `${asset.durationSec.toFixed(1)} 秒` : '时长未知'}</span>
                  <span className="flex flex-wrap gap-1">
                    {usedByThis && <span className="rounded-full bg-ok/10 px-1.5 py-0.5 text-[10px] text-ok">本片已用</span>}
                    {usedByOthers && <span className="rounded-full bg-surface-subtle px-1.5 py-0.5 text-[10px] text-ink-secondary">其他成片已用</span>}
                    {asset.excluded && <span className="rounded-full bg-fail/10 px-1.5 py-0.5 text-[10px] text-fail">已排除</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {pendingReplaceAsset && (selectedClip || clips.length > 0) && (
            <div className="tile space-y-2 p-3">
              <p className="text-xs text-ink">
                {selectedClip
                  ? `用「${pendingReplaceAsset.displayName}」替换片段 #${clips.findIndex((clip) => clip.clipId === selectedClip.clipId) + 1}？画面窗口将从素材开头起播，替换后可再用「修剪」调整入点。`
                  : `把「${pendingReplaceAsset.displayName}」追加到末尾？默认插入 3 秒，插入后可再用「修剪」调整长度。`}
              </p>
              {/* 素材池是窄列,四个按钮排不下:必须让整行换行 + 每颗按钮 nowrap/不压缩。
                  .btn-* 基类是 line-height:1,一旦折行文字就会顶出 h-8 的胶囊。 */}
              <div className="flex flex-wrap gap-2">
                {selectedClip && (
                  <>
                    <button
                      type="button"
                      className="btn-primary h-8 shrink-0 whitespace-nowrap px-3 text-xs"
                      disabled={submitting}
                      onClick={() => void confirmReplace()}
                    >{submitting ? '处理中…' : '替换当前片段'}</button>
                    <button
                      type="button"
                      className="btn-secondary h-8 shrink-0 whitespace-nowrap px-3 text-xs"
                      disabled={submitting}
                      onClick={() => void confirmInsertAfter()}
                    >{submitting ? '处理中…' : '插入到选中片段之后'}</button>
                  </>
                )}
                <button
                  type="button"
                  className="btn-secondary h-8 shrink-0 whitespace-nowrap px-3 text-xs"
                  disabled={submitting || clips.length === 0}
                  onClick={() => void confirmAppendToEnd()}
                >{submitting ? '处理中…' : '追加到末尾'}</button>
                <button
                  type="button"
                  className="btn-secondary h-8 shrink-0 whitespace-nowrap px-3 text-xs"
                  disabled={submitting}
                  onClick={() => setReplaceCandidateId(null)}
                >取消</button>
              </div>
            </div>
          )}
        </section>
      </div>

      <BatchTimeline
        clips={clips}
        assets={poolAssets}
        subtitleCues={view.subtitleCues}
        narrationDurationUs={view.narration.durationUs}
        playheadSec={playheadSec}
        selectedClipId={selectedClipId}
        disabled={editLocked}
        onSeek={setPlayheadSec}
        onSelectClip={setSelectedClipId}
        onTrimVariable={async (clipId, sourceStartUs, sourceEndUs) =>
          submitEdit({ type: 'trim_variable', clipId, sourceStartUs, sourceEndUs })}
        onSplit={async (clipId, offsetUs) => submitEdit({ type: 'split', clipId, offsetUs })}
        onOpenFineTrim={(clipId) => { setSelectedClipId(clipId); setFreeformClipId(clipId); }}
        onDeleteClip={(clipId) => void confirmDelete(clipId)}
      />

      {freeformClip && (
        <BatchClipTrimEditor
          key={freeformClip.clipId}
          clip={freeformClip}
          asset={assetsById.get(freeformClip.assetId) ?? null}
          disabled={editLocked}
          onTrimCommit={handleVariableTrimCommit}
          onSplitCommit={handleSplitCommit}
          onClose={() => setFreeformClipId(null)}
        />
      )}
    </div>
  );
}
