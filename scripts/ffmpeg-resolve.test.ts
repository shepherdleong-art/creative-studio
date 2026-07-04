// scripts/ffmpeg-resolve.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveFfmpegPath, resolveFfprobePath, runFfmpeg, probeDurationSec } from '../lib/ffmpeg.ts';

const ffmpeg = resolveFfmpegPath();
const ffprobe = resolveFfprobePath();

assert.ok(ffmpeg.length > 0, 'ffmpeg path resolved');
assert.ok(ffprobe.length > 0, 'ffprobe path resolved');
assert.ok(ffmpeg === 'ffmpeg' || fs.existsSync(ffmpeg), 'ffmpeg binary exists');

// Verify ffmpeg binary actually runs
const r = spawnSync(ffmpeg, ['-version'], { encoding: 'utf-8', timeout: 5000 });
assert.equal(r.status, 0, 'ffmpeg -version runs');
assert.match(r.stdout, /ffmpeg version/);

// ffprobe-static ships broken arm64 binaries on macOS — verify resolveFfprobePath
// returns a non-empty string (probeDurationSec has a built-in ffmpeg fallback).
// If the actual ffprobe binary is runnable, verify it; otherwise skip.
const pv = spawnSync(ffprobe, ['-version'], { encoding: 'utf-8', timeout: 5000 });
if (pv.status === 0) {
  assert.match(pv.stdout, /ffprobe version/);
  console.log('ffprobe binary verified');
} else {
  console.log(`ffprobe binary unavailable (status=${pv.status}, error=${pv.error?.message ?? 'none'}), relying on ffmpeg fallback for probing`);
}

// Verify probeDurationSec works via ffmpeg fallback
const tmpFile = path.join(os.tmpdir(), 'ffmpeg-test-probe.mp4');
await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=25', '-pix_fmt', 'yuv420p', '-y', tmpFile]);
const dur = await probeDurationSec(tmpFile);
assert.ok(Math.abs(dur - 2) < 0.15, `probed duration ${dur} ≈ 2s`);
try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

console.log('ffmpeg-resolve tests passed');
