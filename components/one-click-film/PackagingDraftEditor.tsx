'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '@/lib/media-core/render-contract';
import { clamp, DEFAULT_SUBTITLE_POSITION, parsePosition, STICKERS, type Position, type StickerCue } from '@/lib/one-click-film/packaging-edit';
import type { PackagingOptions, PackagingRecord, TextCue } from '@/lib/one-click-film/packaging';
import { ONE_CLICK_FILM_TEMPLATE_IDS, ONE_CLICK_FILM_TEMPLATE_LABELS } from '@/lib/one-click-film/packaging-constants';
import { PackagingTimeline, type PackagingTrack, type TimelineClip } from './PackagingTimeline';
import { useShotThumbnails } from './useShotThumbnails';
import styles from './one-click-film.module.css';

export type PackagingMedia = {
  url: string;
  durationSec: number;
  shots: Array<{ id: string; index: number; startUs: number; endUs: number }>;
};
type Tab = 'subtitle' | 'packaging' | 'sticker' | 'music';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'subtitle', label: '字幕' }, { id: 'packaging', label: '花字包装' },
  { id: 'sticker', label: '贴纸' }, { id: 'music', label: '配乐' },
];
const frameSec = 1 / FINAL_EDIT_FPS;

function activeAt<T extends Pick<TextCue, 'startSec' | 'endSec'>>(rows: T[], position: number) {
  return rows.find((cue) => position >= cue.startSec && position < cue.endSec);
}

