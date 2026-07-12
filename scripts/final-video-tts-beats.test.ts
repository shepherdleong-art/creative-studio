import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';

const projectRootUrl = new URL('../', import.meta.url);
type ResolveContext = { parentURL?: string };
type NextResolve = (specifier: string, context: ResolveContext) => unknown;
const registerHooks = (nodeModule as unknown as {
  registerHooks(hooks: {
    resolve: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => unknown;
  }): void;
}).registerHooks;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const candidate = new URL(`${specifier.slice(2)}.ts`, projectRootUrl);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-tts-beats-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;

const { runFfmpeg, probeDurationSec } = await import('../lib/ffmpeg.ts');
const { getDb } = await import('../lib/db.ts');
const { synthesizeNarrationBeats, buildNarrationTrack } = await import('../lib/final-video/tts.ts');

const sourceWav = path.join(dataRoot, 'source.wav');
await runFfmpeg([
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8.1',
  '-c:a', 'pcm_s16le', '-y', sourceWav,
]);
const sourceBytes = fs.readFileSync(sourceWav);
const emptyWav = path.join(dataRoot, 'empty.wav');
await runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0', '-c:a', 'pcm_s16le', '-y', emptyWav]);
const emptyBytes = fs.readFileSync(emptyWav);

const db = getDb();
db.prepare(`
  UPDATE narration_providers
  SET apiKey = ?, baseUrl = ?, model = ?, voices = ?, enabled = 1
  WHERE id = 'openai-tts'
`).run('test-key', 'https://tts.invalid', 'test-model', 'test-voice');

const requests: Array<Record<string, unknown>> = [];
let responseMode: 'binary' | 'json' | 'empty' = 'binary';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  if (responseMode === 'json') {
    return Response.json({ output: { audio: { data: sourceBytes.toString('base64') } } });
  }
  if (responseMode === 'empty') {
    return new Response(emptyBytes, { status: 200, headers: { 'content-type': 'audio/wav' } });
  }
  return new Response(sourceBytes, { status: 200, headers: { 'content-type': 'audio/wav' } });
};

