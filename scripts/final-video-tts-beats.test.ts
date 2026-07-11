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
  const beats = await synthesizeNarrationBeats({
    draftId: 'draft-safe_1',
    beats: [
      { beatId: 'natural-1', groupId: 'natural-1', index: 0, text: '这是一句足够长的自然口播文本。' },
      { beatId: 'natural-2', groupId: 'natural-2', index: 1, text: '第二句自然口播文本也保持完整合成。' },
    ],
    providerId: 'openai-tts',
    voice: 'test-voice',
    speed: 1.25,
    maxClipSeconds: 4,
  });

  assert.equal(requests.length, 2, 'each natural sentence is synthesized exactly once');
  assert.deepEqual(
    requests.map(({ input, voice, speed, model }) => ({ input, voice, speed, model })),
    [
      { input: '这是一句足够长的自然口播文本。', voice: 'test-voice', speed: 1.25, model: 'test-model' },
      { input: '第二句自然口播文本也保持完整合成。', voice: 'test-voice', speed: 1.25, model: 'test-model' },
    ],
  );
  assert.deepEqual(beats.slice(0, 3).map((beat) => Number(beat.durationSec.toFixed(3))), [4, 4, 0.1]);
  assert.ok(beats.slice(0, 3).every((beat) => beat.audioPath === beats[0].audioPath));
  assert.deepEqual(beats.slice(0, 3).map((beat) => beat.beatId), ['natural-1-1', 'natural-1-2', 'natural-1-3']);
  assert.deepEqual(beats.map((beat) => beat.index), beats.map((_, index) => index));
  assert.equal(beats[0].startSec, 0);
  assert.ok(Math.abs(beats[3].startSec - 8.1) < 0.03, 'real probed duration drives the next group start');
  assert.equal(
    beats.slice(0, 3).map((beat) => beat.text.replace(/\s/g, '')).join(''),
    '这是一句足够长的自然口播文本。',
  );
  assert.ok(beats[0].audioPath.startsWith(path.join(dataRoot, 'storage', 'final-video-drafts', 'draft-safe_1', 'narration')));

  responseMode = 'json';
  const locallySped = await synthesizeNarrationBeats({
    draftId: 'draft-local-speed',
    beats: [{ beatId: 'speed', groupId: 'speed', index: 0, text: '本地语速转换测试文本足够长。' }],
    providerId: 'openai-tts', voice: 'test-voice', speed: 2, maxClipSeconds: 5,
  });
  assert.ok(
    Math.abs(locallySped.reduce((sum, beat) => sum + beat.durationSec, 0) - 4.05) < 0.08,
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
      draftId: '../escape', beats: [{ beatId: 'b', groupId: 'g', index: 0, text: 'text' }],
      providerId: 'openai-tts', voice: 'test-voice', speed: 1, maxClipSeconds: 4,
    }),
    /draftId|安全/,
  );
  await assert.rejects(
    synthesizeNarrationBeats({
      draftId: 'draft', beats: [{ beatId: 'b', groupId: 'g', index: 0, text: ' ' }],
      providerId: 'openai-tts', voice: 'test-voice', speed: 1, maxClipSeconds: 4,
    }),
    /text|文本/,
  );
  for (const [speed, maxClipSeconds] of [[0, 4], [Number.NaN, 4], [1, 0], [1, Number.POSITIVE_INFINITY]]) {
    await assert.rejects(
      synthesizeNarrationBeats({
        draftId: 'draft', beats: [{ beatId: 'b', groupId: 'g', index: 0, text: 'text' }],
        providerId: 'openai-tts', voice: 'test-voice', speed, maxClipSeconds,
      }),
      /speed|maxClipSeconds/,
    );
  }
  await assert.rejects(
    synthesizeNarrationBeats({
      draftId: 'draft',
      beats: [
        { beatId: 'b1', groupId: 'same', index: 0, text: 'first' },
        { beatId: 'b2', groupId: 'same', index: 1, text: 'second' },
      ],
      providerId: 'openai-tts', voice: 'test-voice', speed: 1, maxClipSeconds: 4,
    }),
    /groupId|重复/,
  );
  await assert.rejects(
    buildNarrationTrack({
      beats: [beats[0], { ...beats[1], audioPath: path.join(dataRoot, 'other.m4a') }],
      introDurationSec: 0,
      workDir: trackDir,
    }),
    /audioPath|一致/,
  );
  await assert.rejects(
    buildNarrationTrack({ beats, introDurationSec: -1, workDir: trackDir }),
    /introDurationSec/,
  );
  responseMode = 'empty';
  await assert.rejects(
    synthesizeNarrationBeats({
      draftId: 'draft-empty-audio',
      beats: [{ beatId: 'empty', groupId: 'empty', index: 0, text: '无效音频时长' }],
      providerId: 'openai-tts', voice: 'test-voice', speed: 1, maxClipSeconds: 4,
    }),
    /probed duration|ffmpeg|ffprobe/,
  );

  console.log('final-video-tts-beats passed');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
