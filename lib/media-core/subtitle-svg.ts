import type { TextStyle } from './cover-types.ts';
import { textStyleToSvgElements } from './cover-title-svg.ts';

const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const closing = /^[，。！？；：、）》】」』,.!?;:)]$/u;

function widthUnits(text: string): number {
  if (/^\s+$/u.test(text)) return 0.35;
  if (/^[ilI.,:;'!|]$/u.test(text)) return 0.35;
  if (/^[MW@%]$/u.test(text)) return 1;
  if (/^[\x20-\x7e]$/u.test(text)) return 0.65;
  return 1.1; // Conservative CJK/emoji allowance; never split a combining sequence.
}

/** Display-only wrapping. Cue text, time and speech provenance remain untouched.
 * The final line keeps the user's baseline; additional lines grow upward.
 * Shared by formula preview and export. Titles, classic/1 and ordinary batches keep their renderer.
 */
export function subtitleStyleToSvgElements(style: TextStyle, text: string, size: { width: number; height: number }): string {
  const fontSize = style.fontSizePx * (style.scale ?? 1);
  const padding = (style.stroke.enabled ? style.stroke.widthPx : 0)
    + (style.shadow.enabled ? style.shadow.distancePx : 0) + (style.italic ? fontSize * 0.22 : 0);
  const width = Math.max(1, Math.min(style.boxWidthPx, size.width * 0.9) - padding * 2);
  const tokens = Array.from(graphemes.segment(text.replace(/\r\n?/g, '\n')), item => item.segment);
  if (!tokens.includes('\n') && tokens.reduce((sum, token) => sum + widthUnits(token), 0) * fontSize <= width) {
    return textStyleToSvgElements(style, text, size);
  }
  function wrap(atSize: number): string[] {
    const lines: string[] = [];
    let line = '', used = 0;
    for (const token of tokens) {
      if (token === '\n') { lines.push(line); line = ''; used = 0; continue; }
      const unit = widthUnits(token) * atSize;
      if (line && used + unit > width && !(closing.test(token) && used <= width)) {
        // Prefer a word boundary for Latin text; CJK can break between graphemes.
        const space = line.lastIndexOf(' ');
        if (space >= line.length / 2 && /[A-Za-z]/.test(token) && /[A-Za-z]$/.test(line)) {
          lines.push(line.slice(0, space)); line = line.slice(space + 1);
          used = Array.from(graphemes.segment(line), item => widthUnits(item.segment) * atSize).reduce((a, b) => a + b, 0);
        } else { lines.push(line); line = ''; used = 0; }
      }
      line += token; used += unit;
    }
    lines.push(line);
    return lines;
  }
  let actualFont = fontSize, lines = wrap(actualFont);
  const lineHeight = Math.max(1, style.lineHeight);
  const availableHeight = Math.max(fontSize, style.y * size.height - size.height * 0.05 - padding);
  // Fit extreme multiline cues vertically without throwing away text or inventing word times.
  for (let attempt = 0; attempt < 12 && lines.length * actualFont * lineHeight > availableHeight; attempt++) {
    actualFont *= Math.min(0.9, availableHeight / (lines.length * actualFont * lineHeight));
    lines = wrap(actualFont);
  }
  return lines.map((line, index) => textStyleToSvgElements({ ...style, fontSizePx: actualFont, scale: 1,
    boxWidthPx: width, y: style.y - (lines.length - 1 - index) * actualFont * lineHeight / size.height }, line, size)).join('');
}
