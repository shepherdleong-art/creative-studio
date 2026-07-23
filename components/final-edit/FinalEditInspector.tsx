'use client';

import { useEffect, useState } from 'react';
import type { FinalEditAssetView, FinalEditGroupView, FinalEditVariantView, OutputPresetId, SubtitleCue, TextStyle, TimelineClip } from '@/lib/final-edit/types';
import type { GroupCommandInput, VariantCommandInput } from './command-types';
import styles from './FinalEditEditor.module.css';

export interface TitlePresetView {
  id: string;
  name: string;
  stylesByPreset: Record<OutputPresetId, { coverPrimary: TextStyle; coverSecondary: TextStyle }>;
}

export type InspectorMode = 'subtitle' | 'cover' | 'framing' | 'audio';
export type StyleTarget = 'coverPrimary' | 'coverSecondary' | 'subtitle';

function timecode(timeUs: number) {
  const seconds = Math.max(0, timeUs / 1_000_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}

export function FinalEditInspector({
  group,
  variant,
  selectedCue,
  selectedCueOverflow,
  selectedClip,
  selectedAsset,
  mode,
  titlePresets,
  firstVideoGap,
  styleTarget,
  onDraftGroup,
  onDraftVariant,
  onVariantCommand,
  onGroupCommand,
  onSavePreset,
  onApplyPreset,
  onRenamePreset,
  onDeletePreset,
  onFillGaps,
  onModeChange,
  onStyleTargetChange,
}: {
  group: FinalEditGroupView;
  variant: FinalEditVariantView;
  selectedCue: SubtitleCue | null;
  selectedCueOverflow: { measuredWidthPx: number; safeWidthPx: number } | null;
  selectedClip: TimelineClip | null;
  selectedAsset: FinalEditAssetView | null;
  mode: InspectorMode;
  titlePresets: TitlePresetView[];
  firstVideoGap: { start: number; end: number } | null;
  styleTarget: StyleTarget;
  onDraftGroup: (group: FinalEditGroupView) => void;
  onDraftVariant: (variant: FinalEditVariantView) => void;
  onVariantCommand: (command: VariantCommandInput) => void;
  onGroupCommand: (command: GroupCommandInput) => void;
  onSavePreset: () => void;
  onApplyPreset: (id: string) => void;
  onRenamePreset: (preset: TitlePresetView) => void;
  onDeletePreset: (id: string) => void;
  onFillGaps: () => void;
  onModeChange: (mode: InspectorMode) => void;
  onStyleTargetChange: (target: StyleTarget) => void;
}) {
  const modes: Array<[InspectorMode, string]> = [['subtitle', '字幕'], ['cover', '封面'], ['framing', '画面'], ['audio', '音频']];
  const previewTextStyle = (target: StyleTarget, style: TextStyle) => {
    onDraftGroup({
      ...group,
      textStyles: {
        ...group.textStyles,
        [variant.outputPreset]: { ...group.textStyles[variant.outputPreset], [target]: style },
      },
    });
  };

  const insertSubtitle = () => {
    const startUs = selectedCue?.endUs ?? Math.max(0, group.narrationDurationUs - 1_000_000);
    const endUs = Math.min(group.narrationDurationUs, startUs + 1_000_000);
    const safeStart = endUs > startUs ? startUs : Math.max(0, endUs - 500_000);
    onGroupCommand({ type: 'insert_subtitle_cue', segmentId: selectedCue?.segmentId || 'manual', text: '新字幕', startUs: safeStart, endUs });
  };

  return (
    <aside className={styles.inspector} aria-label="属性检查器">
      <div className={styles.inspectorTabs} role="tablist">
        {modes.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={mode === id} className={mode === id ? styles.activeInspector : ''} onClick={() => onModeChange(id)}>{label}</button>)}
      </div>
      <div className={styles.inspectorScroll}>
        {mode === 'subtitle' && (
          <>
            <InspectorHeading title="字幕编辑" description="文字在这里修改；时间位置只在下方时间轴拖动，避免两套入口互相覆盖。" />
            {selectedCue ? (
              <>
                <label className={styles.fieldLabel}>当前字幕</label>
                <input className={styles.input} value={selectedCue.text} onChange={(event) => onDraftGroup({ ...group, subtitleCues: group.subtitleCues.map((cue) => cue.id === selectedCue.id ? { ...cue, text: event.target.value.replace(/\n/g, '') } : cue) })} onBlur={(event) => onGroupCommand({ type: 'set_subtitle_cue_text', cueId: selectedCue.id, text: event.target.value })} />
                <div className={styles.inlineButtons}>
                  <button type="button" onClick={() => { const chars = Array.from(selectedCue.text); const cut = Math.max(1, Math.floor(chars.length / 2)); onGroupCommand({ type: 'split_subtitle_cue', cueId: selectedCue.id, splitUs: Math.round((selectedCue.startUs + selectedCue.endUs) / 2), leftText: chars.slice(0, cut).join(''), rightText: chars.slice(cut).join('') }); }}>从中间拆分</button>
                  <button type="button" onClick={insertSubtitle}>后插字幕</button>
                  <button type="button" className={styles.danger} onClick={() => onGroupCommand({ type: 'delete_subtitle_cue', cueId: selectedCue.id })}>删除</button>
                </div>
                <p className={styles.hint}>{timecode(selectedCue.startUs)} — {timecode(selectedCue.endUs)} · 拖动字幕块移动，拖两侧把手修剪。</p>
                {selectedCueOverflow && (
                  <div className={`${styles.issue} ${styles.warning}`} role="status">
                    <strong>此条字幕超出单行安全宽度</strong><br />
                    实测约 {Math.ceil(selectedCueOverflow.measuredWidthPx)} px，安全宽度 {selectedCueOverflow.safeWidthPx} px，超出 {Math.ceil(selectedCueOverflow.measuredWidthPx - selectedCueOverflow.safeWidthPx)} px。可缩短文字、减小字号/缩放，或增大单行宽度。
                  </div>
                )}
              </>
            ) : <button type="button" className={styles.actionButton} onClick={insertSubtitle}>插入第一条字幕</button>}
            <SectionTitle title="字幕样式" action="恢复默认" onAction={() => onGroupCommand({ type: 'reset_text_style', preset: variant.outputPreset, target: 'subtitle' })} />
            <StyleEditor key={`subtitle-${group.revision}`} value={group.textStyles[variant.outputPreset].subtitle} onPreview={(style) => previewTextStyle('subtitle', style)} onCommit={(style) => onGroupCommand({ type: 'set_text_style', preset: variant.outputPreset, target: 'subtitle', style })} />
          </>
        )}

        {mode === 'cover' && (
          <>
            <InspectorHeading title="封面与标题" description="选择分镜图或视频关键帧，并单独调整封面取景与两段标题。" />
            <label className={styles.fieldLabel}>封面底图</label>
            <select className={styles.input} value={variant.cover.coverKey || ''} onChange={(event) => onVariantCommand({ type: 'set_cover', coverKey: event.target.value })}>
              {group.coverCandidates.map((candidate, index) => <option key={candidate.coverKey} value={candidate.coverKey}>{candidate.kind === 'video_keyframe' ? '视频关键帧' : '分镜图片'} {index + 1}</option>)}
            </select>
            <SectionTitle title="封面取景" />
            <Slider label="缩放" value={variant.cover.framing.scale} min={1} max={3} step={0.05} onPreview={(scale) => onDraftVariant({ ...variant, cover: { ...variant.cover, framing: { ...variant.cover.framing, scale } } })} onCommit={(scale) => onVariantCommand({ type: 'set_cover_framing', scale, offsetX: variant.cover.framing.offsetX, offsetY: variant.cover.framing.offsetY })} />
            <Slider label="水平偏移" value={variant.cover.framing.offsetX} min={-1} max={1} step={0.05} onPreview={(offsetX) => onDraftVariant({ ...variant, cover: { ...variant.cover, framing: { ...variant.cover.framing, offsetX } } })} onCommit={(offsetX) => onVariantCommand({ type: 'set_cover_framing', scale: variant.cover.framing.scale, offsetX, offsetY: variant.cover.framing.offsetY })} />
            <Slider label="垂直偏移" value={variant.cover.framing.offsetY} min={-1} max={1} step={0.05} onPreview={(offsetY) => onDraftVariant({ ...variant, cover: { ...variant.cover, framing: { ...variant.cover.framing, offsetY } } })} onCommit={(offsetY) => onVariantCommand({ type: 'set_cover_framing', scale: variant.cover.framing.scale, offsetX: variant.cover.framing.offsetX, offsetY })} />
            <SectionTitle title="标题文字" action="保存标题预设" onAction={onSavePreset} />
            <label className={styles.fieldLabel}>第一段</label>
            <input className={styles.input} value={group.coverTitle.primary.text} onChange={(event) => onDraftGroup({ ...group, coverTitle: { ...group.coverTitle, primary: { ...group.coverTitle.primary, text: event.target.value } } })} onBlur={(event) => onGroupCommand({ type: 'set_cover_title_part_text', part: 'primary', text: event.target.value })} />
            <label className={styles.fieldLabel}>第二段</label>
            <input className={styles.input} value={group.coverTitle.secondary.text} onChange={(event) => onDraftGroup({ ...group, coverTitle: { ...group.coverTitle, secondary: { ...group.coverTitle.secondary, text: event.target.value } } })} onBlur={(event) => onGroupCommand({ type: 'set_cover_title_part_text', part: 'secondary', text: event.target.value })} />
            <div className={styles.inlineButtons}>{([['coverPrimary', '标题一'], ['coverSecondary', '标题二']] as const).map(([id, label]) => <button type="button" key={id} className={styleTarget === id ? styles.activeFilter : ''} onClick={() => onStyleTargetChange(id)}>{label}</button>)}</div>
            <SectionTitle title="标题样式" action="恢复默认" onAction={() => onGroupCommand({ type: 'reset_text_style', preset: variant.outputPreset, target: styleTarget === 'subtitle' ? 'coverPrimary' : styleTarget })} />
            <StyleEditor key={`${styleTarget}-${group.revision}`} value={group.textStyles[variant.outputPreset][styleTarget === 'subtitle' ? 'coverPrimary' : styleTarget]} onPreview={(style) => previewTextStyle(styleTarget === 'subtitle' ? 'coverPrimary' : styleTarget, style)} onCommit={(style) => onGroupCommand({ type: 'set_text_style', preset: variant.outputPreset, target: styleTarget === 'subtitle' ? 'coverPrimary' : styleTarget, style })} />
            {titlePresets.length > 0 && <div className={styles.presetList}>{titlePresets.map((preset) => <div key={preset.id} className={styles.presetItem}><button type="button" onClick={() => onApplyPreset(preset.id)}>{preset.name}</button><button type="button" onClick={() => onRenamePreset(preset)}>改名</button><button type="button" className={styles.danger} onClick={() => onDeletePreset(preset.id)}>删除</button></div>)}</div>}
          </>
        )}

        {mode === 'framing' && (
          <>
            <InspectorHeading title="视频片段" description={selectedClip ? `时间轴 ${selectedClip.timelineInFrame}–${selectedClip.timelineOutFrame} 帧 · 源 ${selectedClip.sourceInFrame}–${selectedClip.sourceOutFrame} 帧` : '先在时间轴点选一个片段；也可以把素材直接拖到视频轨。'} />
            {selectedClip ? (
              <>
                <Slider label="缩放" value={selectedClip.framing.scale} min={1} max={3} step={0.05} onPreview={(scale) => onDraftVariant({ ...variant, timeline: { ...variant.timeline, clips: variant.timeline.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, framing: { ...clip.framing, scale } } : clip) } })} onCommit={(scale) => onVariantCommand({ type: 'set_framing', clipId: selectedClip.id, scale, offsetX: selectedClip.framing.offsetX, offsetY: selectedClip.framing.offsetY })} />
                <Slider label="水平偏移" value={selectedClip.framing.offsetX} min={-1} max={1} step={0.05} onPreview={(offsetX) => onDraftVariant({ ...variant, timeline: { ...variant.timeline, clips: variant.timeline.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, framing: { ...clip.framing, offsetX } } : clip) } })} onCommit={(offsetX) => onVariantCommand({ type: 'set_framing', clipId: selectedClip.id, scale: selectedClip.framing.scale, offsetX, offsetY: selectedClip.framing.offsetY })} />
                <Slider label="垂直偏移" value={selectedClip.framing.offsetY} min={-1} max={1} step={0.05} onPreview={(offsetY) => onDraftVariant({ ...variant, timeline: { ...variant.timeline, clips: variant.timeline.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, framing: { ...clip.framing, offsetY } } : clip) } })} onCommit={(offsetY) => onVariantCommand({ type: 'set_framing', clipId: selectedClip.id, scale: selectedClip.framing.scale, offsetX: selectedClip.framing.offsetX, offsetY })} />
                <label className={styles.fieldLabel}>绑定口播</label>
                <select className={styles.input} value={selectedClip.boundSegmentId || ''} onChange={(event) => onVariantCommand(event.target.value ? { type: 'bind_clip', clipId: selectedClip.id, segmentId: event.target.value } : { type: 'unbind_clip', clipId: selectedClip.id })}>
                  <option value="">不绑定</option>{[...new Set(group.subtitleCues.map((cue) => cue.segmentId))].map((segmentId) => <option key={segmentId} value={segmentId}>{segmentId}</option>)}
                </select>
                <div className={styles.inlineButtons}>
                  {selectedAsset && selectedAsset.videoJobId !== selectedClip.videoJobId && <button type="button" onClick={() => onVariantCommand({ type: 'replace_clip', clipId: selectedClip.id, videoJobId: selectedAsset.videoJobId, sourceFingerprint: selectedAsset.fingerprint, sourceInFrame: 0, sourceOutFrame: selectedClip.sourceOutFrame - selectedClip.sourceInFrame })}>用选中素材替换</button>}
                  {variant.timeline.clips.findIndex((clip) => clip.id === selectedClip.id) < variant.timeline.clips.length - 1 && <button type="button" onClick={() => { const index = variant.timeline.clips.findIndex((clip) => clip.id === selectedClip.id); onVariantCommand({ type: 'swap_clips', leftClipId: selectedClip.id, rightClipId: variant.timeline.clips[index + 1].id }); }}>与下一片段交换</button>}
                </div>
              </>
            ) : null}
            {selectedAsset && firstVideoGap && <button type="button" className={styles.actionButton} onClick={() => { const length = Math.min(72, firstVideoGap.end - firstVideoGap.start, Math.floor(selectedAsset.durationUs / 1_000_000 * 24)); onVariantCommand({ type: 'insert_clip', videoJobId: selectedAsset.videoJobId, sourceFingerprint: selectedAsset.fingerprint, sourceInFrame: 0, sourceOutFrame: length, timelineInFrame: firstVideoGap.start, timelineOutFrame: firstVideoGap.start + length }); }}>把选中素材插入第一个缺口</button>}
            {variant.issues.some((issue) => issue.code === 'timeline_gap') && <button type="button" className={styles.primaryButton} onClick={onFillGaps}>AI 补齐所有画面缺口</button>}
            <SectionTitle title="问题" />
            <div className={styles.issueList}>{variant.issues.length ? variant.issues.map((issue, index) => <div className={`${styles.issue} ${issue.severity === 'blocking' ? styles.blocking : styles.warning}`} key={`${issue.code}-${index}`}>{issue.message}</div>) : <div className={`${styles.issue} ${styles.hint}`}>未发现阻断问题</div>}</div>
          </>
        )}

        {mode === 'audio' && (
          <>
            <InspectorHeading title="音频" description="口播轨锁定；只允许选择 BGM、调整增益与尾部淡出。" />
            <label className={styles.fieldLabel}>BGM</label>
            <select className={styles.input} value={variant.bgm.trackId || ''} onChange={(event) => onVariantCommand({ type: 'set_bgm', trackId: event.target.value || null })}><option value="">无 BGM</option>{group.bgmTracks.map((track) => <option key={track.id} value={track.id}>{track.relativePath}</option>)}</select>
            <Slider label="BGM 增益（dB）" value={variant.bgm.gainDb} min={-40} max={0} step={0.5} onPreview={(gainDb) => onDraftVariant({ ...variant, bgm: { ...variant.bgm, gainDb } })} onCommit={(gainDb) => onVariantCommand({ type: 'set_bgm_gain', gainDb })} />
            <p className={styles.hint}>TTS 口播时长 {(group.narrationDurationUs / 1_000_000).toFixed(2)} 秒，时间轴位置不可解锁。</p>
          </>
        )}
      </div>
    </aside>
  );
}

