// lib/final-video/cover.ts
/**
 * 封面 = 首个片段 0.5s 处抽帧 + 模板化排版。
 * 模板布局/色彩由 cover-templates.ts 定义，此处负责生成 FFmpeg drawtext/drawbox 参数。
 */
import { escapeDrawtext, escapeSubtitlePath } from './ffmpeg-graph.ts';
import { resolveTemplate, type CoverTemplateId } from './cover-templates.ts';

export interface CoverArgsInput {
  sourceVideoPath: string;
  titleText: string;
  titleSize: number;
  titleColor: string;
  width: number;
  height: number;
  fontFile: string;
  outJpgPath: string;
  templateId?: CoverTemplateId | string;
  sellingPoints?: string[];
}

/** 将长标题按可用宽度折行，超两行时缩小字号。CJK 按 fontSize ≈ 字宽估算。 */
function wrapTitle(
  text: string,
  fontSize: number,
  boxPxWidth: number,
  maxLines = 2
): Array<{ line: string; effectiveSize: number }> {
  const charsPerLine = Math.max(1, Math.floor(boxPxWidth / fontSize));
  if (text.length <= charsPerLine) return [{ line: text, effectiveSize: fontSize }];

  // 先按原始字号折行
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    lines.push(remaining.slice(0, charsPerLine));
    remaining = remaining.slice(charsPerLine);
  }

  // 超过 maxLines 行则缩字号，保证能装下
  let effectiveSize = fontSize;
  if (lines.length > maxLines) {
    effectiveSize = Math.max(24, Math.floor(fontSize * maxLines / lines.length));
  }
  return lines.slice(0, maxLines).map((line) => ({ line, effectiveSize }));
}

function fitSingleLine(text: string, fontSize: number, boxPxWidth: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const maxChars = Math.max(4, Math.floor(boxPxWidth / Math.max(1, fontSize)));
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function buildCoverArgs(input: CoverArgsInput): string[] {
  const { width: w, height: h } = input;
  const template = resolveTemplate(input.templateId);
  const fontPart = input.fontFile ? `:fontfile='${escapeSubtitlePath(input.fontFile)}'` : '';
  const vfParts: string[] = [];

  // Step 1: Scale and crop to target dimensions
  vfParts.push(`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`);

  // Step 2: Background overlay (semi-transparent dark overlay for luxury templates)
  if (template.theme.backgroundOverlay) {
    vfParts.push(`drawbox=x=0:y=0:w=${w}:h=${h}:color=${template.theme.backgroundOverlay}:t=fill`);
  }

  // Step 3: Decorative accent bar (luxury templates only)
  if (template.id !== 'minimal-01') {
    const barX = Math.round(w * 0.08);
    const titleBoxY = Math.round(h * template.layout.titleBox.yPct / 100);
    const barY = Math.max(0, titleBoxY - Math.round(h * 0.025));
    const barW = Math.round(w * 0.025);
    const barH = Math.max(2, Math.round(h * 0.004));
    vfParts.push(
      `drawbox=x=${barX}:y=${barY}:w=${barW}:h=${barH}:color=${template.theme.accentColor}@0.9:t=fill`
    );
  }

  // Step 4: Title text（支持折行，超长时自动缩字号）
  const title = input.titleText.trim();
  if (title) {
    const { titleBox } = template.layout;
    const titleColor = template.theme.titleColor;
    const boxPxW = Math.round((w * titleBox.widthPct) / 100);
    const titleLines = wrapTitle(title, input.titleSize, boxPxW);
    const baseY = Math.round((h * titleBox.yPct) / 100);

    titleLines.forEach(({ line, effectiveSize }, i) => {
      const xExpr =
        titleBox.align === 'center'
          ? `(w-text_w)/2`
          : `${Math.round((w * titleBox.xPct) / 100)}`;
      const yVal = baseY + i * Math.round(effectiveSize * 1.3);

      vfParts.push(
        `drawtext=text='${escapeDrawtext(line)}':fontsize=${effectiveSize}` +
          `:fontcolor=${titleColor}:x=${xExpr}:y=${yVal}` +
          `:borderw=4:bordercolor=black${fontPart}`
      );
    });
  }

  // Step 5: Selling points
  const points = (input.sellingPoints || []).filter((p) => p.trim());
  const spBox = template.layout.sellingPointsBox;
  if (points.length > 0 && spBox) {
    const maxItems = spBox.maxItems;
    const spFontSize = Math.round(input.titleSize * 0.5);
    const spBoxPxW = Math.round((w * spBox.widthPct) / 100);
    const displayItems = points
      .slice(0, maxItems)
      .map((point) => fitSingleLine(point, spFontSize, spBoxPxW))
      .filter(Boolean);
    const lineH = Math.round(spFontSize * 1.7);
    const bodyColor = template.theme.bodyColor;
    const spX = Math.round((w * spBox.xPct) / 100);
    const spBaseY = Math.round((h * spBox.yPct) / 100);

    displayItems.forEach((point, i) => {
      const yVal = spBaseY + i * lineH;
      vfParts.push(
        `drawtext=text='${escapeDrawtext(point.trim())}':fontsize=${spFontSize}` +
          `:fontcolor=${bodyColor}:x=${spX}:y=${yVal}` +
          `:borderw=2:bordercolor=black${fontPart}`
      );
    });
  }

  return [
    '-hide_banner',
    '-ss',
    '0.5',
    '-i',
    input.sourceVideoPath,
    '-vf',
    vfParts.join(','),
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-y',
    input.outJpgPath,
  ];
}
