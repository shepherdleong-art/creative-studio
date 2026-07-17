import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { runFfmpeg, probeDurationSec } from '../lib/ffmpeg.ts';
import { renderFinalEditSnapshot, type FinalEditRenderSnapshot } from '../lib/final-edit/renderer.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-final-render-'));
const storage = path.join(root, 'storage');
fs.mkdirSync(path.join(storage, 'videos'), { recursive: true });
fs.mkdirSync(path.join(storage, 'audio'), { recursive: true });
fs.mkdirSync(path.join(storage, 'overlays'), { recursive: true });
const source = path.join(storage, 'videos', 'source.mp4');
const narration = path.join(storage, 'audio', 'narration.wav');
const bgm = path.join(storage, 'audio', 'bgm.wav');
const cover = path.join(storage, 'cover.png');
await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', source]);
await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', narration]);
await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.7', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', bgm]);
await sharp({ create: { width: 320, height: 240, channels: 3, background: '#446688' } }).png().toFile(cover);
await sharp({ create: { width: 1080, height: 1440, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(path.join(storage, 'overlays', 'title.png'));
await sharp({ create: { width: 1080, height: 1440, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(path.join(storage, 'overlays', 'subtitle-cue-1.png'));
const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
const bgmFingerprint = crypto.createHash('sha256').update(fs.readFileSync(bgm)).digest('hex');

const snapshot: FinalEditRenderSnapshot = {
  groupRevision: 1,
  variantRevision: 0,
  group: { narrationDurationUs: 2_000_000, subtitleCues: [{ id: 'cue-1', segmentId: 'seg-1', text: '测试字幕', startUs: 0, endUs: 2_000_000, textSource: 'script', timingSource: 'aligned' }] },
  variant: {
    id: 'variant-1', indexNum: 1, outputPreset: '3x4', revision: 0, lastRenderedRevision: null, renderStatus: null, maxOverlap: 0, issues: [],
    timeline: { fps: 24, introFrames: 20, bodyFrames: 48, clips: [{ id: 'clip-1', videoJobId: 'video-1', sourceFingerprint: fingerprint, sourceInFrame: 0, sourceOutFrame: 48, timelineInFrame: 0, timelineOutFrame: 48, boundSegmentId: 'seg-1', framing: { scale: 1.15, offsetX: 0.25, offsetY: -0.25 }, manualUseOverride: false }] },
    bgm: { trackId: null, gainDb: -16, loop: true, fadeOutSec: 0.8 }, cover: { coverKey: 'image:cover', kind: 'storyboard_image', sourceUrl: null, framing: { scale: 1.1, offsetX: 0.2, offsetY: -0.1 } },
  },
  sources: [{ videoJobId: 'video-1', relativePath: 'videos/source.mp4', fingerprint }],
  coverRelativePath: 'cover.png', narrationRelativePath: 'audio/narration.wav',
  bgm: { id: 'bgm-1', relativePath: 'audio/bgm.wav', fileFingerprint: bgmFingerprint, gainDb: -16, loop: true, fadeOutSec: 0.8 },
  overlayBundle: { id: 'bundle-1', relativeDir: 'overlays', manifest: {} },
};

const result = await renderFinalEditSnapshot({ jobId: 'job-1', storageRoot: storage, snapshot });
assert.ok(fs.existsSync(path.join(storage, result.videoRelativePath)));
assert.ok(fs.existsSync(path.join(storage, result.coverRelativePath)));
assert.ok(Math.abs(await probeDurationSec(path.join(storage, result.videoRelativePath)) - (2 + 20 / 24)) < 1 / 24 + 0.02);
const metadata = await sharp(path.join(storage, result.coverRelativePath)).metadata();
assert.equal(metadata.width, 1080);
assert.equal(metadata.height, 1440);

fs.rmSync(root, { recursive: true, force: true });
console.log('final-edit real render test passed');