function InspectorHeading({ title, description }: { title: string; description: string }) { return <div className={styles.inspectorHeading}><h3>{title}</h3><p>{description}</p></div>; }
function SectionTitle({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) { return <div className={styles.sectionTitle}><span>{title}</span>{action && <button type="button" onClick={onAction}>{action}</button>}</div>; }

function StyleEditor({ value, onPreview, onCommit }: { value: TextStyle; onPreview: (style: TextStyle) => void; onCommit: (style: TextStyle) => void }) {
  const [draft, setDraft] = useState(value);
  const [fonts, setFonts] = useState<string[]>([value.fontFamily]);

  useEffect(() => {
    void fetch('/api/system-fonts').then((response) => response.json()).then((body) => {
      const values = Array.isArray(body) ? body : body.fonts;
      if (Array.isArray(values)) setFonts([...new Set([value.fontFamily, ...values.map((item) => typeof item === 'string' ? item : item.family).filter(Boolean)])]);
    }).catch(() => undefined);
  }, [value.fontFamily]);

  const refreshFonts = async () => {
    const localWindow = window as Window & { queryLocalFonts?: () => Promise<Array<{ family: string; postscriptName?: string }>> };
    if (!localWindow.queryLocalFonts) return;
    try {
      const localFonts = await localWindow.queryLocalFonts();
      setFonts([...new Set([value.fontFamily, ...localFonts.map((font) => font.family)])]);
    } catch { /* Permission can be declined without blocking editing. */ }
  };
  const preview = (patch: Partial<TextStyle>) => { const next = { ...draft, ...patch }; setDraft(next); onPreview(next); };
  const commit = (patch: Partial<TextStyle>) => { const next = { ...draft, ...patch }; setDraft(next); onPreview(next); onCommit(next); };

  return (
    <div>
      <label className={styles.fieldLabel}>字体</label>
      <div className={styles.sliderRow}><select className={styles.input} value={draft.fontFamily} onChange={(event) => commit({ fontFamily: event.target.value })}>{fonts.map((font) => <option key={font}>{font}</option>)}</select><button type="button" className={styles.actionButton} onClick={() => void refreshFonts()}>刷新</button></div>
      <Slider label="字号" value={draft.fontSizePx} min={12} max={180} step={1} onPreview={(fontSizePx) => preview({ fontSizePx })} onCommit={(fontSizePx) => commit({ fontSizePx })} />
      <Slider label="X 位置" value={draft.x} min={0} max={1} step={0.01} onPreview={(x) => preview({ x })} onCommit={(x) => commit({ x })} />
      <Slider label="Y 位置" value={draft.y} min={0} max={1} step={0.01} onPreview={(y) => preview({ y })} onCommit={(y) => commit({ y })} />
      <Slider label="缩放" value={draft.scale} min={0.5} max={2} step={0.01} onPreview={(scale) => preview({ scale })} onCommit={(scale) => commit({ scale })} />
      <Slider label="单行宽度" value={draft.boxWidthPx} min={200} max={1800} step={10} onPreview={(boxWidthPx) => preview({ boxWidthPx })} onCommit={(boxWidthPx) => commit({ boxWidthPx })} />
      <div className={styles.twoColumns}><label><span className={styles.fieldLabel}>颜色</span><input className={styles.input} type="color" value={draft.color} onChange={(event) => commit({ color: event.target.value })} /></label><label><span className={styles.fieldLabel}>对齐</span><select className={styles.input} value={draft.align} onChange={(event) => commit({ align: event.target.value as TextStyle['align'] })}><option value="left">左</option><option value="center">中</option><option value="right">右</option></select></label></div>
      <label className={styles.effectHeader}>描边 <input type="checkbox" checked={draft.stroke.enabled} onChange={(event) => commit({ stroke: { ...draft.stroke, enabled: event.target.checked } })} /></label>
      {draft.stroke.enabled && <div className={styles.effectBody}><label className={styles.colorRow}><input type="color" value={draft.stroke.color} onChange={(event) => commit({ stroke: { ...draft.stroke, color: event.target.value } })} /><span /></label><Slider label="粗细" value={draft.stroke.widthPx} min={0} max={16} step={0.5} onPreview={(widthPx) => preview({ stroke: { ...draft.stroke, widthPx } })} onCommit={(widthPx) => commit({ stroke: { ...draft.stroke, widthPx } })} /></div>}
      <label className={styles.effectHeader}>阴影 <input type="checkbox" checked={draft.shadow.enabled} onChange={(event) => commit({ shadow: { ...draft.shadow, enabled: event.target.checked } })} /></label>
      {draft.shadow.enabled && <div className={styles.effectBody}><label className={styles.colorRow}><input aria-label="阴影颜色" type="color" value={draft.shadow.color} onChange={(event) => commit({ shadow: { ...draft.shadow, color: event.target.value } })} /><span /></label><Slider label="不透明度" value={draft.shadow.opacity} min={0} max={1} step={0.05} onPreview={(opacity) => preview({ shadow: { ...draft.shadow, opacity } })} onCommit={(opacity) => commit({ shadow: { ...draft.shadow, opacity } })} /><Slider label="模糊" value={draft.shadow.blurPx} min={0} max={40} step={1} onPreview={(blurPx) => preview({ shadow: { ...draft.shadow, blurPx } })} onCommit={(blurPx) => commit({ shadow: { ...draft.shadow, blurPx } })} /><Slider label="距离" value={draft.shadow.distancePx} min={0} max={40} step={1} onPreview={(distancePx) => preview({ shadow: { ...draft.shadow, distancePx } })} onCommit={(distancePx) => commit({ shadow: { ...draft.shadow, distancePx } })} /><Slider label="角度" value={draft.shadow.angleDeg} min={0} max={360} step={1} onPreview={(angleDeg) => preview({ shadow: { ...draft.shadow, angleDeg } })} onCommit={(angleDeg) => commit({ shadow: { ...draft.shadow, angleDeg } })} /></div>}
    </div>
  );
}

function Slider({ label, value, min, max, step, onPreview, onCommit }: { label: string; value: number; min: number; max: number; step: number; onPreview: (value: number) => void; onCommit: (value: number) => void }) {
  const preview = (next: number) => onPreview(Math.max(min, Math.min(max, next)));
  return <label className={styles.sliderField}><span>{label}</span><div className={styles.sliderRow}><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => preview(Number(event.currentTarget.value))} onPointerUp={(event) => onCommit(Number(event.currentTarget.value))} onKeyUp={(event) => onCommit(Number(event.currentTarget.value))} /><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => preview(Number(event.currentTarget.value))} onBlur={(event) => onCommit(Number(event.currentTarget.value))} /></div></label>;
}
