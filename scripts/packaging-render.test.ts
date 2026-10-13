import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { PACKAGING_TEMPLATE_IDS } from '../lib/media-core/packaging-vars.ts';

const root = path.resolve('outputs/packaging-render-verification');
await fs.mkdir(root, { recursive: true });
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.resolve('packaging');
const { runFfmpeg, probeVideoMedia } = await import('../lib/ffmpeg.ts');
const { renderVideoPackaging } = await import('../lib/media-core/packaging-render.ts');
const controller = new AbortController();
for (const template of PACKAGING_TEMPLATE_IDS) {
  if (process.env.PACKAGING_TEST_TEMPLATE && process.env.PACKAGING_TEST_TEMPLATE !== template) continue;
  const dir = path.join(root, template);
  await fs.mkdir(dir, { recursive: true });
  const video = path.join(dir, 'video.mp4');
  const cover = path.join(dir, 'cover.jpg');
  await sharp({ create: { width: 360, height: 480, channels: 3, background: '#aabbaa' } }).jpeg().toFile(cover);
  const before = await fs.readFile(cover);
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=0xaabbaa:s=360x480:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '2', video], { signal: controller.signal });
  await renderVideoPackaging({ videoPath: video, coverPath: cover, totalSec: 2, signal: controller.signal,
    config: { enabled: true, template, varsOverrides: { title: '实木餐边柜', subtitle: '客厅收纳新选择', point1: '环保实木', point2: '大容量收纳', point3: '灵活分区' },
      pointCues: [{ id: 'p_test', text: '大容量收纳', startSec: 0.9, endSec: 1.9 }], pointCuesMode: 'timed',
      layouts: { [template]: { cover: { title: { x: 42, y: 12, scale: 0.9, rotate: -3 } } } } } });
  const probe = await probeVideoMedia(video);
  assert.equal(probe.width, 360); assert.equal(probe.height, 480); assert.equal(probe.fps, 24);
  assert.equal(probe.hasAudio, true); assert.equal(probe.audioSampleRate, 48000);
  assert.equal(probe.videoCodec, 'h264'); assert.equal(probe.pixelFormat, 'yuv420p');
  assert.ok(Math.abs(probe.durationUs / 1e6 - 2) < 0.12);
  assert.notDeepEqual(await fs.readFile(cover), before, '正式封面包含包装');
  await runFfmpeg(['-y', '-ss', '1.4', '-i', video, '-frames:v', '1', path.join(dir, 'body.png')], { signal: controller.signal });
  console.log(`${template}: actual transparent render, packaged cover, audio and video contracts passed`);
}
console.log(`Packaging render evidence: ${root}`);
