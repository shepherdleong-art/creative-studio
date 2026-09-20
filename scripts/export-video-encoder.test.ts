import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExportVideoRunner } from '../lib/media-core/export-video-encoder.ts';
import { probeVideoMedia, type RunFfmpegOptions } from '../lib/ffmpeg.ts';

const previousMode = process.env.CREATIVE_STUDIO_EXPORT_ENCODER;
delete process.env.CREATIVE_STUDIO_EXPORT_ENCODER;
const outputArgs = ['-i', 'input.mp4', '-pix_fmt', 'yuv420p', '-f', 'mp4', '-y', 'output.mp4.tmp'];
const abortError = Object.assign(new Error('shutdown'), { name: 'AbortError' });
type Call = { args: string[]; options: RunFfmpegOptions };
function harness(behavior: (call: Call) => Promise<void> = async () => {}) {
  const calls: Call[] = [];
  let clock = 1000;
  let binaryPath = 'ffmpeg-one';
  const run = createExportVideoRunner({
    run: async (args, options = {}) => {
      const call = { args, options };
      calls.push(call);
      await behavior(call);
    },
    resolvePath: () => binaryPath,
    now: () => clock,
  });
  return { calls, run, advance: (ms: number) => { clock += ms; }, changeBinary: () => { binaryPath = 'ffmpeg-two'; } };
}
const isProbe = (call: Call) => call.args.includes('lavfi');
const codec = (call: Call) => call.args[call.args.indexOf('-c:v') + 1];

try {
  const supported = harness();
  assert.equal(await supported.run(outputArgs), 'h264_nvenc');
  assert.deepEqual(supported.calls[1].args.slice(0, outputArgs.length - 1), outputArgs.slice(0, -1));
  assert.equal(supported.calls[1].args.at(-1), 'output.mp4.tmp');
  await supported.run(outputArgs);
  assert.equal(supported.calls.filter(isProbe).length, 1, 'successful probe is cached');
  supported.changeBinary();
  await supported.run(outputArgs);
  assert.equal(supported.calls.filter(isProbe).length, 2, 'changing FFmpeg invalidates the probe');

  const unsupported = harness(async (call) => { if (isProbe(call)) throw new Error('No capable devices found'); });
  assert.equal(await unsupported.run(outputArgs), 'libx264');
  await unsupported.run(outputArgs);
  assert.equal(unsupported.calls.filter(isProbe).length, 1);
  unsupported.advance(60_001);
  await unsupported.run(outputArgs);
  assert.equal(unsupported.calls.filter(isProbe).length, 2, 'unavailable hardware is periodically rechecked');

  const fallback = harness(async (call) => {
    if (!isProbe(call) && codec(call) === 'h264_nvenc') throw new Error('encoder session exhausted');
  });
  const progress: number[] = [];
  assert.equal(await fallback.run(outputArgs, { onProgressSec: (sec) => progress.push(sec) }), 'libx264');
  assert.deepEqual(fallback.calls.map(codec), ['h264_nvenc', 'h264_nvenc', 'libx264']);
  assert.deepEqual(progress, [0], 'CPU retry resets media progress');
  await fallback.run(outputArgs);
  assert.equal(fallback.calls.length, 4, 'failed GPU is skipped for following jobs during cooldown');

  for (const duringProbe of [true, false]) {
    const cancelled = harness(async (call) => { if (isProbe(call) === duringProbe) throw abortError; });
    await assert.rejects(cancelled.run(outputArgs), { name: 'AbortError' });
    assert.equal(cancelled.calls.some((call) => codec(call) === 'libx264'), false, 'shutdown never retries on CPU');
  }
  const controller = new AbortController();
  controller.abort();
  const preCancelled = harness();
  await assert.rejects(preCancelled.run(outputArgs, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(preCancelled.calls.length, 0);

  const signalController = new AbortController();
  const signalled = harness(async (call) => {
    assert.equal(call.options.signal, signalController.signal, 'probe and export use the task signal');
    if (!isProbe(call)) { signalController.abort(); throw new Error('process exited'); }
  });
  await assert.rejects(signalled.run(outputArgs, { signal: signalController.signal }), { name: 'AbortError' });
  assert.equal(signalled.calls.length, 2);

  const budget = harness(async (call) => {
    if (isProbe(call)) budget.advance(200);
    else if (codec(call) === 'h264_nvenc') { budget.advance(300); throw new Error('GPU lost'); }
  });
  await budget.run(outputArgs, { timeoutMs: 1000 });
  assert.deepEqual(budget.calls.map((call) => call.options.timeoutMs), [1000, 800, 500]);
  const expired = harness(async (call) => {
    if (!isProbe(call)) { expired.advance(1000); throw new Error('timeout'); }
  });
  await assert.rejects(expired.run(outputArgs, { timeoutMs: 1000 }), /超时/);
  assert.equal(expired.calls.length, 2, 'timeout does not start a fresh full-length retry');

  process.env.CREATIVE_STUDIO_EXPORT_ENCODER = 'cpu';
  const forcedCpu = harness();
  assert.equal(await forcedCpu.run(outputArgs), 'libx264');
  assert.equal(forcedCpu.calls.length, 1, 'CPU override bypasses the hardware probe');
  const cpuFailure = harness(async () => { throw new Error('disk full'); });
  await assert.rejects(cpuFailure.run(outputArgs), /disk full/);
  assert.equal(cpuFailure.calls.length, 1);

  // Real MP4 exports in both automatic and CPU modes, without touching project data.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-export-encoder-'));
  try {
    for (const mode of ['auto', 'cpu']) {
      process.env.CREATIVE_STUDIO_EXPORT_ENCODER = mode;
      const file = path.join(root, `${mode}.mp4`);
      const selected = await createExportVideoRunner()([
        '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=24:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-f', 'mp4', file,
      ], { timeoutMs: 30_000 });
      const media = await probeVideoMedia(file);
      assert.equal(media.videoCodec, 'h264');
      assert.equal(media.pixelFormat, 'yuv420p');
      assert.equal(media.width, 1920);
      assert.equal(media.height, 1080);
      assert.equal(media.fps, 24);
      assert.equal(media.audioCodec, 'aac');
      assert.equal(media.audioSampleRate, 48000);
      assert.ok(Math.abs(media.durationUs - 1_000_000) < 50_000);
      if (mode === 'cpu') assert.equal(selected, 'libx264');
      console.log(`Real export (${mode}): ${selected}, H.264/AAC 1080p/24 verified`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('export-video-encoder tests passed');
} finally {
  if (previousMode === undefined) delete process.env.CREATIVE_STUDIO_EXPORT_ENCODER;
  else process.env.CREATIVE_STUDIO_EXPORT_ENCODER = previousMode;
}
