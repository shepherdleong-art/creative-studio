'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { FinalEditPreview } from '@/components/final-edit/FinalEditPreview';
import { StyleEditor } from '@/components/final-edit/FinalEditInspector';
import { drawText, textStyleFont } from '@/components/final-edit/text-canvas-renderer';
import type { GroupCommandInput, VariantCommandInput } from '@/components/final-edit/command-types';
import { drawFramedImage } from '@/lib/final-edit/cover-framing';
import { timelineGaps } from '@/lib/final-edit/domain';
import { FINAL_EDIT_FPS, FINAL_EDIT_MIN_CLIP_FRAMES, OUTPUT_PRESETS, type CoverEditorDraft, type FinalEditAssetView, type FinalEditGroupView, type FinalEditVariantView, type TimelineClip } from '@/lib/final-edit/types';
import { MixcutTimeline } from './MixcutTimeline';
import { TrimEditor } from './TrimEditor';
import { CoverEditorDrawer } from './CoverEditorDrawer';
import styles from './MixcutPanel.module.css';

const FPS = FINAL_EDIT_FPS;

async function responseBody<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}

type VariantCommandRequest = VariantCommandInput | ((variant: FinalEditVariantView) => VariantCommandInput);
type GroupCommandRequest = GroupCommandInput | ((group: FinalEditGroupView) => GroupCommandInput);

