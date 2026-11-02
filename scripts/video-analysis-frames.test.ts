import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as module from 'node:module';
import sharp from 'sharp';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { buildVideoFrameSamples } from '../lib/media-core/adapters/video-analysis-prompt.ts';

// Only replace the external model: exercise the real probe, scene detector,
// frame extraction, image reading and request assembly without credentials/DB.
const { registerHooks } = module as unknown as {
  registerHooks(hooks: { resolve: (specifier: string, context: unknown,
    next: (specifier: string, context: unknown) => { url: string }) => { url: string; shortCircuit?: boolean } }): { deregister(): void };
};
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../../script-providers/index.ts') return {
    url: `data:text/javascript,${encodeURIComponent('export async function completeJson(request) { return { summary: JSON.stringify(request) }; }')}`,
    shortCircuit: true,
  };
  return next(specifier, context);
} });
const { analyzeVideoWithVision } = await import('../lib/media-core/adapters/video-analysis.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-analysis-frames-'));
type Request = { userPrompt: string; images: Array<{ imageBase64: string }> };

async function check(filePath: string, name: string) {
  const cacheDir = path.join(root, name);
  const result = await analyzeVideoWithVision({ filePath, videoJobId: name, providerId: 'offline-fixture', cacheDir });
  const request: Request = JSON.parse(result.summary);
  const match = request.userPrompt.match(/对应表为 (\[.*?\])/);
  assert(match, 'the model must receive frame/time mapping');
  const frames: Array<{ imageIndex: number; sceneIndex: number; timeUs: number }> = JSON.parse(match[1]);
  assert.equal(request.images.length, frames.length);
  assert(frames.length > 0);
  for (const [i, frame] of frames.entries()) {
    assert.equal(frame.imageIndex, i + 1);
    const bytes = Buffer.from(request.images[i].imageBase64, 'base64');
    assert.equal((await sharp(bytes).metadata()).format, 'jpeg');
    assert.deepEqual(bytes, fs.readFileSync(path.join(cacheDir, `${frame.timeUs}.jpg`)));
    const scene = result.scenes[frame.sceneIndex];
    assert(frame.timeUs >= scene.startUs && frame.timeUs < scene.endUs);
    if (i) assert(frame.timeUs >= frames[i - 1].timeUs, 'images remain chronological after fallback');
  }
  return { frames, result };
}

try {
  const filePath = path.join(root, 'audio-tail.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=96x128:r=24:d=5.041667',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '5.056',
    '-c:v', 'libx264', '-c:a', 'aac', '-y', filePath], { timeoutMs: 20_000 });
  const tail = await check(filePath, 'audio-tail');
  const requested = buildVideoFrameSamples(tail.result.scenes).at(-1)!.timeUs;
  assert(requested > 5_000_000, 'fixture must request a frame after the last video PTS');
  assert(tail.frames.at(-1)!.timeUs <= 5_000_000, 'empty tail extraction must recover before calling the model');
  assert(tail.frames.at(-1)!.timeUs > 4_500_000, 'retain late-scene evidence');

  const shortPath = path.join(root, 'one-frame.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=96x128:r=24', '-frames:v', '1',
    '-c:v', 'libx264', '-y', shortPath], { timeoutMs: 20_000 });
  const short = await check(shortPath, 'one-frame');
  assert.equal(short.frames.length, 1);
  assert.equal(short.frames[0].timeUs, 0, 'single-frame clips must fall back within the short scene');

  const normalPath = path.join(root, 'normal.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=96x128:r=24:d=2',
    '-c:v', 'libx264', '-y', normalPath], { timeoutMs: 20_000 });
  const normal = await check(normalPath, 'normal');
  assert.deepEqual(normal.frames, buildVideoFrameSamples(normal.result.scenes), 'ordinary clips keep their original samples');

  const audioPath = path.join(root, 'no-video.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1',
    '-c:a', 'aac', '-y', audioPath], { timeoutMs: 20_000 });
  const staleDir = path.join(root, 'stale');
  fs.mkdirSync(staleDir);
  const stale = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  for (const timeUs of [0, 50_000, 500_000, 950_000]) fs.writeFileSync(path.join(staleDir, `${timeUs}.jpg`), stale);
  await assert.rejects(analyzeVideoWithVision({ filePath: audioPath, videoJobId: 'no-video', providerId: 'offline-fixture',
    cacheDir: staleDir }), /素材画面抽取失败|ffmpeg/i, 'missing video must fail before the model, even with stale cache files');
  assert(!fs.existsSync(path.join(staleDir, '50000.jpg')), 'stale frame cannot masquerade as fresh extraction');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(analyzeVideoWithVision({ filePath, videoJobId: 'cancel', providerId: 'offline-fixture',
    cacheDir: path.join(root, 'cancel'), signal: controller.signal }), { name: 'AbortError' });

  // Optional real local asset; no file is copied or changed, no model request is sent.
  if (process.env.VIDEO_ANALYSIS_FIXTURE) await check(process.env.VIDEO_ANALYSIS_FIXTURE, 'real-asset');
  console.log('video analysis real frame extraction tests passed');
} finally {
  hook.deregister();
  fs.rmSync(root, { recursive: true, force: true });
}