export function PackagingDraftEditor({ projectId, draft, media, tracks, busy, onChange, onRecognize }: {
  projectId: string;
  draft: PackagingRecord;
  media: PackagingMedia;
  tracks: Array<{ id: string; name: string }>;
  busy: boolean;
  onChange: (next: PackagingRecord) => void;
  onRecognize: () => void;
}) {
  const offset = draft.options.cover ? FINAL_EDIT_INTRO_FRAMES / FINAL_EDIT_FPS : 0;
  const duration = media.durationSec + offset;
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [size, setSize] = useState({ width: 540, height: 720 });
  const [tab, setTab] = useState<Tab>('packaging');
  const [selected, setSelected] = useState('');
  const [overlay, setOverlay] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [coverField, setCoverField] = useState('title');
  const frame = useRef<HTMLIFrameElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const music = useRef<HTMLAudioElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const time = useRef(0);
  const positionDrag = useRef<{ pointer: number; x: number; y: number; origin: Position; width: number; height: number } | null>(null);
  const captionText = useRef<HTMLTextAreaElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const pointInput = useRef<HTMLInputElement>(null);

  // Only the HyperFrames inputs reload the iframe. Subtitle and sticker edits draw immediately above/below it.
  const overlayInput = JSON.stringify({
    action: 'preview', entryCode: draft.entryCode, title: draft.title, pointCues: draft.pointCues,
    options: { template: draft.template, cover: draft.options.cover, decoration: draft.options.decoration,
      layouts: draft.options.layouts, coverText: draft.options.coverText },
  });
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/one-click-film/${projectId}/packaging`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: overlayInput, signal: abort.signal,
        });
        const payload = await response.json() as { html?: string; message?: string };
        if (!response.ok) throw new Error(payload.message || '包装图层准备失败');
        setOverlay(payload.html ?? '');
        setPreviewError('');
      } catch (cause) {
        if (!abort.signal.aborted) setPreviewError(cause instanceof Error ? cause.message : String(cause));
      }
    }, 160);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [projectId, overlayInput]);

  const syncOverlay = useCallback(() => {
    const win = frame.current?.contentWindow as (Window & {
      __timelines?: { overlay?: { seek: (seconds: number) => void } };
      __editMode?: { active: boolean; only: string | null };
    }) | null;
    if (!win) return;
    win.__editMode = { active: !playing && !busy && tab === 'packaging', only: selected.startsWith('point:')
      ? `cue:${selected.slice('point:'.length)}` : null };
    win.__timelines?.overlay?.seek(time.current);
  }, [playing, busy, tab, selected]);
  useEffect(() => { syncOverlay(); }, [position, syncOverlay]);

  const updateOptions = (patch: Partial<PackagingOptions>) =>
    onChange({ ...draft, options: { ...draft.options, ...patch } });
  useEffect(() => {
    const handle = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== location.origin) return;
      const data = event.data;
      if (!data || typeof data.id !== 'string') return;
      const section = data.id.startsWith('cover:') ? 'cover' : data.id.startsWith('cue:') ? 'cues' : null;
      if (!section) return;
      const id = data.id.slice(data.id.indexOf(':') + 1);
      if (data.type === 'packaging:layout') {
        const center = parsePosition(data.layout);
        if (!center || !Number.isFinite(data.layout.scale)) return;
        const layouts = draft.options.layouts ?? {};
        const templateLayout = layouts[draft.template] ?? {};
        onChange({ ...draft, options: { ...draft.options, layouts: {
          ...layouts, [draft.template]: { ...templateLayout, [section]: {
            ...templateLayout[section], [id]: { ...center, scale: data.layout.scale, rotate: data.layout.rotate },
          } },
        } } });
      }
      if (data.type === 'packaging:text') {
        setTab('packaging');
        setSelected(section === 'cover' ? 'cover' : `point:${id}`);
        if (section === 'cover' && ['title', 'subtitle', 'point1', 'point2', 'point3'].includes(id)) setCoverField(id);
        requestAnimationFrame(() => (section === 'cover' ? coverInput : pointInput).current?.focus());
      }
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [draft, onChange]);

  const musicId = draft.options.bgm ? draft.options.bgmId || tracks[0]?.id : undefined;
  const seek = (value: number) => {
    const next = clamp(value, 0, duration);
    video.current?.pause();
    music.current?.pause();
    if (video.current?.readyState) video.current.currentTime = clamp(next - offset, 0, media.durationSec);
    time.current = next;
    setPlaying(false);
    setPosition(next);
  };
  const togglePlay = () => {
    if (playing) { seek(time.current); return; }
    if (time.current >= duration - frameSec / 2) seek(0);
    const audio = music.current;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = time.current % audio.duration;
      audio.volume = draft.options.bgmVolume / 100;
      void audio.play().catch(() => {});
    }
    setPreviewError('');
    setPlaying(true);
  };
  useEffect(() => {
    if (!playing) return;
    const element = video.current;
    if (!element) return;
    const origin = time.current;
    let started: number | null = null;
    let bodyPlaying = origin >= offset;
    let animation = 0;
    const playBody = () => { void element.play().catch(() => { setPlaying(false); setPreviewError('正文视频暂时无法播放'); }); };
    if (bodyPlaying) playBody();
    const tick = (now: number) => {
      started ??= now;
      if (!bodyPlaying) {
        time.current = Math.min(offset, origin + (now - started) / 1000);
        if (time.current >= offset) { bodyPlaying = true; playBody(); }
      } else {
        time.current = Math.min(duration, offset + element.currentTime);
      }
      setPosition(time.current);
      if (element.ended || time.current >= duration) { setPlaying(false); return; }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    const background = music.current;
    return () => { cancelAnimationFrame(animation); element.pause(); background?.pause(); };
  }, [playing, offset, duration]);

  const bodyTime = Math.round((position - offset) * 1e6) / 1e6;
  const caption = draft.options.subtitles ? activeAt(draft.subtitleCues, bodyTime) : undefined;
  const stickers = draft.options.stickers ?? [];
  const selectedSubtitle = draft.subtitleCues.find((cue) => selected === `subtitle:${cue.id}`);
  const selectedPoint = draft.pointCues.find((cue) => selected === `point:${cue.id}`);
  const selectedSticker = stickers.find((cue) => selected === `sticker:${cue.id}`);
  const positionOfSubtitle = draft.options.subtitlePosition ?? DEFAULT_SUBTITLE_POSITION;
  const moveOnCanvas = (event: PointerEvent<HTMLButtonElement>, origin: Position, callback: (next: Position) => void) => {
    const gesture = positionDrag.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    callback({ x: clamp(origin.x + (event.clientX - gesture.x) / gesture.width * 100, 0, 100),
      y: clamp(origin.y + (event.clientY - gesture.y) / gesture.height * 100, 0, 100) });
  };
  const startCanvasDrag = (event: PointerEvent<HTMLButtonElement>, origin: Position, target: Tab, id: string) => {
    if (event.button !== 0 || busy) return;
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    positionDrag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, origin, width: bounds.width, height: bounds.height };
    seek(time.current);
    setSelected(id);
    setTab(target);
  };
  const stopDrag = () => { positionDrag.current = null; };

  const thumbnail = useShotThumbnails(media.url, media.shots.map((shot) => Math.round((shot.startUs + shot.endUs) / 2)).join(','));
  const cueClip = (cue: TextCue, prefix: string): TimelineClip => ({
    id: `${prefix}:${cue.id}`, text: cue.text, start: cue.startSec + offset, end: Math.min(duration, cue.endSec + offset), editable: !busy,
  });
  const rows: PackagingTrack[] = [
    { kind: 'subtitle', label: '字幕', start: offset, clips: draft.options.subtitles ? draft.subtitleCues.map((cue) => cueClip(cue, 'subtitle')) : [] },
    { kind: 'packaging', label: '花字包装', start: offset, clips: [
      ...(offset ? [{ id: 'cover', text: '封面', start: 0, end: offset }] : []),
      ...(draft.options.decoration ? draft.pointCues.map((cue) => cueClip(cue, 'point')) : []),
    ] },
    { kind: 'sticker', label: '贴纸', start: offset, clips: stickers.map((cue) => cueClip({ ...cue, text: STICKERS[cue.kind].label }, 'sticker')) },
    { kind: 'picture', label: '主画面', clips: media.shots.map((shot) => ({
      id: shot.id, text: `镜头 ${String(shot.index).padStart(2, '0')}`, start: offset + shot.startUs / 1e6,
      end: Math.min(duration, offset + shot.endUs / 1e6), image: thumbnail(Math.round((shot.startUs + shot.endUs) / 2)),
    })) },
    { kind: 'voice', label: '原声／旁白', clips: [{ id: 'voice', text: '正文声音', start: offset, end: duration }] },
    { kind: 'music', label: '配乐', clips: musicId ? [{ id: 'music', text: tracks.find((track) => track.id === musicId)?.name ?? '配乐', start: 0, end: duration }] : [] },
  ];

  const selectedText = tab === 'subtitle' ? selectedSubtitle : selectedPoint;
  const updateSubtitleText = (cue: TextCue, text: string) => onChange({
    ...draft, subtitleCues: draft.subtitleCues.map((item) => item.id === cue.id ? { ...item, text } : item),
  });
  const canSplit = selectedSubtitle && bodyTime - selectedSubtitle.startSec >= frameSec && selectedSubtitle.endSec - bodyTime >= frameSec;
  const split = () => {
    if (!selectedSubtitle || !canSplit || busy) return;
    const chars = Array.from(selectedSubtitle.text);
    if (chars.length < 2) return;
    const at = Math.round(bodyTime * FINAL_EDIT_FPS) / FINAL_EDIT_FPS;
    if (at - selectedSubtitle.startSec < frameSec - 0.000001 || selectedSubtitle.endSec - at < frameSec - 0.000001) return;
    const index = clamp(Math.round(chars.length * (at - selectedSubtitle.startSec) / (selectedSubtitle.endSec - selectedSubtitle.startSec)), 1, chars.length - 1);
    const right = { ...selectedSubtitle, id: crypto.randomUUID(), startSec: at, text: chars.slice(index).join('') };
    const left = { ...selectedSubtitle, endSec: at, text: chars.slice(0, index).join('') };
    onChange({ ...draft, subtitleCues: draft.subtitleCues.flatMap((cue) => cue.id === left.id ? [left, right] : [cue]) });
    setSelected(`subtitle:${right.id}`);
  };
  const addSticker = (kind: StickerCue['kind']) => {
    const startSec = clamp(bodyTime, 0, Math.max(0, media.durationSec - frameSec));
    const sticker = { id: crypto.randomUUID(), kind, startSec, endSec: Math.min(media.durationSec, startSec + 2), x: 75, y: 24 };
    updateOptions({ stickers: [...stickers, sticker] });
    setSelected(`sticker:${sticker.id}`);
    seek(startSec + offset);
  };

  return <div className={styles.draftEditor} onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      split();
    }
  }}>
    <div className={styles.draftCenter}>
      <div className={styles.draftMonitor}>
        <div className={styles.draftCanvas} ref={canvas} style={{ aspectRatio: size.width / size.height }}>
          <video ref={video} src={media.url} aria-label={`${draft.entryCode} 编辑预览`} playsInline preload="auto"
            onLoadedMetadata={(event) => {
              const element = event.currentTarget;
              if (element.videoWidth && element.videoHeight) setSize({ width: element.videoWidth, height: element.videoHeight });
            }} onError={() => setPreviewError('正文视频无法加载')} />
          {stickers.filter((cue) => bodyTime >= cue.startSec && bodyTime < cue.endSec).map((cue) =>
            <button key={cue.id} type="button" className={styles.previewSticker} data-active={selected === `sticker:${cue.id}`}
              style={{ left: `${cue.x}%`, top: `${cue.y}%` }} aria-label={`移动${STICKERS[cue.kind].label}贴纸`}
              onPointerDown={(event) => startCanvasDrag(event, cue, 'sticker', `sticker:${cue.id}`)}
              onPointerMove={(event) => moveOnCanvas(event, positionDrag.current?.origin ?? cue,
                (next) => updateOptions({ stickers: stickers.map((item) => item.id === cue.id ? { ...item, ...next } : item) }))}
              onPointerUp={stopDrag} onPointerCancel={stopDrag}>
              <svg viewBox="-15 -15 30 30" aria-hidden="true"><path d={STICKERS[cue.kind].path} fill={STICKERS[cue.kind].fill} /></svg>
            </button>)}
          {overlay ? <iframe ref={frame} srcDoc={overlay} title="可编辑包装图层" onLoad={syncOverlay}
            className={styles.draftOverlay} data-editable={!playing && !busy && tab === 'packaging'} /> : null}
          {caption ? <button type="button" className={styles.previewCaption} data-active={selected === `subtitle:${caption.id}`}
            style={{ left: `${positionOfSubtitle.x}%`, top: `${positionOfSubtitle.y}%` }}
            onPointerDown={(event) => startCanvasDrag(event, positionOfSubtitle, 'subtitle', `subtitle:${caption.id}`)}
            onPointerMove={(event) => moveOnCanvas(event, positionDrag.current?.origin ?? positionOfSubtitle,
              (next) => updateOptions({ subtitlePosition: next }))}
            onPointerUp={stopDrag} onPointerCancel={stopDrag}
            onDoubleClick={() => captionText.current?.focus()} aria-label="移动画面字幕">{caption.text}</button> : null}
        </div>
      </div>
      {musicId ? <audio ref={music} src={`/api/final-edit-bgm/${encodeURIComponent(musicId)}/file`} preload="auto" loop /> : null}
      <div className={styles.inlineActions}>
        <button type="button" className="cap" disabled={busy} onClick={togglePlay}>{playing ? '暂停预览' : '播放完整预览'}</button>
        {previewError ? <span className={styles.hintFail} role="alert">{previewError}</span> : null}
      </div>
      <PackagingTimeline tracks={rows} duration={duration} position={position} selected={selected} onSeek={seek}
        onPick={(kind, clip) => {
          setSelected(clip.id);
          if (kind === 'subtitle' || kind === 'packaging' || kind === 'sticker' || kind === 'music') setTab(kind);
          seek(clip.start);
        }}
        onRange={(kind, clip, range, at) => {
          const key = clip.id.slice(clip.id.indexOf(':') + 1);
          const times = { startSec: Math.max(0, range.start - offset), endSec: range.end - offset };
          if (kind === 'subtitle') onChange({ ...draft, subtitleCues: draft.subtitleCues.map((cue) => cue.id === key ? { ...cue, ...times } : cue) });
          if (kind === 'packaging') onChange({ ...draft, pointCues: draft.pointCues.map((cue) => cue.id === key ? { ...cue, ...times } : cue) });
          if (kind === 'sticker') updateOptions({ stickers: stickers.map((cue) => cue.id === key ? { ...cue, ...times } : cue) });
          seek(at);
        }} />
    </div>
    <aside className={styles.reviewRight} aria-label="包装属性">
      <div className={styles.inlineActions} role="tablist" aria-label="包装图层">
        {TABS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
          className={`cap${tab === item.id ? ' cap-primary' : ''}`} onClick={() => {
            setTab(item.id);
            if (item.id === 'subtitle' && !selectedSubtitle && draft.subtitleCues[0]) {
              setSelected(`subtitle:${draft.subtitleCues[0].id}`);
              seek(draft.subtitleCues[0].startSec + offset);
            }
            if (item.id === 'packaging' && !selectedPoint) { setSelected('cover'); if (offset) seek(0); }
          }}>{item.label}</button>)}
      </div>
      {tab === 'subtitle' ? <>
        <label className={styles.editRow}>显示口播字幕<input type="checkbox" checked={draft.options.subtitles}
          onChange={(event) => updateOptions({ subtitles: event.target.checked })} /></label>
        {draft.options.subtitles && !draft.subtitlesPrepared ? <p className={styles.hint}>当前显示脚本字幕，可先识别实际口播并对时。</p> : null}
        {selectedText ? <label className={styles.editRow}>当前字幕
          <textarea ref={captionText} className="input-field" value={selectedText.text} maxLength={60}
            onChange={(event) => updateSubtitleText(selectedText, event.target.value)} />
        </label> : <p className={styles.hint}>点选时间轴上的字幕即可改字。</p>}
        <div className={styles.inlineActions}>
          <button type="button" className="cap" disabled={busy || !canSplit} onClick={split}>在播放头处分割</button>
          <button type="button" className="cap" disabled={busy} onClick={() => updateOptions({ subtitlePosition: DEFAULT_SUBTITLE_POSITION })}>恢复字幕位置</button>
          <button type="button" className="cap" disabled={busy || !draft.options.subtitles} onClick={onRecognize}>
            {draft.subtitlesPrepared ? '重新识别口播' : '识别口播字幕'}
          </button>
        </div>
      </> : null}
      {tab === 'packaging' ? <>
        <label className={styles.editRow}>本条模板<select className="input-field" value={draft.template} onChange={(event) => {
          const template = event.target.value as PackagingRecord['template'];
          onChange({ ...draft, template, options: { ...draft.options, template } });
        }}>{ONE_CLICK_FILM_TEMPLATE_IDS.map((item) => <option key={item} value={item}>{ONE_CLICK_FILM_TEMPLATE_LABELS[item]}</option>)}</select></label>
        <div className={styles.inlineActions}>
          <label><input type="checkbox" checked={draft.options.cover} onChange={(event) => { seek(0); updateOptions({ cover: event.target.checked }); }} /> 封面</label>
          <label><input type="checkbox" checked={draft.options.decoration} onChange={(event) => updateOptions({ decoration: event.target.checked })} /> 花字</label>
        </div>
        {selectedPoint ? <label className={styles.editRow}>当前花字<input ref={pointInput} className="input-field" maxLength={60}
          value={selectedPoint.text} onChange={(event) => onChange({ ...draft, pointCues: draft.pointCues.map((cue) =>
            cue.id === selectedPoint.id ? { ...cue, text: event.target.value } : cue) })} /></label>
          : <label className={styles.editRow}>封面文字
            <select className="input-field" aria-label="封面文字对象" value={coverField} onChange={(event) => setCoverField(event.target.value)}>
              <option value="title">主标题</option><option value="subtitle">副标题</option>
              <option value="point1">卖点 1</option><option value="point2">卖点 2</option><option value="point3">卖点 3</option>
            </select>
            <input ref={coverInput} className="input-field" aria-label={`${draft.entryCode} 标题`} maxLength={60}
              value={coverField === 'title' ? draft.title : draft.options.coverText?.[coverField as 'subtitle' | 'point1' | 'point2' | 'point3'] ?? ''}
              onChange={(event) => {
                if (coverField === 'title') onChange({ ...draft, title: event.target.value });
                else updateOptions({ coverText: { ...draft.options.coverText, [coverField]: event.target.value } });
              }} />
          </label>}
        <p className={styles.hint}>暂停时可在画面拖动或双击改字，花字时长在轨道上调整。</p>
      </> : null}
      {tab === 'sticker' ? <>
        <div className={styles.inlineActions}>{(Object.keys(STICKERS) as Array<StickerCue['kind']>).map((kind) =>
          <button key={kind} type="button" className="cap" disabled={busy || stickers.length >= 24}
            onClick={() => addSticker(kind)}>添加{STICKERS[kind].label}</button>)}</div>
        {selectedSticker ? <button type="button" className="cap" disabled={busy}
          onClick={() => updateOptions({ stickers: stickers.filter((cue) => cue.id !== selectedSticker.id) })}>移除选中贴纸</button> : null}
      </> : null}
      {tab === 'music' ? <>
        <label className={styles.editRow}>启用配乐<input type="checkbox" checked={draft.options.bgm} onChange={(event) => {
          seek(time.current); updateOptions({ bgm: event.target.checked });
        }} /></label>
        <label className={styles.editRow}>配乐<select className="input-field" value={draft.options.bgmId ?? ''} onChange={(event) => {
          seek(time.current); updateOptions({ bgmId: event.target.value });
        }}><option value="">曲库默认</option>{tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</select></label>
        <label className={styles.editRow}>音量 {draft.options.bgmVolume}%<input type="range" min={0} max={100} value={draft.options.bgmVolume}
          onChange={(event) => {
            const bgmVolume = Number(event.target.value);
            if (music.current) music.current.volume = bgmVolume / 100;
            updateOptions({ bgmVolume });
          }} /></label>
      </> : null}
    </aside>
  </div>;
}
