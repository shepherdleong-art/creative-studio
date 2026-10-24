import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createOpenAiAlignmentAdapter, createOpenAiTranscriptionAdapter, speechContent } from '../lib/media-core/adapters/alignment.ts';
import { alignOrProportionallyTime } from '../lib/media-core/adapters/tts-common.ts';

const config = { baseUrl: 'https://speech.example.test/v1', apiKey: 'test-secret', model: 'whisper-1' };
const audioPath = fileURLToPath(import.meta.url);
const originalFetch = globalThis.fetch;
try {
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({ words: [{ word: '你好', start: 0, end: 0.5 }] });
  };
  const stopped = new AbortController();
  const reason = new Error('任务已停止');
  stopped.abort(reason);
  await assert.rejects(createOpenAiAlignmentAdapter({}, config).align({ audioPath, text: '你好', signal: stopped.signal }),
    error => error === reason, '已经停止的任务不再读取或提交声音');
  assert.equal(requests, 0);
  const alignment = createOpenAiAlignmentAdapter({}, config);
  await assert.rejects(alignOrProportionallyTime({ alignment, audioPath, narration: '你好',
    durationUs: 1_000_000, segmentId: 's1', signal: stopped.signal }), error => error === reason,
  '停止不能被当成普通对齐失败后继续提交估算字幕');
  globalThis.fetch = async (_url, init) => {
    const body = init!.body as FormData;
    assert.equal(body.has('prompt'), false, '原声转写不能拿 Excel 文案提示模型补出台词');
    return Response.json({ text: '更安静。', words: [{ word: '更安静', start: 2, end: 3 }] });
  };
  assert.deepEqual(await createOpenAiTranscriptionAdapter({}, config).transcribe({ audioPath, durationUs: 4_000_000 }), {
    text: '更安静。', words: [{ text: '更安静', startUs: 2_000_000, endUs: 3_000_000 }],
  });
  globalThis.fetch = async (_url, init) => {
    await delay(80, undefined, { signal: init?.signal ?? undefined });
    return Response.json({ text: '你好', words: [{ word: '你好', start: 0, end: 0.5 }] });
  };
  await assert.rejects(createOpenAiTranscriptionAdapter({}, { ...config, timeoutMs: 20 })
    .transcribe({ audioPath, durationUs: 1_000_000 }), /超时/, '转写请求不能无限等待');
  globalThis.fetch = async () => new Response('echo test-secret https://private.example/audio?signature=secret', { status: 401 });
  await assert.rejects(createOpenAiAlignmentAdapter({}, config).align({ audioPath, text: '你好' }), error =>
    error instanceof Error && /401/.test(error.message) && !/test-secret|signature|private/.test(error.message),
  '上游错误不把密钥、签名地址或正文带进任务日志');
  globalThis.fetch = async () => Response.json({ words: [{ word: '更费电', start: 0, end: 0.5 }] });
  const mismatched = await alignOrProportionallyTime({ alignment, audioPath, narration: '更省电', durationUs: 1_000_000, segmentId: 's1' });
  assert.equal(mismatched.degraded, true, '字数相同但内容不同，不能当作对齐成功');
  const transcription = createOpenAiTranscriptionAdapter({}, config);
  for (const payload of [
    { text: '', words: [] },
    { text: '你好', words: [] },
    { text: '...', words: [{ word: '...', start: 0, end: 0.5 }] },
    { text: '---', words: [{ word: '---', start: 0, end: 0.5 }] },
    { text: '你好', words: [{ word: '你好', start: -1, end: 0.5 }] },
    { text: '你好', words: [{ word: '你好', start: 0, end: 1.1 }] },
    { text: '你好', words: [{ word: '你好', start: null, end: 0.5 }] },
    { text: '你好', words: [{ word: '你', start: 0, end: 0.6 }, { word: '好', start: 0.5, end: 0.7 }] },
    { text: '省电', words: [{ word: '费电', start: 0, end: 0.5 }] },
    { text: '1.5', words: [{ word: '15', start: 0, end: 0.5 }] },
    { text: '20%', words: [{ word: '20', start: 0, end: 0.5 }] },
    { text: '-5', words: [{ word: '5', start: 0, end: 0.5 }] },
    null,
  ]) {
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(transcription.transcribe({ audioPath, durationUs: 1_000_000 }),
      '缺词、无内容、错误台词和不合法时间不能作为原声依据');
  }
  const midRequest = new AbortController();
  let cancelledRequests = 0;
  globalThis.fetch = async (_url, init) => {
    cancelledRequests += 1;
    assert(init?.signal, '上传必须携带任务信号');
    midRequest.abort(reason);
    throw new Error('fetch aborted');
  };
  await assert.rejects(transcription.transcribe({ audioPath, durationUs: 1_000_000, signal: midRequest.signal }), error => error === reason);
  assert.equal(cancelledRequests, 1, '取消中的上传不进入网络错误重试');
  const backoff = new AbortController();
  globalThis.fetch = async () => {
    setTimeout(() => backoff.abort(reason), 5);
    return new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } });
  };
  await assert.rejects(createOpenAiTranscriptionAdapter({}, { ...config, timeoutMs: 100 })
    .transcribe({ audioPath, durationUs: 1_000_000, signal: backoff.signal }), error => error === reason,
    '重试等待期间停止应立即结束，不等待三十秒或被误报为超时');
  globalThis.fetch = async () => Response.json({ words: [{ word: '你好。', start: 0, end: 0.5 }] });
  const aligned = await alignOrProportionallyTime({ alignment, audioPath, narration: '你好', durationUs: 1_000_000, segmentId: 's1' });
  assert.equal(aligned.degraded, false, '正常标点变化仍可对齐');
  const unavailable = await alignOrProportionallyTime({ alignment: createOpenAiAlignmentAdapter({}), audioPath,
    narration: '你好', durationUs: 1_000_000, segmentId: 's1' });
  assert.equal(unavailable.degraded, true, '保留旧流程中明确标为估算的退路');
  assert.equal(speechContent('买沙发🛋️前'), speechContent('买沙发前'));
  console.log('media speech tests passed');
} finally { globalThis.fetch = originalFetch; }
