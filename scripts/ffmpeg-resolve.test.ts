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
if (process.platform === 'win32' && !process.env.CREATIVE_STUDIO_FFPROBE) {
  assert.match(ffprobe.replace(/\\/g, '/'), /@ffprobe-installer\/win32-[^/]+\/ffprobe\.exe$/, 'Windows defaults to the pinned replacement probe');
}

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
if (process.platform === 'win32') {
  const source = `import assert from 'node:assert/strict';
    import { resolveFfprobePath, probeDurationSec } from ${JSON.stringify(new URL('../lib/ffmpeg.ts', import.meta.url).href)};
    assert.ok(resolveFfprobePath().length > 0);
    assert.ok(Math.abs(await probeDurationSec(${JSON.stringify(tmpFile)}) - 2) < 0.15);`;
  const missingPackage = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, npm_config_arch: 'unsupported', CREATIVE_STUDIO_FFPROBE: '' },
  });
  assert.equal(missingPackage.status, 0, `missing platform package must retain fallback: ${missingPackage.stderr}`);
}
try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

console.log('ffmpeg-resolve tests passed');
