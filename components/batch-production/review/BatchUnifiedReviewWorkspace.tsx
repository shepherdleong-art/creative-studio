'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';
import { FINAL_EDIT_FPS } from '@/lib/media-core/render-contract';
import { audioClips } from '@/lib/media-core/audio-edit';
import type { OutputPresetId } from '@/lib/media-core/cover-types';
import type { BatchOutputClipEditView, BatchOutputPoolAssetView } from '@/lib/batch-production/output-arrangement';
import BatchReviewPoolDock from './BatchReviewPoolDock';
import BatchReviewPreviewDock from './BatchReviewPreviewDock';
import BatchReviewInspectorDock from './BatchReviewInspectorDock';
import BatchReviewTimelineDock from './BatchReviewTimelineDock';
import BatchUnifiedExportDialog from './BatchUnifiedExportDialog';
import type { InspectorTab, SelectionTarget, TimelineTool, UnifiedFilmState } from './types';
import styles from './batch-unified-review.module.css';
import { subtitleSplitEdit } from './subtitle-edit';

const FPS = FINAL_EDIT_FPS;

/** 撤销/重做历史项:记录受影响成片与编辑前后的整包快照(回放走后端 restore_arrangement)。 */
interface EditHistoryEntry {
  planId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/** 从编辑器数据视图派生后端 restore_arrangement 快照(只含可编辑字段)。 */
function buildRestoreSnapshot(view: BatchOutputClipEditView): Record<string, unknown> {
  return {
    clips: view.clips,
    ...(view.audio !== undefined ? { audio: view.audio } : {}),
    preserveGaps: view.preserveGaps === true,
    subtitleOverride: view.subtitleOverride,
    subtitleCues: view.subtitleCues,
    subtitleStyle: view.subtitleStyle,
    subtitleStyleOverride: view.subtitleStyleOverride,
    coverAssetId: view.coverAssetId,
    coverTimeUs: view.coverTimeUs,
    coverFraming: view.coverFraming,
    coverTitle: view.coverTitle,
    coverTitleOverride: view.coverTitleOverride,
    musicTrackId: view.music.trackId,
    musicGainDb: view.music.gainDb,
    musicFadeInSec: view.music.fadeInSec,
    musicFadeOutSec: view.music.fadeOutSec,
    narrationGainDb: view.narration.gainDb,
  };
}

export interface BatchUnifiedReviewWorkspaceProps {
  projectId: string;
  batchId: string;
  workspace: BatchWorkspaceView;
  outputPreset: OutputPresetId;
  selectedPlanIds: string[];
  onTogglePlan: (planId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onReview: (decision: 'approved' | 'rework' | 'cancelled') => void;
  /** 按明确成片集合审核;预览区「确认这条」只作用于正在预览的那一条。 */
  onReviewPlans: (planIds: string[], decision: 'approved' | 'rework' | 'cancelled') => void;
  onReallocate: (planId: string) => void;
  onRetryNarration: (taskId: string) => void;
  onRetryRender: (taskId: string) => void;
  /** Phase E 单条任务重试/重分配的进行中标记(`narration:<id>` / `render:<id>` / planId)。 */
  phaseEBusy: string | null;
  onOutputChanged?: () => void;
}

const DEFAULT_LEFT = 250;
const DEFAULT_RIGHT = 300;
const DEFAULT_UPPER_PCT = 44; // 为两条带波形的音轨留出完整默认高度
const MIN_UPPER = 200;
const MIN_TIMELINE = 240;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export default function BatchUnifiedReviewWorkspace({
  projectId,
  batchId,
  workspace,
  outputPreset,
  selectedPlanIds,
  onTogglePlan,
  onSelectAll,
  onReview,
  onReviewPlans,
  onReallocate,
  onRetryNarration,
  onRetryRender,
  phaseEBusy,
  onOutputChanged,
}: BatchUnifiedReviewWorkspaceProps) {
  // Splitter panel sizes
  const [leftWidth, setLeftWidth] = useState<number | null>(null);
  const [rightWidth, setRightWidth] = useState<number | null>(null);
  const [upperHeightPct, setUpperHeightPct] = useState(DEFAULT_UPPER_PCT);
  const [resizing, setResizing] = useState<'left' | 'right' | 'top' | null>(null);

  const workbenchRef = useRef<HTMLDivElement>(null);
  const [workbenchSize, setWorkbenchSize] = useState({ width: 1000, height: 694 });
  useEffect(() => {
    const element = workbenchRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWorkbenchSize({ width: entry.borderBoxSize[0].inlineSize, height: entry.borderBoxSize[0].blockSize });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Grid padding (16px) and gaps (8px each) are excluded from the usable tracks.
  const columnsWidth = workbenchSize.width - 32;
  const rowsHeight = Math.max(MIN_UPPER + MIN_TIMELINE, workbenchSize.height - 24);
  // 宽窗口的新增空间也分给素材与属性；手动拖动后保留用户设定。
  const defaultLeft = clamp(columnsWidth * 0.26, DEFAULT_LEFT, 480);
  const defaultRight = clamp(columnsWidth * 0.2, DEFAULT_RIGHT, 380);
  const actualRight = clamp(rightWidth ?? defaultRight, 280, columnsWidth - 220 - 280);
  const actualLeft = clamp(leftWidth ?? defaultLeft, 220, columnsWidth - actualRight - 280);
  const upperHeight = clamp(rowsHeight * upperHeightPct / 100, MIN_UPPER, rowsHeight - MIN_TIMELINE);

  // Playhead and playback
  const [playheadSec, setPlayheadSec] = useState(0);

  // Tools & modes
  const [tool, setTool] = useState<TimelineTool>('select');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('subtitle');

  // Selection
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(() => workspace.cards[0]?.planId ?? null);
  const [selection, setSelection] = useState<SelectionTarget | null>(null);
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<BatchOutputPoolAssetView | null>(null);

  // Export dialog
  const [exportOpen, setExportOpen] = useState(false);

  // Arrangements cache: planId -> BatchOutputClipEditView
  const [arrangements, setArrangements] = useState<Record<string, BatchOutputClipEditView>>({});
  // Eye visibility map: planId -> boolean (default true)
  const [eyeMap, setEyeMap] = useState<Record<string, boolean>>({});

  // Undo / Redo history:撤销/重做把快照整包回放到后端(restore_arrangement),
  // 由后端走正式修订/冲突门禁——前端本地状态不再作为"已保存"的事实来源。
  const [undoStack, setUndoStack] = useState<EditHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<EditHistoryEntry[]>([]);

  // Fetch arrangements for all films
  const loadAllArrangements = useCallback(async () => {
    const plans = workspace.cards.map((c) => c.planId);
    if (plans.length === 0) return;

    try {
      const results = await Promise.all(
        plans.map(async (planId) => {
          const res = await fetch(
            `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(
              planId
            )}/arrangement?projectId=${encodeURIComponent(projectId)}`,
            { cache: 'no-store' }
          );
          if (!res.ok) return null;
          const data = (await res.json()) as BatchOutputClipEditView;
          return { planId, data };
        })
      );

      setArrangements((curr) => {
        const next = { ...curr };
        for (const item of results) {
          if (item) next[item.planId] = item.data;
        }
        return next;
      });
    } catch {
      // Ignore background fetch error
    }
  }, [batchId, projectId, workspace.cards]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadAllArrangements();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadAllArrangements]);

  // Load single film arrangement; returns the refreshed view (null on failure)
  const refreshFilmArrangement = useCallback(
    async (planId: string): Promise<BatchOutputClipEditView | null> => {
      try {
        const res = await fetch(
          `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(
            planId
          )}/arrangement?projectId=${encodeURIComponent(projectId)}`,
          { cache: 'no-store' }
        );
        if (!res.ok) return null;
        const data = (await res.json()) as BatchOutputClipEditView;
        setArrangements((curr) => ({ ...curr, [planId]: data }));
        onOutputChanged?.();
        return data;
      } catch {
        return null;
      }
    },
    [batchId, onOutputChanged, projectId]
  );

  // Submit an edit to a film's arrangement via REST API;成功后记录撤销历史
  const handleMediaEdit = useCallback(
    async (planId: string, edit: Record<string, unknown>): Promise<boolean> => {
      const beforeView = arrangements[planId] ?? null;
      try {
        const response = await fetch(
          `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/clips?projectId=${encodeURIComponent(projectId)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...edit, projectId }),
          }
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.message || '编辑失败');
        }
        const afterView = await refreshFilmArrangement(planId);
        if (beforeView && afterView) {
          setUndoStack((stack) => [
            ...stack.slice(-20),
            {
              planId,
              before: buildRestoreSnapshot(beforeView),
              after: buildRestoreSnapshot(afterView),
            },
          ]);
          setRedoStack([]);
        }
        return true;
      } catch (err) {
        alert(err instanceof Error ? err.message : '操作失败');
        return false;
      }
    },
    [arrangements, batchId, projectId, refreshFilmArrangement]
  );

  // Replay a restore snapshot to the backend (undo/redo shared path)
  const postRestoreSnapshot = useCallback(
    async (planId: string, snapshot: Record<string, unknown>): Promise<'ok' | 'conflict' | 'error'> => {
      const current = arrangements[planId];
      try {
        const response = await fetch(
          `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/clips?projectId=${encodeURIComponent(projectId)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId,
              type: 'restore_arrangement',
              snapshot,
              ...(current ? { expectedEditRevision: current.editRevision } : {}),
            }),
          }
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (data.code === 'conflict') return 'conflict';
          throw new Error(data.message || '撤销/重做失败');
        }
        await refreshFilmArrangement(planId);
        return 'ok';
      } catch (err) {
        alert(err instanceof Error ? err.message : '操作失败');
        return 'error';
      }
    },
    [arrangements, batchId, projectId, refreshFilmArrangement]
  );

