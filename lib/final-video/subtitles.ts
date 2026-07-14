// lib/final-video/subtitles.ts
/**
 * ASS 字幕构建（PlayRes = 输出分辨率，Alignment 2 底部居中）。
 * 参考：混剪计划 §Task 4.3 build_ass 的 TS 移植，时间轴改用 startSec（已含片头偏移）。
 */
import fs from 'node:fs';
import type { NarrationBeat, SubtitleStyle } from './types.ts';

const PLATFORM_FONTS: Record<string, string[]> = {
  darwin: [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
  ],
  win32: ['C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\simhei.ttf'],
  linux: [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  ],
};

const PLATFORM_FONT_NAMES: Record<string, string> = {
  darwin: 'PingFang SC',
  win32: 'Microsoft YaHei',
  linux: 'Noto Sans CJK SC',
};

/** 返回本机可用的中文字体文件路径；找不到返回 ''（libass 回退默认字体） */
export function resolveFontFile(): string {
  for (const cand of PLATFORM_FONTS[process.platform] ?? []) {
    if (fs.existsSync(cand)) return cand;
  }
  return '';
}

export function platformFontName(): string {
  return PLATFORM_FONT_NAMES[process.platform] ?? 'sans-serif';
}

function assTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function bgr(hexColor: string): string {
  const c = hexColor.replace('#', '');
  if (c.length !== 6) return 'FFFFFF';
  return `${c.slice(4, 6)}${c.slice(2, 4)}${c.slice(0, 2)}`.toUpperCase();
}

function buildAssHeader(style: SubtitleStyle, width: number, height: number): string {
  const marginV = Math.round((height * style.marginBottomPct) / 100);
  return (
    '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    // Keep libass on its documented smart-wrap policy; Chinese-specific
    // wrapping is added below because Chinese text has no word boundaries.
    'WrapStyle: 0\n' +
    `PlayResX: ${width}\n` +
    `PlayResY: ${height}\n\n` +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, ' +
    'Bold, Italic, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    `Style: Default,${platformFontName()},${style.fontSize},&H00${bgr(style.color)},` +
    `&H00${bgr(style.strokeColor)},&H80000000,0,0,${style.strokeWidth},0,2,20,20,${marginV},1\n\n` +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
  );
}

const MAX_SUBTITLE_COLUMNS = 30;

function subtitleColumnWidth(char: string): number {
  // CJK/full-width glyphs consume roughly twice the horizontal space of ASCII
  // in the configured Chinese font. This keeps sentence-level subtitles from
  // running beyond a 1080px portrait canvas.
  return /^[\x00-\xff]$/.test(char) ? 1 : 2;
}

function wrapSubtitleLine(line: string): string {
  let columns = 0;
  let wrapped = '';
  for (const char of line) {
    const width = subtitleColumnWidth(char);
    if (columns > 0 && columns + width > MAX_SUBTITLE_COLUMNS) {
      wrapped += '\\N';
      columns = 0;
    }
    wrapped += char;
    columns += width;
  }
  return wrapped;
}

function escapeAssText(text: string): string {
  return text.split('\n').map(wrapSubtitleLine).join('\\N');
}

/** Build one subtitle dialogue per narration sentence (one beat = one sentence). */
export function buildNarrationAss(
  beats: NarrationBeat[],
  introDurationSec: number,
  style: SubtitleStyle,
  width: number,
  height: number,
): string {
  if (!Number.isFinite(introDurationSec) || introDurationSec < 0) {
    throw new Error('introDurationSec must be finite and non-negative');
  }

  const sorted = [...beats].sort((a, b) => a.index - b.index);
  const beatIds = new Set<string>();
  for (let position = 0; position < sorted.length; position += 1) {
    const beat = sorted[position];
    if (!Number.isInteger(beat.index) || beat.index !== position) {
      throw new Error(`beat indexes must be contiguous from zero; expected ${position}, got ${beat.index}`);
    }
    if (beatIds.has(beat.beatId)) throw new Error(`duplicate beatId: ${beat.beatId}`);
    beatIds.add(beat.beatId);
    if (!Number.isFinite(beat.startSec) || beat.startSec < 0) {
      throw new Error(`beat startSec must be finite and non-negative: ${beat.beatId}`);
    }
    if (!Number.isFinite(beat.durationSec) || beat.durationSec <= 0) {
      throw new Error(`beat durationSec must be finite and positive: ${beat.beatId}`);
    }
  }

  const lines = [buildAssHeader(style, width, height)];
  if (style.enabled) {
    for (const beat of sorted) {
      const text = (beat.subtitleText || beat.text).trim();
      if (!text) continue;
      const start = assTime(introDurationSec + beat.startSec);
      const end = assTime(introDurationSec + beat.startSec + beat.durationSec);
      lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${escapeAssText(text)}`);
    }
  }
  return lines.join('\n') + '\n';
}
