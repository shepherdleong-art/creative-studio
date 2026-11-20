import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const { createVolcFlashAsrAdapter } = await import('../lib/media-core/adapters/volc-asr.ts');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volc-asr-'));
const audioPath = path.join(directory, 'sample.wav');
const audio = Buffer.from('synthetic audio');
await fs.writeFile(audioPath, audio);
const originalFetch = globalThis.fetch;

try {
  const input = { audioPath, durationUs: 1_500_000 };
  const adapter = createVolcFlashAsrAdapter({ DOUBAO_TTS_API_KEY: 'test-voice-key' });
  assert.equal(adapter.configured, true);
  assert.equal(createVolcFlashAsrAdapter({}).configured, false);

  const reply = (status: string, body: unknown = {}, httpStatus = 200) =>
    new Response(JSON.stringify(body), { status: httpStatus, headers: { 'X-Api-Status-Code': status } });
  const recognized = {
    result: { text: '测试。', utterances: [{ text: '测试。', words: [
      { text: '测', start_time: 250, end_time: 530 },
      { text: '试', start_time: 520, end_time: 1520 },
    ] }] },
  };

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), 'test-voice-key');
    assert.equal(headers.get('x-api-resource-id'), 'volc.seedasr.auc');
    assert.equal(headers.get('x-api-sequence'), '-1');
    const request = JSON.parse(String(init?.body));
    assert.equal(request.audio.data, audio.toString('base64'));
    assert.equal(request.request.show_utterances, true);
    return reply('20000000', recognized);
  };
  assert.deepEqual(await adapter.transcribe(input), {
    text: '测试。',
    words: [
      { text: '测', startUs: 250_000, endUs: 530_000 },
      { text: '试。', startUs: 530_000, endUs: 1_500_000 },
    ],
  });

  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), 'test-asr-key');
    assert.equal(headers.get('x-api-resource-id'), 'volc.bigasr.auc_turbo');
    return reply('20000003');
  };
  const dedicated = createVolcFlashAsrAdapter({
    CREATIVE_STUDIO_VOLC_ASR_API_KEY: 'test-asr-key',
    CREATIVE_STUDIO_VOLC_ASR_RESOURCE_ID: 'volc.bigasr.auc_turbo',
    DOUBAO_TTS_API_KEY: 'test-voice-key',
  });
  assert.deepEqual(await dedicated.transcribe(input), { text: '', words: [], noSpeech: { provider: 'volc', statusCode: '20000003' } });

  globalThis.fetch = async () => reply('45000030', { detail: 'test-voice-key' }, 403);
  await assert.rejects(adapter.transcribe(input), /^Error: 当前豆包语音 Key 未开通 ASR 资源 volc\.seedasr\.auc（45000030）$/);
  globalThis.fetch = async () => reply('20000000', { result: { text: '' } });
  await assert.rejects(adapter.transcribe(input), /没有返回正文和逐字时间/);
  globalThis.fetch = async () => reply('20000000', { result: { ...recognized.result, text: '不一致' } });
  await assert.rejects(adapter.transcribe(input), /正文与逐字时间不一致/);
  console.log('豆包 ASR 适配器契约通过');
} finally {
  globalThis.fetch = originalFetch;
  await fs.unlink(audioPath);
  await fs.rmdir(directory);
}
