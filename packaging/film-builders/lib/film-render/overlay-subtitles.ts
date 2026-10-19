import path from 'node:path';
import { openSync } from 'fontkit';
import { defaultTextStyle } from '../media-core/cover-domain.ts';
import { escapeXml } from '../media-core/cover-title-svg.ts';
import { classicTemplateDir, CLASSIC_ASSETS, sha256 } from './files.ts';
import { FilmRenderError, requireInput } from './errors.ts';

export const SUBTITLE_FONT_ASSET = 'assets/fonts/SourceHanSansCN-VF.ttf';

/** Outline the bundled font so sharp cannot silently substitute a system font. */
export function createOverlaySubtitleRenderer() {
  const file = path.join(classicTemplateDir(), SUBTITLE_FONT_ASSET);
  const hash = sha256(file);
  if (hash !== CLASSIC_ASSETS[SUBTITLE_FONT_ASSET]) {
    throw new FilmRenderError('ASSET_HASH_MISMATCH', `字幕字体 SHA256 不符: ${file}`, 3);
  }
  const font = openSync(file).getVariation({ wght: 400 });
  const style = { ...defaultTextStyle('subtitle', 1080), fontFamily: 'Source Han Sans CN VF' };
  return {
    style,
    font: { asset: `templates/classic/1/${SUBTITLE_FONT_ASSET}`, sha256: hash, weight: 400 },
    svg(text: string): string {
      for (const char of text) {
        requireInput(font.hasGlyphForCodePoint(char.codePointAt(0)!), 'SUBTITLE_GLYPH_MISSING', `思源黑体缺少字幕字符: ${char}`);
      }
      const run = font.layout(text);
      const advance = run.positions.reduce((sum, position) => sum + position.xAdvance, 0);
      const size = style.fontSizePx * Math.max(0.5, Math.min(1, style.boxWidthPx / Math.max(1, advance / font.unitsPerEm * style.fontSizePx)));
      const scale = size / font.unitsPerEm;
      const left = style.x * 1080 - advance * scale / 2;
      let x = 0, y = 0;
      const paths = run.glyphs.map((glyph, index) => {
        const position = run.positions[index];
        const element = `<path transform="translate(${x + position.xOffset},${y + position.yOffset})" d="${glyph.path.toSVG()}"/>`;
        x += position.xAdvance; y += position.yAdvance;
        return element;
      }).join('');
      const layer = (dx: number, dy: number, color: string, opacity: number) =>
        `<g transform="translate(${left + dx},${Math.round(style.y * 1440) + dy}) scale(${scale},${-scale})" fill="${escapeXml(color)}" fill-opacity="${opacity}" stroke="${escapeXml(style.stroke.color)}" stroke-width="${style.stroke.widthPx / scale}" stroke-linejoin="round" paint-order="stroke fill">${paths}</g>`;
      const radians = style.shadow.angleDeg * Math.PI / 180;
      return `<svg width="1080" height="1440" xmlns="http://www.w3.org/2000/svg">${layer(Math.cos(radians) * style.shadow.distancePx, Math.sin(radians) * style.shadow.distancePx, style.shadow.color, style.shadow.opacity)}${layer(0, 0, style.color, 1)}</svg>`;
    },
  };
}
