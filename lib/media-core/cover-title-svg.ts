import type { TextStyle } from './cover-types.ts';

/**
 * 标题文字的 SVG 构造：纯字符串计算，没有任何 Node 依赖（不碰 sharp、fs、
 * better-sqlite3），所以既能在服务端合成封面，也能被客户端组件直接 import
 * 做预览。预览与成片因此是同一份实现，不是两套近似。
 *
 * 坐标一律用输出像素：调用方给 outputSize，浏览器侧只要把同样的 outputSize
 * 写进 <svg viewBox>，缩放交给浏览器，不需要任何预览缩放系数。
 */

/** SVG 文本转义。batch-renderer 的字幕图层与封面标题共用这一份实现。 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

export const FONT_FALLBACK_STACK = 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC, Heiti SC, sans-serif';

const CJK_WIDE_CHAR = /[ᄀ-ᅟ⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/u;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 单行近似行宽:CJK 按字号、拉丁按 0.55 倍字号估算。 */
function estimateSingleLineWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) width += CJK_WIDE_CHAR.test(char) ? fontSize : fontSize * 0.55;
  return width;
}

/**
 * TextStyle → SVG `<text>` 元素串(阴影开启时含偏移下层)。
 * 服务端单行近似:文本按 boxWidthPx 估算行宽,超限时等比缩字号到刚好放下
 * (下限 0.5 倍,缩不下就保持 0.5 倍),不做多行折行。
 */
export function textStyleToSvgElements(style: TextStyle, text: string, outputSize: { width: number; height: number }): string {
  const x = style.x * outputSize.width;
  const y = style.y * outputSize.height;
  const anchor = style.align === 'left' ? 'start' : style.align === 'right' ? 'end' : 'middle';
  let fontSize = style.fontSizePx * (style.scale ?? 1);
  if (text && style.boxWidthPx > 0) {
    const estimated = estimateSingleLineWidth(text, fontSize);
    if (estimated > style.boxWidthPx) fontSize *= Math.max(0.5, style.boxWidthPx / estimated);
  }
  const fontFamily = `${style.fontFamily}, ${FONT_FALLBACK_STACK}`;
  const italicAttr = style.italic ? ' font-style="italic"' : '';
  const strokeAttr = style.stroke.enabled && style.stroke.widthPx > 0
    ? ` stroke="${escapeXml(style.stroke.color)}" stroke-width="${round2(style.stroke.widthPx)}" stroke-linejoin="round" paint-order="stroke fill"`
    : '';
  const escapedText = escapeXml(text);
  const textElement = (px: number, py: number, fill: string, opacityAttr: string) =>
    `<text x="${Math.round(px)}" y="${Math.round(py)}" text-anchor="${anchor}" font-family="${escapeXml(fontFamily)}" font-size="${round2(fontSize)}"${italicAttr} fill="${fill}"${opacityAttr}${strokeAttr}>${escapedText}</text>`;
  const body = textElement(x, y, escapeXml(style.color), '');
  if (!style.shadow.enabled) return body;
  // librsvg 的滤镜(模糊)支持有限,阴影用两层同内容 text 近似:下层按
  // (distancePx, angleDeg) 极坐标偏移、带透明度,忽略 blurPx;描边与正文一致,
  // 保持视觉厚度一致。
  const radians = style.shadow.angleDeg * Math.PI / 180;
  const dx = Math.cos(radians) * style.shadow.distancePx;
  const dy = Math.sin(radians) * style.shadow.distancePx;
  return textElement(x + dx, y + dy, escapeXml(style.shadow.color), ` fill-opacity="${round2(style.shadow.opacity)}"`) + body;
}
