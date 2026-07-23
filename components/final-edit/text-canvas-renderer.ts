import type { FinalEditGroupView, OutputPresetId, SubtitleCue, TextStyle } from '@/lib/final-edit/types';
import { OUTPUT_PRESETS } from '@/lib/final-edit/types';

export type TextOverflowTarget = 'coverPrimary' | 'coverSecondary' | 'subtitle';

export interface TextOverflowDetail {
  target: TextOverflowTarget;
  cueId?: string;
  measuredWidthPx: number;
  safeWidthPx: number;
}

export class TextOverflowError extends Error {
  readonly details: TextOverflowDetail[];
  readonly cueIds: string[];

  constructor(details: TextOverflowDetail[]) {
    const subtitleCount = details.filter((detail) => detail.target === 'subtitle').length;
    const titleCount = details.length - subtitleCount;
    const parts = [
      subtitleCount ? `${subtitleCount} 条字幕` : '',
      titleCount ? `${titleCount} 处封面标题` : '',
    ].filter(Boolean);
    super(`有 ${parts.join('、')}超出单行安全宽度，请点击提示定位并调整文字或样式`);
    this.name = 'TextOverflowError';
    this.details = details;
    this.cueIds = details.flatMap((detail) => detail.cueId ? [detail.cueId] : []);
  }
}

export function drawText(ctx: CanvasRenderingContext2D, text: string, style: TextStyle) {
  ctx.save();
  ctx.font = `${style.fontSizePx * style.scale}px ${JSON.stringify(style.fontFamily)}`;
  ctx.textAlign = style.align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = style.color;
  const x = style.x * ctx.canvas.width;
  const y = style.y * ctx.canvas.height;
  if (style.shadow.enabled) {
    const radians = style.shadow.angleDeg * Math.PI / 180;
    ctx.shadowColor = colorWithOpacity(style.shadow.color, style.shadow.opacity);
    ctx.shadowBlur = style.shadow.blurPx;
    ctx.shadowOffsetX = Math.cos(radians) * style.shadow.distancePx;
    ctx.shadowOffsetY = Math.sin(radians) * style.shadow.distancePx;
  }
  if (style.stroke.enabled && style.stroke.widthPx > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = style.stroke.widthPx * 2;
    ctx.strokeStyle = style.stroke.color;
    ctx.strokeText(text, x, y);
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

export function drawEditorOverlay(canvas: HTMLCanvasElement, group: FinalEditGroupView, preset: OutputPresetId, cue: SubtitleCue | null, showTitle: boolean) {
  const expected = OUTPUT_PRESETS[preset];
  if (canvas.width !== expected.width) canvas.width = expected.width;
  if (canvas.height !== expected.height) canvas.height = expected.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const styles = group.textStyles[preset];
  if (showTitle) {
    drawText(context, group.coverTitle.primary.text, styles.coverPrimary);
    drawText(context, group.coverTitle.secondary.text, styles.coverSecondary);
  } else if (cue) {
    drawText(context, cue.text, styles.subtitle);
  }
}

function colorWithOpacity(color: string, opacity: number) {
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0');
    return `${color}${alpha}`;
  }
  return color;
}

function canvasFor(preset: OutputPresetId) {
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_PRESETS[preset].width;
  canvas.height = OUTPUT_PRESETS[preset].height;
  return canvas;
}

function toBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png').split(',')[1] || '';
}

function measureText(ctx: CanvasRenderingContext2D, text: string, style: TextStyle): number {
  ctx.font = `${style.fontSizePx * style.scale}px ${JSON.stringify(style.fontFamily)}`;
  const shadowOffsetX = style.shadow.enabled
    ? Math.abs(Math.cos(style.shadow.angleDeg * Math.PI / 180) * style.shadow.distancePx)
    : 0;
  return ctx.measureText(text).width
    + (style.stroke.enabled ? style.stroke.widthPx * 2 : 0)
    + (style.shadow.enabled ? style.shadow.blurPx * 2 + shadowOffsetX : 0);
}

export function measureTextOverflowDetails(group: FinalEditGroupView, preset: OutputPresetId): TextOverflowDetail[] {
  const style = group.textStyles[preset];
  const canvas = canvasFor(preset);
  const context = canvas.getContext('2d');
  if (!context) return [];
  const details: TextOverflowDetail[] = [];
  const titleParts = [
    { target: 'coverPrimary' as const, text: group.coverTitle.primary.text, style: style.coverPrimary },
    { target: 'coverSecondary' as const, text: group.coverTitle.secondary.text, style: style.coverSecondary },
  ];
  for (const part of titleParts) {
    const measuredWidthPx = measureText(context, part.text, part.style);
    if (measuredWidthPx > part.style.boxWidthPx) details.push({ target: part.target, measuredWidthPx, safeWidthPx: part.style.boxWidthPx });
  }
  for (const cue of group.subtitleCues) {
    const measuredWidthPx = measureText(context, cue.text, style.subtitle);
    if (measuredWidthPx > style.subtitle.boxWidthPx) details.push({ target: 'subtitle', cueId: cue.id, measuredWidthPx, safeWidthPx: style.subtitle.boxWidthPx });
  }
  return details;
}

export async function createOverlayBundlePayload(group: FinalEditGroupView, preset: OutputPresetId) {
  const style = group.textStyles[preset];
  const requiredFonts = new Set([style.coverPrimary.fontFamily, style.coverSecondary.fontFamily, style.subtitle.fontFamily]);
  for (const family of requiredFonts) {
    if (!document.fonts.check(`16px ${JSON.stringify(family)}`)) throw new Error(`字体缺失：${family}`);
  }
  await document.fonts.ready;
  const titleCanvas = canvasFor(preset);
  const titleContext = titleCanvas.getContext('2d');
  if (!titleContext) throw new Error('浏览器 Canvas 不可用');
  const titlePrimaryWidth = measureText(titleContext, group.coverTitle.primary.text, style.coverPrimary);
  const titleSecondaryWidth = measureText(titleContext, group.coverTitle.secondary.text, style.coverSecondary);
  const overflowDetails = measureTextOverflowDetails(group, preset);
  if (overflowDetails.length) throw new TextOverflowError(overflowDetails);
  drawText(titleContext, group.coverTitle.primary.text, style.coverPrimary);
  drawText(titleContext, group.coverTitle.secondary.text, style.coverSecondary);

  const subtitles: Record<string, string> = {};
  const subtitleWidths: Record<string, number> = {};
  for (const cue of group.subtitleCues) {
    const canvas = canvasFor(preset);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器 Canvas 不可用');
    const measured = measureText(context, cue.text, style.subtitle);
    subtitleWidths[cue.id] = measured;
    drawText(context, cue.text, style.subtitle);
    subtitles[cue.id] = toBase64(canvas);
  }
  return {
    groupRevision: group.revision,
    titlePngBase64: toBase64(titleCanvas),
    subtitlePngs: subtitles,
    manifest: {
      width: titleCanvas.width,
      height: titleCanvas.height,
      overflow: false,
      measurements: { titlePrimaryWidth, titleSecondaryWidth, subtitleWidths },
      cues: group.subtitleCues.map((cue) => ({ id: cue.id, startUs: cue.startUs, endUs: cue.endUs })),
    },
  };
}
