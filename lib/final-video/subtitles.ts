// lib/final-video/subtitles.ts
/**
 * ASS 字幕构建（PlayRes = 输出分辨率，Alignment 2 底部居中）。
 * 参考：混剪计划 §Task 4.3 build_ass 的 TS 移植，时间轴改用 startSec（已含片头偏移）。
 */
import fs from 'node:fs';
import type { SubtitleStyle } from './types.ts';

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

export interface AssSegment {
  subtitle: string;
  startSec: number;
  segmentDurationSec: number;
}

export function buildAss(segments: AssSegment[], style: SubtitleStyle, width: number, height: number): string {
  const marginV = Math.round((height * style.marginBottomPct) / 100);
  const header =
    '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    `PlayResX: ${width}\n` +
    `PlayResY: ${height}\n\n` +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, ' +
    'Bold, Italic, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    `Style: Default,${platformFontName()},${style.fontSize},&H00${bgr(style.color)},` +
    `&H00${bgr(style.strokeColor)},&H80000000,0,0,${style.strokeWidth},0,2,20,20,${marginV},1\n\n` +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

  const lines = [header];
  for (const seg of segments) {
    const text = (seg.subtitle || '').trim();
    if (!text) continue;
    const start = assTime(seg.startSec);
    const end = assTime(seg.startSec + seg.segmentDurationSec);
    lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text.replace(/\n/g, '\\N')}`);
  }
  return lines.join('\n') + '\n';
}
