import type { TextStyle } from './types';

const PRESETS = ['3x4', '9x16', '16x9'] as const;
const STYLE_KEYS = ['fontFamily', 'fontPostscriptName', 'fontSizePx', 'x', 'y', 'scale', 'color', 'align', 'boxWidthPx', 'lineHeight', 'stroke', 'shadow'] as const;

function cleanStyle(raw: unknown): TextStyle {
  if (!raw || typeof raw !== 'object') throw new Error('标题预设样式格式错误');
  const source = raw as Record<string, unknown>;
  const clean = Object.fromEntries(STYLE_KEYS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])) as unknown as TextStyle;
  if (!clean.fontFamily || !Number.isFinite(clean.fontSizePx) || !clean.stroke || !clean.shadow) throw new Error('标题预设缺少必要样式字段');
  return clean;
}
export function sanitizeTitlePresetStyles(raw: unknown) {
  if (!raw || typeof raw !== 'object') throw new Error('标题预设格式错误');
  const source = raw as Record<string, unknown>;
  const result: Record<string, { coverPrimary: TextStyle; coverSecondary: TextStyle }> = {};
  for (const preset of PRESETS) {
    const value = source[preset];
    if (!value || typeof value !== 'object') throw new Error(`标题预设缺少 ${preset} 样式`);
    const entry = value as Record<string, unknown>;
    result[preset] = { coverPrimary: cleanStyle(entry.coverPrimary), coverSecondary: cleanStyle(entry.coverSecondary) };
  }
  return result;
}
