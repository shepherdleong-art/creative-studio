'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { FinalEditPreview } from '@/components/final-edit/FinalEditPreview';
import { StyleEditor } from '@/components/final-edit/FinalEditInspector';
import { drawText, textStyleFont } from '@/components/final-edit/text-canvas-renderer';
import type { GroupCommandInput, VariantCommandInput } from '@/components/final-edit/command-types';
import { drawFramedImage } from '@/lib/final-edit/cover-framing';
import { timelineGaps } from '@/lib/final-edit/domain';
import { hasLegacyAutomaticSubtitleCuesToNormalize } from '@/lib/final-edit/subtitle-cue-normalize';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES, FINAL_EDIT_MIN_CLIP_FRAMES, OUTPUT_PRESETS, type CoverEditorDraft, type FinalEditAssetView, type FinalEditGroupView, type FinalEditVariantView, type TimelineClip } from '@/lib/final-edit/types';
import { NARRATION_GAIN_DB_DEFAULT } from '@/lib/media-core/audio-gain';
import type { PackagingLayoutsPatch, PackagingPointLayout, PackagingVars } from '@/lib/final-edit/packaging-vars';
import type { PointCue } from '@/lib/final-edit/packaging-cues';
import { MixcutTimeline } from './MixcutTimeline';
import { NarrationPlaybackRateControl } from './NarrationPlaybackRateControl';
import { NarrationGainControl } from './NarrationGainControl';
import { TrimEditor } from './TrimEditor';
import { VideoPlaybackRateControl } from '@/components/mixcut/VideoPlaybackRateControl';
import { ClipFramingControl } from './ClipFramingControl';
import { CoverEditorDrawer } from './CoverEditorDrawer';
import { preloadSystemFonts } from '@/components/system-fonts';
import { BgmCard, type BgmImportUiResult } from './BgmCard';
import { PackagingCard, type PackagingPreviewData } from './PackagingCard';
import { PackagingTextEditPopover } from '@/components/packaging/PackagingTextEditor';
import { PackagingOverlaySync } from './packaging-overlay-sync';
import type { BgmImportResponse } from '@/lib/final-edit/types';
import styles from './mixcut-content.module.css';

const FPS = FINAL_EDIT_FPS;
type PreviewMode = 'output' | 'material';

async function responseBody<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || `HTTP ${response.status}`) as Error & { details?: unknown; code?: string };
    if (body.details !== undefined) error.details = body.details;
    if (typeof body.error === 'string') error.code = body.error;
    throw error;
  }
  return body as T;
}

type VariantCommandRequest = VariantCommandInput | ((variant: FinalEditVariantView) => VariantCommandInput);
type GroupCommandRequest = GroupCommandInput | ((group: FinalEditGroupView) => GroupCommandInput);

/** Partial<PackagingVars>（值可缺省）→ 命令要求的 Record<string, string>（与 PackagingCard.overridesRecord 同逻辑）。 */
function packagingVarsOverridesRecord(overrides: Partial<PackagingVars>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') record[key] = value;
  }
  return record;
}

// V2 第 3 步（规格 §6）：直接渲染网格子节点——素材替换列 / Resizer / 主区（工具行+大纸）/ Resizer / 右栏三卡。