try {
  // N 句 → N 个 beat：不再切窗口，每句只合成一次。
  const beats = await synthesizeNarrationBeats({
    draftId: 'draft-safe_1',
    beats: [
      { beatId: 'natural-1', index: 0, text: '这是一句足够长的自然口播文本。', subtitleText: '第一句字幕文案', shotId: 'shot-1', imageAssetId: 'image-1' },
      { beatId: 'natural-2', index: 1, text: '第二句自然口播文本也保持完整合成。', subtitleText: '', shotId: 'shot-2', imageAssetId: null },
    ],
    providerId: 'openai-tts',
    voice: 'test-voice',
    speed: 1.25,
  });

  assert.equal(requests.length, 2, 'each sentence is synthesized exactly once');
  assert.deepEqual(
    requests.map(({ input, voice, speed, model }) => ({ input, voice, speed, model })),
    [
      { input: '这是一句足够长的自然口播文本。', voice: 'test-voice', speed: 1.25, model: 'test-model' },
      { input: '第二句自然口播文本也保持完整合成。', voice: 'test-voice', speed: 1.25, model: 'test-model' },
    ],
  );
  assert.equal(beats.length, 2, 'one beat per sentence, no window-splitting');
  assert.deepEqual(beats.map((beat) => beat.beatId), ['natural-1', 'natural-2']);
  assert.deepEqual(beats.map((beat) => beat.index), [0, 1]);
  assert.deepEqual(beats.map((beat) => beat.shotId), ['shot-1', 'shot-2']);
  assert.deepEqual(beats.map((beat) => beat.imageAssetId), ['image-1', null]);
  // text 是完整原句，不再被切分重组
  assert.equal(beats[0].text, '这是一句足够长的自然口播文本。');
  assert.equal(beats[1].text, '第二句自然口播文本也保持完整合成。');
  // subtitleText 独立于 text 传递；缺省（空串）回落到 text
  assert.equal(beats[0].subtitleText, '第一句字幕文案');
  assert.equal(beats[1].subtitleText, beats[1].text, 'empty subtitleText falls back to text');
  // 每个 beat 的 durationSec = 该句真实探测出的音频时长
  assert.equal(beats[0].startSec, 0);
  assert.ok(Math.abs(beats[0].durationSec - 8.1) < 0.08, `expected ~8.1s probed duration, got ${beats[0].durationSec}`);
  assert.ok(Math.abs(beats[1].durationSec - 8.1) < 0.08, `expected ~8.1s probed duration, got ${beats[1].durationSec}`);
  // startSec 按真实时长连续累加（非估算/非切窗口）
  assert.equal(beats[1].startSec, beats[0].durationSec, 'startSec accumulates contiguously from the previous real probed duration');
  assert.ok(beats[0].audioPath.startsWith(path.join(dataRoot, 'storage', 'final-video-drafts', 'draft-safe_1', 'narration')));
  assert.notEqual(beats[0].audioPath, beats[1].audioPath, 'each beat gets its own audio file');

  responseMode = 'json';
  const locallySped = await synthesizeNarrationBeats({
    draftId: 'draft-local-speed',
    beats: [{ beatId: 'speed', index: 0, text: '本地语速转换测试文本足够长。', subtitleText: '本地语速转换测试文本足够长。', shotId: 'shot-speed', imageAssetId: 'image-speed' }],
    providerId: 'openai-tts', voice: 'test-voice', speed: 2,
  });
  assert.equal(locallySped.length, 1, 'one beat for one sentence');
  assert.ok(
    Math.abs(locallySped[0].durationSec - 4.05) < 0.08,
    'JSON/DashScope-shaped response applies speed locally before probing',
  );
  responseMode = 'binary';

  const trackDir = path.join(dataRoot, 'track');
  fs.mkdirSync(trackDir, { recursive: true });
  const track = await buildNarrationTrack({ beats, introDurationSec: 1.25, workDir: trackDir });
  assert.equal(track, path.join(trackDir, 'narration.m4a'));
  const trackDuration = await probeDurationSec(track);
  assert.ok(Math.abs(trackDuration - (1.25 + 16.2)) < 0.08, `track duration ${trackDuration}`);

  await assert.rejects(
    synthesizeNarrationBeats({
      draftId: '../escape', beats: [{ beatId: 'b', index: 0, text: 'text', subtitleText: 'text', shotId: 'shot-1', imageAssetId: 'image-1' }],
      providerId: 'openai-tts', voice: 'test-voice', speed: 1,
    }),
    /draftId|安全/,
  );
  await assert.rejects(
    synthesizeNarrationBeats({
      draftId: 'draft', beats: [{ beatId: 'b', index: 0, text: ' ', subtitleText: ' ', shotId: 'shot-1', imageAssetId: 'image-1' }],
      providerId: 'openai-tts', voice: 'test-voice', speed: 1,
    }),
    /text|文本/,
  );
  await assert.rejects(
    synthesizeNarrationBeats({
      draftId: 'draft', beats: [{ beatId: 'b', index: 0, text: 'text', subtitleText: 'text', shotId: '  ', imageAssetId: 'image-1' }],
      providerId: 'openai-tts', voice: 'test-voice', speed: 1,
    }),
    /shotId/,
  );
  for (const speed of [0, Number.NaN]) {
    await assert.rejects(
      synthesizeNarrationBeats({
        draftId: 'draft', beats: [{ beatId: 'b', index: 0, text: 'text', subtitleText: 'text', shotId: 'shot-1', imageAssetId: 'image-1' }],
        providerId: 'openai-tts', voice: 'test-voice', speed,
      }),
      /speed/,
    );
  }
  await assert.rejects(
    synthesizeNarrationBeats({
      draftId: 'draft',
      beats: [
        { beatId: 'same', index: 0, text: 'first', subtitleText: 'first', shotId: 'shot-1', imageAssetId: 'image-1' },
        { beatId: 'same', index: 1, text: 'second', subtitleText: 'second', shotId: 'shot-2', imageAssetId: 'image-2' },
      ],
      providerId: 'openai-tts', voice: 'test-voice', speed: 1,
    }),
    /重复 beatId|beatId/,
  );
  await assert.rejects(
    buildNarrationTrack({
      beats: [beats[0], { ...beats[1], startSec: beats[1].startSec + 5 }],
      introDurationSec: 0,
      workDir: trackDir,
    }),
    /startSec|不连续/,
  );
  await assert.rejects(
    buildNarrationTrack({ beats, introDurationSec: -1, workDir: trackDir }),
    /introDurationSec/,
  );
  responseMode = 'empty';
  await assert.rejects(
    synthesizeNarrationBeats({
      draftId: 'draft-empty-audio',
      beats: [{ beatId: 'empty', index: 0, text: '无效音频时长', subtitleText: '无效音频时长', shotId: 'shot-empty', imageAssetId: 'image-empty' }],
      providerId: 'openai-tts', voice: 'test-voice', speed: 1,
    }),
    /probed duration|ffmpeg|ffprobe/,
  );

  console.log('final-video-tts-beats passed');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
