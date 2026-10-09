import assert from 'node:assert/strict';
import { createFilenameAnalysisStream, readFilenameAnalysisStream } from '../lib/batch-production/filename-analysis-stream.ts';
import type { FilenameAnalysisProgress, FilenameAnalysisResult } from '../lib/batch-production/filename-analysis.ts';

const event: FilenameAnalysisProgress = { completed: 0, total: 2, succeeded: 0, failed: 0,
  assetId: 'a', displayName: '女生手持面霜.mp4', status: 'processing' };
const result: FilenameAnalysisResult = { items: [{ assetId: 'a', analysisId: 'analysis', description: '女生手持面霜', reused: false }],
  errors: [{ assetId: 'b', message: '文件名缺少内容描述' }] };
let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const response = createFilenameAnalysisStream(async report => {
  report(event);
  await gate;
  report({ ...event, completed: 2, succeeded: 1, failed: 1, status: 'failed' });
  return result;
}, () => '提取失败');
const progress: FilenameAnalysisProgress[] = [];
const reading = readFilenameAnalysisStream(response, entry => { progress.push(entry); release(); });
assert.deepEqual(await reading, result);
assert.equal(progress.length, 2, '必须在整批结束前交付进度，否则门闩无法释放');

// 刻意逐字节拆分中文和 JSON 行，模拟网络分块。
const bytes = new TextEncoder().encode(`${JSON.stringify({ type: 'progress', progress: event })}\n${JSON.stringify({ type: 'result', result })}\n`);
const split = new Response(new ReadableStream<Uint8Array>({ start(stream) {
  for (const byte of bytes) stream.enqueue(Uint8Array.of(byte));
  stream.close();
} }), { headers: { 'Content-Type': 'application/x-ndjson' } });
assert.deepEqual(await readFilenameAnalysisStream(split, entry => assert.equal(entry.displayName, event.displayName)), result);
await assert.rejects(() => readFilenameAnalysisStream(new Response(`${JSON.stringify({ type: 'progress', progress: event })}\n`, {
  headers: { 'Content-Type': 'application/x-ndjson' },
}), () => undefined), /连接中断/);
await assert.rejects(() => readFilenameAnalysisStream(createFilenameAnalysisStream(async () => { throw new Error('private-path'); },
  () => '安全错误提示'), () => undefined), /安全错误提示/);
assert.deepEqual(await readFilenameAnalysisStream(Response.json(result), () => undefined), result, '保留旧 JSON 接口兼容');
let abortSignal: AbortSignal | undefined;
const cancelled = createFilenameAnalysisStream(async (report, signal) => {
  abortSignal = signal;
  report(event);
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  signal.throwIfAborted();
  return result;
}, () => '已中断');
const reader = cancelled.body!.getReader();
await reader.read();
await reader.cancel();
assert.equal(abortSignal?.aborted, true, '客户端退出必须停止后续提取');
console.log('batch filename analysis stream tests passed');
