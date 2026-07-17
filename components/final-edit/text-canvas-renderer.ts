import type { FinalEditGroupView, OutputPresetId, SubtitleCue, TextStyle } from '@/lib/final-edit/types';
import { OUTPUT_PRESETS } from '@/lib/final-edit/types';

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
  return ctx.measureText(text).width + (style.stroke.enabled ? style.stroke.widthPx * 2 : 0) + (style.shadow.enabled ? style.shadow.blurPx * 2 + style.shadow.distancePx : 0);
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
  if (titlePrimaryWidth > style.coverPrimary.boxWidthPx || titleSecondaryWidth > style.coverSecondary.boxWidthPx) throw new Error('封面标题超出单行安全宽度，请调整文字或样式');
  drawText(titleContext, group.coverTitle.primary.text, style.coverPrimary);
  drawText(titleContext, group.coverTitle.secondary.text, style.coverSecondary);

  const subtitles: Record<string, string> = {};
  const subtitleWidths: Record<string, number> = {};
  const overflows: string[] = [];
  for (const cue of group.subtitleCues) {
    const canvas = canvasFor(preset);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器 Canvas 不可用');
    const measured = measureText(context, cue.text, style.subtitle);
    if (measured > style.subtitle.boxWidthPx) overflows.push(cue.id);
    subtitleWidths[cue.id] = measured;
    drawText(context, cue.text, style.subtitle);
    subtitles[cue.id] = toBase64(canvas);
  }
  if (overflows.length) throw new Error(`有 ${overflows.length} 条字幕超出单行安全宽度，请调整文字或样式`);
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