  // Pool assets: aggregate from all loaded arrangements
  const poolAssets = useMemo(() => {
    const assetMap = new Map<string, BatchOutputPoolAssetView>();
    for (const view of Object.values(arrangements)) {
      if (!view?.poolAssets) continue;
      for (const asset of view.poolAssets) {
        if (!assetMap.has(asset.assetId)) {
          assetMap.set(asset.assetId, asset);
        } else {
          // Merge use counts
          const existing = assetMap.get(asset.assetId)!;
          const mergedCounts = { ...existing.useCountByPlanId, ...asset.useCountByPlanId };
          const mergedCoverPlans = Array.from(new Set([...existing.coverUsedByPlanIds, ...asset.coverUsedByPlanIds]));
          assetMap.set(asset.assetId, {
            ...existing,
            useCountByPlanId: mergedCounts,
            coverUsedByPlanIds: mergedCoverPlans,
          });
        }
      }
    }
    return Array.from(assetMap.values());
  }, [arrangements]);

  // Unified film states
  const films: UnifiedFilmState[] = useMemo(() => {
    return workspace.cards.map((card) => {
      const arrangement = arrangements[card.planId] ?? null;
      const lastClipEndSec = arrangement?.clips?.at(-1)?.timelineEndUs ? arrangement.clips.at(-1)!.timelineEndUs / 1e6 : 0;
      const narrationSec = arrangement?.narration?.durationUs ? arrangement.narration.durationUs / 1e6 : 0;
      const durationSec = Math.max(lastClipEndSec, narrationSec, 5);

      return {
        planId: card.planId,
        seq: card.seq,
        scriptTitle: card.scriptTitle || '未命名脚本',
        status: card.status,
        approved: card.approved,
        approvable: card.approvable,
        formalOutdated: card.formalOutdated,
        coverAttemptId: card.coverAttemptId,
        coverStatus: card.coverStatus,
        durationSec,
        arrangement,
        visible: eyeMap[card.planId] ?? true,
        warnings: card.warnings,
        blockers: card.blockers,
        narrationTask: card.narrationTask,
        coverTask: card.coverTask,
        fullRenderTask: card.fullRenderTask,
        subtitleOverride: card.subtitleOverride,
      };
    });
  }, [workspace.cards, arrangements, eyeMap]);

