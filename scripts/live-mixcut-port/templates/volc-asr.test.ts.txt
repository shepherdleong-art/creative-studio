import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVolcFlashAsrAdapter, VOLC_FLASH_ASR_RESOURCE_ID } from '../lib/media-core/adapters/volc-asr.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'volc-asr-test-'));
const audioPath = path.join(root, 'source.wav');
fs.writeFileSync(audioPath, Buffer.from('RIFF-test-audio'));
const originalFetch = globalThis.fetch;
const env = { CREATIVE_STUDIO_VOLC_ASR_API_KEY: 'test-key-123' };

type Reply = { status?: number; code: string; body?: unknown };
function stubReplies(replies: Reply[]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: { audio: { data: string } } }> = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
    const reply = replies.shift()!;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'X-Api-Status-Code': reply.code, 'X-Tt-Logid': 'log-1' } });
  }) as typeof fetch;
  return calls;
}
const ok = (words: Array<[string, number, number]>, text = words.map(([t]) => t).join('')) => ({
  code: '20000000', body: { result: { text, utterances: [{ words: words.map(([t, s, e]) => ({ text: t, start_time: s, end_time: e })) }] } } });

try {
  // 没有 Key：不算已配置，调用时报错。
  const unconfigured = createVolcFlashAsrAdapter({});
  assert.equal(unconfigured.configured, false);
  await assert.rejects(unconfigured.transcribe({ audioPath, durationUs: 1_000_000 }), /未配置/);

  // 成功：毫秒换成微秒，请求头和请求体按文档。
  const adapter = createVolcFlashAsrAdapter(env);
  assert.equal(adapter.configured, true);
  assert.equal(adapter.identity.adapterVersion, 'volc-flash-asr/1');
  let calls = stubReplies([ok([['好', 100, 300], ['擦', 300, 500], ['洗', 500, 800]], '好擦洗。')]);
  const result = await adapter.transcribe({ audioPath, durationUs: 2_000_000 });
  assert.equal(result.text, '好擦洗。');
  assert.deepEqual(result.words, [{ text: '好', startUs: 100_000, endUs: 300_000 }, { text: '擦', startUs: 300_000, endUs: 500_000 }, { text: '洗', startUs: 500_000, endUs: 800_000 }]);
  assert.equal(calls[0].headers['X-Api-Key'], 'test-key-123');
  assert.equal(calls[0].headers['X-Api-Resource-Id'], VOLC_FLASH_ASR_RESOURCE_ID);
  assert.equal(calls[0].headers['X-Api-Sequence'], '-1');
  assert.equal(calls[0].body.audio.data, Buffer.from('RIFF-test-audio').toString('base64'));

  // 服务繁忙重试一次后成功。
  calls = stubReplies([{ code: '55000031' }, ok([['好', 0, 200]])]);
  assert.equal((await adapter.transcribe({ audioPath, durationUs: 1_000_000 })).text, '好');
  assert.equal(calls.length, 2);

  // 参数错误不重试，错误信息不带 Key。
  calls = stubReplies([{ code: '45000001' }]);
  await assert.rejects(adapter.transcribe({ audioPath, durationUs: 1_000_000 }), error => {
    assert.match((error as Error).message, /45000001/);
    assert.doesNotMatch((error as Error).message, /test-key-123/);
    return true;
  });
  assert.equal(calls.length, 1);

  // 重叠、零长度的逐字时间修成单调递增；末字超出 50 毫秒以内截到时长。
  stubReplies([ok([['坐', 100, 400], ['得', 350, 350], ['稳', 400, 1_020]])]);
  const fixed = await adapter.transcribe({ audioPath, durationUs: 1_000_000 });
  assert.deepEqual(fixed.words.map(word => [word.startUs, word.endUs]), [[100_000, 400_000], [400_000, 401_000], [401_000, 1_000_000]]);

  // 超出时长太多、台词和逐字内容对不上：都当失败。
  stubReplies([ok([['好', 100, 2_000]])]);
  await assert.rejects(adapter.transcribe({ audioPath, durationUs: 1_000_000 }), /超出原片长度/);
  stubReplies([ok([['好', 100, 300]], '坐得稳。')]);
  await assert.rejects(adapter.transcribe({ audioPath, durationUs: 1_000_000 }), /不一致/);
  console.log('volc asr tests passed');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
