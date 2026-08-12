export type OutputPresetId = '3x4' | '9x16' | '16x9';

export const OUTPUT_PRESETS = {
  '3x4': { width: 1080, height: 1440, fps: 24 },
  '9x16': { width: 1080, height: 1920, fps: 24 },
  '16x9': { width: 1920, height: 1080, fps: 24 },
} as const;

export interface TextStyle {
  fontFamily: string;
  fontPostscriptName?: string;
  fontSizePx: number;
  italic: boolean;
  x: number;
  y: number;
  scale: number;
  color: string;
  align: 'left' | 'center' | 'right';
  boxWidthPx: number;
  lineHeight: number;
  stroke: { enabled: boolean; color: string; widthPx: number };
  shadow: { enabled: boolean; color: string; opacity: number; blurPx: number; distancePx: number; angleDeg: number };
}

export interface CoverFraming {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface CoverPresetV2 {
  version: 2;
  stylesByPreset: Record<OutputPresetId, {
    primary: TextStyle;
    secondary: TextStyle;
    framing: CoverFraming;
  }>;
}
