// 运行：node scripts/packaging-auto-layout-render.test.ts
// 真实 FFmpeg + Chrome + HyperFrames：验证 v2 正式导出只使用冻结布局资源。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';



import type { FinalEditPackagingConfig, PackagingVars } from '../lib/media-core/packaging-vars.ts';
import type { PackagingStickerInstance } from '../lib/media-core/packaging-stickers.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-auto-layout-render-'));
const previousDataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const previousPackagingDir = process.env.CREATIVE_STUDIO_PACKAGING_DIR;
const source = path.resolve('packaging');
const isolatedPackaging = path.join(root, 'resources');
fs.mkdirSync(isolatedPackaging, { recursive: true });
for (const entry of ['templates', 'fonts', 'stickers', 'auto-layout', 'layout-service.mjs', 'package-video.mjs', 'win-hide-spawn.cjs']) {
  fs.cpSync(path.join(source, entry), path.join(isolatedPackaging, entry), { recursive: true });
}
for (const entry of ['node_modules', 'runtime']) fs.symlinkSync(fs.realpathSync(path.join(source, entry)), path.join(isolatedPackaging, entry), process.platform === 'win32' ? 'junction' : 'dir');
process.env.CREATIVE_STUDIO_PACKAGING_DIR = isolatedPackaging;
const { probeVideoMedia, runFfmpeg } = await import('../lib/ffmpeg.ts');
const { resolvePackagingAutoLayout } = await import('../lib/media-core/packaging-auto-layout-service.ts');
const { renderVideoPackaging } = await import('../lib/media-core/packaging-render.ts');
const width = 320;
const height = 240;
const bodySec = 6;
const coverSec = 20 / 24;
const videoPath = path.join(root, 'rough.mp4');
const coverPath = path.join(root, 'cover.jpg');
const templateIndex = path.join(isolatedPackaging, 'templates/overlay-poster/index.html');
const liveReplay = path.join(isolatedPackaging, 'auto-layout/replay.js');

try {
  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=c=0x101018:s=${width}x${height}:r=24:d=${bodySec + coverSec}`,
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', videoPath,
  ], { timeoutMs: 60_000 });
  await sharp({ create: { width, height, channels: 3, background: '#202028' } }).jpeg().toFile(coverPath);
  const stickers: PackagingStickerInstance[] = [
    {
      id: 'v2_opening', assetId: 'highlight', styleMode: 'follow-template', fixedStyle: null,
      startFrame: 20, endFrame: 72, centerXPct: 30, centerYPct: 20, visualWidthPct: 24,
      rotationDeg: 0, trackIndex: 0, animation: 'soft',
      origin: { kind: 'auto', autoGroupId: 'v2_render', autoEdited: false, layoutVersion: 2 },
    },
    {
      id: 'v2_middle', assetId: 'present', styleMode: 'follow-template', fixedStyle: null,
      startFrame: 72, endFrame: 132, centerXPct: 70, centerYPct: 20, visualWidthPct: 24,
      rotationDeg: 0, trackIndex: 1, animation: 'soft',
      origin: { kind: 'auto', autoGroupId: 'v2_render', autoEdited: false, layoutVersion: 2 },
    },
  ];
  const config: FinalEditPackagingConfig = {
    enabled: true,
    template: 'overlay-poster',
    varsOverrides: {},
    pointCues: [{ id: 'v2_point', text: '轻便耐用', startSec: coverSec + 0.2, endSec: 4.8 }],
    pointCuesMode: 'timed',
    pointCuesLayoutVersion: 2,
    layoutRuntimeBundleVersion: 2,
    stickers,
    stickerDefaults: { animation: 'soft' },
  };
  const vars: PackagingVars = {
    title: '测试产品', subtitle: '冻结资源导出', point1: '轻便耐用', point2: '', point3: '',
    accent1: '', accent2: '', accent3: '',
  };
  const resolution = await resolvePackagingAutoLayout({
    config, vars, totalSec: bodySec + coverSec, coverSec,
    outputWidth: width, outputHeight: height,
  });
  if (resolution.status !== 'resolved') throw new Error(`v2 布局未解析：${JSON.stringify(resolution)}`);
  const resolvedConfig = { ...config, layoutResolution: resolution };

  // 布局冻结后移走在线模板与重放器；正式导出若误读 live 资源会立即失败。
  fs.renameSync(templateIndex, `${templateIndex}.v2-test-backup`);
  fs.renameSync(liveReplay, `${liveReplay}.v2-test-backup`);
  try {
    await renderVideoPackaging({ videoPath, coverPath, config: resolvedConfig, totalSec: bodySec + coverSec });
  } finally {
    fs.renameSync(`${templateIndex}.v2-test-backup`, templateIndex);
    fs.renameSync(`${liveReplay}.v2-test-backup`, liveReplay);
  }

  const probe = await probeVideoMedia(videoPath);
  assert.ok(!probe.errorMessage, probe.errorMessage ?? '');
  assert.equal(probe.width, width);
  assert.equal(probe.height, height);
  assert.equal(probe.videoCodec, 'h264');
  const cover = await sharp(coverPath).metadata();
  assert.equal(cover.format, 'jpeg');
  assert.equal(cover.width, width);
  assert.equal(cover.height, height);

  const framePath = path.join(root, 'body.png');
  await runFfmpeg(['-y', '-v', 'error', '-i', videoPath, '-vf', 'select=eq(n\\,46)', '-frames:v', '1', framePath], { timeoutMs: 60_000 });
  const { data } = await sharp(framePath).extract({ left: 0, top: 0, width, height: Math.floor(height * 0.4) }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let bright = 0;
  for (let index = 0; index < data.length; index += 3) {
    if (Math.max(data[index], data[index + 1], data[index + 2]) > 80) bright += 1;
  }
  assert.ok(bright > 100, `上 40% 正文区域未检测到包装像素：${bright}`);
  console.log('v2 真实导出测试通过：冻结模板/贴纸/引擎、MP4 与封面、上 40% 正文像素均通过。');
} finally {
  if (fs.existsSync(`${templateIndex}.v2-test-backup`)) fs.renameSync(`${templateIndex}.v2-test-backup`, templateIndex);
  if (fs.existsSync(`${liveReplay}.v2-test-backup`)) fs.renameSync(`${liveReplay}.v2-test-backup`, liveReplay);
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
  if (previousPackagingDir === undefined) delete process.env.CREATIVE_STUDIO_PACKAGING_DIR;
  else process.env.CREATIVE_STUDIO_PACKAGING_DIR = previousPackagingDir;
  fs.rmSync(root, { recursive: true, force: true });
}
