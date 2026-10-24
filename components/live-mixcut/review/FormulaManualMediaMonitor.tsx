'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BatchOutputClipEditView } from '@/lib/live-mixcut/output-arrangement';
import { FINAL_EDIT_FPS as FPS } from '@/lib/media-core/render-contract';
import { TrimEditor } from '@/components/mixcut/TrimEditor';
import { LutVideoPlayer } from '../LutVideoPlayer';
import type { FormulaMediaSession } from './types';

interface SpeechDraft { text: string; start: string; end: string }
const speechField = 'min-w-0 rounded border border-hairline bg-surface px-2 py-1 text-ink';

export default function FormulaManualMediaMonitor({ session, projectId, onApply, onClose }: {
  session: FormulaMediaSession;
  projectId: string;
  onApply: (planId: string, edit: Record<string, unknown>, undoBasis?: BatchOutputClipEditView) => Promise<boolean>;
  onClose: () => void;
}) {
  const { view, asset, edit, requestKey } = session;
  const clipIndex = edit.type === 'replace' ? view.clips.findIndex(clip => clip.clipId === edit.clipId) : view.clips.length;
  const target = edit.type === 'replace' ? view.clips[clipIndex] : null;
  const hasLinkedVoice = target && view.audioPlan?.clips.some(clip => clip.kind === 'source' && clip.linkedVideoClipId === target.clipId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(0);
  // A lost reply must retry exactly the same request, even if the workspace has refreshed meanwhile.
  const pendingEdit = useRef<Record<string, unknown> | null>(null);
  const [locked, setLocked] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState('');
  const [lengthText, setLengthText] = useState<string | null>(null);
  const [sourceInUs, setSourceInUs] = useState(0);
  const [protectAction, setProtectAction] = useState(false);
  const [actionStart, setActionStart] = useState('');
  const [actionEnd, setActionEnd] = useState('');
  const [sound, setSound] = useState<'mute' | 'source'>('mute');
  const [speech, setSpeech] = useState<SpeechDraft[]>([{ text: '', start: '', end: '' }]);
  const [speechConfirmed, setSpeechConfirmed] = useState(false);
  const [replaceNarrationIds, setReplaceNarrationIds] = useState<string[]>([]);
  const previousSpeech = target ? view.sourceSpeechByClipId?.[target.clipId] ?? [] : [];
  const lengthValue = lengthText ?? String(Math.min(3, Math.floor(duration * FPS) / FPS));
  const insertFrames = Math.round(Number(lengthValue) * FPS);
  const sourceLengthUs = target ? target.sourceEndUs - target.sourceStartUs
    : Number.isFinite(insertFrames) ? Math.round(insertFrames * 1e6 / FPS) : 0;
  const timelineStartUs = target?.timelineStartUs ?? (edit.type === 'insert'
    ? edit.timelineStartUs ?? view.clips.find(clip => clip.clipId === edit.afterClipId)?.timelineEndUs ?? 0 : 0);
  const narrationOverlaps = (view.audioPlan?.clips ?? []).filter(clip => clip.kind === 'narration'
    && clip.timelineStartUs < timelineStartUs + sourceLengthUs && clip.timelineEndUs > timelineStartUs).map(clip => {
    const words = view.narrationSpeechByClipId?.[clip.id] ?? [];
    return { ...clip, text: words.map(word => word.text).join(''), replaceable: words.length > 0
      && words.every(word => word.startUs >= clip.sourceInUs && word.endUs <= clip.sourceOutUs)
      && clip.timelineStartUs >= timelineStartUs && clip.timelineEndUs <= timelineStartUs + sourceLengthUs };
  });
  const narrationConflict = narrationOverlaps.some(clip => !clip.replaceable || !replaceNarrationIds.includes(clip.id));
  const protectedRange = protectAction ? { inUs: Math.round(Number(actionStart) * 1e6), outUs: Math.round(Number(actionEnd) * 1e6) } : null;
  const invalidProtection = protectedRange && (!actionStart.trim() || !actionEnd.trim()
    || !Number.isSafeInteger(protectedRange.inUs) || !Number.isSafeInteger(protectedRange.outUs)
    || protectedRange.inUs < sourceInUs || protectedRange.outUs > sourceInUs + sourceLengthUs
    || protectedRange.inUs >= protectedRange.outUs);
  const segments = speech.map(segment => ({ text: segment.text.trim(),
    startUs: Math.round(Number(segment.start) * 1e6), endUs: Math.round(Number(segment.end) * 1e6) }));
  const invalidSpeech = segments.some((segment, i) => !/[\p{L}\p{N}]/u.test(segment.text)
    || !speech[i].start.trim() || !speech[i].end.trim()
    || !Number.isSafeInteger(segment.startUs) || !Number.isSafeInteger(segment.endUs)
    || segment.startUs < sourceInUs || segment.endUs > sourceInUs + sourceLengthUs || segment.startUs >= segment.endUs
    || (i > 0 && segment.startUs < segments[i - 1].endUs)) || segments.reduce((sum, segment) => sum + segment.text.length, 0) > 20_000;
  const editSpeech = (index: number, patch: Partial<SpeechDraft>) => {
    setSpeech(current => current.map((segment, i) => i === index ? { ...segment, ...patch } : segment));
    setSpeechConfirmed(false);
  };
  const flushSeek = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState === 0 || video.seeking || pendingSeek.current === null) return;
    const sec = pendingSeek.current; pendingSeek.current = null;
    if (Math.abs(video.currentTime - sec) > 1e-6) video.currentTime = sec;
  }, []);
  useEffect(() => {
    const video = videoRef.current;
    let frame = 0;
    const onSeeked = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(flushSeek); };
    video?.addEventListener('seeked', onSeeked);
    return () => { cancelAnimationFrame(frame); video?.removeEventListener('seeked', onSeeked); };
  }, [flushSeek]);
  const tooShort = duration > 0 && Math.floor(duration * FPS) < sourceLengthUs * FPS / 1e6 - 1e-5;
  const blocked = !view.editable || !duration || sourceLengthUs < 500_000 || tooShort || (!!hasLinkedVoice && sound === 'mute');

  return <section aria-label="人工素材取用" className="flex h-full min-h-0 w-full flex-col gap-1 bg-surface">
    <p className="shrink-0 px-2 text-xs text-ink-secondary">
      {edit.type === 'replace' ? '选择替换画面，镜头长度不变。' : '选择插入画面。'}
      {sound === 'mute' ? '新素材原声静音，已有配音保持原位。' : '试听新原片，写下实际台词和时间；保存时一起更新声音与字幕。'}
    </p>
    <fieldset disabled={locked} className="flex shrink-0 gap-4 px-2 text-xs text-ink">
      <legend className="sr-only">新素材声音</legend>
      {([['mute', '静音'], ['source', '保留原声']] as const).map(([value, label]) => <label key={value} className="flex items-center gap-1">
        <input type="radio" name={`manual-media-sound-${requestKey}`} checked={sound === value} onChange={() => {
          setSound(value); setSpeechConfirmed(false);
          if (videoRef.current) videoRef.current.muted = value === 'mute';
        }} />{label}</label>)}
    </fieldset>
    <div className={`min-h-0 flex-1 ${sound === 'source' ? 'grid grid-cols-2 gap-2' : ''}`}>
      <div className="h-full min-h-0 min-w-0">
      <LutVideoPlayer src={`/api/live-mixcut/assets/${encodeURIComponent(asset.assetId)}/preview?projectId=${encodeURIComponent(projectId)}`}
        videoRef={videoRef} ariaLabel={`完整素材：${asset.displayName}`} className="h-full w-full" poster={asset.thumbnailUrl}
        lut={asset.lutId ? { lutId: asset.lutId, url: `/api/live-mixcut/luts/${encodeURIComponent(asset.lutId)}/file?projectId=${encodeURIComponent(projectId)}` } : null}
        onLoadedMetadata={event => {
          event.currentTarget.muted = sound === 'mute';
          setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
          flushSeek();
        }} onError={() => { setDuration(0); setError('源视频加载失败，请检查素材是否可用。'); }} />
      </div>
      {sound === 'source' && <div className="min-h-0 overflow-y-auto pr-2 text-xs text-ink-secondary" aria-label="原声台词填写">
        {previousSpeech.length > 0 && <div className="mb-2 rounded border border-hairline p-2">
          <p className="font-medium text-ink">替换前台词</p>
          <p>{previousSpeech.map(segment => segment.text).join('')}</p>
        </div>}
        <p className="mb-2">按新原片的秒数填写完整话语，须落在下方取用区间内。字幕使用你填写的时间。</p>
        <fieldset disabled={locked} className="space-y-2">
          <legend className="sr-only">新原片实际台词</legend>
          {narrationOverlaps.length > 0 && <div className="space-y-2 rounded border border-hairline p-2">
            <p className="font-medium text-ink">这里已有配音</p>
            <p>勾选要由新口播替代的配音。想保留配音，请返回成片调整声音位置，或选择静音画面。</p>
            {narrationOverlaps.map(clip => <div key={clip.id}>
              <label className="flex items-start gap-1 text-ink"><input type="checkbox" disabled={!clip.replaceable}
                aria-label={`替代这段配音：${clip.text || '台词不可用'}`} checked={replaceNarrationIds.includes(clip.id)} onChange={event => {
                  setReplaceNarrationIds(current => event.target.checked ? [...current, clip.id] : current.filter(id => id !== clip.id));
                  setSpeechConfirmed(false);
                }} /><span>{clip.text || '未能读取配音台词'}<br />正文 {(clip.timelineStartUs / 1e6).toFixed(3)}–{(clip.timelineEndUs / 1e6).toFixed(3)} 秒</span></label>
              {!clip.replaceable && <p className="text-warn">须完整覆盖这段配音及话语；请先在配音轨道按完整话语分割，或调整画面。</p>}
            </div>)}
            {narrationConflict && <p className="text-warn">还有配音会与新原声重叠，请先选择替代或返回调整。</p>}
          </div>}
          {speech.map((segment, index) => <div key={index} className="space-y-1 rounded border border-hairline p-2">
            <label className="block">实际台词 {index + 1}
              <textarea className={`${speechField} mt-1 w-full`} rows={2} aria-label={`实际台词 ${index + 1}`} maxLength={20_000}
                value={segment.text} onChange={event => editSpeech(index, { text: event.target.value })} /></label>
            <div className="grid grid-cols-2 gap-2">
              <label>开始（秒）<input type="number" min={0} step="0.001" className={`${speechField} w-full`}
                aria-label={`台词 ${index + 1} 开始秒`} value={segment.start} onChange={event => editSpeech(index, { start: event.target.value })} /></label>
              <label>结束（秒）<input type="number" min={0} step="0.001" className={`${speechField} w-full`}
                aria-label={`台词 ${index + 1} 结束秒`} value={segment.end} onChange={event => editSpeech(index, { end: event.target.value })} /></label>
            </div>
            <div className="flex flex-wrap gap-1">
              <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={!duration} onClick={() => {
                if (videoRef.current) editSpeech(index, { start: videoRef.current.currentTime.toFixed(3) });
              }}>播放位置作起点</button>
              <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={!duration} onClick={() => {
                if (videoRef.current) editSpeech(index, { end: videoRef.current.currentTime.toFixed(3) });
              }}>播放位置作终点</button>
              <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={speech.length === 1} aria-label={`移除台词 ${index + 1}`} onClick={() => {
                setSpeech(current => current.filter((_, i) => i !== index)); setSpeechConfirmed(false);
              }}>移除</button>
            </div>
          </div>)}
          <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={speech.length >= 1000} onClick={() => {
            setSpeech(current => [...current, { text: '', start: '', end: '' }]); setSpeechConfirmed(false);
          }}>添加一句台词</button>
          {invalidSpeech && <p className="text-warn">请填齐台词和起止时间，按先后排列、不重叠，且完整落在取用区间内。</p>}
          <label className="flex items-start gap-1 text-ink"><input type="checkbox" checked={speechConfirmed} onChange={event => setSpeechConfirmed(event.target.checked)} />
            我已试听，确认实际台词和时间正确{previousSpeech.length ? '，且可以替代上面的旧台词' : ''}{replaceNarrationIds.length ? '，并能替代所选配音' : ''}。</label>
        </fieldset>
      </div>}
    </div>
    {hasLinkedVoice && sound === 'mute' && <p role="alert" className="shrink-0 px-2 text-xs text-warn">原镜头含需要保留的台词，不能静音换片。请选择「保留原声」，试听新片并核对台词。</p>}
    {tooShort && <p role="alert" className="shrink-0 px-2 text-xs text-warn">{target ? '新素材长度不足以替换这段镜头，请换一条更长的素材。' : '取用时长超过源视频，请缩短时长。'}</p>}
    {!target && <label className="flex shrink-0 items-center gap-2 px-2 text-xs text-ink-secondary">
      取用时长（秒）
      <input type="number" min={0.5} max={duration || undefined} step="any" aria-label="取用时长（秒）"
        className="w-20 rounded border border-hairline bg-surface px-2 py-1 text-ink" value={lengthValue} disabled={locked || !duration}
        onChange={event => {
          setLengthText(event.target.value); setSourceInUs(0); setSpeechConfirmed(false); setReplaceNarrationIds([]);
          pendingSeek.current = 0; videoRef.current?.pause(); flushSeek();
        }} />
      <span>{sourceLengthUs >= 500_000 ? `实际取用 ${(sourceLengthUs / 1e6).toFixed(3)} 秒` : '至少取用 0.5 秒'}</span>
    </label>}
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-ink-secondary">
      <label className="flex items-center gap-1"><input type="checkbox" checked={protectAction} disabled={locked}
        onChange={event => {
          setProtectAction(event.target.checked);
          if (event.target.checked) { setActionStart(String(sourceInUs / 1e6)); setActionEnd(String((sourceInUs + sourceLengthUs) / 1e6)); }
        }} />保护一段完整动作</label>
      {protectAction && <>
        <label>开始 <input type="number" step="any" min={0} aria-label="动作开始（源视频秒）" value={actionStart} disabled={locked}
          className="w-20 rounded border border-hairline bg-surface px-1 text-ink" onChange={event => setActionStart(event.target.value)} /></label>
        <label>结束 <input type="number" step="any" min={0} aria-label="动作结束（源视频秒）" value={actionEnd} disabled={locked}
          className="w-20 rounded border border-hairline bg-surface px-1 text-ink" onChange={event => setActionEnd(event.target.value)} /></label>
        <span>按源视频秒数填写，后续修剪会保留这段动作。</span>
      </>}
    </div>
    {invalidProtection && <p role="alert" className="shrink-0 px-2 text-xs text-warn">动作的开始须早于结束，并完整落在取用区间内。</p>}
    <TrimEditor key={sourceLengthUs} compact clip={{ sourceInFrame: 0, sourceOutFrame: sourceLengthUs * FPS / 1e6 }}
      clipIndex={clipIndex} asset={{ durationUs: Math.round(duration * 1e6), thumbnailUrl: asset.thumbnailUrl }}
      disabled={blocked} selectionDisabled={locked} commitDisabled={!!invalidProtection || (sound === 'source' && (invalidSpeech || !speechConfirmed || narrationConflict))} onClose={onClose}
      commitLabel={locked && error ? '重试保存' : `${edit.type === 'replace' ? '替换' : '插入'}画面并${sound === 'source' ? '保留原声' : '静音'}`}
      onPreview={sec => { setSourceInUs(Math.round(sec * 1e6)); setSpeechConfirmed(false); videoRef.current?.pause(); pendingSeek.current = sec; flushSeek(); }}
      onCommit={async startFrame => {
        videoRef.current?.pause(); setError(''); setLocked(true);
        const inUs = Math.round(startFrame / FPS * 1e6);
        pendingEdit.current ??= { ...edit, requestKey, expectedEditRevision: view.editRevision,
          expectedOutputVersionId: view.outputVersionId,
          formulaMedia: { contentFingerprint: asset.contentFingerprint, inUs, outUs: inUs + sourceLengthUs,
            protected: protectedRange, sound, segments: sound === 'source' ? segments : [], confirmed: true,
            ...(sound === 'source' ? { speechConfirmed, replaceNarrationClipIds: replaceNarrationIds } : {}) } };
        try {
          const saved = await onApply(view.planId, pendingEdit.current, view);
          if (!saved) throw new Error('未能确认保存结果');
          return true;
        } catch (cause) {
          setError(`${cause instanceof Error ? cause.message : '未能确认保存结果'}。可重试同一次保存；若成片已更新，请返回成片后重新选择。`);
          return false;
        }
      }} />
    {error && <p role="alert" className="shrink-0 px-2 text-xs text-fail">{error}</p>}
  </section>;
}