  // Preview film: the FIRST film in `films` where visible === true
  const previewFilm = useMemo(() => {
    return films.find((f) => f.visible) ?? null;
  }, [films]);

  // Selected film for inspector
  const activeFilm = useMemo(() => {
    return films.find((f) => f.planId === selectedPlanId) ?? films[0] ?? null;
  }, [films, selectedPlanId]);

  // Toggle eye visibility for a film
  const handleToggleEye = useCallback((planId: string) => {
    setEyeMap((curr) => ({
      ...curr,
      [planId]: !(curr[planId] ?? true),
    }));
  }, []);

  // Splitter pointer drag handlers
  const handleSplitterPointerDown = (type: 'left' | 'right' | 'top', e: React.PointerEvent) => {
    e.preventDefault();
    setResizing(type);

    const startX = e.clientX;
    const startY = e.clientY;
    const initLeft = actualLeft;
    const initRight = actualRight;
    const initUpper = upperHeight;

    const onMove = (moveEvent: PointerEvent) => {
      if (type === 'left') {
        const delta = moveEvent.clientX - startX;
        setLeftWidth(clamp(initLeft + delta, 220, columnsWidth - actualRight - 280));
      } else if (type === 'right') {
        const delta = startX - moveEvent.clientX;
        setRightWidth(clamp(initRight + delta, 280, columnsWidth - actualLeft - 280));
      } else if (type === 'top') {
        const deltaY = moveEvent.clientY - startY;
        setUpperHeightPct(clamp(initUpper + deltaY, MIN_UPPER, rowsHeight - MIN_TIMELINE) / rowsHeight * 100);
      }
    };

    const onUp = () => {
      setResizing(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onUp);
  };

  // Undo / Redo:把编辑前(后)快照回放到后端,由后端完成正式修订与审核清理;
  // 冲突(期间发生了更新的正式编辑)时不覆盖新修订,历史整体作废。
  const handleUndo = useCallback(async () => {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    const outcome = await postRestoreSnapshot(entry.planId, entry.before);
    if (outcome === 'ok') {
      setUndoStack((s) => s.slice(0, -1));
      setRedoStack((s) => [...s, entry]);
    } else if (outcome === 'conflict') {
      setUndoStack([]);
      setRedoStack([]);
      alert('这条成片已有更新的正式编辑，撤销被拒绝。已按最新状态刷新，历史已重置。');
    }
  }, [undoStack, postRestoreSnapshot]);

  const handleRedo = useCallback(async () => {
    const entry = redoStack[redoStack.length - 1];
    if (!entry) return;
    const outcome = await postRestoreSnapshot(entry.planId, entry.after);
    if (outcome === 'ok') {
      setRedoStack((s) => s.slice(0, -1));
      setUndoStack((s) => [...s, entry]);
    } else if (outcome === 'conflict') {
      setUndoStack([]);
      setRedoStack([]);
      alert('这条成片已有更新的正式编辑，重做被拒绝。已按最新状态刷新，历史已重置。');
    }
  }, [redoStack, postRestoreSnapshot]);

  // Global Keyboard Shortcuts (PRD T-06)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if focus is in input / textarea
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        // Space triggers play/pause in BatchTimelinePreview
        const playBtn = document.querySelector<HTMLButtonElement>('[data-toggle-play]');
        playBtn?.click();
      } else if (e.key === 'v' || e.key === 'V') {
        setTool('select');
      } else if (e.key === 'b' || e.key === 'B') {
        if (e.metaKey || e.ctrlKey) {
          // Split at playhead(视频或选中的音频片段)
          e.preventDefault();
          if (selectedPlanId) {
            const film = films.find((f) => f.planId === selectedPlanId);
            if (selection?.kind === 'clip' && selection.clipId) {
              const clip = film?.arrangement?.clips.find((c) => c.clipId === selection.clipId);
              if (clip) {
                const offsetUs = Math.round((playheadSec - clip.timelineStartUs / 1e6) * 1e6);
                if (offsetUs >= 500_000 && clip.sourceEndUs - clip.sourceStartUs - offsetUs >= 500_000) {
                  void handleMediaEdit(selectedPlanId, {
                    type: 'split',
                    clipId: clip.clipId,
                    offsetUs,
                  });
                }
              }
            } else if (selection?.kind === 'subtitle' && selection.cueId && film?.arrangement?.editable) {
              const cue = film.arrangement.subtitleCues.find(c => c.id === selection.cueId);
              const edit = cue ? subtitleSplitEdit(cue, Math.round(playheadSec * 1e6)) : null;
              if (edit) void handleMediaEdit(selectedPlanId, edit);
            } else if (selection?.kind === 'audio' && selection.track && selection.clipId && film?.arrangement) {
              const trackClips = audioClips(
                { audio: film.arrangement.audio },
                selection.track,
                film.arrangement.narration?.durationUs ?? film.durationSec * 1e6
              );
              const audioClip = trackClips.find((c) => c.id === selection.clipId);
              const atUs = Math.round(playheadSec * 1e6);
              if (audioClip && atUs - audioClip.timelineStartUs >= 500_000 && audioClip.timelineEndUs - atUs >= 500_000) {
                void handleMediaEdit(selectedPlanId, {
                  type: 'split_audio_clip',
                  track: selection.track,
                  clipId: audioClip.id,
                  atUs,
                });
              }
            }
          }
        } else {
          setTool('split');
        }
      } else if (e.key === 'n' || e.key === 'N') {
        setSnapEnabled((s) => !s);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedPlanId) {
          if (selection?.kind === 'clip' && selection.clipId) {
            e.preventDefault();
            void handleMediaEdit(selectedPlanId, { type: 'delete', clipId: selection.clipId });
            setSelection(null);
          } else if (selection?.kind === 'subtitle' && selection.cueId) {
            e.preventDefault();
            void handleMediaEdit(selectedPlanId, { type: 'delete_subtitle_cue', cueId: selection.cueId });
            setSelection(null);
          } else if (selection?.kind === 'audio' && selection.track && selection.clipId) {
            e.preventDefault();
            void handleMediaEdit(selectedPlanId, {
              type: 'delete_audio_clip',
              track: selection.track,
              clipId: selection.clipId,
            });
            setSelection(null);
          }
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const step = e.shiftKey ? 10 / FPS : 1 / FPS;
        setPlayheadSec((t) => Math.max(0, t - step));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 10 / FPS : 1 / FPS;
        setPlayheadSec((t) => t + step);
      } else if (e.key === 'Escape') {
        setPreviewAsset(null);
        setFocusedAssetId(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selection, selectedPlanId, films, playheadSec, handleMediaEdit, handleUndo, handleRedo]);

