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

export function textStyleFont(style: TextStyle): string {
  return `${style.italic ? 'italic ' : ''}${style.fontSizePx * style.scale}px ${JSON.stringify(style.fontFamily)}`;
}

export function drawText(ctx: CanvasRenderingContext2D, text: string, style: TextStyle) {
  ctx.save();
  ctx.font = textStyleFont(style);
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

function renderedAlphaWidth(canvas: HTMLCanvasElement): number {
  const context = canvas.getContext('2d');
  if (!context) return 0;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width;
  let maxX = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (pixels[(y * canvas.width + x) * 4 + 3] > 0) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
  }
  return maxX < minX ? 0 : maxX - minX + 1;
}

function renderSingleTextWidth(preset: OutputPresetId, text: string, style: TextStyle): number {
  const canvas = canvasFor(preset);
  const context = canvas.getContext('2d');
  if (!context) return 0;
  drawText(context, text, style);
  return renderedAlphaWidth(canvas);
}

export function measureSingleLineText(ctx: CanvasRenderingContext2D, text: string, style: TextStyle): number {
  ctx.font = textStyleFont(style);
  ctx.textAlign = style.align;
  const metrics = ctx.measureText(text);
  const inkLeft = Number.isFinite(metrics.actualBoundingBoxLeft) ? Math.max(0, metrics.actualBoundingBoxLeft) : 0;
  const inkRight = Number.isFinite(metrics.actualBoundingBoxRight) ? Math.max(0, metrics.actualBoundingBoxRight) : 0;
  const inkWidth = style.align === 'center' ? Math.max(inkLeft, inkRight) * 2 : inkLeft + inkRight;
  const shadowOffsetX = style.shadow.enabled
    ? Math.abs(Math.cos(style.shadow.angleDeg * Math.PI / 180) * style.shadow.distancePx)
    : 0;
  return Math.max(metrics.width, inkWidth)
    + (style.stroke.enabled ? style.stroke.widthPx * 2 : 0)
    + (style.shadow.enabled ? style.shadow.blurPx * 2 + shadowOffsetX : 0);
}

export function horizontalTextBounds(canvasWidth: number, measuredWidth: number, style: TextStyle) {
  const anchor = style.x * canvasWidth;
  if (style.align === 'left') return { left: anchor, right: anchor + measuredWidth };
  if (style.align === 'right') return { left: anchor - measuredWidth, right: anchor };
  return { left: anchor - measuredWidth / 2, right: anchor + measuredWidth / 2 };
}

export function isTextStyleWithinSafeArea(ctx: CanvasRenderingContext2D, text: string, style: TextStyle, safeMargin = 0.04): boolean {
  const measuredWidth = measureSingleLineText(ctx, text, style);
  const safeLeft = ctx.canvas.width * safeMargin;
  const safeRight = ctx.canvas.width * (1 - safeMargin);
  const bounds = horizontalTextBounds(ctx.canvas.width, measuredWidth, style);
  return measuredWidth <= Math.min(style.boxWidthPx, safeRight - safeLeft)
    && bounds.left >= safeLeft
    && bounds.right <= safeRight;
}

export function fitTextStyleToSingleLine(ctx: CanvasRenderingContext2D, text: string, style: TextStyle, minimumFontSizePx = 12): TextStyle {
  let next = { ...style };
  const safeLeft = ctx.canvas.width * 0.04;
  const safeRight = ctx.canvas.width * 0.96;
  const shiftInsideSafeArea = (current: TextStyle): TextStyle => {
    const measuredWidth = measureSingleLineText(ctx, text, current);
    const bounds = horizontalTextBounds(ctx.canvas.width, measuredWidth, current);
    const delta = bounds.left < safeLeft ? safeLeft - bounds.left : bounds.right > safeRight ? safeRight - bounds.right : 0;
    return delta ? { ...current, x: Math.max(0.04, Math.min(0.96, current.x + delta / ctx.canvas.width)) } : current;
  };
  next = shiftInsideSafeArea(next);
  while (next.fontSizePx > minimumFontSizePx && !isTextStyleWithinSafeArea(ctx, text, next)) {
    next = { ...next, fontSizePx: Math.max(minimumFontSizePx, next.fontSizePx - 1) };
  }
  return shiftInsideSafeArea(next);
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
    const measuredWidthPx = measureSingleLineText(context, part.text, part.style);
    if (measuredWidthPx > part.style.boxWidthPx) details.push({ target: part.target, measuredWidthPx, safeWidthPx: part.style.boxWidthPx });
  }
  for (const cue of group.subtitleCues) {
    const measuredWidthPx = measureSingleLineText(context, cue.text, style.subtitle);
    if (measuredWidthPx > style.subtitle.boxWidthPx) details.push({ target: 'subtitle', cueId: cue.id, measuredWidthPx, safeWidthPx: style.subtitle.boxWidthPx });
  }
  return details;
}

