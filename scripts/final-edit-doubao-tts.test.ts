import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestDoubaoAudio } from '../lib/final-edit/adapters/doubao-tts.ts';
import { getFinalEditTtsAdapter } from '../lib/final-edit/adapters/tts-registry.ts';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-edit-doubao-tts-'));
const outputPath = path.join(tempDir, 'speech.mp3');
const originalFetch = globalThis.fetch;
let requestedUrl = '';
let requestedInit: RequestInit | undefined;

function pcmWav(durationMs: number): Buffer {
  const sampleRate = 24_000;
  const dataSize = Math.round(sampleRate * durationMs / 1_000) * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

try {
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    const first = Buffer.from('first-audio-chunk');
    const second = Buffer.from('second-audio-chunk');
    const body = [
      JSON.stringify({
        code: 0,
        message: 'ok',
        data: first.toString('base64'),
        sentence: { words: [{ word: '你', startTime: 0, endTime: 0.12 }, { word: '好', startTime: 0.12, endTime: 0.28 }] },
      }),
      JSON.stringify({ code: 0, message: 'ok', data: second.toString('base64') }),
      JSON.stringify({ code: 20_000_000, message: 'done' }),
    ].join('');
    return new Response(body, { status: 200, headers: { 'X-Tt-Logid': 'doubao-log-1' } });
  };

  const result = await requestDoubaoAudio(
    { baseUrl: 'https://openspeech.bytedance.com', apiKey: 'test-key', model: 'seed-tts-2.0' },
    'zh_female_vv_uranus_bigtts',
    '你好，豆包。',
    outputPath,
  );

  assert.equal(requestedUrl, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  const headers = new Headers(requestedInit?.headers);
  assert.equal(headers.get('X-Api-Key'), 'test-key');
  assert.equal(headers.get('X-Api-Resource-Id'), 'seed-tts-2.0');
  assert.match(headers.get('X-Api-Request-Id') || '', /^[0-9a-f-]{36}$/i);
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    req_params: {
      text: '你好，豆包。',
      speaker: 'zh_female_vv_uranus_bigtts',
      audio_params: { format: 'mp3', sample_rate: 24_000, enable_subtitle: true },
    },
  });
  assert.deepEqual(fs.readFileSync(outputPath), Buffer.from('first-audio-chunksecond-audio-chunk'));
  assert.deepEqual(result.wordTimings, [
    { text: '你', startUs: 0, endUs: 120_000 },
    { text: '好', startUs: 120_000, endUs: 280_000 },
  ]);

  const adapter = getFinalEditTtsAdapter('doubao-seed-tts-2');
  assert.equal(adapter.type, 'doubao-http-chunked');
  assert.equal(adapter.providesWordTimings, true);
  assert.equal(adapter.defaultVoice, 'zh_female_vv_uranus_bigtts');
  assert.equal(adapter.voices.find((voice) => voice.label === '大壹')?.id, 'zh_male_dayi_saturn_bigtts');
  assert.equal(adapter.validateBaseUrl('https://openspeech.bytedance.com/'), 'https://openspeech.bytedance.com');
  assert.equal(
    adapter.validateBaseUrl('https://openspeech.bytedance.com/api/v3/tts/unidirectional'),
    'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
  );
  assert.throws(() => adapter.validateBaseUrl('http://openspeech.bytedance.com'), /HTTPS/);
  assert.throws(() => adapter.validateBaseUrl('https://openspeech.bytedance.com/private'), /origin/);

  globalThis.fetch = async () => new Response([
    JSON.stringify({
      code: 0,
      data: pcmWav(400).toString('base64'),
      sentence: { words: [{ word: '你', startTime: 0, endTime: 0.1 }, { word: '好', startTime: 0.1, endTime: 0.2 }] },
    }),
    JSON.stringify({ code: 20_000_000, message: 'done' }),
  ].join(''), { status: 200 });
  const narration = await adapter.synthesize({
    provider: { baseUrl: 'https://openspeech.bytedance.com', apiKey: 'test-key', model: 'seed-tts-2.0' },
    voice: adapter.defaultVoice,
    speed: 1,
    segments: [{ segmentId: 'segment-1', narration: '你好' }],
    outputDir: path.join(tempDir, 'narration'),
    relativeOutputPath: 'final-edits/narration/test/narration.wav',
    alignment: { configured: false, align: async () => [] },
  });
  assert.deepEqual(narration.wordTimings, [
    { text: '你', startUs: 0, endUs: 100_000 },
    { text: '好', startUs: 100_000, endUs: 200_000 },
  ]);
  assert.deepEqual(narration.alignmentDegradedSegmentIds, []);
  assert.equal(fs.existsSync(narration.absolutePath), true);
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('final-edit Doubao TTS protocol test passed');
