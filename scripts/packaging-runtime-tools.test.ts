// The actual packaging child must receive the same binaries as the app's media resolver.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFfmpegPath, resolveFfprobePath } from '../lib/ffmpeg.ts';
import { runPackagingPipeline } from '../lib/media-core/packaging-runtime.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaging-tools-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const packagingDir = path.resolve('packaging');
const helper = path.join(root, 'report-tools.cjs');
const report = path.join(root, 'tools.json');
fs.writeFileSync(helper, `const fs = require('node:fs');
const { createRequire } = require('node:module');
const localRequire = createRequire(${JSON.stringify(path.join(packagingDir, 'package-video.mjs'))});
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
  ffmpeg: process.env.CREATIVE_STUDIO_FFMPEG || localRequire('ffmpeg-static'),
  ffprobe: process.env.CREATIVE_STUDIO_FFPROBE || localRequire('ffprobe-static').path,
}));`);
try {
  delete process.env.CREATIVE_STUDIO_FFMPEG; delete process.env.CREATIVE_STUDIO_FFPROBE;
  await runPackagingPipeline({ nodeExe: process.execPath, packagingDir, args: [helper] });
  assert.deepEqual(JSON.parse(fs.readFileSync(report, 'utf8')), { ffmpeg: resolveFfmpegPath(), ffprobe: resolveFfprobePath() }, 'default packaging child must use the shared media selector');
  // Invalid overrides must be resolved by the shared selector before reaching the child.
  process.env.CREATIVE_STUDIO_FFMPEG = path.join(root, 'missing-ffmpeg');
  process.env.CREATIVE_STUDIO_FFPROBE = path.join(root, 'missing-ffprobe');
  const expected = { ffmpeg: resolveFfmpegPath(), ffprobe: resolveFfprobePath() };
  await runPackagingPipeline({ nodeExe: process.execPath, packagingDir, args: [helper] });
  assert.deepEqual(JSON.parse(fs.readFileSync(report, 'utf8')), expected, 'packaging child must use resolved media binaries, not invalid overrides or old ffprobe-static');
  console.log('PASS packaging child receives resolved tools with default and invalid overrides');
} finally {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
