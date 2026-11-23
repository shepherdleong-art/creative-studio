import type { FinalEditPackagingConfig } from '../media-core/packaging-vars.ts';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '../media-core/render-contract.ts';
import { splitNarrationForDisplay } from '../subtitle-display.ts';
import type { PackagingRecord, TextCue } from './packaging.ts';

export type Position = { x: number; y: number };
export const DEFAULT_SUBTITLE_POSITION: Position = { x: 50, y: 91 };
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
  if (Array.from(cue.text).length <= 16 && !/[，、；。！？]/u.test(cue.text.slice(0, -1))) return [cue];
  const parts = splitNarrationForDisplay(cue.text, { maxContentCharacters: 16 });
  if (parts.length < 2) return [cue];
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

export function packagingOverlayConfig(record: Pick<PackagingRecord, 'title' | 'pointCues' | 'options' | 'template'>): FinalEditPackagingConfig {
  const offset = record.options.cover ? FINAL_EDIT_INTRO_FRAMES / FINAL_EDIT_FPS : 0;
  return {
    enabled: record.options.cover || record.options.decoration,
    template: record.template,
    varsOverrides: { title: record.title, ...record.options.coverText },
    layouts: record.options.layouts,
    pointCues: record.options.decoration
      ? record.pointCues.map((cue) => ({ ...cue, startSec: cue.startSec + offset, endSec: cue.endSec + offset }))
      : [],
    pointCuesMode: record.options.decoration ? 'timed' : 'none',
  };
}