// 列宽与折叠由 MixcutPanel 通过 CSS 变量与 body class 驱动。
export function PreviewStep({ group, active, onGroupChange, onExport, onRepCollapse, onRgtCollapse, onResizeStart }: {
  group: FinalEditGroupView;
  active: boolean;
  onGroupChange: (group: FinalEditGroupView) => void;
  onExport: (variantId: string) => void;
  onRepCollapse: (collapsed: boolean) => void;
  onRgtCollapse: (collapsed: boolean) => void;
  onResizeStart: (side: 'rep' | 'rgt') => (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const [selectedVariantId, setSelectedVariantId] = useState(group.variants[0]?.id || '');
  const [selectedClipId, setSelectedClipId] = useState('');
  const [selectedMaterialKey, setSelectedMaterialKey] = useState('');
  const [previewMode, setPreviewMode] = useState<PreviewMode>('output');
  const [previewMaterialKey, setPreviewMaterialKey] = useState('');
  const [selectedCueId, setSelectedCueId] = useState(group.subtitleCues[0]?.id || '');
  const [selectedPointId, setSelectedPointId] = useState('');
  const [playheadSec, setPlayheadSec] = useState(0);
  const [seekRequestId, setSeekRequestId] = useState(0);
  const [message, setMessage] = useState('已从本地草稿恢复');
  const [busy, setBusy] = useState(false);
  const [narrationGainPreview, setNarrationGainPreview] = useState<{ groupId: string; gainDb: number } | null>(null);
  const [bgmGainPreview, setBgmGainPreview] = useState<{ variantId: string; gainDb: number } | null>(null);
  const [previewStopRequestId, setPreviewStopRequestId] = useState(0);
  const [auditionStopRequestId, setAuditionStopRequestId] = useState(0);
  const [coverOpen, setCoverOpen] = useState(false);
  const [trimClip, setTrimClip] = useState<TimelineClip | null>(null);
  const [trimPreviewInFrame, setTrimPreviewInFrame] = useState(0);
  const [analyzingKey, setAnalyzingKey] = useState('');
  type HistoryEntry = { scope: 'variant' | 'group'; id: string; before: number; after: number };
  const historyRef = useRef<{ undo: HistoryEntry[]; redo: HistoryEntry[] }>({ undo: [], redo: [] });
  const [historyAvailable, setHistoryAvailable] = useState({ undo: false, redo: false });
  const syncHistory = () => setHistoryAvailable({ undo: historyRef.current.undo.length > 0, redo: historyRef.current.redo.length > 0 });
  const groupRef = useRef(group);
  const previewRootRef = useRef<HTMLElement>(null);
  const clearHistory = () => { historyRef.current = { undo: [], redo: [] }; syncHistory(); };
  const recordHistory = (entry: HistoryEntry) => {
    historyRef.current.undo.push(entry);
    historyRef.current.redo = [];
    syncHistory();
  };
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const previewTabRefs = useRef<Record<PreviewMode, HTMLButtonElement | null>>({ output: null, material: null });
  const pendingRef = useRef(0);
  const mountedRef = useRef(true);
  const applyGroupRef = useRef<(request: GroupCommandRequest) => Promise<boolean>>(async () => false);
  const automaticSubtitleNormalizationRef = useRef(new Set<string>());
  const variant = group.variants.find((item) => item.id === selectedVariantId) || group.variants[0] || null;
  const selectedClip = variant?.timeline.clips.find((clip) => clip.id === selectedClipId) || null;
  const selectedMaterial = group.assets.find((asset) => (asset.assetKey || asset.videoJobId) === selectedMaterialKey) || null;
  const previewMaterial = group.assets.find((asset) => (asset.assetKey || asset.videoJobId) === previewMaterialKey) || null;
  // 用户可见名称一律走 displayName（D5）；filename 只服务播放 URL/物理路径。
  const materialName = (asset: FinalEditAssetView | null) => (asset ? asset.displayName || asset.filename : '');
  const timelineSelectedCueId = group.subtitleCues.some((cue) => cue.id === selectedCueId) ? selectedCueId : '';
  // 卖点选中态：与 selectedCueId 同级；选中 id 可能因删除/重提取失效，下游一律用校验后的 timelineSelectedPointId
  const selectedPointIdRef = useRef('');
  const timelineSelectedPointId = group.packaging.pointCues?.some((cue) => cue.id === selectedPointId) ? selectedPointId : '';
  const orderedClips = useMemo(() => variant ? [...variant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame) : [], [variant]);
  const trimClipIndex = trimClip ? orderedClips.findIndex((clip) => clip.id === trimClip.id) : -1;
  const trimAsset = trimClip ? group.assets.find((asset) => asset.videoJobId === trimClip.videoJobId) ?? null : null;
  // 截取草稿只交给播放器；点击“完成”前不改时间轴数据或保存历史。
  const trimPreviewVariant = useMemo(() => {
    if (!variant || !trimClip) return variant;
    return {
      ...variant,
      timeline: {
        ...variant.timeline,
        clips: variant.timeline.clips.map((clip) => clip.id === trimClip.id ? {
          ...clip,
          sourceInFrame: trimPreviewInFrame,
          sourceOutFrame: trimPreviewInFrame + trimClip.sourceOutFrame - trimClip.sourceInFrame,
        } : clip),
      },
    };
  }, [variant, trimClip, trimPreviewInFrame]);
  const usedVideoJobIds = useMemo(() => new Set(variant?.timeline.clips.map((clip) => clip.videoJobId) ?? []), [variant]);
  const firstInsertableGap = useMemo(() => variant
    ? timelineGaps(variant.timeline.bodyFrames, variant.timeline.clips)
      .find((gap) => gap.endFrame - gap.startFrame >= FINAL_EDIT_MIN_CLIP_FRAMES) || null
    : null, [variant]);
  const selectedBgmTrack = group.bgmTracks.find(
    (track) => track.id === variant?.bgm.trackId,
  );

  useEffect(() => { groupRef.current = group; }, [group]);
  // 进入混剪步骤即预取字体列表：封面抽屉是条件挂载，预取让它打开的首帧就是全量字体。
  useEffect(() => { preloadSystemFonts(); }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const publishGroup = (next: FinalEditGroupView) => {
    groupRef.current = next;
    if (mountedRef.current) onGroupChange(next);
  };

  const reloadGroup = async (groupId: string) => {
    const current = await responseBody<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${groupId}`));
    if (groupRef.current.id === groupId) publishGroup(current);
    return current;
  };
  // 供预览 JSON 副作用使用（effect 依赖不含函数本体，沿用 applyGroupRef 同款持法）
  const reloadGroupRef = useRef(reloadGroup);
  useEffect(() => { reloadGroupRef.current = reloadGroup; });

  const enqueue = <T,>(work: () => Promise<T>): Promise<T> => {
    pendingRef.current += 1;
    setBusy(true);
    const scheduled = queueRef.current.then(work, work);
    queueRef.current = scheduled.then(() => undefined, () => undefined);
    return scheduled.finally(() => {
      pendingRef.current -= 1;
      if (mountedRef.current && pendingRef.current === 0) setBusy(false);
    });
  };

  const applyVariantNow = async (request: VariantCommandRequest, record = true): Promise<boolean> => {
    const currentGroup = groupRef.current;
    const currentVariant = currentGroup.variants.find((item) => item.id === selectedVariantId) || currentGroup.variants[0];
    if (!currentVariant) return false;
    const command = typeof request === 'function' ? request(currentVariant) : request;
    try {
      const result = await responseBody<{ view: FinalEditVariantView }>(await fetch(`/api/final-edit-variants/${currentVariant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: currentVariant.revision, ...command }),
      }));
      const latest = groupRef.current;
      if (latest.id === currentGroup.id) publishGroup({ ...latest, variants: latest.variants.map((item) => item.id === result.view.id ? result.view : item) });
      if (record) recordHistory({ scope: 'variant', id: currentVariant.id, before: currentVariant.revision, after: result.view.revision });
      if (mountedRef.current) setMessage('已自动保存');
      return true;
    } catch (error) {
      clearHistory();
      await reloadGroup(currentGroup.id).catch(() => undefined);
      if (mountedRef.current) setMessage(`保存失败，已恢复服务端版本：${error instanceof Error ? error.message : String(error)}`);
      // 源校验失败时后端 details 会给出 clipId，直接定位到出问题的片段
      // （复用 TextOverflowError 的「点击提示定位」交互）。
      const details = (error as { details?: { clipId?: string } } | undefined)?.details;
      if (details?.clipId) setSelectedClipId(details.clipId);
      return false;
    }
  };

  const applyVariant = (request: VariantCommandRequest): Promise<boolean> =>
    enqueue(() => applyVariantNow(request));

  const importBgmFiles = (files: File[]): Promise<BgmImportUiResult> => {
    const targetGroupId = groupRef.current.id;
    return enqueue(async () => {
      const formData = new FormData();
      for (const file of files) formData.append('files', file);
      const response = await fetch('/api/final-edit-bgm', {
        method: 'POST',
        body: formData,
      });
      const body = await response.json().catch(() => ({})) as Partial<BgmImportResponse> & {
        error?: string;
        message?: string;
      };
      if (!response.ok && response.status !== 422) {
        throw new Error(body.message || body.error || `HTTP ${response.status}`);
      }
      const imported = body.imported || [];
      const reused = body.reused || [];
      const errors = body.errors || [];
      const detailParts: string[] = [];
      if (imported.length) detailParts.push(`已导入 ${imported.length} 首`);
      if (reused.length) detailParts.push(`已复用 ${reused.length} 首`);
      if (errors.length) detailParts.push(`${errors.length} 首失败`);
      const details = detailParts.join('，');
      const errorMessages = errors.map((error) => `${error.filename}：${error.message}`).join('\n');

      if (groupRef.current.id !== targetGroupId) {
        if (errorMessages && mountedRef.current) setMessage(errorMessages);
        return body.firstSuccessfulTrackId
          ? { outcome: 'imported' as const, announcement: `音乐已添加到音乐库，未应用到当前音轨（${details}）`, details }
          : { outcome: 'failed' as const, announcement: '添加失败', details };
      }

      const refreshed = await reloadGroup(targetGroupId);
      const firstId = body.firstSuccessfulTrackId || null;
      if (!firstId) {
        if (errorMessages && mountedRef.current) setMessage(errorMessages);
        return { outcome: 'failed' as const, announcement: '添加失败', details };
      }

      const refreshedVariant = refreshed.variants.find((item) => item.id === selectedVariantId) || refreshed.variants[0];
      if (!refreshedVariant) {
        if (errorMessages && mountedRef.current) setMessage(errorMessages);
        return { outcome: 'failed' as const, announcement: '添加失败', details };
      }

      const succeeded = await applyVariantNow({ type: 'set_bgm', trackId: firstId });
      if (succeeded) {
        if (errorMessages && mountedRef.current) setMessage(errorMessages);
        return { outcome: 'applied' as const, announcement: `已添加并应用到音轨（${details}）`, details };
      }
      return { outcome: 'failed' as const, announcement: '添加失败', details };
    }).then((result) => result, () => ({ outcome: 'failed' as const, announcement: '添加失败，请重试', details: '' }));
  };

  const applyGroup = (request: GroupCommandRequest, record = true): Promise<boolean> => {
    const targetGroupId = groupRef.current.id;
    return enqueue(async () => {
      const currentGroup = groupRef.current;
      if (currentGroup.id !== targetGroupId) return false;
      const command = typeof request === 'function' ? request(currentGroup) : request;
      try {
        const result = await responseBody<{ view: FinalEditGroupView }>(await fetch(`/api/final-edit-groups/${currentGroup.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedRevision: currentGroup.revision, ...command }),
        }));
        if (groupRef.current.id === currentGroup.id) publishGroup(result.view);
        if (record && /subtitle/.test(command.type) && command.type !== 'normalize_automatic_subtitles') {
          recordHistory({ scope: 'group', id: currentGroup.id, before: currentGroup.revision, after: result.view.revision });
        } else if (record) clearHistory();
        if (mountedRef.current) setMessage('已自动保存');
        return true;
      } catch (error) {
        clearHistory();
        await reloadGroup(currentGroup.id).catch(() => undefined);
        if (mountedRef.current) setMessage(`保存失败，已恢复服务端版本：${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    });
  };
  useEffect(() => {
    applyGroupRef.current = applyGroup;
  });

  useEffect(() => {
    if (!hasLegacyAutomaticSubtitleCuesToNormalize(group.subtitleCues)) return;
    const requestKey = group.id + ':' + group.revision;
    if (automaticSubtitleNormalizationRef.current.has(requestKey)) return;
    automaticSubtitleNormalizationRef.current.add(requestKey);
    void applyGroupRef.current({ type: 'normalize_automatic_subtitles' }).then((accepted) => {
      if (!accepted) automaticSubtitleNormalizationRef.current.delete(requestKey);
    });
  }, [group.id, group.revision, group.subtitleCues]);

  const restoreHistory = async (redo: boolean) => {
    if (busy) return;
    const history = historyRef.current;
    const entry = (redo ? history.redo : history.undo).at(-1);
    if (!entry) return;
    if (entry.scope === 'variant' && entry.id !== variant?.id) return;
    const revision = redo ? entry.after : entry.before;
    const accepted = entry.scope === 'variant'
      ? await enqueue(() => applyVariantNow({ type: 'restore_revision', revision }, false))
      : await applyGroup({ type: 'restore_subtitle_revision', revision }, false);
    if (!accepted) return;
    (redo ? history.redo : history.undo).pop();
    (redo ? history.undo : history.redo).push(entry);
    syncHistory();
    setSelectedClipId(''); setSelectedCueId('');
    setMessage(redo ? '已重做' : '已撤销');
  };

  const reanalyzeMaterial = (asset: FinalEditAssetView) => {
    if (busy) return;
    const groupId = groupRef.current.id;
    setAnalyzingKey(asset.assetKey || asset.videoJobId);
    setMessage('正在重新分析素材…');
    void enqueue(async () => {
      try {
        const next = await responseBody<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${groupId}/assets/${encodeURIComponent(asset.videoJobId)}/reanalyze`, { method: 'POST' }));
        if (groupRef.current.id === groupId) {
          publishGroup(next);
          setMessage('素材分析完成，可以添加或替换片段');
        }
      } catch (error) {
        if (groupRef.current.id === groupId) setMessage(`素材分析失败，可再次重试：${error instanceof Error ? error.message : String(error)}`);
      } finally { if (mountedRef.current) setAnalyzingKey(''); }
    });
  };

  const previewSubtitleStyle = (style: FinalEditGroupView['textStyles']['3x4']['subtitle']) => {
    const current = groupRef.current;
    publishGroup({
      ...current,
      textStyles: {
        ...current.textStyles,
        [variant!.outputPreset]: { ...current.textStyles[variant!.outputPreset], subtitle: style },
      },
    });
  };

  const seek = (seconds: number) => {
    // 丢弃播放中的尾随上报，避免它把截取预览拉回拖动前的位置。
    window.clearTimeout(playheadCommitRef.current.timer);
    playheadCommitRef.current.timer = 0;
    setPlayheadSec(seconds);
    setSeekRequestId((value) => value + 1);
  };

  // 播放头上报降频：播放中 FinalEditPreview 每 rAF（60fps）回调一次，全量重渲 PreviewStep+时间线成本不小；
  // 降到 30fps 提交（UI 足够流畅），尾随定时器保证暂停时的精确值 33ms 内到达。弱机收益显著（①修复配套）。
  const playheadCommitRef = useRef({ latest: 0, lastAt: 0, timer: 0 });
  const handlePlayheadChange = useCallback((timeSec: number) => {
    const s = playheadCommitRef.current;
    s.latest = timeSec;
    const now = performance.now();
    const elapsed = now - s.lastAt;
    if (elapsed >= 33) {
      s.lastAt = now;
      setPlayheadSec(timeSec);
      return;
    }
    if (!s.timer) {
      s.timer = window.setTimeout(() => {
        s.timer = 0;
        s.lastAt = performance.now();
        setPlayheadSec(playheadCommitRef.current.latest);
      }, 33 - elapsed);
    }
  }, []);
  useEffect(() => () => {
    const s = playheadCommitRef.current;
    if (s.timer) window.clearTimeout(s.timer);
  }, []);

  const [packagingPreview, setPackagingPreview] = useState<PackagingPreviewData | null>(null);
  const [packagingPreviewError, setPackagingPreviewError] = useState('');
  const [packagingPreviewRefreshId, setPackagingPreviewRefreshId] = useState(0);
  // §B 画面内文字直改：桥 dblclick 上报打开的浮框状态（rect=元素在 iframe 内的视口 rect，frame=iframe 自身视口左上）
  const [packagingTextEdit, setPackagingTextEdit] = useState<{
    pointId: string;
    rect: { left: number; top: number; width: number; height: number };
    frame: { left: number; top: number };
  } | null>(null);
  const packagingTextEditRef = useRef<typeof packagingTextEdit>(null);
  const packagingPreviewRef = useRef(packagingPreview);
  useEffect(() => { packagingPreviewRef.current = packagingPreview; }, [packagingPreview]);
  const openPackagingTextEdit = (edit: typeof packagingTextEdit) => {
    packagingTextEditRef.current = edit;
    setPackagingTextEdit(edit);
  };

  const packagingIframeRef = useRef<HTMLIFrameElement | null>(null);
  // ---- §5/§6 卖点选中与卖点轨变更 ----
  const setPointSelection = (pointId: string) => {
    selectedPointIdRef.current = pointId;
    setSelectedPointId(pointId);
  };
  // 卖点数据变更（重新提取/删除）后选中 id 可能已失效：失效即清除——
  // 否则桥 only 过滤会拿失效 id 把全部气泡挡在门外，编辑整体锁死（2026-10-09 实锤）
  useEffect(() => {
    if (selectedPointId && !(group.packaging.pointCues ?? []).some((cue) => cue.id === selectedPointId)) {
      const timer = window.setTimeout(() => setPointSelection(''), 0);
      return () => window.clearTimeout(timer);
    }
  }, [group.packaging.pointCues, selectedPointId]);
  // 卖点选中取消出口（§18.5 摩擦项）：父页面捕获阶段 Esc 清选中——卖点文本框聚焦时 Esc 会被输入框吞掉，
  // 桥内 Esc 只覆盖 iframe 聚焦场景，这里兜底；blur 一并放下输入框焦点。
  // 包装文字浮框打开时 Esc 归浮框自己（取消编辑），不清卖点选中。
  useEffect(() => {
    if (!timelineSelectedPointId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (packagingTextEditRef.current) return;
      setPointSelection('');
      (document.activeElement as HTMLElement | null)?.blur?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [timelineSelectedPointId]);
  // 卖点块单击（含拖动手势起始）：选中；新选中时 seek 到弹出中点（自动暂停，§5）
  const handleSelectPoint = (pointId: string) => {
    const previous = selectedPointIdRef.current;
    setPointSelection(pointId);
    if (pointId && pointId !== previous) {
      const cue = groupRef.current.packaging.pointCues?.find((item) => item.id === pointId);
      if (cue) seek((cue.startSec + cue.endSec) / 2);
    }
  };

  // ⑤ 正片卖点直点：编辑模式关闭（正片段未选中）时叠加层 iframe pointer-events 为 none，点击穿透到本层——
  // 父页代做命中探测：命中可见 cue 气泡即选中（与时间线点选同效），随后 only 模式自动激活可拖可改。
  // 封面元素此时因 .stage 退场不可见但自身 opacity 为 1，故只探测 cue:*（封面段编辑由桥内 cover 态负责）。
  const probePackagingCueHit = (event: React.PointerEvent<HTMLDivElement>) => {
    if (packagingEditModeKey !== 'off') return;
    const iframe = packagingIframeRef.current;
    const win = iframe?.contentWindow;
    const doc = iframe?.contentDocument;
    if (!iframe || !win || !doc) return;
    const rect = iframe.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    const stack = doc.elementsFromPoint(x, y);
    for (const node of stack) {
      const el = (node as Element).closest?.('[data-point-id^="cue:"]');
      if (!el) continue;
      const cs = win.getComputedStyle(el);
      const opacity = parseFloat(cs.opacity);
      if (cs.display === 'none' || cs.visibility === 'hidden' || (isFinite(opacity) ? opacity : 1) < 0.05) continue;
      handleSelectPoint(el.getAttribute('data-point-id')!.slice('cue:'.length));
      break;
    }
  };
  // 卖点轨增/删/改字/移动/修剪：enabled/template/varsOverrides 必须携带现值（省略即重置），pointCues 整体替换
  const applyPointCues = (next: PointCue[]) => {
    void applyGroup((current) => ({
      type: 'set_packaging_config',
      config: {
        enabled: current.packaging.enabled,
        template: current.packaging.template,
        varsOverrides: packagingVarsOverridesRecord(current.packaging.varsOverrides),
        pointCues: next,
      },
    }));
  };

  // §B 画面内文字直改提交：cover:* → varsOverrides（与默认值相同删键）；cue:* → pointCues 文本替换
  // （空文本拒绝，与时间线改字同规则）。提交后叠加层经既有重载键刷新，模板 refitAll 自动重排。
  const commitPackagingTextEdit = (pointId: string, rawText: string) => {
    openPackagingTextEdit(null);
    const value = rawText.trim().slice(0, 40);
    if (pointId.startsWith('cover:')) {
      const key = pointId.slice('cover:'.length);
      if (!['title', 'subtitle', 'point1', 'point2', 'point3'].includes(key)) return;
      void applyGroupRef.current((current): GroupCommandInput => {
        const defaults = packagingPreviewRef.current?.defaults;
        const defaultValue = defaults && typeof defaults[key as keyof PackagingVars] === 'string' ? String(defaults[key as keyof PackagingVars]) : null;
        const nextOverrides = packagingVarsOverridesRecord(current.packaging.varsOverrides);
        if (defaultValue !== null && value === defaultValue) delete nextOverrides[key];
        else nextOverrides[key] = value;
        return {
          type: 'set_packaging_config',
          config: {
            enabled: current.packaging.enabled,
            template: current.packaging.template,
            varsOverrides: nextOverrides,
          },
        };
      }).then((accepted) => {
        if (accepted) mergePackagingPreviewVars({ [key]: value });
      });
      return;
    }
    if (pointId.startsWith('cue:')) {
      const cueId = pointId.slice('cue:'.length);
      const cues = groupRef.current.packaging.pointCues ?? [];
      const cue = cues.find((item) => item.id === cueId);
      if (!cue || !value || value === cue.text) return;
      applyPointCues(cues.map((item) => (item.id === cueId ? { ...item, text: value } : item)));
    }
  };

  // §B 浮框预填文案：父页自有数据（封面 ← preview.vars，正片 ← pointCues），桥不传文本
  const resolvePackagingTextEditInitial = (pointId: string): string => {
    if (pointId.startsWith('cover:')) {
      const value = (packagingPreview?.vars as Record<string, unknown> | undefined)?.[pointId.slice('cover:'.length)];
      return typeof value === 'string' ? value : '';
    }
    const cueId = pointId.slice('cue:'.length);
    return group.packaging.pointCues?.find((item) => item.id === cueId)?.text ?? '';
  };

  const previewNarrationPlaybackRate = (playbackRate: number) => {
    const current = groupRef.current;
    publishGroup({
      ...current,
      script: {
        ...current.script,
        narrationConfig: { ...current.script.narrationConfig, playbackRate },
      },
    });
  };
  const persistedNarrationGainDb = group.script.narrationConfig.gainDb ?? NARRATION_GAIN_DB_DEFAULT;
  const effectiveNarrationGainDb = narrationGainPreview?.groupId === group.id
    ? narrationGainPreview.gainDb
    : persistedNarrationGainDb;
  const persistedBgmGainDb = variant?.bgm.gainDb ?? 0;
  const effectiveBgmGainDb = bgmGainPreview?.variantId === variant?.id
    ? bgmGainPreview.gainDb
    : persistedBgmGainDb;
  const previewNarrationGain = (gainDb: number) => {
    setNarrationGainPreview({ groupId: group.id, gainDb });
  };
  const commitNarrationGain = (gainDb: number): Promise<boolean> => {
    const targetGroupId = group.id;
    return applyGroup({ type: 'set_narration_gain', gainDb }).then((accepted) => {
      if (mountedRef.current && groupRef.current.id === targetGroupId) {
        setNarrationGainPreview((current) => current?.groupId === targetGroupId ? null : current);
      }
      return accepted;
    });
  };
  const previewBgmGain = (gainDb: number) => {
    if (!variant) return;
    setBgmGainPreview({ variantId: variant.id, gainDb });
  };
  const commitBgmGain = (gainDb: number): Promise<boolean> => {
    const targetVariantId = variant?.id;
    if (!targetVariantId) return Promise.resolve(false);
    return applyVariant({ type: 'set_bgm_gain', gainDb }).then((accepted) => {
      if (mountedRef.current) {
        setBgmGainPreview((current) => current?.variantId === targetVariantId ? null : current);
      }
      return accepted;
    });
  };
  const closeCover = useCallback(() => setCoverOpen(false), []);

  // 素材替换：把选中片段的素材换成另一个（规格 §6.5），保留片段时长、从 0 帧起截
  const replaceClipAsset = (asset: FinalEditAssetView) => {
    if (!selectedClip || busy) return;
    const sourceFrames = Math.max(1, Math.round((asset.durationUs / 1_000_000) * FPS));
    const length = selectedClip.sourceOutFrame - selectedClip.sourceInFrame;
    void applyVariant({
      type: 'replace_clip',
      clipId: selectedClip.id,
      videoJobId: asset.videoJobId,
      sourceFingerprint: asset.fingerprint,
      sourceInFrame: 0,
      sourceOutFrame: Math.min(length, sourceFrames),
    });
  };

  const insertClipAsset = (asset: FinalEditAssetView) => {
    if (!firstInsertableGap || busy) return;
    const sourceFrames = Math.max(0, Math.floor((asset.durationUs / 1_000_000) * FPS));
    const length = Math.min(firstInsertableGap.endFrame - firstInsertableGap.startFrame, sourceFrames);
    if (length < FINAL_EDIT_MIN_CLIP_FRAMES) {
      setMessage('该素材不足 0.5 秒，无法插入时间轴');
      return;
    }
    void applyVariant({
      type: 'insert_clip',
      videoJobId: asset.videoJobId,
      sourceFingerprint: asset.fingerprint,
      sourceInFrame: 0,
      sourceOutFrame: length,
      timelineInFrame: firstInsertableGap.startFrame,
      timelineOutFrame: firstInsertableGap.startFrame + length,
    });
  };

  const openTrim = (clip: TimelineClip) => {
    setSelectedClipId(clip.id);
    setTrimClip(clip);
    setTrimPreviewInFrame(clip.sourceInFrame);
    setPreviewMode('output');
    seek((FINAL_EDIT_INTRO_FRAMES + clip.timelineInFrame) / FPS);
  };

  const narrationSec = group.narrationDurationUs / 1_000_000 / group.script.narrationConfig.playbackRate;
  const totalSec = variant ? narrationSec + (variant.cover ? 20 / FPS : 0) : 0;
  const effectivePlayheadSec = Math.min(playheadSec, totalSec);
  const bodySec = variant ? variant.timeline.bodyFrames / FPS : 0;
  const narrationMatch = Math.abs(narrationSec - bodySec) < 1;
  const coverSourceIndex = variant ? orderedClips.findIndex((clip) => clip.videoJobId === variant.cover.sourceKey) : -1;

  // ---- §3 包装叠加层 + §2 右栏包装卡 ----
  const packagingConfig = group.packaging;
  const packagingEnabled = packagingConfig.enabled;
  const packagingTemplate = packagingConfig.template;
  const previewVariantId = variant?.id ?? '';
  // 叠加层同步控制器：构造函数无副作用（visibilitychange 监听首次 attach 才绑定），可安全惰性初始化
  const packagingSyncRef = useRef<PackagingOverlaySync | null>(null);
  packagingSyncRef.current ??= new PackagingOverlaySync();
  // §6 编辑模式：iframe 元素引用（写 __editMode 用）；布局提交防抖队列（瞬态值入 ref，不新增渲染订阅）
  const packagingLayoutPendingRef = useRef<Map<string, PackagingPointLayout | null> | null>(null);
  const packagingLayoutTimerRef = useRef(0);
  // 叠加层 iframe 挂载态（入 __editMode effect 依赖：iframe 挂载前 effect 落空须重跑，2026-10-10 竞态实锤）
  const [overlayMounted, setOverlayMounted] = useState(false);

  useEffect(() => {
    const sync = packagingSyncRef.current;
    return () => {
      sync?.destroy();
      if (packagingSyncRef.current === sync) packagingSyncRef.current = null;
    };
  }, []);

  // §6 编辑桥接线：__packagingEditCommit 实实现（pointId 解析 + 防抖 500ms 合并连续提交后经 applyGroup 写 layouts）、
  // __packagingEditExit（ESC → 清卖点选中）。layouts 合并语义（workspace/packaging-vars）：段级并入、叶子 null=删除该键。
  const flushPackagingLayoutCommits = useCallback(() => {
    const pending = packagingLayoutPendingRef.current;
    packagingLayoutPendingRef.current = null;
    if (!pending || pending.size === 0) return;
    const entries = [...pending].filter(([pointId]) => pointId.startsWith('cover:') || pointId.startsWith('cue:'));
    if (entries.length === 0) return;
    void applyGroupRef.current((current): GroupCommandInput => {
      const template = current.packaging.template;
      const section: { cover?: Record<string, PackagingPointLayout | null>; cues?: Record<string, PackagingPointLayout | null> } = {};
      for (const [pointId, layout] of entries) {
        if (pointId.startsWith('cover:')) {
          section.cover = section.cover ?? {};
          section.cover[pointId.slice('cover:'.length)] = layout; // cover:pointN → layouts.<模板>.cover.pointN
        } else {
          section.cues = section.cues ?? {};
          section.cues[pointId.slice('cue:'.length)] = layout; // cue:<id> → layouts.<模板>.cues.<id>
        }
      }
      const layouts: PackagingLayoutsPatch = { [template]: section };
      return {
        type: 'set_packaging_config',
        config: {
          enabled: current.packaging.enabled,
          template: current.packaging.template,
          varsOverrides: packagingVarsOverridesRecord(current.packaging.varsOverrides),
          layouts,
        },
      };
    });
  }, []);

  const schedulePackagingLayoutCommit = useCallback((pointId: string, layout: PackagingPointLayout | null) => {
    const pending = packagingLayoutPendingRef.current ?? new Map<string, PackagingPointLayout | null>();
    packagingLayoutPendingRef.current = pending;
    pending.set(pointId, layout); // 同键后写覆盖先写（拖拽连续提交只留终态）
    if (packagingLayoutTimerRef.current) window.clearTimeout(packagingLayoutTimerRef.current);
    packagingLayoutTimerRef.current = window.setTimeout(() => {
      packagingLayoutTimerRef.current = 0;
      flushPackagingLayoutCommits();
    }, 500);
  }, [flushPackagingLayoutCommits]);

  const packagingBridgeHandlersRef = useRef({ handleSelectPoint, openPackagingTextEdit });
  useEffect(() => { packagingBridgeHandlersRef.current = { handleSelectPoint, openPackagingTextEdit }; });

  useEffect(() => {
    const target = window as Window & {
      __packagingEditCommit?: (pointId: string, layout: PackagingPointLayout | null, numeric: PackagingPointLayout | null) => void;
      __packagingEditExit?: () => void;
      __packagingEditText?: (pointId: string, rect: { left: number; top: number; width: number; height: number }) => void;
      __packagingEditCueSelect?: (cueId: string) => void;
    };
    target.__packagingEditCommit = (pointId, layout) => schedulePackagingLayoutCommit(pointId, layout);
    target.__packagingEditExit = () => setPointSelection('');
    // ⑤ 桥内直点另一条正片卖点气泡的上报通道：与时间线点选同效（选中+跳中点暂停，only 模式随后自动激活）
    target.__packagingEditCueSelect = (cueId) => packagingBridgeHandlersRef.current.handleSelectPoint(cueId);
    // §B 桥 dblclick 上报：换算 iframe 视口坐标后开浮框（元素 rect 冻结于打开时刻，提交后叠加层经重载键刷新）
    target.__packagingEditText = (pointId, rect) => {
      const iframe = packagingIframeRef.current;
      if (!iframe) return;
      const frameRect = iframe.getBoundingClientRect();
      packagingBridgeHandlersRef.current.openPackagingTextEdit({ pointId, rect, frame: { left: frameRect.left, top: frameRect.top } });
    };
    return () => {
      delete target.__packagingEditCommit;
      delete target.__packagingEditExit;
      delete target.__packagingEditText;
      delete target.__packagingEditCueSelect;
      if (packagingLayoutTimerRef.current) {
        window.clearTimeout(packagingLayoutTimerRef.current);
        packagingLayoutTimerRef.current = 0;
      }
    };
  }, [schedulePackagingLayoutCommit]);

  // 预览 JSON：进入/换模板/换草稿/重新提取后拉取（供包装卡表单默认值、「跳到封面」coverSec 与叠加层加载闸门）
  useEffect(() => {
    if (!active || !packagingEnabled || !previewVariantId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const query = new URLSearchParams({ variantId: previewVariantId, template: packagingTemplate });
        const next = await responseBody<PackagingPreviewData>(
          await fetch(`/api/final-edit-groups/${encodeURIComponent(group.id)}/packaging-preview?${query}`, { signal: controller.signal }),
        );
        if (!controller.signal.aborted) {
          setPackagingPreview(next);
          setPackagingPreviewError('');
          // 预览端点会按需补提取卖点并静默落库（派生缓存不 bump revision，组视图感知不到）：
          // 比对预览时间轴与组视图卖点，不一致即重拉组视图同步时间轴卖点轨——
          // 覆盖重新生成、异步重新提取等所有静默落库路径（屏幕有、时间轴无的断链实锤）。
          const cueKey = (cues: Array<{ id?: string; text: string; startSec: number; endSec: number }>) =>
            cues.map((cue) => `${cue.id ?? ''}${cue.text}${cue.startSec}${cue.endSec}`).join('~');
          if (cueKey(next.timeline?.pointCues ?? []) !== cueKey(groupRef.current.packaging.pointCues ?? [])) {
            void reloadGroupRef.current(groupRef.current.id).catch(() => undefined);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setPackagingPreview(null);
          setPackagingPreviewError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => controller.abort();
  }, [active, packagingEnabled, packagingTemplate, group.id, previewVariantId, packagingPreviewRefreshId]);

  // 播放头转发（暂停态 rAF 节流 seek；播放态仅更新漂移基准）——沿用既有 playheadSec state，不新增订阅
  useEffect(() => {
    packagingSyncRef.current?.setPlayhead(effectivePlayheadSec);
  }, [effectivePlayheadSec]);

  const handlePreviewPlayingChange = useCallback((playing: boolean) => {
    packagingSyncRef.current?.setPlaying(playing);
  }, []);

  const attachPackagingOverlay = useCallback((element: HTMLIFrameElement | null) => {
    packagingIframeRef.current = element;
    packagingSyncRef.current?.attach(element);
    setOverlayMounted(Boolean(element));
  }, []);

  const mergePackagingPreviewVars = useCallback((saved: Partial<PackagingVars>) => {
    setPackagingPreview((current) => (current ? { ...current, vars: { ...current.vars, ...saved } } : current));
  }, []);

  const refreshPackagingPreview = useCallback(() => {
    setPackagingPreviewRefreshId((value) => value + 1);
  }, []);

  // iframe 重载键：模板/三槽字体/文案覆盖层/草稿/卖点数组任一变化即重载（不含 layouts——拖拽保存不重载，§6）。
  // pointCues 入键：卖点增删改后 iframe 重载，同步控制器 load 后自动 seek 回当前播放头（§3 恢复逻辑）。
  const packagingOverlayKey = `${packagingTemplate}|${JSON.stringify(packagingConfig.varsOverrides)}|${packagingConfig.titleFont?.file ?? ''}|${packagingConfig.subtitleFont?.file ?? ''}|${packagingConfig.pointFont?.file ?? ''}|${previewVariantId}|${JSON.stringify(packagingConfig.pointCues ?? [])}`;
  const packagingOverlaySrc = packagingEnabled && previewVariantId && packagingPreview
    ? `/api/final-edit-groups/${encodeURIComponent(group.id)}/packaging-preview?variantId=${encodeURIComponent(previewVariantId)}&template=${encodeURIComponent(packagingTemplate)}&format=html&sync=1&edit=1`
    : '';

  // §6 编辑模式三态：封面段（播放头 < coverSec）封面 point1-3 可拖（only=null）——封面段正片气泡本就不可见，
  // 封面编辑必须优先于选中态（否则选中过正片卖点后封面全部被 only 过滤锁死，2026-10-09 实锤）；
  // 正片段且选中卖点 → 仅该条可拖（only=cue:<id>）；其余关闭。
  const packagingCoverSec = packagingPreview?.timeline.coverSec ?? FINAL_EDIT_INTRO_FRAMES / FPS;
  const packagingEditModeKey = !packagingEnabled
    ? 'off'
    : effectivePlayheadSec < packagingCoverSec
      ? 'cover'
      : timelineSelectedPointId
        ? `cue:${timelineSelectedPointId}`
        : 'off';
  const packagingEditActive = packagingEditModeKey !== 'off';

  // iframe load 后与三态变化时写 contentWindow.__editMode（同源可用；跨域/文档销毁静默降级——桥内读不到即不激活）。
  // overlayMounted 入依赖：预览 JSON 到达前 iframe 未挂载，effect 首跑必落空——F5 且播放头在封面段时
  // modeKey/overlayKey 此后均不再变化，__editMode 永远写不进（2026-10-10 验收竞态实锤：点击全放行选不中）
  useEffect(() => {
    const mode: { active: boolean; only: string | null } = packagingEditModeKey === 'off'
      ? { active: false, only: null }
      : packagingEditModeKey === 'cover'
        ? { active: true, only: null }
        : { active: true, only: packagingEditModeKey };
    const iframe = packagingIframeRef.current;
    if (!iframe) return;
    const apply = () => {
      try {
        const win = iframe.contentWindow as (Window & { __editMode?: { active: boolean; only: string | null } }) | null;
        if (win) win.__editMode = mode;
      } catch { /* 跨域或文档已销毁：静默降级 */ }
    };
    apply();
    iframe.addEventListener('load', apply);
    return () => iframe.removeEventListener('load', apply);
  }, [packagingEditModeKey, packagingOverlayKey, overlayMounted]);

  // 「+ 卖点」默认文案：当前播放头处字幕句（与 FinalEditPreview 同口径：bodyTimeUs=(playhead-INTRO)*1e6*rate）
  const playbackRateForCueLookup = group.script.narrationConfig.playbackRate;
  const activeCueText = useMemo(() => {
    if (effectivePlayheadSec < packagingCoverSec) return '';
    const bodyTimeUs = (effectivePlayheadSec - packagingCoverSec) * 1_000_000 * playbackRateForCueLookup;
    return group.subtitleCues.find((cue) => bodyTimeUs >= cue.startUs && bodyTimeUs < cue.endUs)?.text ?? '';
  }, [effectivePlayheadSec, packagingCoverSec, playbackRateForCueLookup, group.subtitleCues]);

  // 匹配诊断必须在第 3 步第一眼可见：blocking 解释真实缺口，warning
  // 解释语义或短素材兜底，避免用户把降级结果误认为预览故障。
  const blockingIssues = variant.issues.filter((issue) => issue.severity === 'blocking');
  const warningIssues = variant.issues.filter((issue) => issue.severity === 'warning');
  const selectedAssetKey = selectedClip ? group.assets.find((asset) => asset.videoJobId === selectedClip.videoJobId)?.assetKey : null;
  const selectedMatchReason = selectedClip && selectedAssetKey
    ? variant.matchDiagnostics?.selectionReasons.find((reason) => reason.sentenceId === selectedClip.boundSegmentId && reason.assetKey === selectedAssetKey)
    : null;
  const selectedMatchReasonLabel = selectedMatchReason ? ({
    manual_lock: '手动锁定',
    semantic_primary: '语义首选',
    semantic_backoff: '语义降级',
    keyword_fallback: '关键词兜底',
    material_length_fallback: '短素材拼接',
    scene_reuse_fallback: '场景复用',
  } as const)[selectedMatchReason.reason] : null;

  const openMaterialPreview = (materialKey: string) => {
    setPreviewMaterialKey(materialKey);
    setPreviewMode('material');
    setPreviewStopRequestId((value) => value + 1);
  };

  if (!variant) {
    return (
      <main className={styles.mainCol}>
        <div className={styles.emptyState}><strong>还没有可预览的成片草稿</strong><span>返回智能创作，等待后台四个阶段完成后再进入。</span></div>
      </main>
    );
  }

  return (
    <>
      {/* 素材替换列 */}
      <aside className={styles.replaceCol}>
        <button type="button" className={styles.collapseBtn} title="隐藏素材替换" onClick={() => onRepCollapse(true)}>‹</button>
        <button type="button" className={styles.expandBtn} title="展开素材替换" onClick={() => onRepCollapse(false)}>›</button>
        <section className={`${styles.panel} ${styles.panelGrow}`}>
          <h3><Icon name="retry" size={15} />素材调整</h3>
          <div className={styles.hintLine} style={{ color: '#B25E00' }}>{selectedClip && firstInsertableGap
            ? `当前片段已选中，时间轴另有 ${(firstInsertableGap.endFrame - firstInsertableGap.startFrame) / FPS}s 缺口。先选素材，再明确选择替换或添加。`
            : selectedClip
              ? '当前片段已选中。先选素材，再点击“替换当前片段”；裁剪或删除可腾出添加缺口。'
              : firstInsertableGap
                ? `时间轴有 ${(firstInsertableGap.endFrame - firstInsertableGap.startFrame) / FPS}s 缺口。先选素材，再点击“添加到缺口”。`
                : '单击下方素材会高亮选中，点击“预览”查看视频；选中时间轴片段后可替换，右键片段可删除并腾出缺口。'}</div>
          <div className={styles.replaceSelection} aria-live="polite">
            <span className={styles.replaceSelectionName} title={materialName(selectedMaterial)}>
              {selectedMaterial ? `已选：${materialName(selectedMaterial)}${selectedMaterial.analysisStatus !== 'succeeded' ? '（请先重新分析）' : ''}` : '尚未选择素材'}
            </span>
            <div className={styles.replaceActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.small}`}
                disabled={busy || !selectedMaterial || selectedMaterial.analysisStatus !== 'succeeded' || !selectedClip}
                title={!selectedClip ? '先在时间轴单击选中要替换的片段' : !selectedMaterial ? '先在下方选择素材' : undefined}
                onClick={() => selectedMaterial && replaceClipAsset(selectedMaterial)}
              >替换当前片段</button>
              <button
                type="button"
                className={`${styles.btn} ${styles.small} ${styles.primary}`}
                disabled={busy || !selectedMaterial || selectedMaterial.analysisStatus !== 'succeeded' || !firstInsertableGap}
                title={!firstInsertableGap ? '时间轴当前没有可插入的缺口' : !selectedMaterial ? '先在下方选择素材' : undefined}
                onClick={() => selectedMaterial && insertClipAsset(selectedMaterial)}
              ><Icon name="plus" size={12} />添加到缺口</button>
            </div>
          </div>
          <div className={styles.replaceList}>
            {group.assets.map((asset) => {
              const materialKey = asset.assetKey || asset.videoJobId;
              const materialSelected = materialKey === selectedMaterialKey;
              return (
                <div className={styles.replaceItem} key={materialKey}>
                  <button
                    type="button"
                    className={`${styles.rep} ${materialSelected ? styles.repActive : ''}`}
                    disabled={busy}
                    aria-pressed={materialSelected}
                    onClick={() => setSelectedMaterialKey(materialKey)}
                    title={`选择素材「${materialName(asset)}」`}
                  >
                    <span className={styles.repThumb}>
                      {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" /> : <Icon name="video" size={14} />}
                    </span>
                    <span className={styles.repInfo}>
                      <span className={styles.repN}>{materialName(asset)}</span>
                      <span className={styles.repM}>{(asset.durationUs / 1_000_000).toFixed(1)}s · {asset.source === 'external' ? '外部导入' : '模块 4'} · {asset.analysisStatus === 'succeeded' ? '已分析' : asset.analysisStatus === 'failed' ? '分析失败' : '待分析'}</span>
                    </span>
                    {materialSelected
                      ? <span className={`${styles.chip} ${styles.chipBlue}`}><Icon name="check" size={10} />已选</span>
                      : usedVideoJobIds.has(asset.videoJobId) && <span className={`${styles.chip} ${styles.chipGreen}`}>已用</span>}
                  </button>
                  <div className={styles.replaceItemActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.small} ${styles.replacePreviewButton}`}
                      aria-label={`预览素材 ${materialName(asset)}`}
                      disabled={!asset.previewUrl && !asset.thumbnailUrl}
                      onClick={() => openMaterialPreview(materialKey)}
                    >预览</button>
                    <button type="button" className={`${styles.btn} ${styles.small}`} disabled={busy}
                      aria-label={`重新分析素材 ${materialName(asset)}`} onClick={() => reanalyzeMaterial(asset)}>
                      {analyzingKey === materialKey ? '分析中…' : '重新分析'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </aside>
      <div className={styles.rz} role="separator" aria-orientation="vertical" title="拖拽调整宽度" onPointerDown={onResizeStart('rep')} />

      {/* 主区：工具行 + 大纸 */}
      <main ref={previewRootRef} className={styles.mainCol}>
        <div className={styles.t3Toolbar}>
          <span className={styles.t3Title}>预览调整</span>
          <span className={`${styles.chip} ${styles.chipGrey}`}>{orderedClips.length} 片段</span>
          <span className={`${styles.chip} ${styles.chipBlue}`}>总时长 {totalSec.toFixed(1)}s</span>
          <span className={`${styles.chip} ${narrationMatch ? styles.chipGreen : styles.chipGrey}`}>口播 {narrationSec.toFixed(1)}s {narrationMatch ? '✓' : '⚠'}</span>
          <span className={`${styles.chip} ${styles.chipGrey}`} title="单击选中 | 拖拽排序 | 双击片段重选时段 | 右键视频/字幕删除 | 右键口播调速 | 双击字幕编辑">单击选中 · 拖拽排序 · 双击编辑 · 右键视频/字幕删除、口播调速</span>
          {selectedMatchReason && selectedMatchReasonLabel && (
            <span className={`${styles.chip} ${styles.chipBlue}`}>匹配：{selectedMatchReasonLabel} · {selectedMatchReason.score.toFixed(2)}</span>
          )}
          <span className={styles.spacer} />
          <span className={styles.flowHint} aria-live="polite">{busy ? '正在保存…' : message}</span>
          {group.variants.length > 1 && (
            <select aria-label="选择成片草稿" value={variant.id} onChange={(event) => { setSelectedVariantId(event.target.value); clearHistory(); setSelectedCueId(''); setSelectedClipId(''); setSelectedMaterialKey(''); setPreviewMaterialKey(''); setPreviewMode('output'); setTrimClip(null); setPlayheadSec(0); }}>
              {group.variants.map((item) => <option key={item.id} value={item.id}>成片 {item.indexNum} · {item.outputPreset.replace('x', ':')}</option>)}
            </select>
          )}
          <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={busy} onClick={() => onExport(variant.id)}>下一步：导出</button>
        </div>

        {blockingIssues.length > 0 && (
          <div className={styles.errorBanner} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
            {blockingIssues.map((issue, index) => (
              <span key={`${issue.code}-${issue.targetId ?? index}`} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Icon name="alert" size={13} />{issue.message}
              </span>
            ))}
          </div>
        )}

        {warningIssues.length > 0 && (
          <div className={styles.warningNotice} style={{ marginBottom: 8, flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
            {warningIssues.map((issue, index) => (
              <span key={`${issue.code}-${issue.targetId ?? index}`} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Icon name="alert" size={13} />{issue.message}
              </span>
            ))}
          </div>
        )}

        <div className={styles.bigPaper} data-output-preset={variant.outputPreset}>
          <div className={styles.previewModeHeader}>
            <div
              className={styles.previewModeTabs}
              role="tablist"
              aria-label="预览内容"
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const nextMode: PreviewMode = previewMode === 'output' ? 'material' : 'output';
                setPreviewMode(nextMode);
                previewTabRefs.current[nextMode]?.focus();
              }}
            >
              <button
                type="button"
                role="tab"
                id="mixcut-output-preview-tab"
                aria-controls="mixcut-preview-panel"
                aria-selected={previewMode === 'output'}
                tabIndex={previewMode === 'output' ? 0 : -1}
                ref={(element) => { previewTabRefs.current.output = element; }}
                className={`${styles.previewModeTab} ${previewMode === 'output' ? styles.previewModeTabActive : ''}`}
                onClick={() => setPreviewMode('output')}
              >成片预览</button>
              <button
                type="button"
                role="tab"
                id="mixcut-material-preview-tab"
                aria-controls="mixcut-preview-panel"
                aria-selected={previewMode === 'material'}
                tabIndex={previewMode === 'material' ? 0 : -1}
                ref={(element) => { previewTabRefs.current.material = element; }}
                className={`${styles.previewModeTab} ${previewMode === 'material' ? styles.previewModeTabActive : ''}`}
                onClick={() => setPreviewMode('material')}
              >素材预览</button>
            </div>
            <span className={styles.previewModeLabel} title={materialName(previewMaterial)}>
              {previewMode === 'material' ? (materialName(previewMaterial) || '请从左侧素材列表点击“预览”') : '实时合成预览'}
            </span>
          </div>
          <div
            id="mixcut-preview-panel"
            role="tabpanel"
            aria-labelledby={previewMode === 'output' ? 'mixcut-output-preview-tab' : 'mixcut-material-preview-tab'}
            className={styles.previewModePanel}
          >
            <div className={styles.previewWrap}>
              <div className={styles.previewFrame} data-output-preset={variant.outputPreset} onPointerDown={probePackagingCueHit}>
                {previewMode === 'material' ? (
                  <div className={styles.materialPreview} data-testid="mixcut-material-preview">
                    {previewMaterial?.previewUrl ? (
                      <video
                        key={`material-preview-${previewMaterial.assetKey || previewMaterial.videoJobId}`}
                        className={styles.materialPreviewVideo}
                        src={previewMaterial.previewUrl}
                        controls
                        muted
                        playsInline
                        preload="metadata"
                        poster={previewMaterial.thumbnailUrl}
                        aria-label={`素材预览：${materialName(previewMaterial)}`}
                      />
                    ) : previewMaterial?.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className={styles.materialPreviewImage} src={previewMaterial.thumbnailUrl} alt={materialName(previewMaterial)} />
                    ) : (
                      <p className={styles.materialPreviewEmpty}>请从左侧素材列表点击“预览”</p>
                    )}
                    {previewMaterial && <p className={styles.materialPreviewName} title={materialName(previewMaterial)}>{materialName(previewMaterial)}</p>}
                  </div>
                ) : (
                  <FinalEditPreview
                    group={group}
                    variant={trimPreviewVariant ?? variant}
                    assets={group.assets}
                    selectedAsset={null}
                    playheadSec={effectivePlayheadSec}
                    seekRequestId={seekRequestId}
                    stopRequestId={previewStopRequestId}
                    active={active}
                    textTarget={null}
                    narrationGainDb={effectiveNarrationGainDb}
                    bgmGainDb={effectiveBgmGainDb}
                overlay={packagingOverlaySrc ? (
                  <iframe
                    key={packagingOverlayKey}
                    ref={attachPackagingOverlay}
                    data-packaging-overlay=""
                    src={packagingOverlaySrc}
                    title="包装效果叠加层"
                    aria-hidden="true"
                    tabIndex={-1}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, pointerEvents: packagingEditActive ? 'auto' : 'none' }}
                  />
                ) : null}
                    onPlaybackStart={() => setAuditionStopRequestId((value) => value + 1)}
                    onPlayheadChange={handlePlayheadChange}
                    onPlayingChange={handlePreviewPlayingChange}
                    onTextPositionChange={() => undefined}
                  />
                )}
              </div>
            </div>
          </div>

          {/* §B 画面内文字直改浮框（桥 dblclick 上报打开） */}
          {packagingTextEdit && (
            <PackagingTextEditPopover
              textEdit={packagingTextEdit}
              initialText={resolvePackagingTextEditInitial(packagingTextEdit.pointId)}
              onCommit={(value) => commitPackagingTextEdit(packagingTextEdit.pointId, value)}
              onCancel={() => openPackagingTextEdit(null)}
            />
          )}

          {trimClip && (
            <TrimEditor
              key={trimClip.id}
              clip={trimClip}
              clipIndex={Math.max(0, trimClipIndex)}
              asset={trimAsset}
              disabled={busy}
              onPreview={(sourceInSec) => {
                setTrimPreviewInFrame(Math.round(sourceInSec * FPS));
                setPreviewMode('output');
                seek((FINAL_EDIT_INTRO_FRAMES + trimClip.timelineInFrame) / FPS);
              }}
              onCommit={(sourceInFrame, sourceOutFrame) => applyVariant({
                type: 'trim_clip',
                clipId: trimClip.id,
                sourceInFrame,
                sourceOutFrame,
                timelineInFrame: trimClip.timelineInFrame,
                timelineOutFrame: trimClip.timelineOutFrame,
              })}
              onClose={() => setTrimClip(null)}
            />
          )}

          <MixcutTimeline
            key={variant.id}
            variant={variant}
            cues={group.subtitleCues}
            assets={group.assets}
            selectedClipId={selectedClipId}
            selectedCueId={timelineSelectedCueId}
            playheadSec={effectivePlayheadSec}
            disabled={busy}
            active={active && !coverOpen && previewMode === 'output'}
            onTogglePlay={() => previewRootRef.current?.querySelector<HTMLButtonElement>('[data-mixcut-toggle-play]')?.click()}
            onUndo={() => void restoreHistory(false)}
            onRedo={() => void restoreHistory(true)}
            canUndo={historyAvailable.undo}
            canRedo={historyAvailable.redo}
            onSeek={seek}
            onSelectClip={(clipId) => {
              setSelectedClipId(clipId);
              setSelectedCueId('');
              const clip = variant.timeline.clips.find((item) => item.id === clipId);
              if (clip) { setPreviewMode('output'); seek((20 + clip.timelineInFrame) / FPS); }
            }}
            onSelectCue={(cueId) => { setSelectedCueId(cueId); setSelectedClipId(''); }}
            onVariantCommand={(command) => applyVariant(command)}
            onGroupCommand={applyGroup}
            onTrimClip={openTrim}
            onEditCueText={(cueId, text) => void applyGroup({ type: 'set_subtitle_cue_text', cueId, text })}
            narrationPlaybackRate={group.script.narrationConfig.playbackRate}
            narrationDurationSec={narrationSec}
            onNarrationPlaybackRatePreview={previewNarrationPlaybackRate}
            onNarrationPlaybackRateCommit={(playbackRate) => void applyGroup({ type: 'set_narration_playback_rate', playbackRate })}
            bgmTrackName={selectedBgmTrack?.filename ?? null}
            pointCues={group.packaging.pointCues ?? []}
            coverSec={packagingCoverSec}
            selectedPointId={timelineSelectedPointId}
            packagingEnabled={packagingEnabled}
            packagingTemplate={packagingTemplate}
            activeCueText={activeCueText}
            onSelectPoint={handleSelectPoint}
            onPointsChange={applyPointCues}
          />
        </div>
      </main>
      <div className={styles.rz} role="separator" aria-orientation="vertical" title="拖拽调整宽度" onPointerDown={onResizeStart('rgt')} />

      {/* 右栏：字幕样式 / 背景音乐 / 口播音频变速与音量 / 封面 */}
      <aside className={styles.rightCol}>
        <button type="button" className={styles.collapseBtn} title="隐藏面板" onClick={() => onRgtCollapse(true)}>›</button>
        <button type="button" className={styles.expandBtn} title="展开面板" onClick={() => onRgtCollapse(false)}>‹</button>

        {selectedClip && <VideoPlaybackRateControl key={`speed:${selectedClip.id}`} value={selectedClip.playbackRate ?? 1} disabled={busy}
          onCommit={(playbackRate) => applyVariant({ type: 'set_clip_playback_rate', clipId: selectedClip.id, playbackRate })} />}

        {selectedClip && <ClipFramingControl key={`framing:${selectedClip.id}`} clip={selectedClip} disabled={busy}
          onPreview={(framing) => {
            const current = groupRef.current;
            publishGroup({ ...current, variants: current.variants.map((item) => item.id === variant.id ? { ...item, timeline: { ...item.timeline, clips: item.timeline.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, framing } : clip) } } : item) });
          }}
          onCommit={(framing) => void applyVariant({ type: 'set_framing', clipId: selectedClip.id, ...framing })}
        />}
        <PackagingCard
          group={group}
          variantId={variant.id}
          preview={packagingPreview}
          previewError={packagingPreviewError}
          busy={busy}
          onApplyGroup={applyGroup}
          onSeek={seek}
          onPreviewVarsMerge={mergePackagingPreviewVars}
          onPreviewRefresh={refreshPackagingPreview}
        />

        <section className={styles.rcard}>
          <h4><Icon name="text" size={15} />字幕样式</h4>
          <div className={styles.ctlRow} style={{ justifyContent: 'flex-end', marginBottom: 6 }}>
            <button type="button" className={styles.linkBtn} onClick={() => void applyGroup({ type: 'reset_text_style', preset: variant.outputPreset, target: 'subtitle' })}>恢复默认</button>
          </div>
          <StyleEditor
            key={`subtitle-style-${variant.outputPreset}-${group.revision}`}
            value={group.textStyles[variant.outputPreset].subtitle}
            onPreview={previewSubtitleStyle}
            onCommit={(style) => void applyGroup({ type: 'set_text_style', preset: variant.outputPreset, target: 'subtitle', style })}
          />
        </section>

        <BgmCard
          key={`bgm-${group.id}-${variant.id}`}
          scopeId={group.id}
          tracks={group.bgmTracks}
          bgm={variant.bgm}
          revision={variant.revision}
          disabled={busy}
          active={active}
          stopRequestId={auditionStopRequestId}
          onAuditionStart={() => setPreviewStopRequestId((value) => value + 1)}
          onCommand={applyVariant}
          onGainPreview={previewBgmGain}
          onGainCommit={commitBgmGain}
          onImportFiles={importBgmFiles}
        />

        <section className={styles.rcard} data-testid="mixcut-narration-speed-card">
          <h4><Icon name="speaker" size={15} />口播音频变速</h4>
          <div className={styles.narrationSpeedSummary}>
            <span>整条口播音轨</span>
            <strong>{group.script.narrationConfig.playbackRate.toFixed(1)}x</strong>
          </div>
          <p className={styles.narrationSpeedCardHint}>同步调整口播、字幕与成片时长</p>
          <NarrationPlaybackRateControl
            idPrefix="mixcut-narration-sidebar-speed"
            value={group.script.narrationConfig.playbackRate}
            disabled={busy}
            showPresets
            ariaLabelPrefix="右侧音频倍速"
            onPreview={previewNarrationPlaybackRate}
            onCommit={(playbackRate) => void applyGroup({ type: 'set_narration_playback_rate', playbackRate })}
          />
        </section>

        <section className={styles.rcard} data-testid="mixcut-narration-volume-card">
          <h4><Icon name="speaker" size={15} />口播音量</h4>
          <div className={styles.narrationSpeedSummary}>
            <span>整条口播音轨</span>
            <strong>{effectiveNarrationGainDb.toFixed(0)} dB</strong>
          </div>
          <p className={styles.narrationSpeedCardHint}>只调整口播响度，不改变口播内容与成片时长</p>
          <NarrationGainControl
            idPrefix="mixcut-narration-sidebar-gain"
            value={persistedNarrationGainDb}
            disabled={busy}
            ariaLabelPrefix="右侧口播音量"
            onPreview={previewNarrationGain}
            onCommit={commitNarrationGain}
          />
        </section>

        <section className={styles.rcard}>
          <button type="button" className={styles.coverEntry} onClick={() => setCoverOpen(true)}>
            <span className={styles.coverThumb}>
              {variant.cover.sourceUrl ? <CoverThumbnail group={group} variant={variant} /> : <Icon name="image" size={18} />}
            </span>
            <span>
              <span className={styles.coverEntryT} style={{ display: 'block' }}>视频封面设置</span>
              <span className={styles.coverEntryS} style={{ display: 'block' }}>{variant.cover.sourceUrl ? '已自定义' : '默认封面'} · {variant.outputPreset.replace('x', ':')}{coverSourceIndex >= 0 ? ` · 片段 #${coverSourceIndex + 1}` : ''}</span>
            </span>
            <span className={styles.coverEntryGo}><Icon name="chevron-right" size={16} /></span>
          </button>
        </section>
      </aside>

      {coverOpen && <CoverEditorDrawer
        active={active}
        group={group}
        variant={variant}
        busy={busy}
        onClose={closeCover}
        onApply={(draft: CoverEditorDraft) => applyGroup((current) => {
          const currentVariant = current.variants.find((item) => item.id === variant.id) || current.variants[0];
          if (!currentVariant) throw new Error('当前没有可编辑的成片草稿');
          return { type: 'apply_cover_editor', variantId: currentVariant.id, expectedVariantRevision: currentVariant.revision, draft };
        })}
      />}
    </>
  );
}

function CoverThumbnail({ group, variant }: { group: FinalEditGroupView; variant: FinalEditVariantView }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const output = OUTPUT_PRESETS[variant.outputPreset];
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !variant.cover.sourceUrl) return;
    canvas.width = output.width;
    canvas.height = output.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const primary = group.textStyles[variant.outputPreset].coverPrimary;
      const secondary = group.textStyles[variant.outputPreset].coverSecondary;
      void Promise.all([
        document.fonts.load(textStyleFont(primary), group.coverTitle.primary.text),
        document.fonts.load(textStyleFont(secondary), group.coverTitle.secondary.text),
      ]).catch(() => undefined).then(() => {
        if (cancelled) return;
        drawFramedImage(context, image, variant.cover.framing);
        // §4 封面标题点选启用：关闭时缩略图不画主/副标题
        if (!group.coverTitle.enabled) return;
        drawText(context, group.coverTitle.primary.text, primary);
        drawText(context, group.coverTitle.secondary.text, secondary);
      });
    };
    image.src = variant.cover.sourceUrl;
    return () => { cancelled = true; };
  }, [group.coverTitle.enabled, group.coverTitle.primary.text, group.coverTitle.secondary.text, group.textStyles, output.height, output.width, variant.cover.framing, variant.cover.sourceUrl, variant.outputPreset]);
  return <canvas ref={canvasRef} width={output.width} height={output.height} aria-label="当前真实封面" />;
}
