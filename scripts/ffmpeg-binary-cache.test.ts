import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-binary-cache-'));
const originalSpawn = childProcess.spawnSync;
const originalNow = Date.now;
const previous = { ffmpeg: process.env.CREATIVE_STUDIO_FFMPEG, ffprobe: process.env.CREATIVE_STUDIO_FFPROBE };
const calls = new Map<string, number>();
const first = path.join(root, 'first.exe'), probe = path.join(root, 'probe.exe'), second = path.join(root, 'second.exe');
for (const file of [first, probe, second]) fs.writeFileSync(file, 'working');
try {
  childProcess.spawnSync = ((command: string, args: string[], options: { windowsHide?: boolean }) => {
    assert.deepEqual(args, ['-version']); assert.equal(options.windowsHide, true);
    calls.set(command, (calls.get(command) ?? 0) + 1);
    const failed = command.startsWith(root) && fs.readFileSync(command, 'utf8') === 'broken';
    return { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: failed ? 1 : 0, signal: null };
  }) as unknown as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  process.env.CREATIVE_STUDIO_FFMPEG = first; process.env.CREATIVE_STUDIO_FFPROBE = probe;
  const { resolveFfmpegPath, resolveFfprobePath } = await import('../lib/ffmpeg.ts');
  for (let i = 0; i < 100; i++) { assert.equal(resolveFfmpegPath(), first); assert.equal(resolveFfprobePath(), probe); }
  assert.equal(calls.get(first), 1, 'Repeated media work must not run a synchronous version child per frame');
  assert.equal(calls.get(probe), 1, 'Repeated duration probes must reuse the same verified binary');
  process.env.CREATIVE_STUDIO_FFMPEG = second;
  assert.equal(resolveFfmpegPath(), second); assert.equal(calls.get(second), 1);
  const mtime = fs.statSync(second).mtime;
  fs.writeFileSync(second, 'broken'); fs.utimesSync(second, mtime, mtime);
  const fallback = resolveFfmpegPath();
  assert.notEqual(fallback, second, 'Replacing a binary must invalidate its positive check even when mtime is restored');
  assert.equal(calls.get(second), 2);
  assert.equal(resolveFfmpegPath(), fallback); assert.equal(calls.get(second), 2, 'A failed candidate must not spawn a version storm');
  const now = Date.now(); Date.now = () => now + 1500;
  assert.equal(resolveFfmpegPath(), fallback); assert.equal(calls.get(second), 3, 'A failed check must eventually retry');
  fs.writeFileSync(second, 'working-again');
  assert.equal(resolveFfmpegPath(), second, 'Repairing the binary must invalidate the failure cache immediately');
  console.log('PASS: one version check across 100 frames, path switch, file replacement, failed fallback, expiry and repair');
} finally {
  Date.now = originalNow; childProcess.spawnSync = originalSpawn; syncBuiltinESMExports();
  for (const [key, value] of [['CREATIVE_STUDIO_FFMPEG', previous.ffmpeg], ['CREATIVE_STUDIO_FFPROBE', previous.ffprobe]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
  fs.rmSync(root, { recursive: true, force: true });
}
