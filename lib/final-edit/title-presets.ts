import { defaultTextStyle, normalizeTextStyle } from './domain.ts';
import { OUTPUT_PRESETS, type CoverFraming, type CoverPresetV2, type OutputPresetId, type TextStyle } from './types.ts';

const PRESETS = Object.keys(OUTPUT_PRESETS) as OutputPresetId[];

function cleanStyle(raw: unknown, kind: 'coverPrimary' | 'coverSecondary', preset: OutputPresetId): TextStyle {
  if (!raw || typeof raw !== 'object') throw new Error('标题预设缺少必要样式字段');
  return normalizeTextStyle(raw, defaultTextStyle(kind, OUTPUT_PRESETS[preset].width));
}

export function cleanFraming(raw: unknown): CoverFraming {
  const value = raw && typeof raw === 'object' ? raw as Partial<CoverFraming> : {};
  const finite = (candidate: unknown, fallback: number) => Number.isFinite(candidate) ? Number(candidate) : fallback;
  return {
    scale: Math.max(1, Math.min(3, finite(value.scale, 1))),
    offsetX: Math.max(-1, Math.min(1, finite(value.offsetX, 0))),
    offsetY: Math.max(-1, Math.min(1, finite(value.offsetY, 0))),
  };
}

export function normalizeCoverPreset(raw: unknown): CoverPresetV2 {
  if (!raw || typeof raw !== 'object') throw new Error('标题预设格式错误');
  const root = raw as Record<string, unknown>;
  const source = root.stylesByPreset && typeof root.stylesByPreset === 'object'
    ? root.stylesByPreset as Record<string, unknown>
    : root;
  const stylesByPreset = {} as CoverPresetV2['stylesByPreset'];
  for (const preset of PRESETS) {
    const value = source[preset];
    if (!value || typeof value !== 'object') throw new Error(`标题预设缺少 ${preset} 样式`);
    const entry = value as Record<string, unknown>;
    stylesByPreset[preset] = {
      primary: cleanStyle(entry.primary ?? entry.coverPrimary, 'coverPrimary', preset),
      secondary: cleanStyle(entry.secondary ?? entry.coverSecondary, 'coverSecondary', preset),
      framing: cleanFraming(entry.framing),
    };
  }
  return { version: 2, stylesByPreset };
}

/** Legacy read shape used by the original module-5 editor while it remains mounted through Phase 6. */
export function sanitizeTitlePresetStyles(raw: unknown): Record<OutputPresetId, { coverPrimary: TextStyle; coverSecondary: TextStyle }> {
  const preset = normalizeCoverPreset(raw);
  return Object.fromEntries(PRESETS.map((id) => [id, {
    coverPrimary: preset.stylesByPreset[id].primary,
    coverSecondary: preset.stylesByPreset[id].secondary,
  }])) as Record<OutputPresetId, { coverPrimary: TextStyle; coverSecondary: TextStyle }>;
}