// V2 第 3 步（规格 §6）：直接渲染网格子节点——素材替换列 / Resizer / 主区（工具行+大纸）/ Resizer / 右栏三卡。
// 列宽与折叠由 MixcutPanel 通过 CSS 变量与 body class 驱动。
export function PreviewStep({ group, active, onGroupChange, onExport, onRegenerateWithSpeed, onRepCollapse, onRgtCollapse, onResizeStart }: {
  group: FinalEditGroupView;
  active: boolean;
  onGroupChange: (group: FinalEditGroupView) => void;
  onExport: (variantId: string) => void;
  onRegenerateWithSpeed: (speed: number, group: FinalEditGroupView) => void;
  onRepCollapse: (collapsed: boolean) => void;
  onRgtCollapse: (collapsed: boolean) => void;
  onResizeStart: (side: 'rep' | 'rgt') => (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const [selectedVariantId, setSelectedVariantId] = useState(group.variants[0]?.id || '');
  const [selectedClipId, setSelectedClipId] = useState('');
  const [selectedCueId, setSelectedCueId] = useState(group.subtitleCues[0]?.id || '');
  const [playheadSec, setPlayheadSec] = useState(0);
  const [seekRequestId, setSeekRequestId] = useState(0);
  const [message, setMessage] = useState('已从本地草稿恢复');
  const [busy, setBusy] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [trimClip, setTrimClip] = useState<TimelineClip | null>(null);
  const groupRef = useRef(group);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);
  const mountedRef = useRef(true);
  const variant = group.variants.find((item) => item.id === selectedVariantId) || group.variants[0] || null;
  const selectedClip = variant?.timeline.clips.find((clip) => clip.id === selectedClipId) || null;
  const selectedCue = group.subtitleCues.find((cue) => cue.id === selectedCueId) || group.subtitleCues[0] || null;
  const orderedClips = useMemo(() => variant ? [...variant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame) : [], [variant]);
  const trimClipIndex = trimClip ? orderedClips.findIndex((clip) => clip.id === trimClip.id) : -1;
  const trimAsset = trimClip ? group.assets.find((asset) => asset.videoJobId === trimClip.videoJobId) ?? null : null;
  const usedVideoJobIds = useMemo(() => new Set(variant?.timeline.clips.map((clip) => clip.videoJobId) ?? []), [variant]);
  const firstInsertableGap = useMemo(() => variant
    ? timelineGaps(variant.timeline.bodyFrames, variant.timeline.clips)
      .find((gap) => gap.endFrame - gap.startFrame >= FINAL_EDIT_MIN_CLIP_FRAMES) || null
    : null, [variant]);

  useEffect(() => { groupRef.current = group; }, [group]);
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

  const enqueue = (work: () => Promise<boolean>): Promise<boolean> => {
    pendingRef.current += 1;
    setBusy(true);
    const scheduled = queueRef.current.then(work, work);
    queueRef.current = scheduled.then(() => undefined, () => undefined);
    return scheduled.finally(() => {
      pendingRef.current -= 1;
      if (mountedRef.current && pendingRef.current === 0) setBusy(false);
    });
  };

  const applyVariant = (request: VariantCommandRequest): Promise<boolean> => enqueue(async () => {
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
      if (mountedRef.current) setMessage('已自动保存');
      return true;
    } catch (error) {
      await reloadGroup(currentGroup.id).catch(() => undefined);
      if (mountedRef.current) setMessage(`保存失败，已恢复服务端版本：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  });

  const applyGroup = (request: GroupCommandRequest): Promise<boolean> => enqueue(async () => {
    const currentGroup = groupRef.current;
    const command = typeof request === 'function' ? request(currentGroup) : request;
    try {
      const result = await responseBody<{ view: FinalEditGroupView }>(await fetch(`/api/final-edit-groups/${currentGroup.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: currentGroup.revision, ...command }),
      }));
      if (groupRef.current.id === currentGroup.id) publishGroup(result.view);
      if (mountedRef.current) setMessage('已自动保存');
      return true;
    } catch (error) {
      await reloadGroup(currentGroup.id).catch(() => undefined);
      if (mountedRef.current) setMessage(`保存失败，已恢复服务端版本：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  });

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
    setPlayheadSec(seconds);
    setSeekRequestId((value) => value + 1);
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
  };

  const totalSec = variant ? (variant.timeline.bodyFrames / FPS) + (variant.cover ? 20 / FPS : 0) : 0;
  const bodySec = variant ? variant.timeline.bodyFrames / FPS : 0;
  const narrationSec = group.narrationDurationUs / 1_000_000;
  const narrationMatch = Math.abs(narrationSec - bodySec) < 1;
  const coverSourceIndex = variant ? orderedClips.findIndex((clip) => clip.videoJobId === variant.cover.sourceKey) : -1;
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
          <div className={styles.hintLine} style={{ color: '#B25E00' }}>{selectedClip
            ? '点击素材可替换当前片段；右键时间轴片段可删除。'
            : firstInsertableGap
              ? `时间轴有 ${(firstInsertableGap.endFrame - firstInsertableGap.startFrame) / FPS}s 缺口，点击素材即可从缺口起点插入。`
              : '先在时间轴选中片段再替换；右键片段可删除并腾出缺口。'}</div>
          <div className={styles.replaceList}>
            {group.assets.map((asset) => (
              <button
                type="button"
                key={asset.assetKey || asset.videoJobId}
                className={`${styles.rep} ${selectedClip?.videoJobId === asset.videoJobId ? styles.repActive : ''}`}
                disabled={busy || (!selectedClip && !firstInsertableGap)}
                onClick={() => selectedClip ? replaceClipAsset(asset) : insertClipAsset(asset)}
                title={selectedClip
                  ? `用「${asset.filename}」替换选中片段`
                  : firstInsertableGap
                    ? `把「${asset.filename}」插入第一个时间轴缺口`
                    : '先删除片段腾出缺口，或选中一个片段进行替换'}
              >
                <span className={styles.repThumb}>
                  {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" /> : <Icon name="video" size={14} />}
                </span>
                <span className={styles.repInfo}>
                  <span className={styles.repN}>{asset.filename}</span>
                  <span className={styles.repM}>{(asset.durationUs / 1_000_000).toFixed(1)}s · {asset.source === 'external' ? '外部导入' : '模块 4'}</span>
                </span>
                {usedVideoJobIds.has(asset.videoJobId) && <span className={`${styles.chip} ${styles.chipGreen}`}>已用</span>}
              </button>
            ))}
          </div>
        </section>
      </aside>
      <div className={styles.rz} role="separator" aria-orientation="vertical" title="拖拽调整宽度" onPointerDown={onResizeStart('rep')} />

      {/* 主区：工具行 + 大纸 */}
      <main className={styles.mainCol}>
        <div className={styles.t3Toolbar}>
          <span className={styles.t3Title}>预览调整</span>
          <span className={`${styles.chip} ${styles.chipGrey}`}>{orderedClips.length} 片段</span>
          <span className={`${styles.chip} ${styles.chipBlue}`}>总时长 {totalSec.toFixed(1)}s</span>
          <span className={`${styles.chip} ${narrationMatch ? styles.chipGreen : styles.chipGrey}`}>口播 {narrationSec.toFixed(1)}s {narrationMatch ? '✓' : '⚠'}</span>
          <span className={`${styles.chip} ${styles.chipGrey}`} title="单击选中 | 拖拽排序 | 双击片段重选时段 | 右键删除 | 双击字幕编辑">单击选中 · 拖拽排序 · 双击编辑 · 右键删除</span>
          {selectedMatchReason && selectedMatchReasonLabel && (
            <span className={`${styles.chip} ${styles.chipBlue}`}>匹配：{selectedMatchReasonLabel} · {selectedMatchReason.score.toFixed(2)}</span>
          )}
          <span className={styles.spacer} />
          <span className={styles.flowHint} aria-live="polite">{busy ? '正在保存…' : message}</span>
          {group.variants.length > 1 && (
            <select aria-label="选择成片草稿" value={variant.id} onChange={(event) => { setSelectedVariantId(event.target.value); setSelectedClipId(''); setTrimClip(null); setPlayheadSec(0); }}>
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
          <div className={styles.previewWrap}>
            <div className={styles.previewFrame} data-output-preset={variant.outputPreset}>
              <FinalEditPreview
                group={group}
                variant={variant}
                assets={group.assets}
                selectedAsset={null}
                playheadSec={playheadSec}
                seekRequestId={seekRequestId}
                active={active}
                textTarget={null}
                onPlayheadChange={setPlayheadSec}
                onTextPositionChange={() => undefined}
              />
            </div>
          </div>

          {trimClip && (
            <TrimEditor
              clip={trimClip}
              clipIndex={Math.max(0, trimClipIndex)}
              asset={trimAsset}
              disabled={busy}
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
            variant={variant}
            cues={group.subtitleCues}
            assets={group.assets}
            selectedClipId={selectedClipId}
            selectedCueId={selectedCue?.id || ''}
            playheadSec={playheadSec}
            disabled={busy}
            onSeek={seek}
            onSelectClip={setSelectedClipId}
            onSelectCue={setSelectedCueId}
            onVariantCommand={(command) => applyVariant(command)}
            onGroupCommand={applyGroup}
            onTrimClip={openTrim}
            onEditCueText={(cueId, text) => void applyGroup({ type: 'set_subtitle_cue_text', cueId, text })}
            narrationSpeed={group.script.narrationConfig.speed}
            onNarrationSpeedChange={(speed) => onRegenerateWithSpeed(speed, group)}
          />
        </div>
      </main>
      <div className={styles.rz} role="separator" aria-orientation="vertical" title="拖拽调整宽度" onPointerDown={onResizeStart('rgt')} />

      {/* 右栏：字幕样式 / 背景音乐 / 封面 */}
      <aside className={styles.rightCol}>
        <button type="button" className={styles.collapseBtn} title="隐藏面板" onClick={() => onRgtCollapse(true)}>›</button>
        <button type="button" className={styles.expandBtn} title="展开面板" onClick={() => onRgtCollapse(false)}>‹</button>

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

        <section className={styles.rcard}>
          <h4><Icon name="music" size={15} />背景音乐</h4>
          <div className={styles.ctlRow}>
            <select style={{ flex: 1, minWidth: 100 }} value={variant.bgm.trackId || ''} disabled={busy} onChange={(event) => void applyVariant({ type: 'set_bgm', trackId: event.target.value || null })} aria-label="BGM 曲目">
              <option value="">无 BGM</option>
              {group.bgmTracks.map((track) => <option key={track.id} value={track.id}>{track.relativePath}</option>)}
            </select>
          </div>
          <div className={styles.ctlRow}>
            <span className={styles.ctlLab}>音量</span>
            <input type="range" min={-40} max={0} step={1} defaultValue={variant.bgm.gainDb} key={`gain-${variant.revision}`} disabled={busy} onChange={(event) => void applyVariant({ type: 'set_bgm_gain', gainDb: Number(event.target.value) })} aria-label="音量（dB）" />
            <span className={styles.ctlVal}>{variant.bgm.gainDb} dB</span>
          </div>
          <div className={styles.ctlRow}>
            <span className={styles.ctlLab}>淡入</span>
            <input type="range" min={0} max={5} step={0.1} defaultValue={variant.bgm.fadeInSec} key={`fade-in-${variant.revision}`} disabled={busy} onChange={(event) => void applyVariant((current) => ({ type: 'set_bgm_fades', fadeInSec: Number(event.target.value), fadeOutSec: current.bgm.fadeOutSec }))} aria-label="淡入（秒）" />
            <span className={styles.ctlVal}>{variant.bgm.fadeInSec}s</span>
          </div>
          <div className={styles.ctlRow}>
            <span className={styles.ctlLab}>淡出</span>
            <input type="range" min={0} max={5} step={0.1} defaultValue={variant.bgm.fadeOutSec} key={`fade-out-${variant.revision}`} disabled={busy} onChange={(event) => void applyVariant((current) => ({ type: 'set_bgm_fades', fadeInSec: current.bgm.fadeInSec, fadeOutSec: Number(event.target.value) }))} aria-label="淡出（秒）" />
            <span className={styles.ctlVal}>{variant.bgm.fadeOutSec}s</span>
          </div>
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
        drawText(context, group.coverTitle.primary.text, primary);
        drawText(context, group.coverTitle.secondary.text, secondary);
      });
    };
    image.src = variant.cover.sourceUrl;
    return () => { cancelled = true; };
  }, [group.coverTitle.primary.text, group.coverTitle.secondary.text, group.textStyles, output.height, output.width, variant.cover.framing, variant.cover.sourceUrl, variant.outputPreset]);
  return <canvas ref={canvasRef} width={output.width} height={output.height} aria-label="当前真实封面" />;
}
