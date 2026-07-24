import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isReusableNarrationChunk, synthesizeVapiNarration, synthesizeVapiPreview, VAPI_VOICES, VAPI_PREVIEW_TEXT, speechUrl, validateVapiAudioUrl } from '../lib/final-edit/adapters/vapi-qwen-tts.ts';
import { assertTtsSpeed } from '../lib/final-edit/tts-speed.ts';

assert.equal(VAPI_VOICES.length, 17);
assert.equal(VAPI_VOICES.find((voice) => voice.label.includes('南京'))?.id, 'li');
assert.equal(VAPI_PREVIEW_TEXT, '你好，我是产品素材工作台语音助手，这是当前音色和语速的试听效果。');
assert.equal(speechUrl('https://api.v3.cm'), 'https://api.v3.cm/v1/audio/speech');
assert.equal(speechUrl('https://api.v3.cm/v1/'), 'https://api.v3.cm/v1/audio/speech');
assert.equal(validateVapiAudioUrl('http://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/a.wav?x=1').protocol, 'https:');
assert.throws(() => validateVapiAudioUrl('https://127.0.0.1/private'));
assert.throws(() => validateVapiAudioUrl('file:///tmp/a.wav'));
assert.doesNotThrow(() => assertTtsSpeed(0.5));
assert.doesNotThrow(() => assertTtsSpeed(2));
assert.throws(() => assertTtsSpeed(0.55), /0.1/);
assert.throws(() => assertTtsSpeed(2.1), /0.5x～2.0x/);

await assert.rejects(
  synthesizeVapiNarration({
    provider: { baseUrl: 'https://api.v3.cm', apiKey: 'unused', model: 'qwen3-tts-flash' },
    voice: 'Cherry', speed: 0.55, segments: [{ segmentId: 's1', narration: '测试' }],
    outputDir: path.join(os.tmpdir(), 'unused-vapi-narration'), relativeOutputPath: 'unused.wav',
    alignment: { configured: true, align: async () => [] },
  }),
  /0.1/,
);
await assert.rejects(
  synthesizeVapiPreview({ provider: { baseUrl: 'https://api.v3.cm', apiKey: 'unused', model: 'qwen3-tts-flash' }, voice: 'Cherry', speed: 2.1, text: '测试', outputPath: path.join(os.tmpdir(), 'unused-vapi-preview.wav') }),
  /0.5x～2.0x/,
);

function pcmWav(durationMs: number): Buffer {
  const sampleRate = 16_000;
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

async function testNarrationChunkValidation() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-edit-tts-test-'));
  try {
    const validPath = path.join(tempDir, 'valid.wav');
    const truncatedPath = path.join(tempDir, 'truncated.wav');
    fs.writeFileSync(validPath, pcmWav(250));
    fs.writeFileSync(truncatedPath, Buffer.alloc(256, 1));
    assert.equal(await isReusableNarrationChunk(validPath), true, 'valid WAV chunks should be reusable');
    assert.equal(await isReusableNarrationChunk(truncatedPath), false, 'truncated files must not be reused merely because they are large');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

void testNarrationChunkValidation()
  .then(() => console.log('final-edit V-API TTS tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
