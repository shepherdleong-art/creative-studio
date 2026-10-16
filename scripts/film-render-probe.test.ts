// Regression for the bundled Windows ffprobe hanging before the final JSON brace.
// FILM_PROBE_SOURCE may select the local failing 1244x1660 / 121-frame fixture.
// Synthetic media alone did not reproduce the original hang; see the acceptance record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeMedia } from '../lib/film-render/media.ts';
import { runFfmpeg, resolveFfprobePath } from '../lib/ffmpeg.ts';

if (process.platform !== 'win32') console.log('SKIP: bundled Windows ffprobe handle regression');
else {
  const parent = path.resolve(process.env.FILM_PROBE_ROOT || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'film-probe-中文 空格-'));
  const tool = resolveFfprobePath();
  if (!process.env.CREATIVE_STUDIO_FFPROBE) assert.match(tool.replace(/\\/g, '/'), /@ffprobe-installer\/win32-x64\/ffprobe\.exe$/);
  try {
    const source = process.env.FILM_PROBE_SOURCE ? path.resolve(process.env.FILM_PROBE_SOURCE) : path.join(root, '探针 素材.mp4');
    if (!process.env.FILM_PROBE_SOURCE) await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=1244x1660:rate=24',
      '-frames:v', '121', '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-video_track_timescale', '16384', source], { timeoutMs: 30_000 });
    const failures: string[] = [];
    for (let i = 0; i < 64; i++) {
      try {
        const probe = await probeMedia(source, root, { timeoutMs: i % 2 === 0 ? 10_000 : 5_000, countFrames: i % 2 === 0 });
        const video = probe.streams.find(stream => stream.codec_type === 'video');
        assert.equal(video?.width, 1244); assert.equal(video?.height, 1660);
        assert.equal(Number(video?.nb_frames), 121);
        if (i % 2 === 0) assert.equal(Number(video?.nb_read_frames), 121);
        else assert.equal(video?.nb_read_frames, undefined, 'metadata probes must not expose a partial decode count');
        assert.ok(Math.abs(Number(probe.format.duration) - 121 / 24) < .001);
      } catch (error) { failures.push(`probe ${i}: ${String(error)}`); }
    }
    assert.deepEqual(fs.readdirSync(root), process.env.FILM_PROBE_SOURCE ? [] : ['探针 素材.mp4'], 'probe scratch files must be cleaned after success or failure');
    assert.equal(failures.length, 0, `${failures.length}/64 probes failed\n${failures.join('\n')}`);
    console.log('PASS: 64 bundled Windows probes, metadata + decoded frame counts, Chinese paths and cleanup');
  } finally {
    assert.ok(path.resolve(root).startsWith(parent + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