  const approvedCount = films.filter((f) => f.approved).length;

  // v14 时间轴行筛选:全部 / 待检查 / 已确认 / 区间重复(只影响行展示,不改数据与眼睛)
  const [rowFilter, setRowFilter] = useState<'all' | 'pending' | 'approved' | 'overlap'>('all');

  // v14「显示全部轨道」:一键恢复所有眼睛可见性
  const handleShowAll = useCallback(() => {
    setEyeMap((curr) => {
      const next = { ...curr };
      for (const card of workspace.cards) next[card.planId] = true;
      return next;
    });
  }, [workspace.cards]);

  return (
    <div className={styles.reviewContainer}>
      {/* Top Header — v14:标题/操作说明 + 已确认 + 统一导出入口 */}
      <header className={styles.reviewHeader}>
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="shrink-0 text-base font-semibold text-ink">批量剪辑 · 统一审片</h2>
          <p className="truncate text-xs text-ink-secondary hidden lg:inline">
            拖动分隔线调整各区大小，双击恢复默认。共用播放头，只播放最上层可见成片。
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <div className="text-xs text-ink-secondary flex items-center gap-1">
            <span>已确认</span>
            <strong className="text-sm font-semibold text-ink">{approvedCount}</strong>
            <span>/ {films.length}</span>
          </div>

          <button
            type="button"
            className="btn-primary h-8 px-3.5 text-xs flex items-center gap-1.5 shadow-sm"
            onClick={() => setExportOpen(true)}
          >
            <span>统一导出 {approvedCount} 条</span>
            <Icon name="chevron-right" size={12} />
          </button>
        </div>
      </header>

      {/* Main 4-zone Workbench */}
      <div
        ref={workbenchRef}
        className={styles.reviewWorkbench}
        style={{
          gridTemplateColumns: `${actualLeft}px minmax(280px, 1fr) ${actualRight}px`,
          gridTemplateRows: `${upperHeight}px minmax(${MIN_TIMELINE}px, 1fr)`,
        }}
      >
        {/* Zone 1: Material Pool Dock (Upper Left) */}
        <div style={{ gridColumn: 1, gridRow: 1 }} className="min-h-0 min-w-0">
          <BatchReviewPoolDock
            projectId={projectId}
            batchId={batchId}
            selectedPlanId={selectedPlanId}
            poolAssets={poolAssets}
            focusedAssetId={focusedAssetId}
            onSelectFocusedAsset={setFocusedAssetId}
            onPreviewAsset={(asset) => setPreviewAsset(asset)}
            onAssetImported={loadAllArrangements}
          />
        </div>

        {/* Zone 2: Video Preview Dock (Upper Middle) */}
        <div style={{ gridColumn: 2, gridRow: 1 }} className="min-h-0 min-w-0">
          <BatchReviewPreviewDock
            projectId={projectId}
            batchId={batchId}
            outputPreset={outputPreset}
            previewFilm={previewFilm}
            previewAsset={previewAsset}
            onClearPreviewAsset={() => setPreviewAsset(null)}
            playheadSec={playheadSec}
            onSeek={setPlayheadSec}
            poolAssets={poolAssets}
            onToggleReview={(planId, currentApproved) => {
              // 「确认这条」只作用于正在预览的这一条成片,与多选集合无关。
              onReviewPlans([planId], currentApproved ? 'cancelled' : 'approved');
            }}
          />
        </div>

        {/* Zone 3: Inspector Dock (Right, spanning rows 1 & 2) */}
        <div style={{ gridColumn: 3, gridRow: '1 / 3' }} className="min-h-0 min-w-0">
          <BatchReviewInspectorDock
            projectId={projectId}
            batchId={batchId}
            outputPreset={outputPreset}
            film={activeFilm}
            selection={selection}
            inspectorTab={inspectorTab}
            onTabChange={setInspectorTab}
            poolAssets={poolAssets}
            onMediaEdit={handleMediaEdit}
            onRefreshFilm={async (planId) => {
              await refreshFilmArrangement(planId);
            }}
          />
        </div>

        {/* Zone 4: Unified Timeline Dock (Bottom, spanning columns 1 & 2) */}
        <div style={{ gridColumn: '1 / 3', gridRow: 2 }} className="min-h-0 min-w-0">
          <BatchReviewTimelineDock
            projectId={projectId}
            batchId={batchId}
            films={films}
            selectedPlanId={selectedPlanId}
            onSelectFilm={(id) => setSelectedPlanId(id)}
            selection={selection}
            onSelectTarget={setSelection}
            focusedAssetId={focusedAssetId}
            onSelectFocusedAsset={setFocusedAssetId}
            playheadSec={playheadSec}
            onSeek={setPlayheadSec}
            tool={tool}
            onToolChange={setTool}
            snapEnabled={snapEnabled}
            onToggleSnap={() => setSnapEnabled((s) => !s)}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={undoStack.length > 0}
            canRedo={redoStack.length > 0}
            poolAssets={poolAssets}
            onToggleEye={handleToggleEye}
            onTogglePlanSelect={(planId, checked) => onTogglePlan(planId, checked)}
            selectedPlanIds={selectedPlanIds}
            onSelectAll={onSelectAll}
            onReview={onReview}
            rowFilter={rowFilter}
            onRowFilterChange={setRowFilter}
            onShowAll={handleShowAll}
            batchControlState={workspace.batch.controlState}
            phaseEBusy={phaseEBusy}
            onReallocate={onReallocate}
            onRetryNarration={onRetryNarration}
            onRetryRender={onRetryRender}
            onMediaEdit={handleMediaEdit}
            onRefreshFilm={async (planId) => {
              await refreshFilmArrangement(planId);
            }}
            onOpenCoverEditor={(planId) => {
              setSelectedPlanId(planId);
              setInspectorTab('cover');
            }}
          />
        </div>

        {/* Left Splitter */}
        <div
          tabIndex={0}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整素材池宽度"
          aria-valuemin={220}
          aria-valuemax={columnsWidth - actualRight - 280}
          aria-valuenow={actualLeft}
          className={`${styles.splitter} ${styles.splitterCol} ${resizing === 'left' ? styles.splitterDragging : ''}`}
          style={{ left: actualLeft + 8, height: upperHeight }}
          onPointerDown={(e) => handleSplitterPointerDown('left', e)}
          onDoubleClick={() => setLeftWidth(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); setLeftWidth(clamp(actualLeft - 12, 220, columnsWidth - actualRight - 280)); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setLeftWidth(clamp(actualLeft + 12, 220, columnsWidth - actualRight - 280)); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); setLeftWidth(null); }
          }}
        />

        {/* Right Splitter */}
        <div
          tabIndex={0}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整属性检查器宽度"
          aria-valuemin={280}
          aria-valuemax={columnsWidth - actualLeft - 280}
          aria-valuenow={actualRight}
          className={`${styles.splitter} ${styles.splitterCol} ${resizing === 'right' ? styles.splitterDragging : ''}`}
          style={{ right: actualRight + 8, top: 8, bottom: 8 }}
          onPointerDown={(e) => handleSplitterPointerDown('right', e)}
          onDoubleClick={() => setRightWidth(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); setRightWidth(clamp(actualRight + 12, 280, columnsWidth - actualLeft - 280)); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setRightWidth(clamp(actualRight - 12, 280, columnsWidth - actualLeft - 280)); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); setRightWidth(null); }
          }}
        />

        {/* Top Horizontal Splitter */}
        <div
          tabIndex={0}
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整上下区域比例"
          aria-valuemin={Math.round(MIN_UPPER / rowsHeight * 100)}
          aria-valuemax={Math.round((rowsHeight - MIN_TIMELINE) / rowsHeight * 100)}
          aria-valuenow={Math.round(upperHeight / rowsHeight * 100)}
          className={`${styles.splitter} ${styles.splitterRow} ${resizing === 'top' ? styles.splitterDragging : ''}`}
          style={{
            top: upperHeight + 8,
            width: `calc(100% - ${actualRight + 24}px)`,
          }}
          onPointerDown={(e) => handleSplitterPointerDown('top', e)}
          onDoubleClick={() => setUpperHeightPct(DEFAULT_UPPER_PCT)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setUpperHeightPct(clamp(upperHeight - 16, MIN_UPPER, rowsHeight - MIN_TIMELINE) / rowsHeight * 100); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setUpperHeightPct(clamp(upperHeight + 16, MIN_UPPER, rowsHeight - MIN_TIMELINE) / rowsHeight * 100); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); setUpperHeightPct(DEFAULT_UPPER_PCT); }
          }}
        />
      </div>

      {/* Export Dialog */}
      <BatchUnifiedExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        films={films}
        projectId={projectId}
        batchId={batchId}
        onExportStarted={() => {
          onOutputChanged?.();
        }}
      />
    </div>
  );
}
