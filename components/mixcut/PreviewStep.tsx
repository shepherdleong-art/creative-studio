'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { FinalEditPreview } from '@/components/final-edit/FinalEditPreview';
import { StyleEditor } from '@/components/final-edit/FinalEditInspector';
import type { GroupCommandInput, VariantCommandInput } from '@/components/final-edit/command-types';
import type { FinalEditGroupView, FinalEditVariantView } from '@/lib/final-edit/types';
import { MixcutTimeline } from './MixcutTimeline';
import styles from './MixcutPanel.module.css';

async function responseBody<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}

type VariantCommandRequest = VariantCommandInput | ((variant: FinalEditVariantView) => VariantCommandInput);

export function PreviewStep({ group, active, onGroupChange, onBack }: {
  group: FinalEditGroupView;
  active: boolean;
  onGroupChange: (group: FinalEditGroupView) => void;
  onBack: () => void;
}) {
  const [selectedVariantId, setSelectedVariantId] = useState(group.variants[0]?.id || '');
  const [selectedClipId, setSelectedClipId] = useState('');
  const [selectedCueId, setSelectedCueId] = useState(group.subtitleCues[0]?.id || '');
  const [playheadSec, setPlayheadSec] = useState(0);
  const [seekRequestId, setSeekRequestId] = useState(0);
  const [message, setMessage] = useState('已从本地草稿恢复');
  const [busy, setBusy] = useState(false);
  const groupRef = useRef(group);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);
  const mountedRef = useRef(true);
  const variant = group.variants.find((item) => item.id === selectedVariantId) || group.variants[0] || null;
  const selectedClip = variant?.timeline.clips.find((clip) => clip.id === selectedClipId) || null;
  const selectedCue = group.subtitleCues.find((cue) => cue.id === selectedCueId) || group.subtitleCues[0] || null;
  const orderedClips = useMemo(() => variant ? [...variant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame) : [], [variant]);

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

  const applyGroup = (command: GroupCommandInput): Promise<boolean> => enqueue(async () => {
    const currentGroup = groupRef.current;
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

  if (!variant) {
    return <section className={styles.previewStep}><div className={styles.emptyState}><strong>还没有可预览的成片草稿</strong><span>返回智能创作，等待后台四个阶段完成后再进入。</span><button type="button" className={styles.secondaryButton} onClick={onBack}>返回智能创作</button></div></section>;
  }

  return (
    <section className={styles.previewStep} aria-labelledby="mixcut-preview-heading" data-output-preset={variant.outputPreset}>
      <header className={styles.previewStepHeader}>
        <div>
          <p className={styles.eyebrow}>STEP 03</p>
          <h1 id="mixcut-preview-heading">预览并调整完整时间轴</h1>
          <p>视频、字幕、口播和 BGM 共享同一个真实时间原点。</p>
        </div>
        <div className={styles.previewHeaderActions}>
          <span aria-live="polite">{busy ? '正在保存…' : message}</span>
          {group.variants.length > 1 && <select aria-label="选择成片草稿" value={variant.id} onChange={(event) => { setSelectedVariantId(event.target.value); setSelectedClipId(''); setPlayheadSec(0); }}>
            {group.variants.map((item) => <option key={item.id} value={item.id}>成片 {item.indexNum} · {item.outputPreset.replace('x', ':')}</option>)}
          </select>}
          <button type="button" className={styles.secondaryButton} onClick={onBack}><Icon name="chevron-left" size={14} />返回创作</button>
        </div>
      </header>

      <div className={styles.previewEditorGrid}>
        <div className={styles.previewPlayerCell}>
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
        <aside className={styles.previewPropertyPanel} aria-label="时间轴属性">
          <div className={styles.previewPropertyTabs}><strong>当前编辑</strong><span>{variant.outputPreset.replace('x', ':')}</span></div>
          <fieldset className={styles.previewPropertyScroll} disabled={busy} aria-label="可持久化编辑属性">
            {selectedCue && (
              <section className={styles.previewPropertyCard}>
                <h2>字幕</h2>
                <label className={styles.fieldLabel}>文字<input defaultValue={selectedCue.text} key={`${selectedCue.id}-${selectedCue.text}`} onBlur={(event) => void applyGroup({ type: 'set_subtitle_cue_text', cueId: selectedCue.id, text: event.target.value })} /></label>
                <p>{(selectedCue.startUs / 1_000_000).toFixed(2)}s – {(selectedCue.endUs / 1_000_000).toFixed(2)}s</p>
                <div className={styles.previewStyleHeading}><strong>全局字幕样式</strong><button type="button" onClick={() => void applyGroup({ type: 'reset_text_style', preset: variant.outputPreset, target: 'subtitle' })}>恢复默认</button></div>
                <StyleEditor
                  key={`subtitle-style-${variant.outputPreset}-${group.revision}`}
                  value={group.textStyles[variant.outputPreset].subtitle}
                  onPreview={previewSubtitleStyle}
                  onCommit={(style) => void applyGroup({ type: 'set_text_style', preset: variant.outputPreset, target: 'subtitle', style })}
                />
              </section>
            )}
            {selectedClip && (
              <section className={styles.previewPropertyCard}>
                <h2>视频片段</h2>
                <p>源 {selectedClip.sourceInFrame}–{selectedClip.sourceOutFrame} 帧<br />时间轴 {selectedClip.timelineInFrame}–{selectedClip.timelineOutFrame} 帧</p>
                <div className={styles.clipOrderButtons}>
                  <button type="button" disabled={orderedClips[0]?.id === selectedClip.id} onClick={() => {
                    void applyVariant((current) => {
                      const clips = [...current.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame);
                      const index = clips.findIndex((clip) => clip.id === selectedClip.id);
                      const ids = clips.map((clip) => clip.id);
                      if (index > 0) [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                      return { type: 'reorder_clips', orderedClipIds: ids };
                    });
                  }}>前移</button>
                  <button type="button" disabled={orderedClips.at(-1)?.id === selectedClip.id} onClick={() => {
                    void applyVariant((current) => {
                      const clips = [...current.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame);
                      const index = clips.findIndex((clip) => clip.id === selectedClip.id);
                      const ids = clips.map((clip) => clip.id);
                      if (index >= 0 && index < ids.length - 1) [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
                      return { type: 'reorder_clips', orderedClipIds: ids };
                    });
                  }}>后移</button>
                </div>
              </section>
            )}
            <section className={styles.previewPropertyCard}>
              <h2>背景音乐</h2>
              <label className={styles.fieldLabel}>曲目<select value={variant.bgm.trackId || ''} onChange={(event) => void applyVariant({ type: 'set_bgm', trackId: event.target.value || null })}><option value="">无 BGM</option>{group.bgmTracks.map((track) => <option key={track.id} value={track.id}>{track.relativePath}</option>)}</select></label>
              <label className={styles.fieldLabel}>音量（dB）<input type="number" min={-40} max={0} step={0.5} defaultValue={variant.bgm.gainDb} key={`gain-${variant.revision}`} onBlur={(event) => void applyVariant({ type: 'set_bgm_gain', gainDb: Number(event.target.value) })} /></label>
              <div className={styles.fadeFields}>
                <label className={styles.fieldLabel}>淡入（秒）<input type="number" min={0} max={variant.timeline.bodyFrames / 24} step={0.1} defaultValue={variant.bgm.fadeInSec} key={`fade-in-${variant.revision}`} onBlur={(event) => { const fadeInSec = Number(event.target.value); void applyVariant((current) => ({ type: 'set_bgm_fades', fadeInSec, fadeOutSec: current.bgm.fadeOutSec })); }} /></label>
                <label className={styles.fieldLabel}>淡出（秒）<input type="number" min={0} max={variant.timeline.bodyFrames / 24} step={0.1} defaultValue={variant.bgm.fadeOutSec} key={`fade-out-${variant.revision}`} onBlur={(event) => { const fadeOutSec = Number(event.target.value); void applyVariant((current) => ({ type: 'set_bgm_fades', fadeInSec: current.bgm.fadeInSec, fadeOutSec })); }} /></label>
              </div>
            </section>
            {variant.issues.length > 0 && <section className={styles.previewPropertyCard}><h2>诊断</h2>{variant.issues.map((issue, index) => <p key={`${issue.code}-${index}`} className={issue.severity === 'blocking' ? styles.previewBlockingIssue : undefined}>{issue.message}</p>)}</section>}
          </fieldset>
        </aside>
      </div>

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
      />
    </section>
  );
}
