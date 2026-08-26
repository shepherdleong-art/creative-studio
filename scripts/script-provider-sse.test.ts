import assert from 'node:assert/strict';
import { readSseStream } from '../lib/script-providers/sse.ts';

const encoder = new TextEncoder();

function streamResponse(chunks: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(chunks: string[]): Promise<string[]> {
  const lines: string[] = [];
  const body = streamResponse(chunks).body;
  if (!body) throw new Error('missing response body');
  await readSseStream(body, new AbortController().signal, {
    onLine: (payload) => lines.push(payload),
  });
  return lines;
}

{
  const lines = await collect([
    'data: {"type":"one"}\n\n',
    ': comment\n\n',
    'event: ignored\n\n',
    'data: {"type":"two"}\n',
    'data: [DONE]\n\n',
    'data: {"type":"three"}\n\n',
  ]);
  assert.deepEqual(lines, ['{"type":"one"}', '{"type":"two"}', '{"type":"three"}']);
}

{
  const lines = await collect([
    'data: {"type":"bro',
    'ken","delta":"a"}\n\n',
    'data: {"type":"continued","delta":"b"}\n',
    '\n',
    'data: {"type":"tail"}',
  ]);
  assert.deepEqual(lines, [
    '{"type":"broken","delta":"a"}',
    '{"type":"continued","delta":"b"}',
    '{"type":"tail"}',
  ]);
}

{
  const streamBody = new Response(new ReadableStream<Uint8Array>({
    start() {
      // 不关闭流，等待 abort 中断读取。
    },
  })).body;
  if (!streamBody) throw new Error('missing response body');
  const controller = new AbortController();
  const pending = readSseStream(streamBody, controller.signal, { onLine: () => undefined });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
}

{
  await assert.rejects(
    (async () => {
      const body = streamResponse(['data: {"valid":1}\n\n']).body;
      if (!body) throw new Error('missing response body');
      await readSseStream(body, new AbortController().signal, {
        onLine: () => {
          throw new Error('parse failed');
        },
      });
    })(),
    /parse failed/,
  );
}

console.log('script provider sse tests passed');