/** 探测文本必须同时含中西文：只测拉丁会漏掉中文字体不生效的情况。 */
const FONT_PROBE_TEXT = '产品素材Ag';
const FONT_PROBE_SIZE_PX = 36;
/** 确定不存在的 sentinel family：用它渲染出的结果即「回落到默认字体」的基线。 */
const FONT_PROBE_SENTINEL = '__cs_missing_font__';

function probeFontFingerprint(family: string): { hash: string; width: number } {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 120;
  const context = canvas.getContext('2d');
  if (!context) return { hash: '', width: 0 };
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = `${FONT_PROBE_SIZE_PX}px ${JSON.stringify(family)}`;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#000000';
  context.fillText(FONT_PROBE_TEXT, 8, 80);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let hash = 2166136261; // FNV-1a
  for (let index = 3; index < data.length; index += 4) {
    hash ^= data[index];
    hash = Math.imul(hash, 16777619);
  }
  return { hash: (hash >>> 0).toString(16), width: context.measureText(FONT_PROBE_TEXT).width };
}

/**
 * 校验字体真实生效：与「确定不存在的 sentinel」渲染完全一致即判定该字体未生效
 * （浏览器静默回落到默认字体）。调用方需先 await document.fonts.ready。
 */
export function assertFontsEffective(families: Iterable<string>): void {
  const sentinel = probeFontFingerprint(FONT_PROBE_SENTINEL);
  for (const family of new Set(families)) {
    if (!family) continue;
    const probe = probeFontFingerprint(family);
    if (probe.hash && probe.hash === sentinel.hash && probe.width === sentinel.width) {
      throw new Error(`字体「${family}」未生效：系统未安装或名称无效`);
    }
  }
}

export async function createOverlayBundlePayload(group: FinalEditGroupView, preset: OutputPresetId) {
  const style = group.textStyles[preset];
  const requiredFonts = new Set([style.coverPrimary.fontFamily, style.coverSecondary.fontFamily, style.subtitle.fontFamily]);
  // document.fonts.check() 对任何字符串都返回 true，挡不住无效字体——改用像素比对。
  await document.fonts.ready;
  assertFontsEffective(requiredFonts);
  const titleCanvas = canvasFor(preset);
  const titleContext = titleCanvas.getContext('2d');
  if (!titleContext) throw new Error('浏览器 Canvas 不可用');
  drawText(titleContext, group.coverTitle.primary.text, style.coverPrimary);
  drawText(titleContext, group.coverTitle.secondary.text, style.coverSecondary);
  const titlePrimaryWidth = renderSingleTextWidth(preset, group.coverTitle.primary.text, style.coverPrimary);
  const titleSecondaryWidth = renderSingleTextWidth(preset, group.coverTitle.secondary.text, style.coverSecondary);
  const titleCompositeWidth = renderedAlphaWidth(titleCanvas);
  const overflowDetails: TextOverflowDetail[] = [];
  if (titlePrimaryWidth > style.coverPrimary.boxWidthPx) overflowDetails.push({ target: 'coverPrimary', measuredWidthPx: titlePrimaryWidth, safeWidthPx: style.coverPrimary.boxWidthPx });
  if (titleSecondaryWidth > style.coverSecondary.boxWidthPx) overflowDetails.push({ target: 'coverSecondary', measuredWidthPx: titleSecondaryWidth, safeWidthPx: style.coverSecondary.boxWidthPx });

  const subtitles: Record<string, string> = {};
  const subtitleWidths: Record<string, number> = {};
  for (const cue of group.subtitleCues) {
    const canvas = canvasFor(preset);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器 Canvas 不可用');
    drawText(context, cue.text, style.subtitle);
    const measured = renderedAlphaWidth(canvas);
    subtitleWidths[cue.id] = measured;
    if (measured > style.subtitle.boxWidthPx) overflowDetails.push({ target: 'subtitle', cueId: cue.id, measuredWidthPx: measured, safeWidthPx: style.subtitle.boxWidthPx });
    subtitles[cue.id] = toBase64(canvas);
  }
  if (overflowDetails.length) throw new TextOverflowError(overflowDetails);
  return {
    groupRevision: group.revision,
    titlePngBase64: toBase64(titleCanvas),
    subtitlePngs: subtitles,
    manifest: {
      width: titleCanvas.width,
      height: titleCanvas.height,
      overflow: false,
      measurements: { titlePrimaryWidth, titleSecondaryWidth, titleCompositeWidth, subtitleWidths },
      cues: group.subtitleCues.map((cue) => ({ id: cue.id, startUs: cue.startUs, endUs: cue.endUs })),
    },
  };
}
