'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '@/lib/media-core/render-contract';
import { clamp, filmCaptionSvg, isUneditedFilmPointSticker, resolveFilmSubtitleStyle, splitFilmCoverTitle, syncFilmPointStickers, STICKERS, type Position } from '@/lib/one-click-film/packaging-edit';
import { applyPackagingStickerEdit, createManualPackagingSticker, MAX_STICKER_INSTANCES, planStickerFramesAtPlayhead, STICKER_MIN_DURATION_FRAMES, type PackagingStickerEditPatch } from '@/lib/media-core/packaging-stickers';
import type { PackagingOptions, PackagingRecord, TextCue } from '@/lib/one-click-film/packaging';
import { resolveFilmCoverMedia, type FilmCoverMedia } from '@/lib/one-click-film/cover-media';
import type { CoverFraming } from '@/lib/media-core/cover-types';
import { FilmCoverAutoControls } from './FilmCoverAutoControls';
import { FilmCoverPanel } from './FilmCoverPanel';
import { FilmCoverFramingPreview } from './FilmCoverFramingPreview';
import { PackagingTimeline, type PackagingTrack, type TimelineClip } from './PackagingTimeline';
import { useShotThumbnails } from './useShotThumbnails';
import { ensureServerFontLoaded } from '@/components/system-fonts';
import BatchTextStyleEditor from '@/components/batch-production/BatchTextStyleEditor';
import { PackagingAppearanceControls } from '@/components/packaging/PackagingAppearanceControls';
import PackagingOverlay from '@/components/packaging/PackagingOverlay';
import { StickerPanel, type StickerAssetChoice } from '@/components/mixcut/StickerPanel';
import { Segmented, ToolbarButton } from '@/components/ui/Appearance';
import { ShotInspector, type FilmReview } from './ReviewStage';
import type { FilmImage, FilmEntry } from './types';
import styles from './one-click-film.module.css';

export type PackagingMedia = {
  url: string;
  durationSec: number;
  sharedFonts: boolean;
  signature: string;
  review: FilmReview;
};
type Tab = 'picture' | 'subtitle' | 'packaging' | 'sticker' | 'music';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'picture', label: '镜头' }, { id: 'subtitle', label: '字幕' }, { id: 'packaging', label: '花字包装' },
  { id: 'sticker', label: '贴纸' }, { id: 'music', label: '配乐' },
];
const frameSec = 1 / FINAL_EDIT_FPS;
const CENTERED_COVER: CoverFraming = { scale: 1, offsetX: 0, offsetY: 0 };

function activeAt<T extends Pick<TextCue, 'startSec' | 'endSec'>>(rows: T[], position: number) {
  return rows.find((cue) => position >= cue.startSec && position < cue.endSec);
}

