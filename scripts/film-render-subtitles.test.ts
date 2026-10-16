import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { createOverlaySubtitleRenderer } from '../lib/film-render/overlay-subtitles.ts';
import { resolveDefaultCjkFontFamily, setDefaultCjkFontFamily } from '../lib/media-core/cover-domain.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previous = process.env.CREATIVE_STUDIO_PACKAGING_DIR;
process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.join(repo, 'packaging');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'film-subtitle-font-'));
try {
  const renderer = createOverlaySubtitleRenderer();
  const text = '思源黑体：实拍细节 ABC 123';
  const svg = renderer.svg(text);
  assert.doesNotMatch(svg, /<text\b|font-family=/); // No system font lookup during rasterization.
  assert.equal(renderer.font.sha256, '25a01e41b5cc99893eb35a6cd2cc7611841dc19eb03cbaf7f0c1de8210f2ba0b');
  const raster = await sharp(Buffer.from(svg)).png().toBuffer();
  setDefaultCjkFontFamily('deliberately-unavailable-font');
  assert.deepEqual(await sharp(Buffer.from(createOverlaySubtitleRenderer().svg(text))).png().toBuffer(), raster);
  const { data, info } = await sharp(raster).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, maxX = -1, minY = info.height, maxY = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] < 16) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  assert.ok(maxX - minX > 500 && maxX - minX < 880, `unexpected text width: ${maxX - minX}`);
  assert.ok(Math.abs((minX + maxX) / 2 - 540) < 15, 'subtitle must stay centered');
  assert.ok(minY > 1100 && maxY < 1210 && maxY - minY > 40, 'glyphs must be upright and inside subtitle area');
  assert.throws(() => renderer.svg('\u0378'), /缺少字幕字符/);
  // A missing or substituted font must fail instead of silently falling back.
  process.env.CREATIVE_STUDIO_PACKAGING_DIR = temporary;
  assert.throws(() => createOverlaySubtitleRenderer());
  const corrupt = path.join(temporary, 'templates/classic/1/assets/fonts/SourceHanSansCN-VF.ttf');
  fs.mkdirSync(path.dirname(corrupt), { recursive: true });
  fs.writeFileSync(corrupt, 'incorrect font');
  assert.throws(() => createOverlaySubtitleRenderer(), /SHA256/);
  console.log('PASS: bundled Source Han glyph raster, placement, system-font independence, missing glyph/font and hash guards');
} finally {
  setDefaultCjkFontFamily(resolveDefaultCjkFontFamily());
  if (previous === undefined) delete process.env.CREATIVE_STUDIO_PACKAGING_DIR;
  else process.env.CREATIVE_STUDIO_PACKAGING_DIR = previous;
  fs.rmSync(temporary, { recursive: true, force: true });
}
