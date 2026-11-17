import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

// Decode the downloaded production artifact, then match opaque coloured pixels
// from its catalog original at the saved geometry. A plain unwrapped video must
// fail this check even if the job and HTTP download both reported success.
export async function verifyStickerProductionMedia(filename, packaging, expectedFrames) {
  const production = fs.realpathSync(process.env.STICKER_TEST_STANDALONE);
  const require = createRequire(path.join(production, 'server.js'));
  const ffmpeg = require('ffmpeg-static');
  const ffprobe = require('ffprobe-static').path;
  for (const executable of [ffmpeg, ffprobe]) assert.ok(executable.startsWith(production + path.sep));
  const run = (executable, args, encoding = 'utf8') => {
    const result = spawnSync(executable, args, { windowsHide: true, encoding, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout;
  };
  const file = path.join(process.env.STICKER_TEST_EVIDENCE_DIR, filename);
  const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]));
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video.r_frame_rate, '24/1');
  assert.equal(Number(video.nb_read_frames), expectedFrames, 'stickers must not add or remove decoded video frames');
  assert.equal(video.codec_name, 'h264');
  assert.equal(audio?.codec_name, 'aac');
  assert.equal(Number(audio.sample_rate), 48000);
  const catalog = JSON.parse(fs.readFileSync(path.join(production, 'packaging/stickers/catalog.json'), 'utf8'));
  const styles = { 'overlay-poster': 'comic', 'overlay-journal': 'journal', 'overlay-minimal': 'editorial', 'overlay-variety': 'show' };
  // The uppermost manual instance remains stable across the editor's auto-layout tests.
  const sticker = packaging.stickers.filter(item => item.origin.kind === 'manual')
    .sort((a, b) => a.trackIndex - b.trackIndex)[0];
  assert.ok(sticker);
  const style = sticker.styleMode === 'fixed' ? sticker.fixedStyle : styles[packaging.template];
  const asset = catalog.assets.find(item => item.id === sticker.assetId && item.style === style);
  assert.ok(asset);
  const original = await sharp(path.join(production, 'packaging/stickers', asset.file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [left, top, right, bottom] = asset.alpha_gt8_bbox;
  const scale = sticker.visualWidthPct / 100 * video.width / (right - left);
  const radians = sticker.rotationDeg * Math.PI / 180;
  const samples = [];
  const step = Math.max(4, Math.floor(Math.sqrt((right - left) * (bottom - top) / 1200)));
  for (let y = top + step; y < bottom - step; y += step) for (let x = left + step; x < right - step; x += step) {
    const offset = (y * original.info.width + x) * 4;
    const color = [...original.data.subarray(offset, offset + 3)];
    if (original.data[offset + 3] < 250 || Math.max(...color) - Math.min(...color) < 45) continue;
    const dx = (x - (left + right) / 2) * scale;
    const dy = (y - (top + bottom) / 2) * scale;
    const px = Math.round(sticker.centerXPct / 100 * video.width + dx * Math.cos(radians) - dy * Math.sin(radians));
    const py = Math.round(sticker.centerYPct / 100 * video.height + dx * Math.sin(radians) + dy * Math.cos(radians));
    if (px >= 2 && px < video.width - 2 && py >= 2 && py < video.height - 2) samples.push({ x: px, y: py, color });
  }
  assert.ok(samples.length >= 20, 'sticker probe needs enough opaque coloured pixels');
  const frames = { intro: 10, stable: Math.floor((sticker.startFrame + sticker.endFrame) / 2), after: sticker.endFrame };
  const matches = {};
  for (const [label, frame] of Object.entries(frames)) {
    if (frame >= expectedFrames) continue;
    const output = file.replace(/\.mp4$/, `-${label}.png`);
    // 通过管道取回 PNG，再由 Node 保存证据，避免 Windows 原生 image2 对证据路径的写入失败。
    fs.writeFileSync(output, run(ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`,
      '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], null));
    const decoded = await sharp(output).removeAlpha().raw().toBuffer();
    let matched = 0;
    for (const sample of samples) {
      let distance = Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const offset = ((sample.y + dy) * video.width + sample.x + dx) * 3;
        distance = Math.min(distance, Math.max(...sample.color.map((value, channel) => Math.abs(value - decoded[offset + channel]))));
      }
      if (distance < 50) matched += 1;
    }
    matches[label] = matched / samples.length;
  }
  assert.ok(matches.stable > 0.60, `production output missing catalog sticker ${asset.file}: ${JSON.stringify(matches)}`);
  assert.ok(matches.stable - matches.intro > 0.30, `sticker must be absent in intro: ${JSON.stringify(matches)}`);
  if (matches.after !== undefined) assert.ok(matches.stable - matches.after > 0.30, `sticker must disappear at exclusive end: ${JSON.stringify(matches)}`);
  return { decodedFrames: Number(video.nb_read_frames), fps: video.r_frame_rate, audio: audio.codec_name,
    width: video.width, height: video.height, sticker, asset: asset.file, samples: samples.length, frames, matches };
}
