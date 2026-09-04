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

/** 斜体剪切角度(度)。librsvg 不会为没有 italic 字面的字体合成斜体,统一用 skewX 合成。 */
const ITALIC_SKEW_DEG = 12;
const ITALIC_SKEW_TAN = Math.tan(ITALIC_SKEW_DEG * Math.PI / 180);

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
 *
 * 斜体走绕基线的 skewX(-12) 剪切合成(librsvg 不给没有 italic 字面的字体合成斜体、
 * 浏览器会,统一走剪切才能让预览与成片同款);可用宽度先扣 overhang 再缩字号,锚点不动。
 * **已知残留(有意保留)**:剪切绕基线做,字身上半部相对锚点右移 ≈ ascender × tan(12°)
 * ≈ 0.17 × 字号,这部分溢出落在锚点一侧(right 对齐最明显),而缩字号是宽度方向的杠杆,
 * 结构上够不着——要根治只能移锚点(破坏 left/right 对齐语义)或改绕中线剪切(引入随字体
 * 变化的 ascender 猜测常量,且只减半不根治)。实测 80px / PingFang SC 右对齐越过右锚点
 * 1~7px;默认样式是 center 对齐且对齐框左右各留 10% 画幅(1080 宽留 108px),该残留碰不
 * 到画面边缘,按已知取舍保留。
 */
export function textStyleToSvgElements(style: TextStyle, text: string, outputSize: { width: number; height: number }): string {
  const x = style.x * outputSize.width;
  const y = style.y * outputSize.height;
  const anchor = style.align === 'left' ? 'start' : style.align === 'right' ? 'end' : 'middle';
  let fontSize = style.fontSizePx * (style.scale ?? 1);
  if (text && style.boxWidthPx > 0) {
    // 斜体开启时,skewX 会让字形横向溢出对齐框:可用宽度先扣掉 overhang 再缩字号。
    // overhang 依赖最终字号,所以按「估一次 → 缩 → 用缩后字号重估 → 再缩」收敛一轮
    // 即可(不必循环)。非斜体 overhang 恒为 0,只算一轮,与历史行为逐字节一致。
    // 0.5 倍下限钳的是**总收缩比**:两轮各钳一次会把斜体的实际下限压到 0.25 倍
    // (同一段文字开不开斜体差一倍字号),所以先把两轮比值乘起来,最后统一钳一次。
    const fitRatio = (size: number): number => {
      const overhang = style.italic ? size * ITALIC_SKEW_TAN : 0;
      const usableWidth = Math.max(1, style.boxWidthPx - overhang);
      const estimated = estimateSingleLineWidth(text, size);
      return estimated > usableWidth ? usableWidth / estimated : 1;
    };
    let ratio = fitRatio(fontSize);
    if (style.italic) ratio *= fitRatio(fontSize * ratio);
    fontSize *= Math.max(0.5, ratio);
  }
  const fontFamily = `${style.fontFamily}, ${FONT_FALLBACK_STACK}`;
  const strokeAttr = style.stroke.enabled && style.stroke.widthPx > 0
    ? ` stroke="${escapeXml(style.stroke.color)}" stroke-width="${round2(style.stroke.widthPx)}" stroke-linejoin="round" paint-order="stroke fill"`
    : '';
  const escapedText = escapeXml(text);
  // 斜体用绕文字锚点的 skewX 剪切合成:librsvg 不会为没有 italic 字面的字体合成
  // 斜体而浏览器会,预览与成片因此不一致;统一走剪切后两处同款。阴影与描边随组
  // 一起剪切,保持视觉厚度一致;锚点坐标不动,只缩字号做 overhang 补偿。
  const textElement = (px: number, py: number, fill: string, opacityAttr: string) => {
    // 属性串两个分支共用一份:分开写过一次,两边独立演化会静默分叉。
    const attrs = `text-anchor="${anchor}" font-family="${escapeXml(fontFamily)}" font-size="${round2(fontSize)}" fill="${fill}"${opacityAttr}${strokeAttr}`;
    if (style.italic) {
      return `<g transform="translate(${Math.round(px)},${Math.round(py)}) skewX(-${ITALIC_SKEW_DEG})"><text x="0" y="0" ${attrs}>${escapedText}</text></g>`;
    }
    return `<text x="${Math.round(px)}" y="${Math.round(py)}" ${attrs}>${escapedText}</text>`;
  };
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
