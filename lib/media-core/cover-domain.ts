import type { TextStyle } from './cover-types.ts';

export function splitCoverTitle(title: string): { primary: string; secondary: string } {
  const value = title.trim();
  if (!value) return { primary: '', secondary: '' };
  const graphemes = Array.from(value);
  const midpoint = graphemes.length / 2;
  const boundaries: number[] = [];
  graphemes.forEach((char, index) => {
    if (/[，。！？；、,.!?;\s]/u.test(char)) boundaries.push(index);
  });
  if (boundaries.length > 0) {
    const boundary = boundaries.sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint))[0];
    const primary = graphemes.slice(0, boundary).join('').trim();
    const secondary = graphemes.slice(boundary + 1).join('').trim();
    if (primary && secondary) return { primary, secondary };
  }
  const cut = Math.max(1, Math.min(graphemes.length - 1, Math.round(midpoint)));
  return { primary: graphemes.slice(0, cut).join(''), secondary: graphemes.slice(cut).join('') };
}

export function defaultTextStyle(kind: 'coverPrimary' | 'coverSecondary' | 'subtitle', width: number): TextStyle {
  const subtitle = kind === 'subtitle';
  return {
    fontFamily: 'PingFang SC', fontSizePx: subtitle ? 56 : kind === 'coverPrimary' ? 84 : 72, italic: false,
    x: 0.5, y: subtitle ? 0.82 : kind === 'coverPrimary' ? 0.2 : 0.31, scale: 1,
    color: kind === 'coverSecondary' ? '#2f7cf6' : '#ffffff', align: 'center', boxWidthPx: Math.round(width * 0.8), lineHeight: 1.2,
    stroke: { enabled: true, color: '#101010', widthPx: subtitle ? 4 : 3 },
    shadow: { enabled: true, color: '#000000', opacity: 0.7, blurPx: subtitle ? 2 : 8, distancePx: subtitle ? 5 : 8, angleDeg: 45 },
  };
}

function finite(value: unknown, fallback: number): number { return Number.isFinite(value) ? Number(value) : fallback; }

export function normalizeTextStyle(value: unknown, fallback: TextStyle): TextStyle {
  const raw = value && typeof value === 'object' ? value as Partial<TextStyle> : {};
  const stroke = raw.stroke && typeof raw.stroke === 'object' ? raw.stroke : fallback.stroke;
  const shadow = raw.shadow && typeof raw.shadow === 'object' ? raw.shadow : fallback.shadow;
  return {
    fontFamily: typeof raw.fontFamily === 'string' && raw.fontFamily.trim() ? raw.fontFamily : fallback.fontFamily,
    ...(typeof raw.fontPostscriptName === 'string' && raw.fontPostscriptName ? { fontPostscriptName: raw.fontPostscriptName } : {}),
    fontSizePx: Math.max(8, finite(raw.fontSizePx, fallback.fontSizePx)), italic: Boolean(raw.italic),
    x: Math.max(0, Math.min(1, finite(raw.x, fallback.x))), y: Math.max(0, Math.min(1, finite(raw.y, fallback.y))),
    scale: Math.max(0.25, Math.min(4, finite(raw.scale, fallback.scale))), color: typeof raw.color === 'string' ? raw.color : fallback.color,
    align: raw.align === 'left' || raw.align === 'right' ? raw.align : 'center', boxWidthPx: Math.max(1, finite(raw.boxWidthPx, fallback.boxWidthPx)),
    lineHeight: Math.max(0.5, finite(raw.lineHeight, fallback.lineHeight)),
    stroke: { enabled: stroke.enabled == null ? fallback.stroke.enabled : Boolean(stroke.enabled), color: typeof stroke.color === 'string' ? stroke.color : fallback.stroke.color, widthPx: Math.max(0, finite(stroke.widthPx, fallback.stroke.widthPx)) },
    shadow: { enabled: shadow.enabled == null ? fallback.shadow.enabled : Boolean(shadow.enabled), color: typeof shadow.color === 'string' ? shadow.color : fallback.shadow.color, opacity: Math.max(0, Math.min(1, finite(shadow.opacity, fallback.shadow.opacity))), blurPx: Math.max(0, finite(shadow.blurPx, fallback.shadow.blurPx)), distancePx: Math.max(0, finite(shadow.distancePx, fallback.shadow.distancePx)), angleDeg: finite(shadow.angleDeg, fallback.shadow.angleDeg) },
  };
}
