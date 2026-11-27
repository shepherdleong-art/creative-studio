import { defaultTextStyle, normalizeTextStyle } from '../media-core/cover-domain.ts';
import { textStyleToSvgElements } from '../media-core/cover-title-svg.ts';
import type { TextStyle } from '../media-core/cover-types.ts';
import type { FinalEditPackagingConfig } from '../media-core/packaging-vars.ts';
import { createManualPackagingSticker, MAX_STICKER_INSTANCES, STICKER_MIN_DURATION_FRAMES, type PackagingStickerInstance } from '../media-core/packaging-stickers.ts';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '../media-core/render-contract.ts';
import { normalizeAutomaticSubtitleText, splitNarrationForDisplay } from '../subtitle-display.ts';
import type { PackagingRecord, TextCue } from './packaging.ts';

export type Position = { x: number; y: number };
export const DEFAULT_SUBTITLE_POSITION: Position = { x: 50, y: 91 };
export function resolveFilmSubtitleStyle(value?: unknown, legacyPosition?: Position): TextStyle {
  const defaults = defaultTextStyle('subtitle', 1080);
  if (legacyPosition) Object.assign(defaults, { x: legacyPosition.x / 100, y: legacyPosition.y / 100 });
  return normalizeTextStyle(value, defaults);
}

export function filmCaptionSvg(style: TextStyle, text: string, width: number, height: number) {
  const design = { width: 1080, height: 1080 * height / width };
  const elements = textStyleToSvgElements(style, normalizeAutomaticSubtitleText(text), design);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1080 ${design.height}">${elements}</svg>`;
}

export const STICKERS = {
  star: { label: '星星', path: 'M 0 -13 L 4 -4 L 14 -4 L 6 2 L 9 12 L 0 6 L -9 12 L -6 2 L -14 -4 L -4 -4 Z',
    drawing: 'm 0 -13 l 4 -4 14 -4 6 2 9 12 0 6 -9 12 -6 2 -14 -4 -4 -4', fill: '#F9CB67', assColor: '67CBF9' },
  heart: { label: '爱心', path: 'M 0 12 L -12 0 L -12 -6 L -7 -10 L -3 -10 L 0 -7 L 3 -10 L 7 -10 L 12 -6 L 12 0 Z',
    drawing: 'm 0 12 l -12 0 -12 -6 -7 -10 -3 -10 0 -7 3 -10 7 -10 12 -6 12 0', fill: '#FBA7AA', assColor: 'AAA7FB' },
} as const;
export type StickerCue = Omit<TextCue, 'text'> & Position & { kind: keyof typeof STICKERS };

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function parsePosition(input: unknown): Position | undefined {
  const value = input as Partial<Position> | null | undefined;
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return undefined;
  return { x: clamp(value.x!, 0, 100), y: clamp(value.y!, 0, 100) };
}

export function splitSubtitleCues(cues: readonly TextCue[]): TextCue[] {
  return cues.flatMap((cue) => splitTimedSubtitle(cue));
}

/** When word timing is available, split at its actual boundaries. */
export function splitTimedSubtitle(cue: TextCue, timestamps?: Array<{ at: number; sec: number }>): TextCue[] {
  const needsSplit = Array.from(cue.text).length > 16 || /[，、；。！？]/u.test(cue.text.slice(0, -1));
  const parts = needsSplit ? splitNarrationForDisplay(cue.text, { maxContentCharacters: 16 }) : [];
  if (parts.length < 2) {
    const text = normalizeAutomaticSubtitleText(cue.text);
    return text ? [{ ...cue, text }] : [];
  }
  const total = parts.reduce((n, part) => n + Array.from(part.sourceText).length, 0);
  let consumed = 0;
  let cursor = cue.startSec;
  let textCursor = 0;
  return parts.map((part, index) => {
    consumed += Array.from(part.sourceText).length;
    const found = cue.text.indexOf(part.sourceText, textCursor);
    if (found >= 0) textCursor = found + part.sourceText.length;
    const wordEnd = found < 0 ? undefined : timestamps?.find((time) => time.at === textCursor)?.sec;
    const proportional = cue.startSec + (cue.endSec - cue.startSec) * consumed / total;
    const slice = (cue.endSec - cue.startSec) / (total * 2);
    const limit = cue.endSec - (parts.length - index - 1) * slice;
    const endSec = index === parts.length - 1 ? cue.endSec : clamp(wordEnd ?? proportional, cursor + slice, limit);
    const next = { id: `${cue.id}-${index + 1}`, text: part.displayText, startSec: cursor, endSec };
    cursor = endSec;
    return next;
  });
}

