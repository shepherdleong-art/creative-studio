/**
 * video-browser-preview 测试：真实调用 ffmpeg 生成/转码素材（依赖 ffmpeg-static）。
 * - 浏览器安全（h264 + yuv420p）的原件原样返回，不产生衍生物
 * - HEVC 10bit 原件生成 <base>.preview.mp4，产物为 h264/yuv420p，可再次探测
 * - 第二次调用走已存在衍生物，不重复转码
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-preview-'));

try {
  const { browserPreviewPath, ensureBrowserPreview } = await import('../lib/video-browser-preview.ts');
  const { probeVideoMedia, runFfmpeg } = await import('../lib/ffmpeg.ts');

  const h264Path = path.join(tmp, 'plain-h264.mp4');
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h264Path,
  ], { timeoutMs: 60_000 });

  // 浏览器安全原件：原样返回，不生成衍生物
  assert.equal(await ensureBrowserPreview(h264Path), h264Path);
  assert.equal(fs.existsSync(browserPreviewPath(h264Path)), false);

  // HEVC 10bit 原件（模拟 Seedance 2.5 1080p 产物）
  const hevcPath = path.join(tmp, 'hevc-10bit.mp4');
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', hevcPath,
  ], { timeoutMs: 60_000 });
  const hevcProbe = await probeVideoMedia(hevcPath);
  assert.equal(hevcProbe.videoCodec, 'hevc');

  const previewPath = await ensureBrowserPreview(hevcPath);
  assert.equal(previewPath, browserPreviewPath(hevcPath));
  assert.ok(fs.existsSync(previewPath), '衍生物必须存在');
  assert.ok(fs.statSync(previewPath).size > 0, '衍生物不能为空文件');
  const previewProbe = await probeVideoMedia(previewPath);
  assert.equal(previewProbe.videoCodec, 'h264');
  assert.equal(previewProbe.pixelFormat, 'yuv420p');
  assert.equal(previewProbe.width, 320);
  assert.equal(previewProbe.height, 240);

  // 第二次调用命中已有衍生物（路径一致且 mtime 不变）
  const mtime = fs.statSync(previewPath).mtimeMs;
  assert.equal(await ensureBrowserPreview(hevcPath), previewPath);
  assert.equal(fs.statSync(previewPath).mtimeMs, mtime);

  // 原件不受影响
  assert.equal((await probeVideoMedia(hevcPath)).videoCodec, 'hevc');

  console.log('video-browser-preview tests passed');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录留待系统清理 */ }
}