export function PackagingDraftEditor({ projectId, images, entry, initialShot, draft, media, tracks, busy, onChange, onRecognize, onRefresh, onAdjustSound, onRetryAutoCover }: {
  projectId: string;
  images: FilmImage[];
  entry: FilmEntry;
  initialShot?: string;
  onRefresh: () => Promise<void>;
  onAdjustSound: () => void;
  draft: PackagingRecord;
  media: PackagingMedia;
  tracks: Array<{ id: string; name: string }>;
  busy: boolean;
  onChange: (next: PackagingRecord) => void;
  onRecognize: () => void;
  onRetryAutoCover: () => void;
}) {
  const offset = draft.options.cover ? FINAL_EDIT_INTRO_FRAMES / FINAL_EDIT_FPS : 0;
  const duration = media.durationSec + offset;
  const initial = media.review.shots.find(shot => shot.id === initialShot);
  const [position, setPosition] = useState(initial ? offset + initial.startUs / 1e6 : 0);
  const playUntil = useRef<number | null>(null);
  const [pickedShot, setPickedShot] = useState(initialShot);
  const [playing, setPlaying] = useState(false);
  const [safeArea, setSafeArea] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draggingSticker, setDraggingSticker] = useState(false);
  const [size, setSize] = useState({ width: 540, height: 720 });
  const [tab, setTab] = useState<Tab>(initial ? 'picture' : 'packaging');
  const [selected, setSelected] = useState('');
  const [overlay, setOverlay] = useState('');
  const [coverImage, setCoverImage] = useState('');
  const [coverExpanded, setCoverExpanded] = useState(false);
  const [coverMode, setCoverMode] = useState<'overlay' | 'framing'>('overlay');
  const [previewError, setPreviewError] = useState('');
  const [coverField, setCoverField] = useState('title');
  const monitor = useRef<HTMLDivElement>(null);
  const overlayFrame = useRef<HTMLIFrameElement | null>(null);
  const handleOverlayFrame = useCallback((frame: HTMLIFrameElement | null) => { overlayFrame.current = frame; }, []);
  const video = useRef<HTMLVideoElement>(null);
  const music = useRef<HTMLAudioElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const time = useRef(position);
  const positionDrag = useRef<{ pointer: number; x: number; y: number; origin: Position; width: number; height: number } | null>(null);
  const captionText = useRef<HTMLTextAreaElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const coverPanel = useRef<HTMLDivElement>(null);
  const pointInput = useRef<HTMLInputElement>(null);
  const dragSticker = useRef<StickerAssetChoice | null>(null);
  const pointRequest = useRef<AbortController | null>(null);
  useEffect(() => () => pointRequest.current?.abort(), []);
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === monitor.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [expanded]);

  const toggleFullscreen = async () => {
    if (expanded) { setExpanded(false); return; }
    if (document.fullscreenElement === monitor.current) { await document.exitFullscreen(); return; }
    try {
      if (!monitor.current?.requestFullscreen) { setExpanded(true); return; }
      await monitor.current.requestFullscreen();
    } catch { setExpanded(true); }
  };

  // Only HyperFrames inputs reload the iframe. Captions stay synchronized to the monitor clock.
  const overlayInput = JSON.stringify({
    action: 'preview', entryCode: draft.entryCode, title: draft.title, pointCues: draft.pointCues,
    options: { template: draft.template, cover: draft.options.cover, decoration: draft.options.decoration,
      coverMedia: draft.options.coverMedia,
      titleFont: draft.options.titleFont, subtitleFont: draft.options.subtitleFont, pointFont: draft.options.pointFont,
      layouts: draft.options.layouts, coverText: draft.options.coverText,
      assetStickers: draft.options.assetStickers, stickerDefaults: draft.options.stickerDefaults },
  });
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/one-click-film/${projectId}/packaging`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: overlayInput, signal: abort.signal,
        });
        const payload = await response.json() as { html?: string; coverImage?: string; message?: string };
        if (!response.ok) throw new Error(payload.message || '包装图层准备失败');
        if (abort.signal.aborted) return;
        setOverlay(payload.html ?? '');
        setCoverImage(payload.coverImage ?? '');
        setPreviewError('');
      } catch (cause) {
        if (!abort.signal.aborted) setPreviewError(cause instanceof Error ? cause.message : String(cause));
      }
    }, 160);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [projectId, media.signature, media.url, overlayInput]);

  const updateOptions = (patch: Partial<PackagingOptions>) =>
    onChange({ ...draft, options: { ...draft.options, ...patch } });

  const musicId = draft.options.bgm ? draft.options.bgmId || tracks[0]?.id : undefined;
  const seek = (value: number) => {
    const next = clamp(value, 0, duration);
    video.current?.pause();
    music.current?.pause();
    if (video.current?.readyState) video.current.currentTime = clamp(next - offset, 0, media.durationSec);
    time.current = next;
    playUntil.current = null;
    setPlaying(false);
    setPosition(next);
  };
  const startPlayback = () => {
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
      if (playUntil.current !== null && time.current >= playUntil.current) {
        const end = playUntil.current;
        playUntil.current = null;
        element.currentTime = Math.max(0, end - offset);
        time.current = end;
        setPosition(end);
        setPlaying(false);
        return;
      }
      setPosition(time.current);
      if (element.ended || time.current >= duration) { setPlaying(false); return; }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    const background = music.current;
    return () => { cancelAnimationFrame(animation); element.pause(); background?.pause(); };
  }, [playing, offset, duration, media.url]);

  const bodyTime = Math.round((position - offset) * 1e6) / 1e6;
  const caption = draft.options.subtitles && (draft.subtitlesPrepared || (!playing && tab === 'subtitle'))
    ? activeAt(draft.subtitleCues, bodyTime) : undefined;
  const stickers = draft.options.stickers ?? [];
  const assetStickers = draft.options.assetStickers ?? [];
  const bodyFrames = Math.round(media.durationSec * FINAL_EDIT_FPS);
  const editingCover = offset > 0 && position < offset && !playing;
  const framingMode = editingCover && coverMode === 'framing' && !busy;
  const coverMedia = resolveFilmCoverMedia(draft.options.coverMedia, { frames: bodyFrames, signature: media.signature });
  const coverFraming = coverMedia.framing ?? CENTERED_COVER;
  const coverFramingInput = JSON.stringify({ action: 'cover-framing-source', entryCode: draft.entryCode,
    options: { coverMedia: { ...coverMedia, framing: undefined } } });
  const updateFraming = (framing?: CoverFraming) => updateOptions({ coverMedia: { ...coverMedia, framing } });
  const selectCover = (coverMedia?: FilmCoverMedia) => {
    const automatic = draft.autoCover?.sourceSignature === media.signature ? draft.autoCover.media : undefined;
    const selected = coverMedia ?? automatic
      ?? { kind: 'auto_frame', frame: 0, sourceSignature: media.signature, fallback: true };
    onChange({ ...draft, coverFrameClamped: false, options: { ...draft.options, coverMedia: selected } });
    if (offset) seek(0);
  };
  const takeCurrentCover = () => {
    if (time.current < offset) return;
    const seconds = video.current?.currentTime ?? time.current - offset;
    const frame = clamp(Math.floor(seconds * FINAL_EDIT_FPS + 1e-6), 0, bodyFrames - 1);
    const atUs = Math.round(frame / FINAL_EDIT_FPS * 1e6);
    const shotId = media.review.shots.find(shot => atUs >= shot.startUs && atUs < shot.endUs)?.id;
    selectCover({ kind: 'video_frame', frame, shotId });
  };
  const selectedSubtitle = draft.subtitleCues.find((cue) => selected === `subtitle:${cue.id}`);
  const selectedPoint = draft.pointCues.find((cue) => selected === `point:${cue.id}`);
  const selectedSticker = stickers.find((cue) => selected === `sticker:${cue.id}`);
  const selectedAssetSticker = assetStickers.find(sticker => selected === `asset:${sticker.id}`);
  const subtitleStyle = resolveFilmSubtitleStyle(draft.options.subtitleStyle, draft.options.subtitlePosition);
  useEffect(() => {
    if (media.sharedFonts) void ensureServerFontLoaded(subtitleStyle.fontFamily).catch(() => setPreviewError('字幕预览字体加载失败'));
  }, [media.sharedFonts, subtitleStyle.fontFamily]);
  const changeStyle = (next: typeof subtitleStyle) => updateOptions({ subtitleStyle: next, subtitlePosition: { x: next.x * 100, y: next.y * 100 } });
  const positionOfSubtitle = { x: subtitleStyle.x * 100, y: subtitleStyle.y * 100 };
  const bodyUs = Math.round(bodyTime * 1e6);
  const shot = media.review.shots.find(item => item.id === pickedShot) ?? media.review.shots.find(item => bodyUs >= item.startUs && bodyUs < item.endUs)
    ?? (bodyTime >= media.durationSec ? media.review.shots.at(-1) : media.review.shots[0]);
  const moveOnCanvas = (event: PointerEvent<HTMLButtonElement>, origin: Position, callback: (next: Position) => void) => {
    const gesture = positionDrag.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    callback({ x: clamp(origin.x + (event.clientX - gesture.x) / gesture.width * 100, 4, 96),
      y: clamp(origin.y + (event.clientY - gesture.y) / gesture.height * 100, 4, 96) });
  };
  const startCanvasDrag = (event: PointerEvent<HTMLButtonElement>, origin: Position, target: Tab, id: string) => {
    if (event.button !== 0 || busy || framingMode) return;
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    positionDrag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, origin, width: bounds.width, height: bounds.height };
    seek(time.current);
    setSelected(id);
    setTab(target);
  };
  const stopDrag = () => { positionDrag.current = null; };

  const thumbnail = useShotThumbnails(media.url, media.review.shots.map((shot) => Math.round((shot.startUs + shot.endUs) / 2)).join(','));
  const cueClip = (cue: TextCue, prefix: string): TimelineClip => ({
    id: `${prefix}:${cue.id}`, text: cue.text, start: cue.startSec + offset, end: Math.min(duration, cue.endSec + offset), editable: !busy,
  });
  const rows: PackagingTrack[] = [
    { kind: 'subtitle', label: '字幕', start: offset, clips: draft.options.subtitles ? draft.subtitleCues.map((cue) => cueClip(cue, 'subtitle')) : [] },
    { kind: 'packaging', label: '花字包装', start: offset, clips: [
      ...(offset ? [{ id: 'cover', text: '封面', start: 0, end: offset, image: coverImage || undefined }] : []),
      ...(draft.options.decoration ? draft.pointCues.map((cue) => cueClip(cue, 'point')) : []),
    ] },
    { kind: 'sticker', label: '贴纸', start: offset, clips: [
      ...stickers.map((cue) => cueClip({ ...cue, text: STICKERS[cue.kind].label }, 'sticker')),
      ...assetStickers.filter(sticker => draft.options.decoration || !isUneditedFilmPointSticker(sticker))
        .map((sticker, index) => cueClip({ id: sticker.id, text: `贴纸 ${String(index + 1).padStart(2, '0')}`, startSec: (sticker.startFrame - FINAL_EDIT_INTRO_FRAMES) * frameSec,
        endSec: (sticker.endFrame - FINAL_EDIT_INTRO_FRAMES) * frameSec }, 'asset')),
    ] },
    { kind: 'picture', label: '主画面', clips: media.review.shots.map((shot) => ({
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
  const stickerFrames = planStickerFramesAtPlayhead(bodyTime + FINAL_EDIT_INTRO_FRAMES * frameSec, bodyFrames);
  const addSticker = (choice: StickerAssetChoice, center?: Position) => {
    if (!stickerFrames || assetStickers.length >= MAX_STICKER_INSTANCES) return;
    const sticker = createManualPackagingSticker({ ...stickerFrames, id: crypto.randomUUID(), assetId: choice.asset.id,
      styleMode: choice.styleMode, fixedStyle: choice.fixedStyle, centerXPct: center?.x ?? 25, centerYPct: center?.y ?? 68,
      animation: draft.options.stickerDefaults?.animation ?? 'follow-template' });
    updateOptions({ assetStickers: [...assetStickers, sticker] });
    setSelected(`asset:${sticker.id}`);
    setTab('sticker');
    seek((sticker.startFrame - FINAL_EDIT_INTRO_FRAMES) * frameSec + offset);
  };
  const editSticker = (id: string, patch: PackagingStickerEditPatch) => {
    updateOptions({ assetStickers: assetStickers.map(sticker => sticker.id === id ? applyPackagingStickerEdit(sticker, patch) : sticker) });
    return true;
  };
  const replaceAutomaticStickers = (points: TextCue[]) => syncFilmPointStickers(assetStickers, points, bodyFrames);
  const extractPoints = async () => {
    pointRequest.current?.abort();
    const request = new AbortController();
    pointRequest.current = request;
    try {
      const response = await fetch(`/api/one-click-film/${projectId}/packaging`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: request.signal,
        body: JSON.stringify({ action: 'extract-points', entryCode: draft.entryCode }) });
      const result = await response.json() as { pointCues?: TextCue[]; message?: string };
      if (!response.ok || !result.pointCues) throw new Error(result.message || '无法提取卖点');
      if (request.signal.aborted) return;
      const layouts = Object.fromEntries(Object.entries(draft.options.layouts ?? {}).map(([template, layout]) => [template, { ...layout, cues: {} }]));
      onChange({ ...draft, pointCues: result.pointCues, options: { ...draft.options, layouts, pointCuesEdited: false,
        assetStickers: replaceAutomaticStickers(result.pointCues) } });
      setPreviewError('');
      setSelected(result.pointCues[0] ? `point:${result.pointCues[0].id}` : '');
      seek((result.pointCues[0]?.startSec ?? 0) + offset);
    } catch (error) { if (!request.signal.aborted) setPreviewError(error instanceof Error ? error.message : String(error)); }
  };

  return <div className={styles.draftEditor} onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      split();
    }
  }}>
    <div className={styles.draftCenter}>
      <div className={styles.draftMonitor} ref={monitor} data-expanded={expanded}>
        <div className={styles.draftCanvas} ref={canvas} style={{ aspectRatio: size.width / size.height }}
          onDragOver={event => { if (!framingMode && dragSticker.current) event.preventDefault(); }}
          onDrop={event => {
            const choice = dragSticker.current;
            if (!choice || framingMode) return;
            event.preventDefault();
            dragSticker.current = null;
            setDraggingSticker(false);
            const bounds = event.currentTarget.getBoundingClientRect();
            addSticker(choice, { x: clamp((event.clientX - bounds.left) / bounds.width * 100, 17, 83),
              y: clamp((event.clientY - bounds.top) / bounds.height * 100, 10, 85) });
          }}>
          <video ref={video} src={media.url} aria-label={`${draft.entryCode} 编辑预览`} playsInline preload="auto"
            onLoadedMetadata={(event) => {
              const element = event.currentTarget;
              element.currentTime = clamp(time.current - offset, 0, media.durationSec);
              if (element.videoWidth && element.videoHeight) setSize({ width: element.videoWidth, height: element.videoHeight });
            }} onError={() => setPreviewError('正文视频无法加载')} />
          {offset > 0 && position < offset && coverImage ? (
            // eslint-disable-next-line @next/next/no-img-element -- 草稿封面与服务器取色使用同一图片
            <img className={styles.draftCoverImage} src={coverImage} alt="片头封面底图" />
          ) : null}
          {framingMode ? <FilmCoverFramingPreview key={`${media.url}:${coverFramingInput}`}
            url={`/api/one-click-film/${encodeURIComponent(projectId)}/packaging`} input={coverFramingInput}
            size={size} framing={coverFraming} onChange={updateFraming} onError={setPreviewError} /> : null}
          {stickers.filter((cue) => bodyTime >= cue.startSec && bodyTime < cue.endSec).map((cue) =>
            <button key={cue.id} type="button" className={styles.previewSticker} data-active={selected === `sticker:${cue.id}`}
              style={{ left: `${cue.x}%`, top: `${cue.y}%` }} aria-label={`移动${STICKERS[cue.kind].label}贴纸`}
              onPointerDown={(event) => startCanvasDrag(event, cue, 'sticker', `sticker:${cue.id}`)}
              onPointerMove={(event) => moveOnCanvas(event, positionDrag.current?.origin ?? cue,
                (next) => updateOptions({ stickers: stickers.map((item) => item.id === cue.id ? { ...item, ...next } : item) }))}
              onPointerUp={stopDrag} onPointerCancel={stopDrag}>
              <svg viewBox="-15 -15 30 30" aria-hidden="true"><path d={STICKERS[cue.kind].path} fill={STICKERS[cue.kind].fill} /></svg>
            </button>)}
          {overlay ? <PackagingOverlay srcDoc={overlay} timeSec={position}
            onFrame={handleOverlayFrame}
            editable={!framingMode && !playing && !busy && (editingCover || tab === 'packaging' || tab === 'sticker') && !draggingSticker}
            stickerEditId={!framingMode && !playing && !busy && !draggingSticker && tab === 'sticker' && selectedAssetSticker
              && bodyTime >= (selectedAssetSticker.startFrame - FINAL_EDIT_INTRO_FRAMES) * frameSec
              && bodyTime < (selectedAssetSticker.endFrame - FINAL_EDIT_INTRO_FRAMES) * frameSec ? selectedAssetSticker.id : ''}
            onLayout={(key, layout) => {
              if (layout && ![layout.x, layout.y, layout.scale].every(Number.isFinite)) return;
              const section = key.startsWith('cover:') ? 'cover' : 'cues';
              const id = key.slice(key.indexOf(':') + 1);
              const layouts = draft.options.layouts ?? {};
              const template = layouts[draft.template] ?? {};
              const elements = { ...template[section] };
              if (layout) {
                const root = overlayFrame.current?.contentDocument?.getElementById('root');
                const box = Array.from(root?.querySelectorAll<HTMLElement>('[data-point-id]') ?? []).find(el => el.dataset.pointId === key);
                const rootRect = root?.getBoundingClientRect();
                const rect = box?.getBoundingClientRect();
                const width = rootRect?.width && rect ? rect.width / rootRect.width * 100 : 32;
                const height = rootRect?.height && rect ? rect.height / rootRect.height * 100 : 10;
                const fit = Math.min(1, 92 / width, 92 / height);
                const xInset = 4 + width * fit / 2;
                const yInset = 4 + height * fit / 2;
                elements[id] = { ...layout, scale: layout.scale * fit, x: clamp(layout.x, xInset, 100 - xInset),
                  y: clamp(layout.y, yInset, 100 - yInset) };
              } else delete elements[id];
              updateOptions({ layouts: { ...layouts, [draft.template]: { ...template, [section]: elements } },
                pointCuesEdited: draft.options.pointCuesEdited || section === 'cues' });
            }}
            onText={({ pointId }) => {
              const isCover = pointId.startsWith('cover:');
              const id = pointId.slice(pointId.indexOf(':') + 1);
              setTab('packaging');
              setSelected(isCover ? 'cover' : `point:${id}`);
              if (isCover && ['title', 'subtitle', 'point1', 'point2', 'point3'].includes(id)) setCoverField(id);
              requestAnimationFrame(() => (isCover ? coverInput : pointInput).current?.focus());
            }}
            onStickerSelect={id => { setSelected(`asset:${id}`); setTab('sticker'); }}
            onStickerCommit={editSticker}
            onStickerDelete={id => { updateOptions({ assetStickers: assetStickers.filter(sticker => sticker.id !== id) }); setSelected(''); }}
            onStickerExit={() => { if (tab === 'sticker') setSelected(''); }} /> : null}
          {caption ? <div className={styles.captionLayer}>
            <div className={styles.captionArt} aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: filmCaptionSvg(subtitleStyle, caption.text, size.width, size.height) }} />
            <button type="button" className={styles.captionHandle} data-active={selected === `subtitle:${caption.id}`}
              style={{ left: `${positionOfSubtitle.x}%`, top: `${positionOfSubtitle.y}%`,
                width: `${subtitleStyle.boxWidthPx / 1080 * 100}%`,
                height: `${Math.max(4, subtitleStyle.fontSizePx * subtitleStyle.scale / (1080 * size.height / size.width) * 120)}%`,
                transform: `translate(${subtitleStyle.align === 'left' ? 0 : subtitleStyle.align === 'right' ? -100 : -50}%, -85%)` }}
              onPointerDown={event => startCanvasDrag(event, positionOfSubtitle, 'subtitle', `subtitle:${caption.id}`)}
              onPointerMove={event => moveOnCanvas(event, positionDrag.current?.origin ?? positionOfSubtitle,
                next => changeStyle({ ...subtitleStyle, x: next.x / 100, y: next.y / 100 }))}
              onPointerUp={stopDrag} onPointerCancel={stopDrag} onDoubleClick={() => captionText.current?.focus()}
              aria-label="移动画面字幕" />
          </div> : null}
          {safeArea ? <div className={styles.draftSafeArea} aria-label="4% 预览安全区" /> : null}
        </div>
        <div className={styles.previewFooter}>
        <div className={styles.previewControls} aria-label="预览控制">
          <ToolbarButton icon={playing ? 'pause' : 'play'} disabled={busy} onClick={() => playing ? seek(time.current) : startPlayback()}>
            {playing ? '暂停' : '播放'}
          </ToolbarButton>
          <button type="button" className="cap" aria-pressed={safeArea} onClick={() => setSafeArea(!safeArea)}>安全区</button>
          <ToolbarButton icon="maximize" onClick={() => void toggleFullscreen()}>{fullscreen || expanded ? '退出全屏' : '全屏'}</ToolbarButton>
          {previewError ? <span className={styles.hintFail} role="alert">{previewError}</span> : null}
        </div>
        {editingCover ? <div className={styles.previewControls}>
          <Segmented value={coverMode} onChange={next => {
            setCoverMode(next);
            if (next === 'overlay' && tab !== 'packaging' && tab !== 'sticker') setTab('packaging');
          }} label="封面编辑模式" size="small" semantics="toggle" options={[
            { value: 'overlay', label: '编辑文字/贴纸' }, { value: 'framing', label: '调整封面底图' },
          ]} />
          {framingMode ? <>
            <label className={styles.coverZoom}>缩放 <output className="tnum">{Math.round(coverFraming.scale * 100)}%</output>
              <input type="range" min={1} max={3} step={0.05} aria-label="封面缩放" value={coverFraming.scale}
                onChange={event => updateFraming({ ...coverFraming, scale: event.target.valueAsNumber })} />
            </label>
            <button type="button" className="cap" disabled={!coverMedia.framing} onClick={() => updateFraming()}>重置构图</button>
          </> : null}
        </div> : null}
        </div>
      </div>
      {musicId ? <audio ref={music} src={`/api/final-edit-bgm/${encodeURIComponent(musicId)}/file`} preload="auto" loop /> : null}
      <PackagingTimeline tracks={rows} duration={duration} position={position} selected={tab === 'picture' ? shot?.id ?? '' : selected} onSeek={at => {
          const us = Math.round((at - offset) * 1e6);
          setPickedShot(media.review.shots.find(item => us >= item.startUs && us < item.endUs)?.id);
          seek(at);
        }}
        onPick={(kind, clip) => {
          setSelected(clip.id);
          if (kind === 'picture') setPickedShot(clip.id);
          if (kind === 'picture' || kind === 'subtitle' || kind === 'packaging' || kind === 'sticker' || kind === 'music') setTab(kind);
          if (clip.id === 'cover') {
            setCoverExpanded(true);
            requestAnimationFrame(() => coverPanel.current?.scrollIntoView({ block: 'nearest' }));
          }
          seek(clip.start);
        }}
        onRange={(kind, clip, range, at) => {
          const key = clip.id.slice(clip.id.indexOf(':') + 1);
          const times = { startSec: Math.max(0, range.start - offset), endSec: range.end - offset };
          if (kind === 'subtitle') onChange({ ...draft, subtitleCues: draft.subtitleCues.map((cue) => cue.id === key ? { ...cue, ...times } : cue) });
          if (kind === 'packaging') {
            const pointCues = draft.pointCues.map((cue) => cue.id === key ? { ...cue, ...times } : cue);
            onChange({ ...draft, pointCues, options: { ...draft.options, pointCuesEdited: true,
              assetStickers: assetStickers.some(isUneditedFilmPointSticker)
                ? replaceAutomaticStickers(pointCues) : draft.options.assetStickers } });
          }
          if (kind === 'sticker' && clip.id.startsWith('asset:')) {
            const startFrame = Math.round(times.startSec * FINAL_EDIT_FPS) + FINAL_EDIT_INTRO_FRAMES;
            const endFrame = Math.min(bodyFrames + FINAL_EDIT_INTRO_FRAMES, Math.round(times.endSec * FINAL_EDIT_FPS) + FINAL_EDIT_INTRO_FRAMES);
            if (endFrame - startFrame >= STICKER_MIN_DURATION_FRAMES) editSticker(key, { startFrame, endFrame });
          } else if (kind === 'sticker') updateOptions({ stickers: stickers.map((cue) => cue.id === key ? { ...cue, ...times } : cue) });
          seek(at);
        }} />
    </div>
    <aside className={styles.reviewRight} aria-label="审片属性">
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
      {tab === 'picture' && shot && <ShotInspector key={`${media.review.jobId}:${shot.id}`} projectId={projectId} images={images}
        review={media.review} shot={shot} positionUs={Math.round(Math.round(bodyTime * FINAL_EDIT_FPS) / FINAL_EDIT_FPS * 1e6)} busy={busy} reload={onRefresh}
        onPlay={() => {
          seek(offset + shot.startUs / 1e6);
          playUntil.current = offset + shot.endUs / 1e6;
          if (playing) void video.current?.play().catch(() => setPreviewError('正文视频暂时无法播放'));
          startPlayback();
        }}
        onAdjustSound={onAdjustSound} />}
      {tab === 'subtitle' ? <>
        <label className={styles.editRow}>显示口播字幕<input type="checkbox" checked={draft.options.subtitles}
          onChange={(event) => updateOptions({ subtitles: event.target.checked })} /></label>
        {draft.options.subtitles && !draft.subtitlesPrepared ? <p className={styles.hint}>时间轴为草稿字幕。识别实际口播后，播放时显示已对时的字幕。</p> : null}
        {selectedText ? <label className={styles.editRow}>当前字幕
          <textarea ref={captionText} className="input-field" value={selectedText.text} maxLength={60}
            onChange={(event) => updateSubtitleText(selectedText, event.target.value)} />
        </label> : <p className={styles.hint}>点选时间轴上的字幕即可改字。</p>}
        <div className={styles.inlineActions}>
          <button type="button" className="cap" disabled={busy || !canSplit} onClick={split}>在播放头处分割</button>
          <button type="button" className="cap" disabled={busy} onClick={() => changeStyle(resolveFilmSubtitleStyle())}>恢复默认样式</button>
          <button type="button" className="cap" disabled={busy || !draft.options.subtitles} onClick={onRecognize}>
            {draft.subtitlesPrepared ? '重新识别口播' : '识别口播字幕'}
          </button>
        </div>
        <BatchTextStyleEditor label="字幕样式" value={subtitleStyle} outputWidth={1080} disabled={busy} onChange={changeStyle} />
      </> : null}
      {tab === 'packaging' ? <>
        <PackagingAppearanceControls config={draft.options} disabled={busy} inlinePanel sharedFonts={media.sharedFonts} onChange={patch => {
          const template = patch.template ?? draft.template;
          onChange({ ...draft, template, options: { ...draft.options, ...patch, template } });
        }} />
        <div className={styles.inlineActions}>
          <label><input type="checkbox" checked={draft.options.cover} onChange={(event) => { seek(0); updateOptions({ cover: event.target.checked }); }} /> 封面</label>
          <label><input type="checkbox" checked={draft.options.decoration} onChange={(event) => updateOptions({ decoration: event.target.checked })} /> 花字</label>
        </div>
        <div ref={coverPanel}>
          <FilmCoverPanel media={draft.options.coverMedia} frames={bodyFrames} signature={media.signature} shots={media.review.shots}
            image={coverImage} thumbnail={thumbnail} expanded={coverExpanded} busy={busy} canTakeCurrent={position >= offset}
            projectId={projectId} images={images} entryCode={draft.entryCode} template={draft.template}
            onSelect={selectCover} onTakeCurrent={takeCurrentCover} onToggle={() => setCoverExpanded(current => !current)} />
          {draft.coverFrameClamped ? <p className={styles.hint} role="status">原选帧超出正文，已定位到最后一帧。</p> : null}
          {coverExpanded ? <FilmCoverAutoControls state={draft.autoCover}
            current={!draft.options.coverMedia || draft.options.coverMedia.kind === 'auto_frame'}
            disabled={busy || draft.autoCover?.sourceSignature !== media.signature} onRetry={onRetryAutoCover} /> : null}
        </div>
        {selectedPoint ? <label className={styles.editRow}>当前花字<input ref={pointInput} className="input-field" maxLength={60}
          value={selectedPoint.text} onChange={(event) => onChange({ ...draft, options: { ...draft.options, pointCuesEdited: true }, pointCues: draft.pointCues.map((cue) =>
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
        <div className={styles.inlineActions}>
          <button type="button" className="cap" disabled={!offset} onClick={() => { setSelected('cover'); seek(0); }}>跳到封面</button>
          <button type="button" className="cap" onClick={() => updateOptions({ layouts: { ...draft.options.layouts, [draft.template]: {} } })}>恢复默认版式</button>
          <button type="button" className="cap" onClick={() => {
            const title = splitFilmCoverTitle(draft.options.titleMode === 'shared' ? draft.options.title || entry.title : entry.title);
            onChange({ ...draft, title: title.title, options: { ...draft.options, coverText: { subtitle: title.subtitle } } });
          }}>恢复默认文案</button>
          <button type="button" className="cap" disabled={busy} onClick={() => void extractPoints()}>重新提取卖点</button>
        </div>
        <p className={styles.hint}>暂停时可在画面拖动或双击改字，花字时长在轨道上调整。</p>
      </> : null}
      {tab === 'sticker' ? <>
        <StickerPanel active enabled busy={busy} template={draft.template}
          stickers={assetStickers} selectedSticker={selectedAssetSticker ?? null}
          defaultAnimation={draft.options.stickerDefaults?.animation ?? 'follow-template'}
          addBlockedReason={assetStickers.length >= MAX_STICKER_INSTANCES ? '已达到贴纸数量上限' : stickerFrames ? '' : '请把播放头移到有足够空间的位置'}
          autoLayoutBlockedReason={draft.pointCues.length ? '' : '请先提取花字卖点'} autoLayoutLabel="随花字布置"
          onAdd={addSticker}
          onDragStart={choice => { dragSticker.current = choice; setDraggingSticker(true); }}
          onDragEnd={() => { dragSticker.current = null; setDraggingSticker(false); }}
          onPatchSticker={async (id, patch) => editSticker(id, patch)}
          onDefaultAnimationChange={animation => updateOptions({ stickerDefaults: { animation } })}
          onApplyAnimationToAll={animation => updateOptions({ assetStickers: assetStickers.map(sticker => applyPackagingStickerEdit(sticker, { animation })) })}
          onPlaySticker={id => {
            const sticker = assetStickers.find(item => item.id === id);
            if (!sticker) return;
            seek((sticker.startFrame - FINAL_EDIT_INTRO_FRAMES) * frameSec + offset);
            playUntil.current = (sticker.endFrame - FINAL_EDIT_INTRO_FRAMES) * frameSec + offset;
            startPlayback();
          }} onAutoLayout={() => updateOptions({ assetStickers: replaceAutomaticStickers(draft.pointCues) })} />
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