export function splitFilmCoverTitle(text: string): { title: string; subtitle: string } {
  const clean = text.trim();
  const separator = clean.search(/[：:\n]/u);
  return separator <= 0 ? { title: clean, subtitle: '' }
    : { title: clean.slice(0, separator).trim(), subtitle: clean.slice(separator + 1).trim() };
}

export const isUneditedFilmPointSticker = (sticker: PackagingStickerInstance) =>
  sticker.origin.kind === 'auto' && sticker.origin.autoGroupId === 'film-points' && !sticker.origin.autoEdited;

export function stickersForFilmPoints(cues: TextCue[], bodyFrames: number) {
  const assets = ['look_here', 'highlight', 'details', 'another_angle', 'also_here', 'more_details'] as const;
  return cues.slice(0, assets.length).flatMap((cue, index) => {
    const start = Math.max(0, Math.round(cue.startSec * FINAL_EDIT_FPS));
    const end = Math.min(bodyFrames, Math.round(cue.endSec * FINAL_EDIT_FPS));
    if (end - start < STICKER_MIN_DURATION_FRAMES) return [];
    const sticker = createManualPackagingSticker({
      id: `film-point-${index}`, assetId: assets[index]!, styleMode: 'follow-template', fixedStyle: null,
      startFrame: FINAL_EDIT_INTRO_FRAMES + start, endFrame: FINAL_EDIT_INTRO_FRAMES + end,
      centerXPct: 23, centerYPct: 69, animation: 'follow-template',
    });
    return [{ ...sticker, visualWidthPct: 22, origin: { kind: 'auto' as const, autoGroupId: 'film-points', autoEdited: false } }];
  });
}

export function syncFilmPointStickers(stickers: readonly PackagingStickerInstance[], cues: TextCue[], bodyFrames: number) {
  const kept = stickers.filter(sticker => !isUneditedFilmPointSticker(sticker));
  const generated = stickersForFilmPoints(cues, bodyFrames).filter(sticker => !kept.some(item => item.id === sticker.id));
  return [...kept, ...generated].slice(0, MAX_STICKER_INSTANCES);
}

export function packagingOverlayConfig(record: Pick<PackagingRecord, 'title' | 'pointCues' | 'options' | 'template'>): FinalEditPackagingConfig {
  const offset = record.options.cover ? FINAL_EDIT_INTRO_FRAMES / FINAL_EDIT_FPS : 0;
  const stickerOffset = record.options.cover ? 0 : FINAL_EDIT_INTRO_FRAMES;
  const stickers = record.options.assetStickers?.filter(sticker => record.options.decoration || !isUneditedFilmPointSticker(sticker));
  return {
    enabled: record.options.cover || record.options.decoration || Boolean(stickers?.length),
    template: record.template,
    varsOverrides: { title: record.title, ...record.options.coverText },
    layouts: record.options.layouts,
    titleFont: record.options.titleFont, subtitleFont: record.options.subtitleFont, pointFont: record.options.pointFont,
    pointCues: record.options.decoration
      ? record.pointCues.map((cue) => ({ ...cue, startSec: cue.startSec + offset, endSec: cue.endSec + offset }))
      : [],
    pointCuesMode: record.options.decoration ? 'timed' : 'none',
    stickers: stickers?.map((sticker) => ({
      ...sticker, startFrame: sticker.startFrame - stickerOffset, endFrame: sticker.endFrame - stickerOffset,
    })),
    stickerDefaults: record.options.stickerDefaults,
  };
}
