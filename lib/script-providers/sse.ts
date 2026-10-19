export interface SseStreamHandlers {
  /** 已剥离 `data:` 前缀、已跳过注释与 `[DONE]` 的事件载荷。 */
  onLine(payload: string): void;
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function consumeSseLine(line: string, onLine: (payload: string) => void): void {
  const normalized = line.replace(/\r$/, '').trim();
  if (!normalized || normalized.startsWith(':') || !normalized.startsWith('data:')) return;
  const payload = normalized.slice(5).trim();
  if (!payload || payload === '[DONE]') return;
  onLine(payload);
}

/**
 * 读取 text/event-stream 响应并按行回调。行缓冲、跨 chunk 断行、注释行、
 * `[DONE]`、abort 中断与提前结束取消 reader 的语义由本模块统一维护。
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  handlers: SseStreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;

  try {
    while (true) {
      const { value, done } = await readWithAbort(reader, signal);
      if (done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consumeSseLine(line, handlers.onLine);
    }

    buffer += decoder.decode();
    if (buffer.trim()) consumeSseLine(buffer, handlers.onLine);
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
