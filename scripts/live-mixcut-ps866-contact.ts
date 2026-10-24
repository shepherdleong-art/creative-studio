/** Local, read-only source frame inspection. Does not confirm speech or approve clips. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { dataRoot } from '../lib/data-root.ts';
import { runFfmpeg } from '../lib/ffmpeg.ts';

const args = process.argv.slice(2);
const arg = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (!arg('--audit')) throw new Error('Usage: node scripts/formula-ps866-contact.ts --audit <审计目录>');
const audit = fs.realpathSync(arg('--audit')!);
const summary = JSON.parse(fs.readFileSync(path.join(audit, 'summary.json'), 'utf8'));
type Media = { relativePath: string; bytes: number; modifiedAt: string; logicalCode: string | null;
  excludedReason: string | null; media?: { durationUs: number } };
type Sample = { scriptNumber: string; platform: string; slots: Array<{ position: number; logicalCode: string; sourceFiles: string[] }> };
const files: Media[] = JSON.parse(fs.readFileSync(path.join(audit, 'files.json'), 'utf8'));
const samples: Sample[] = JSON.parse(fs.readFileSync(path.join(audit, 'sample-candidates.json'), 'utf8'));
const source = fs.realpathSync(path.join(summary.source, '预处理'));
const output = path.join(dataRoot(), 'outputs', 'formula-ps866', `contact-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(output, { recursive: true });
const cache = new Map<string, Array<{ path: string; seconds: number }>>();
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const text = (value: string, width: number, height: number) => Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#181818"/><text x="12" y="26" fill="white" font-size="18" font-family="Microsoft YaHei">${escape(value)}</text></svg>`);
const evidence: unknown[] = [];
for (const sample of samples) {
  const width = 960, rowHeight = 276;
  const layers: sharp.OverlayOptions[] = [{ input: text(`脚本 ${sample.scriptNumber} · ${sample.platform} · 原片 20% / 50% / 80% 帧（非成片）`, width, 40), left: 0, top: 0 }];
  for (let row = 0; row < sample.slots.length; row++) {
    const slot = sample.slots[row];
    if (slot.sourceFiles.length !== 1) throw new Error(`${slot.logicalCode} 需要先明确选片，本工具不代选`);
    const relative = slot.sourceFiles[0], file = files.find(item => item.relativePath === relative);
    if (!file?.media || file.excludedReason) throw new Error('素材未核验或已排除');
    const filename = fs.realpathSync(path.join(source, relative));
    if (path.relative(source, filename).startsWith('..')) throw new Error('原片超出源目录');
    const stat = fs.statSync(filename);
    if (stat.size !== file.bytes || stat.mtime.toISOString() !== file.modifiedAt) throw new Error('原片自审计后已变化');
    if (!cache.has(relative)) {
      const frames = [];
      for (const fraction of [0.2, 0.5, 0.8]) {
        const seconds = file.media.durationUs / 1_000_000 * fraction;
        const identity = createHash('sha256').update(`${relative}:${seconds}`).digest('hex').slice(0, 16);
        const image = path.join(output, `frame-${identity}.jpg`);
        await runFfmpeg(['-y', '-ss', String(seconds), '-i', filename, '-frames:v', '1', '-an',
          '-vf', 'scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2', '-q:v', '3', image], { timeoutMs: 30_000 });
        frames.push({ path: image, seconds });
      }
      cache.set(relative, frames);
    }
    const frames = cache.get(relative)!;
    layers.push({ input: text(`${slot.position}. ${slot.logicalCode} · ${frames.map(frame => `${frame.seconds.toFixed(2)}s`).join(' / ')}`, width, 36), left: 0, top: 40 + row * rowHeight });
    frames.forEach((frame, column) => layers.push({ input: frame.path, left: column * 320, top: 76 + row * rowHeight }));
    evidence.push({ scriptNumber: sample.scriptNumber, position: slot.position, logicalCode: slot.logicalCode, relativePath: relative, frames });
  }
  await sharp({ create: { width, height: 40 + sample.slots.length * rowHeight, channels: 3, background: '#181818' } })
    .composite(layers).jpeg({ quality: 90 }).toFile(path.join(output, `script-${sample.scriptNumber}.jpg`));
  console.log(`已生成脚本 ${sample.scriptNumber} 的原片画面检查图`);
}
fs.writeFileSync(path.join(output, 'frames.json'), JSON.stringify({ audit, source, purpose: 'visual_inspection_only', evidence }, null, 2));
console.log(output);
