// Rasterize the workbench's shared text styles plus project-specified packaging.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { defaultTextStyle } from '../lib/media-core/cover-domain.ts';
import { textStyleToSvgElements, escapeXml } from '../lib/media-core/cover-title-svg.ts';
const project = path.resolve(process.argv[2]);
const timeline = JSON.parse(fs.readFileSync(path.join(project, 'tools/timeline.json'), 'utf8'));
const packaging = JSON.parse(fs.readFileSync(path.join(project, 'tools/packaging.json'), 'utf8'));
const { width, height } = timeline;
const size = { width, height };
const dir = path.join(project, 'tools/overlays');
fs.mkdirSync(dir, { recursive: true });
const cache = new Map();
const svg = content => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${content}</svg>`;
function text(content, x, y, fontSize, color = '#fff') {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="Microsoft YaHei, sans-serif" font-size="${fontSize}">${escapeXml(content)}</text>`;
}
for (let frame = 0; frame < timeline.frames; frame++) {
  let content = '';
  if (frame < timeline.introFrames) {
    content += textStyleToSvgElements(defaultTextStyle('coverPrimary', width), timeline.coverPrimary, size);
    content += textStyleToSvgElements(defaultTextStyle('coverSecondary', width), timeline.coverSecondary, size);
  } else {
    for (const sub of timeline.subtitles.filter(s => frame >= s.startFrame && frame < s.endFrame)) content += textStyleToSvgElements(defaultTextStyle('subtitle', width), sub.text, size);
    for (const item of packaging.filter(s => frame >= s.startFrame && frame < s.endFrame)) {
      const { x, y, w, h } = item;
      content += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="#161614" fill-opacity=".68"/>`;
      let title = item.title;
      if (item.countTo !== undefined) title = `${Math.round(item.countTo * Math.min(1, (frame - item.startFrame) / 12))} mm`;
      content += text(title, x + 28, y + 62, item.countTo !== undefined ? 54 : 44);
      if (item.sub) content += text(item.sub, x + 28, y + 108, 28, '#eee5da');
      if (item.dot) {
        const [dx, dy] = item.dot;
        content += `<path d="M${x + w / 2},${y + h} L${dx},${dy}" fill="none" stroke="#fff" stroke-width="2"/><circle cx="${dx}" cy="${dy}" r="7" fill="#fff"/>`;
      }
    }
  }
  const markup = svg(content);
  const hash = crypto.createHash('sha256').update(markup).digest('hex');
  if (!cache.has(hash)) cache.set(hash, await sharp(Buffer.from(markup)).png().toBuffer());
  await fs.promises.writeFile(path.join(dir, `${String(frame).padStart(5, '0')}.png`), cache.get(hash));
}
const titleSvg = svg(textStyleToSvgElements(defaultTextStyle('coverPrimary', width), timeline.coverPrimary, size) + textStyleToSvgElements(defaultTextStyle('coverSecondary', width), timeline.coverSecondary, size));
await sharp(path.join(project, timeline.coverImage)).resize(width, height, { fit: 'cover' }).composite([{ input: Buffer.from(titleSvg) }]).png().toFile(path.join(project, 'tools/cover.png'));
console.log(`Text layers: ${timeline.frames} frames, ${cache.size} unique states; cover generated`);
