import type { FilenameAnalysisProgress, FilenameAnalysisResult } from './filename-analysis.ts';

type FilenameEvent =
  | { type: 'progress'; progress: FilenameAnalysisProgress }
  | { type: 'result'; result: FilenameAnalysisResult }
  | { type: 'error'; message: string };

/** 单次请求保留整批归属校验；进度只在本地核验/落库的真实边界发送。 */
export function createFilenameAnalysisStream(
  run: (report: (progress: FilenameAnalysisProgress) => void, signal: AbortSignal) => Promise<FilenameAnalysisResult>,
  publicError: (error: unknown) => string,
): Response {
  const controller = new AbortController();
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(stream) {
      const send = (event: FilenameEvent) => {
        if (!cancelled) stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        const result = await run((progress) => send({ type: 'progress', progress }), controller.signal);
        send({ type: 'result', result });
      } catch (error) {
        send({ type: 'error', message: publicError(error) });
      } finally {
        if (!cancelled) stream.close();
      }
    },
    cancel() {
      cancelled = true;
      controller.abort();
    },
  });
  return new Response(body, { headers: {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  } });
}

/** 支持跨网络分块的中文；无最终回执时不把半途断线当成功。 */
export async function readFilenameAnalysisStream(
  response: Response,
  onProgress: (progress: FilenameAnalysisProgress) => void,
): Promise<FilenameAnalysisResult> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const payload = await response.json() as FilenameAnalysisResult & { message?: string };
    if (!response.ok) throw new Error(payload.message || '文件名描述提取失败');
    return payload;
  }
  if (!response.body) throw new Error('文件名提取进度连接不可用');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: FilenameAnalysisResult | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as FilenameEvent;
    if (event.type === 'progress') onProgress(event.progress);
    else if (event.type === 'result') result = event.result;
    else if (event.type === 'error') throw new Error(event.message);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) break;
    }
    consume(buffer);
    if (!result) throw new Error('文件名提取连接中断，已完成的素材已保留，请刷新后重试剩余素材');
    return result;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
